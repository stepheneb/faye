Faye.Client = Faye.Class({
  UNCONNECTED:          <%= Faye::Client::UNCONNECTED %>,
  CONNECTING:           <%= Faye::Client::CONNECTING %>,
  CONNECTED:            <%= Faye::Client::CONNECTED %>,
  DISCONNECTED:         <%= Faye::Client::DISCONNECTED %>,
  
  HANDSHAKE:            '<%= Faye::Client::HANDSHAKE %>',
  RETRY:                '<%= Faye::Client::RETRY %>',
  NONE:                 '<%= Faye::Client::NONE %>',
  
  CONNECTION_TIMEOUT:   <%= Faye::Client::CONNECTION_TIMEOUT %>,
  
  DEFAULT_ENDPOINT:     '<%= Faye::RackAdapter::DEFAULT_ENDPOINT %>',
  MAX_DELAY:            <%= Faye::Connection::MAX_DELAY %>,
  INTERVAL:             <%= Faye::Connection::INTERVAL * 1000 %>,
  
  initialize: function(endpoint, options) {
    this.info('New client created for ' + endpoint);
    
    this._endpoint  = endpoint || this.DEFAULT_ENDPOINT;
    this._options   = options || {};
    this._timeout   = this._options.timeout || this.CONNECTION_TIMEOUT;
    
    this._transport = Faye.Transport.get(this);
    this._state     = this.UNCONNECTED;
    this._namespace = new Faye.Namespace();
    this._outbox    = [];
    this._channels  = new Faye.Channel.Tree();
    this._callbacks = [];
    
    this._advice = {reconnect: this.RETRY, interval: this.INTERVAL};
    
    if (!Faye.Event) return;
    Faye.Event.on(Faye.ENV, 'beforeunload', this.disconnect, this);
  },
  
  // Request
  // MUST include:  * channel
  //                * version
  //                * supportedConnectionTypes
  // MAY include:   * minimumVersion
  //                * ext
  //                * id
  // 
  // Success Response                             Failed Response
  // MUST include:  * channel                     MUST include:  * channel
  //                * version                                    * successful
  //                * supportedConnectionTypes                   * error
  //                * clientId                    MAY include:   * supportedConnectionTypes
  //                * successful                                 * advice
  // MAY include:   * minimumVersion                             * version
  //                * advice                                     * minimumVersion
  //                * ext                                        * ext
  //                * id                                         * id
  //                * authSuccessful
  handshake: function(callback, scope) {
    if (this._advice.reconnect === this.NONE) return;
    if (this._state !== this.UNCONNECTED) return;
    
    this._state = this.CONNECTING;
    var self = this;
    
    this.info('Initiating handshake with ' + this._endpoint);
    
    this._transport.send({
      channel:      Faye.Channel.HANDSHAKE,
      version:      Faye.BAYEUX_VERSION,
      supportedConnectionTypes: Faye.Transport.supportedConnectionTypes()
      
    }, function(response) {
      
      if (!response.successful) {
        this.info('Handshake unsuccessful');
        setTimeout(function() { self.handshake(callback, scope) }, this._advice.interval);
        return this._state = this.UNCONNECTED;
      }
      
      this._state     = this.CONNECTED;
      this._clientId  = response.clientId;
      this._transport = Faye.Transport.get(this, response.supportedConnectionTypes);
      
      this.info('Handshake successful: ' + this._clientId);
      if (callback) callback.call(scope);
    }, this);
  },
  
  // Request                              Response
  // MUST include:  * channel             MUST include:  * channel
  //                * clientId                           * successful
  //                * connectionType                     * clientId
  // MAY include:   * ext                 MAY include:   * error
  //                * id                                 * advice
  //                                                     * ext
  //                                                     * id
  //                                                     * timestamp
  connect: function(callback, scope) {
    if (this._advice.reconnect === this.NONE) return;
    if (this._state === this.DISCONNECTED) return;
    
    if (this._advice.reconnect === this.HANDSHAKE || this._state === this.UNCONNECTED) {
      this._beginReconnectTimeout();
      return this.handshake(function() { this.connect(callback, scope) }, this);
    }
    
    if (this._state === this.CONNECTING)
      return this.callback(callback, scope);
    
    if (this._state !== this.CONNECTED) return;
    
    this.info('Calling deferred actions for ' + this._clientId);
    this.setDeferredStatus('succeeded');
    this.setDeferredStatus('deferred');
    if (callback) callback.call(scope);
    
    if (this._connectionId) return;
    this._connectionId = this._namespace.generate();
    var self = this;
    this.info('Initiating connection for ' + this._clientId);
    
    this._transport.send({
      channel:        Faye.Channel.CONNECT,
      clientId:       this._clientId,
      connectionType: this._transport.connectionType,
      id:             this._connectionId
      
    }, this._verifyClientId(function(response) {
      delete this._connectionId;
      this.removeTimeout('reconnect');
      
      this.info('Closed connection for ' + this._clientId);
      setTimeout(function() { self.connect() }, this._advice.interval);
    }));
    
    this._beginReconnectTimeout();
  },
  
  // Request                              Response
  // MUST include:  * channel             MUST include:  * channel
  //                * clientId                           * successful
  // MAY include:   * ext                                * clientId
  //                * id                  MAY include:   * error
  //                                                     * ext
  //                                                     * id
  disconnect: function() {
    if (this._state !== this.CONNECTED) return;
    this._state = this.DISCONNECTED;
    
    this.info('Disconnecting ' + this._clientId);
    
    this._transport.send({
      channel:    Faye.Channel.DISCONNECT,
      clientId:   this._clientId
    });
    
    this.info('Clearing channel listeners for ' + this._clientId);
    this._channels = new Faye.Channel.Tree();
    this.removeTimeout('reconnect');
  },
  
  // Request                              Response
  // MUST include:  * channel             MUST include:  * channel
  //                * clientId                           * successful
  //                * subscription                       * clientId
  // MAY include:   * ext                                * subscription
  //                * id                  MAY include:   * error
  //                                                     * advice
  //                                                     * ext
  //                                                     * id
  //                                                     * timestamp
  subscribe: function(channels, callback, scope) {
    this.connect(function() {
      
      channels = [].concat(channels);
      this._validateChannels(channels);
      
      this.info('Client ' + this._clientId + ' attempting to subscribe to [' +
                channels.join(', ') + ']');
      
      this._transport.send({
        channel:      Faye.Channel.SUBSCRIBE,
        clientId:     this._clientId,
        subscription: channels
        
      }, this._verifyClientId(function(response) {
        if (!response.successful || !callback) return;
        
        this.info('Subscription acknowledged for ' + this._clientId + ' to [' +
                  channels.join(', ') + ']');
      
        channels = [].concat(response.subscription);
        Faye.each(channels, function(channel) {
          this._channels.set(channel, [callback, scope]);
        }, this);
      }));
      
    }, this);
  },
  
  // Request                              Response
  // MUST include:  * channel             MUST include:  * channel
  //                * clientId                           * successful
  //                * subscription                       * clientId
  // MAY include:   * ext                                * subscription
  //                * id                  MAY include:   * error
  //                                                     * advice
  //                                                     * ext
  //                                                     * id
  //                                                     * timestamp
  unsubscribe: function(channels, callback, scope) {
    this.connect(function() {
      
      channels = [].concat(channels);
      this._validateChannels(channels);
      
      this.info('Client ' + this._clientId + ' attempting to unsubscribe from [' +
                channels.join(', ') + ']');
      
      this._transport.send({
        channel:      Faye.Channel.UNSUBSCRIBE,
        clientId:     this._clientId,
        subscription: channels
        
      }, this._verifyClientId(function(response) {
        if (!response.successful) return;
        
        this.info('Unsubscription acknowledged for ' + this._clientId + ' from [' +
                  channels.join(', ') + ']');
      
        channels = [].concat(response.subscription);
        Faye.each(channels, function(channel) {
          this._channels.set(channel, null);
        }, this);
      }));
      
    }, this);
  },
  
  // Request                              Response
  // MUST include:  * channel             MUST include:  * channel
  //                * data                               * successful
  // MAY include:   * clientId            MAY include:   * id
  //                * id                                 * error
  //                * ext                                * ext
  publish: function(channel, data) {
    this.connect(function() {
      
      this._validateChannels([channel]);
      
      this.info('Client ' + this._clientId + ' queueing published message to ' +
                channel + ': ' + Faye.toJSON(data));
      
      this._enqueue({
        channel:      channel,
        data:         data,
        clientId:     this._clientId
      });
      
      this.addTimeout('publish', this.MAX_DELAY, this._flush, this);
      
    }, this);
  },
  
  handleAdvice: function(advice) {
    Faye.extend(this._advice, advice);
    if (this._advice.reconnect === this.HANDSHAKE) this._clientId = null;
  },
  
  deliverMessages: function(messages) {
    Faye.each(messages, function(message) {
      this.info('Client ' + this._clientId + ' calling listeners for ' +
                message.channel + ' with ' + Faye.toJSON(message.data));
      
      var channels = this._channels.glob(message.channel);
      Faye.each(channels, function(callback) {
        if (!callback) return;
        callback[0].call(callback[1], message.data);
      });
    }, this);
  },
  
  _beginReconnectTimeout: function() {
    this.addTimeout('reconnect', this._timeout, function() {
      delete this._connectionId;
      delete this._clientId;
      this._state = this.UNCONNECTED;
      
      this.info('Server took >' + this._timeout + 's to reply to connection for ' +
                this._clientId + ': attempting to reconnect');
      
      this.subscribe(this._channels.getKeys());
    }, this);
  },
  
  _enqueue: function(message) {
    this._outbox.push(message);
  },
  
  _flush: function() {
    this._transport.send(this._outbox);
    this._outbox = [];
  },
  
  _validateChannels: function(channels) {
    Faye.each(channels, function(channel) {
      if (!Faye.Channel.isValid(channel))
        throw '"' + channel + '" is not a valid channel name';
      if (!Faye.Channel.isSubscribable(channel))
        throw 'Clients may not subscribe to channel "' + channel + '"';
    });
  },
  
  _verifyClientId: function(callback) {
    var self = this;
    return function(response) {
      if (response.clientId !== self._clientId) return false;
      callback.call(self, response);
      return true;
    };
  }
});

Faye.extend(Faye.Client.prototype, Faye.Deferrable);
Faye.extend(Faye.Client.prototype, Faye.Timeouts);
Faye.extend(Faye.Client.prototype, Faye.Logging);

