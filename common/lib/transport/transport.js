var Transport = (function() {
	var actions = ProtocolMessage.Action;
	var closeMessage = ProtocolMessage.fromValues({action: actions.CLOSE});
	var disconnectMessage = ProtocolMessage.fromValues({action: actions.DISCONNECT});
	var noop = function() {};

	/*
	 * EventEmitter, generates the following events:
	 *
	 * event name       data
	 * closed           error
	 * failed           error
	 * disposed
	 * connected        null error, connectionKey
	 * event            channel message object
	 */

	/* public constructor */
	function Transport(connectionManager, auth, params) {
		EventEmitter.call(this);
		this.connectionManager = connectionManager;
		connectionManager.registerProposedTransport(this);
		this.auth = auth;
		this.params = params;
		this.timeouts = params.options.timeouts;
		this.format = params.format;
		this.isConnected = false;
		this.isFinished = false;
		this.idleTimer = null;
	}
	Utils.inherits(Transport, EventEmitter);

	Transport.prototype.connect = function() {};

	Transport.prototype.close = function() {
		if(this.isConnected) {
			this.requestClose();
		}
		this.finish('closed', ConnectionError.closed);
	};

	Transport.prototype.disconnect = function(err) {
		/* Used for network/transport issues that need to result in the transport
		 * being disconnected, but should not affect the connection */
		if(this.isConnected) {
			this.requestDisconnect();
		}
		this.finish('disconnected', err || ConnectionError.disconnected);
	};

	Transport.prototype.fail = function(err) {
		/* Used for client-side-detected fatal connection issues */
		if(this.isConnected) {
			this.requestDisconnect();
		}
		this.finish('failed', err || ConnectionError.failed);
	};

	Transport.prototype.finish = function(event, err) {
		if(this.isFinished) {
			return;
		}

		this.isFinished = true;
		this.isConnected = false;
		this.timeoutOnIdle = false;
		clearTimeout(this.idleTimer);
		this.emit(event, err);
		this.dispose();
	};

	Transport.prototype.onProtocolMessage = function(message) {
		if (Logger.shouldLog(Logger.LOG_MICRO)) {
			Logger.logAction(Logger.LOG_MICRO, 'Transport.onProtocolMessage()', 'received on ' + this.shortName + ': ' + ProtocolMessage.stringify(message));
		}
		if(this.timeoutOnIdle) {
			this.resetIdleTimeout();
		}

		switch(message.action) {
		case actions.HEARTBEAT:
			Logger.logAction(Logger.LOG_MICRO, 'Transport.onProtocolMessage()', this.shortName + ' heartbeat; connectionKey = ' + this.connectionManager.connectionKey);
			this.emit('heartbeat', message.id);
			break;
		case actions.CONNECTED:
			this.onConnect(message);
			this.emit('connected', message.error, (message.connectionDetails ? message.connectionDetails.connectionKey : message.connectionKey), message.connectionSerial, message.connectionId, message.connectionDetails);
			break;
		case actions.CLOSED:
			this.onClose(message);
			break;
		case actions.DISCONNECTED:
			this.onDisconnect(message);
			break;
		case actions.ACK:
			this.emit('ack', message.msgSerial, message.count);
			break;
		case actions.NACK:
			this.emit('nack', message.msgSerial, message.count, message.error);
			break;
		case actions.SYNC:
			if(message.connectionId !== undefined) {
				/* a transport SYNC */
				this.emit('sync', message.connectionSerial, message.connectionId);
				break;
			}
			/* otherwise it's a channel SYNC, so handle it in the channel */
			this.connectionManager.onChannelMessage(message, this);
			break;
		case actions.ERROR:
			Logger.logAction(Logger.LOG_MINOR, 'Transport.onProtocolMessage()', 'received error action; connectionKey = ' + this.connectionManager.connectionKey + '; err = ' + Utils.inspect(message.error) + (message.channel ? (', channel: ' +  message.channel) : ''));
			if(message.channel === undefined) {
				this.onFatalError(message);
				break;
			}
			/* otherwise it's a channel-specific error, so handle it in the channel */
			this.connectionManager.onChannelMessage(message, this);
			break;
		default:
			/* all other actions are channel-specific */
			this.connectionManager.onChannelMessage(message, this);
		}
	};

	Transport.prototype.onConnect = function(message) {
		this.isConnected = true;
		if(message.connectionDetails.maxIdleInterval === 0) {
			/* Realtime declines to guarantee any maximum idle interval - CD2h */
			this.timeoutOnIdle = false;
		} else {
			/* TODO remove "|| 15000" once realtime starts sending this */
			this.maxIdleInterval = message.connectionDetails.maxIdleInterval || 15000;
		}
		if(this.timeoutOnIdle) {
			this.resetIdleTimeout();
		}
	};

	Transport.prototype.onDisconnect = function(message) {
		/* Used for when the server has disconnected the client (usually with a
		 * DISCONNECTED action) */
		var err = message && message.error;
		Logger.logAction(Logger.LOG_MINOR, 'Transport.onDisconnect()', 'err = ' + Utils.inspectError(err));
		this.finish('disconnected', err);
	};

	Transport.prototype.onFatalError = function(message) {
		/* On receipt of a fatal connection error, we can assume that the server
		 * will close the connection and the transport, and do not need to request
		 * a disconnection - RTN15i */
		var err = message && message.error;
		Logger.logAction(Logger.LOG_MINOR, 'Transport.onFatalError()', 'err = ' + Utils.inspectError(err));
		this.finish('failed', err);
	};

	Transport.prototype.onClose = function(message) {
		var err = message && message.error;
		Logger.logAction(Logger.LOG_MINOR, 'Transport.onClose()', 'err = ' + Utils.inspectError(err));
		this.finish('closed', err);
	};

	Transport.prototype.requestClose = function() {
		Logger.logAction(Logger.LOG_MINOR, 'Transport.requestClose()', '');
		this.send(closeMessage);
	};

	Transport.prototype.requestDisconnect = function() {
		Logger.logAction(Logger.LOG_MINOR, 'Transport.requestDisconnect()', '');
		this.send(disconnectMessage);
	};

	Transport.prototype.ping = function(id) {
		var msg = {action: ProtocolMessage.Action.HEARTBEAT};
		if(id) msg.id = id;
		this.send(ProtocolMessage.fromValues(msg));
	};

	Transport.prototype.dispose = function() {
		Logger.logAction(Logger.LOG_MINOR, 'Transport.dispose()', '');
		this.off();
	};

	Transport.prototype.resetIdleTimeout = function() {
		var self = this,
			timeout = this.maxIdleInterval + this.timeouts.realtimeRequestTimeout;

		clearTimeout(this.idleTimer);

		this.idleTimer = setTimeout(function() {
			var msg = 'No activity seen from realtime in ' + timeout + 'ms; assuming connection has dropped';
			Logger.logAction(Logger.LOG_ERROR, 'Transport.resetIdleTimeout()', msg);
			self.disconnect(new ErrorInfo(msg, 80003, 408));
		}, timeout);
	};

	return Transport;
})();
