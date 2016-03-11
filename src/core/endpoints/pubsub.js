/* @flow */

import Networking from '../components/networking';
import Config from '../components/config';
import Keychain from '../components/keychain';
import State from '../components/state';
import PublishQueue from '../components/publish_queue';

import PresenceEndpoints from './presence';

import Responders from './presenters/responders';

import utils from '../utils';
import constants from '../../../defaults.json';

type pubSubConstruct = {
  networking: Networking,
  state: State,
  keychain: Keychain,
  error: Function,
  config: Config,
  publishQueue: PublishQueue,
  presenceEndpoints: PresenceEndpoints,
};

export default class {
  _networking: Networking;
  _config: Config;
  _state: State;
  _keychain: Keychain;
  _presence: PresenceEndpoints;
  _error: Function;
  _publishQueue: PublishQueue;

  _subscribeIntervalId: number | null;

  constructor({ networking, config, keychain, presenceEndpoints, publishQueue, state, error }: pubSubConstruct) {
    this._networking = networking;
    this._config = config;
    this._keychain = keychain;
    this._state = state;
    this._error = error;
    this._presence = presenceEndpoints;
    this._publishQueue = publishQueue;
  }

  __publish(next: boolean) {
    if (NO_WAIT_FOR_PENDING) {
      if (!PUB_QUEUE.length) return;
    } else {
      if (next) PUB_QUEUE.sending = 0;
      if (PUB_QUEUE.sending || !PUB_QUEUE.length) return;
      PUB_QUEUE.sending = 1;
    }

    xdr(PUB_QUEUE.shift());
  }

  performPublish(args:Object, argCallback: Function) {
    var msg = args.message;
    if (!msg) return this._error('Missing Message');

    var callback = argCallback || args.callback || function () {};
    var channel = args.channel;
    var authKey = args.auth_key || this._keychain.getAuthKey();
    var cipher_key = args.cipher_key;
    var err = args.error || function () {};
    var post = args.post || false;
    var store = args.store_in_history || true;
    var params: Object = {
      uuid: this._keychain.getUUID(),
      auth: authKey,
    };

    if (!channel) return this._error('Missing Channel');
    if (!this._keychain.getPublishKey()) return this._error('Missing Publish Key');
    if (!this._keychain.getSubscribeKey()) return this._error('Missing Subscribe Key');

    if (msg['getPubnubMessage']) {
      msg = msg['getPubnubMessage']();
    }

    // If trying to send Object
    msg = JSON.stringify(encrypt(msg, cipher_key));

    if (!store) {
      params.store = '0';
    }

    if (this._config.isInstanceIdEnabled()) {
      params.instanceid = this._keychain.getInstanceId();
    }

    let publishItem = this._publishQueue.createQueueable();
    publishItem.channel = channel;
    publishItem.params = params;
    publishItem.httpMethod = (post) ? 'POST' : 'GET';
    publishItem.onFail = (response) => {
      Responders.error(response, err);
      this.__publish(true);
    };
    publishItem.onSuccess = (response) => {
      Responders.callback(response, callback, err);
      this.__publish(true);
    };

    // Queue Message Send
    this._publishQueue.queuePublishItem(publishItem);

    // Send Message
    this.__publish(false);
  }

  subscribe(args: Object, subscribeCallback: Function, presenceCallback: Function) {
    let channel = args.channel;
    let channelGroup = args.channel_group;
    let timetoken = args.timetoken || 0;
    let cipherKey = args.cipher_key;

    let sub_timeout = args.timeout || SUB_TIMEOUT;
    let windowing = args.windowing || SUB_WINDOWING;

    // Make sure we have a Channel
    if (!channel && !channelGroup) {
      return this._error('Missing Channel');
    }

    if (!subscribeCallback) {
      return this._error('Missing Callback');
    }
    if (!this._keychain.getSubscribeKey()) {
      return this._error('Missing Subscribe Key');
    }

    // Setup Channel(s)
    if (channel) {
      let channelList = (channel.join ? channel.join(',') : '' + channel).split(',');
      utils.each(channelList, (channel) => {
        this.__subscribeToChannel(channel, cipherKey, subscribeCallback, presenceCallback);
      });
    }

    // Setup Channel Groups
    if (channelGroup) {
      let ChannelGroupList = (channelGroup.join ? channelGroup.join(',') : '' + channelGroup).split(',');
      utils.each(ChannelGroupList, (channelGroup) => {
        this.__subscribeToChannelGroup(channelGroup, cipherKey, subscribeCallback, presenceCallback);
      });
    }
  }

  __restartSubscribeLoop() {
    let channels = this._state.generate_channel_list().join(',');
    let channel_groups = stateStorage.generate_channel_group_list().join(',');

    // Stop Connection
    if (!channels && !channel_groups) return;

    if (!channels) channels = ',';

    // Connect to PubNub Subscribe Servers
    _reset_offline();

    let data = networking.prepareParams({ uuid: keychain.getUUID(), auth: keychain.getAuthKey() });

    if (channel_groups) {
      data['channel-group'] = channel_groups;
    }


    let st = JSON.stringify(stateStorage.getPresenceState());
    if (st.length > 2) data['state'] = JSON.stringify(stateStorage.getPresenceState());

    if (config.getPresenceTimeout()) {
      data['heartbeat'] = config.getPresenceTimeout();
    }

    if (config.isInstanceIdEnabled()) {
      data['instanceid'] = keychain.getInstanceId();
    }

    SUB_RECEIVER = xdr({
      timeout: sub_timeout,
      fail: function (response) {
        if (response && response['error'] && response['service']) {
          Responders.error(response, SUB_ERROR);
          _test_connection(false);
        } else {
          SELF['time'](function (success) {
            !success && (Responders.error(response, SUB_ERROR));
            _test_connection(success);
          });
        }
      },
      data: networking.prepareParams(data),
      url: [
        networking.getSubscribeOrigin(), 'subscribe',
        keychain.getSubscribeKey(), utils.encode(channels),
        0, TIMETOKEN
      ],
      success: function (messages) {
        // Check for Errors
        if (!messages || (typeof messages == 'object' && 'error' in messages && messages['error'])) {
          SUB_ERROR(messages);
          return utils.timeout(CONNECT, constants.SECOND);
        }

        // Restore Previous Connection Point if Needed
        TIMETOKEN = !TIMETOKEN && SUB_RESTORE && db['get'](keychain.getSubscribeKey()) || messages[1];

        /*
         // Connect
         each_channel_registry(function(registry){
         if (registry.connected) return;
         registry.connected = 1;
         registry.connect(channel.name);
         });
         */

        // Route Channel <---> Callback for Message
        /*
        var next_callback = (function () {
          var channels = '';
          var channels2 = '';

          if (messages.length > 3) {
            channels = messages[3];
            channels2 = messages[2];
          } else if (messages.length > 2) {
            channels = messages[2];
          } else {
            channels = utils.map(
              this._state.getChannels(), function (chan) {
                return utils.map(
                  Array(messages[0].length)
                    .join(',').split(','),
                  function () {
                    return chan;
                  }
                );
              }).join(',');
          }

          var list = channels.split(',');
          var list2 = (channels2) ? channels2.split(',') : [];

          return function () {
            var channel = list.shift() || SUB_CHANNEL;
            var channel2 = list2.shift();

            var chobj = {};

            if (channel2) {
              if (channel && channel.indexOf('-pnpres') >= 0
                && channel2.indexOf('-pnpres') < 0) {
                channel2 += '-pnpres';
              }
              chobj = stateStorage.getChannelGroup(channel2) || stateStorage.getChannel(channel2) || { callback: function () {} };
            } else {
              chobj = stateStorage.getChannel(channel);
            }

            var r = [
              chobj
                .callback || SUB_CALLBACK,
              channel.split(constants.PRESENCE_SUFFIX)[0],
            ];
            channel2 && r.push(channel2.split(constants.PRESENCE_SUFFIX)[0]);
            return r;
          };
        })();
        */

        let latency = utils.detect_latency(+messages[1]);
        utils.each(messages[0], function (msg) {
          var next = next_callback();
          var decrypted_msg = decrypt(msg,
            (stateStorage.getChannel(next[1])) ? stateStorage.getChannel(next[1])['cipher_key'] : null);
          next[0] && next[0](decrypted_msg, messages, next[2] || next[1], latency, next[1]);
        });

        utils.timeout(_connect, windowing);
      },
    });
  }

  __subscribeToChannel(channelName: string, cipherKey: string, subscribeCallback: Function, presenceCallback: Function) {
    this._state.addChannel(channelName, {
      name: channelName,
      subscribed: 1,
      callback: subscribeCallback,
      cipher_key: cipherKey,
    });

    // Presence Enabled?
    if (!presenceCallback) {
      return;
    }

    this._state.addChannel(channelName, {
      name: channelName + constants.PRESENCE_SUFFIX,
      subscribed: 1,
      callback: presenceCallback,
    });
  }

  __subscribeToChannelGroup(channelGroupName: string, cipherKey: string, subscribeCallback: Function, presenceCallback: Function) {
    this._state.addChannelGroup(channelGroupName, {
      name: channelGroupName,
      subscribed: 1,
      callback: subscribeCallback,
      cipher_key: cipherKey,
    });

    // Presence Enabled?
    if (!presenceCallback) {
      return;
    }

    this._state.addChannel(channelGroupName, {
      name: channelGroupName + constants.PRESENCE_SUFFIX,
      subscribed: 1,
      callback: presenceCallback,
    });
  }

  performUnsubscribe(args: Object, argCallback: Function) {
    var channelArg = args['channel'];
    var channelGroupArg = args['channel_group'];
    var authKey = args.auth_key || this._keychain.getAuthKey();
    var callback = argCallback || args.callback || function () {};
    var err = args.error || function () {};

    if (!channelArg && !channelGroupArg) {
      return this._error('Missing Channel or Channel Group');
    }

    if (!this._keychain.getSubscribeKey()) {
      return this._error('Missing Subscribe Key');
    }

    if (channelArg) {
      var channels = utils.isArray(channelArg) ? channelArg : ('' + channelArg).split(',');
      var existingChannels = [];
      var presenceChannels = [];

      utils.each(channels, function (channel) {
        if (this._state.getChannel(channel)) {
          existingChannels.push(channel);
        }
      });

      // if we do not have any channels to unsubscribe from, trigger a callback.
      if (existingChannels.length === 0) {
        callback({ action: 'leave' });
        return;
      }

      // Prepare presence channels
      utils.each(existingChannels, function (channel) {
        presenceChannels.push(channel + constants.PRESENCE_SUFFIX);
      });

      utils.each(existingChannels.concat(presenceChannels), function (channel) {
        if (this._state.containsChannel(channel)) {
          this._state.removeChannel(channel);
        }

        if (this._state.isInPresenceState(channel)) {
          this._state.removeFromPresenceState(channel);
        }
      });

      this._presence.announceChannelLeave(existingChannels.join(','), authKey, callback, err);
    }

    if (channelGroupArg) {
      var channelGroups = utils.isArray(channelGroupArg) ? channelGroupArg : ('' + channelGroupArg).split(',');
      var existingChannelGroups = [];
      var presenceChannelGroups = [];

      utils.each(channelGroups, function (channelGroup) {
        if (this._state.getChannelGroup(channelGroup)) {
          existingChannelGroups.push(channelGroup);
        }
      });

      // if we do not have any channel groups to unsubscribe from, trigger a callback.
      if (existingChannelGroups.length === 0) {
        callback({ action: 'leave' });
        return;
      }

      // Prepare presence channels
      utils.each(existingChannelGroups, function (channelGroup) {
        presenceChannelGroups.push(channelGroup + constants.PRESENCE_SUFFIX);
      });

      utils.each(existingChannelGroups.concat(presenceChannelGroups), function (channelGroup) {
        if (this._state.containsChannelGroup(channelGroup)) {
          this._state.removeChannelGroup(channelGroup);
        }
        if (this._state.isInPresenceState(channelGroup)) {
          this._state.removeFromPresenceState(channelGroup);
        }
      });

      this._presence.announceChannelGroupLeave(existingChannelGroups.join(','), authKey, callback, err);
    }
  }

}