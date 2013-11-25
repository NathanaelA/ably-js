var Channel = (function() {
	function noop() {}

	/* public constructor */
	function Channel(rest, name, options) {
		Logger.logAction(Logger.LOG_MINOR, 'Channel()', 'started; name = ' + name);
		EventEmitter.call(this);
		this.rest = rest;
    	this.name = name;
		this.cipher = null;
	}
	Utils.inherits(Channel, EventEmitter);

	Channel.prototype.setOptions = function(channelOpts, callback) {
		callback = callback || noop;
		if(channelOpts && channelOpts.encrypted) {
			var self = this;
			Crypto.getCipher(channelOpts, function(err, cipher) {
				self.cipher = cipher;
				callback(null);
			});
		} else {
			callback(null, this.cipher = null);
		}
	};

	Channel.prototype.presence = function(params, callback) {
		Logger.logAction(Logger.LOG_MICRO, 'Channel.presence()', 'channel = ' + this.name);
		/* params and callback are optional; see if params contains the callback */
		if(callback === undefined) {
			if(typeof(params) == 'function') {
				callback = params;
				params = null;
			} else {
				callback = noop;
			}
		}
		var rest = this.rest, binary = !rest.options.useTextProtocol;
		var headers = Utils.copy(Utils.defaultGetHeaders(binary));
		if(rest.options.headers)
			Utils.mixin(headers, rest.options.headers);
		Resource.get(rest, '/channels/' + this.name + '/presence', headers, params, function(err, res) {
			if(err) {
				callback(err);
				return;
			}
			if(binary) PresenceMessage.decodeTPresenceArray(res, callback);
			else callback(null, res);
		});
	};

	Channel.prototype.history = function(params, callback) {
		Logger.logAction(Logger.LOG_MICRO, 'Channel.history()', 'channel = ' + this.name);
		/* params and callback are optional; see if params contains the callback */
		if(callback === undefined) {
			if(typeof(params) == 'function') {
				callback = params;
				params = null;
			} else {
				callback = noop;
			}
		}
		var rest = this.rest,
			binary = !rest.options.useTextProtocol,
			headers = Utils.copy(Utils.defaultGetHeaders(binary)),
			cipher = this.cipher;

		if(rest.options.headers)
			Utils.mixin(headers, rest.options.headers);
		Resource.get(rest, '/channels/' + this.name + '/history', headers, params, function(err, res) {
			if(err) {
				callback(err);
				return;
			}
			try {
				var messages = Serialize.TMessageArray.decode(res, binary);
				if(cipher) {
					for(var i = 0; i < messages.length; i++) {
						Message.decrypt(messages[i], cipher);
						if (binary)
							messages[i].data = Data.fromTData(messages[i].data);
					}
				}

				callback(null, messages);
			} catch(err) {
				callback(err);
			}
		});
	};

	Channel.prototype.publish = function(name, data, callback) {
		Logger.logAction(Logger.LOG_MICRO, 'Channel.publish()', 'channel = ' + this.name + '; name = ' + name);
		callback = callback || noop;
		var rest = this.rest,
			binary = !rest.options.useTextProtocol,
			msg = {name:name, data:data},
			cipher = this.cipher;
		if(cipher)
			Message.encrypt(msg, cipher);
		var requestBody = Serialize.TMessageArray.encode([msg], binary);
		var headers = Utils.copy(Utils.defaultPostHeaders(binary));
		if(rest.options.headers)
			Utils.mixin(headers, rest.options.headers);
		Resource.post(rest, '/channels/' + this.name + '/publish', requestBody, headers, null, callback);
	};

	return Channel;
})();
