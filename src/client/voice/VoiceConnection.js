'use strict';

const EventEmitter = require('events');
const { getCiphers } = require('node:crypto');
const { setTimeout } = require('node:timers');
const { Collection } = require('@discordjs/collection');
const VoiceUDP = require('./networking/VoiceUDPClient');
const VoiceWebSocket = require('./networking/VoiceWebSocket');
const MediaPlayer = require('./player/MediaPlayer');
const VoiceReceiver = require('./receiver/Receiver');
const { parseStreamKey } = require('./util/Function');
const PlayInterface = require('./util/PlayInterface');
const Silence = require('./util/Silence');
const { Error } = require('../../errors');
const { Opcodes, VoiceOpcodes, VoiceStatus, Events } = require('../../util/Constants');
const Speaking = require('../../util/Speaking');
const Util = require('../../util/Util');

// Workaround for Discord now requiring silence to be sent before being able to receive audio
class SingleSilence extends Silence {
  _read() {
    super._read();
    this.push(null);
  }
}

const SUPPORTED_MODES = ['aead_xchacha20_poly1305_rtpsize'];

// Just in case there's some system that doesn't come with aes-256-gcm, conditionally add it as supported
if (getCiphers().includes('aes-256-gcm')) {
  SUPPORTED_MODES.unshift('aead_aes256_gcm_rtpsize');
}

const SUPPORTED_CODECS = ['VP8', 'H264'];

/**
 * Represents a connection to a guild's voice server.
 * ```js
 * // Obtained using:
 * client.voice.joinChannel(channel)
 *   .then(connection => {
 *
 *   });
 * ```
 * @extends {EventEmitter}
 * @implements {PlayInterface}
 */
class VoiceConnection extends EventEmitter {
  constructor(voiceManager, channel) {
    super();

    /**
     * The voice manager that instantiated this connection
     * @type {ClientVoiceManager}
     */
    this.voiceManager = voiceManager;

    /**
     * The voice channel this connection is currently serving
     * @type {VoiceChannel}
     */
    this.channel = channel;

    /**
     * The current status of the voice connection
     * @type {VoiceStatus}
     */
    this.status = VoiceStatus.AUTHENTICATING;

    /**
     * Our current speaking state
     * @type {Readonly<Speaking>}
     */
    this.speaking = new Speaking().freeze();

    /**
     * Our current video state
     * @type {boolean | null}
     */
    this.videoStatus = null;

    /**
     * The authentication data needed to connect to the voice server
     * @type {Object}
     * @private
     */
    this.authentication = {};

    /**
     * The active DAVE (E2EE) session, if DAVE is negotiated.
     * @type {?object}
     * @private
     */
    this.daveSession = null;

    /**
     * The negotiated DAVE protocol version (0 = transport-only, 1 = E2EE).
     * @type {number}
     */
    this.daveProtocolVersion = 0;

    /**
     * Pending DAVE transitions: Map<transitionId, protocolVersion>
     * @type {Map<number, number>}
     * @private
     */
    this._davePendingTransitions = new Map();

    /**
     * @deprecated use _davePendingTransitions
     * @type {?number}
     * @private
     */
    this._davePendingTransitionId = null;

    /**
     * The audio player for this voice connection
     * @type {MediaPlayer}
     */
    this.player = new MediaPlayer(this, this.constructor.name === 'StreamConnection');

    this.player.on('debug', m => {
      /**
       * Debug info from the connection.
       * @event VoiceConnection#debug
       * @param {string} message The debug message
       */
      this.emit('debug', `media player - ${m}`);
    });

    this.player.on('error', e => {
      /**
       * Warning info from the connection.
       * @event VoiceConnection#warn
       * @param {string|Error} warning The warning
       */
      this.emit('warn', e);
    });

    this.once('closing', () => this.player.destroy());

    /**
     * Map SSRC values to user IDs
     * @type {Map<number, { userId: Snowflake, speaking: boolean, hasVideo: boolean }>}
     * @private
     */
    this.ssrcMap = new Map();

    /**
     * Tracks which users are talking
     * @type {Map<Snowflake, Readonly<Speaking>>}
     * @private
     */
    this._speaking = new Map();

    /**
     * Object that wraps contains the `ws` and `udp` sockets of this voice connection
     * @type {Object}
     * @private
     */
    this.sockets = {};

    /**
     * The voice receiver of this connection
     * @type {VoiceReceiver}
     */
    this.receiver = new VoiceReceiver(this);

    /**
     * Video codec
     * * `VP8`
     * * `VP9` (Not supported for encoding & decoding)
     * * `H264`
     * * `H265` (Not supported for encoding & decoding)
     * * `AV1` (Not supported for encoding & decoding)
     * @typedef {string} VideoCodec
     */

    /**
     * Video codec (encoded) of this connection
     * @type {VideoCodec}
     */
    this.videoCodec = 'H264';

    /**
     * Create a stream connection ?
     * @type {?StreamConnection}
     */
    this.streamConnection = null;

    /**
     * All stream watch connection
     * @type {Collection<Snowflake, StreamConnectionReadonly>}
     */
    this.streamWatchConnection = new Collection();
  }

  /**
   * The client that instantiated this connection
   * @type {Client}
   * @readonly
   */
  get client() {
    return this.voiceManager.client;
  }

  /**
   * The current audio dispatcher (if any)
   * @type {?AudioDispatcher}
   * @readonly
   */
  get dispatcher() {
    return this.player.dispatcher;
  }

  /**
   * The current video dispatcher (if any)
   * @type {?VideoDispatcher}
   * @readonly
   */
  get videoDispatcher() {
    return this.player.videoDispatcher;
  }

  /**
   * Sets whether the voice connection should display as "speaking", "soundshare" or "none".
   * @param {BitFieldResolvable} value The new speaking state
   */
  setSpeaking(value) {
    if (this.speaking.equals(value)) return;
    if (this.status !== VoiceStatus.CONNECTED) return;
    this.speaking = new Speaking(value).freeze();
    this.sockets.ws
      .sendPacket({
        op: VoiceOpcodes.SPEAKING,
        d: {
          speaking: this.speaking.bitfield,
          delay: 0,
          ssrc: this.authentication.ssrc,
        },
      })
      .catch(e => {
        this.emit('debug', e);
      });
  }

  /**
   * Set video codec before select protocol
   * @param {VideoCodec} value Codec
   * @returns {VoiceConnection}
   */
  setVideoCodec(value) {
    if (!SUPPORTED_CODECS.includes(value)) throw new Error('INVALID_VIDEO_CODEC', SUPPORTED_CODECS);
    this.videoCodec = value;
    return this;
  }

  /**
   * Sets video status
   * @param {boolean} value Video on or off
   */
  setVideoStatus(value) {
    if (value === this.videoStatus) return;
    if (this.status !== VoiceStatus.CONNECTED) return;
    this.videoStatus = value;
    if (!value) {
      this.sockets.ws
        .sendPacket({
          op: VoiceOpcodes.SOURCES,
          d: {
            audio_ssrc: this.authentication.ssrc,
            video_ssrc: 0,
            rtx_ssrc: 0,
            streams: [],
          },
        })
        .catch(e => {
          this.emit('debug', e);
        });
    } else {
      this.sockets.ws
        .sendPacket({
          op: VoiceOpcodes.SOURCES,
          d: {
            audio_ssrc: this.authentication.ssrc,
            video_ssrc: this.authentication.ssrc + 1,
            rtx_ssrc: this.authentication.ssrc + 2,
            streams: [
              {
                type: 'video',
                rid: '100',
                ssrc: this.authentication.ssrc + 1,
                active: true,
                quality: 100,
                rtx_ssrc: this.authentication.ssrc + 2,
                max_bitrate: 8000000,
                max_framerate: 60,
                max_resolution: {
                  type: 'source',
                  width: 0,
                  height: 0,
                },
              },
            ],
          },
        })
        .catch(e => {
          this.emit('debug', e);
        });
    }
  }

  /**
   * The voice state of this connection
   * @type {?VoiceState}
   */
  get voice() {
    return this.client.user.voice;
  }

  /**
   * Sends a request to the main gateway to join a voice channel.
   * @param {Object} [options] The options to provide
   * @returns {Promise<Shard>}
   * @private
   */
  sendVoiceStateUpdate(options = {}) {
    const isDM = ['DM', 'GROUP_DM'].includes(this.channel.type);
    options = Util.mergeDefault(
      {
        guild_id: this.channel.guild?.id || null,
        channel_id: this.channel.id,
        self_mute: this.voice ? this.voice.selfMute : false,
        self_deaf: this.voice ? this.voice.selfDeaf : false,
        self_video: this.voice ? this.voice.selfVideo : false,
        // flags: 2 marks the session as an embedded activity — wrong for plain
        // audio/video calls and causes the voice session to be invalidated (4006).
        flags: isDM ? 0 : 2,
      },
      options,
    );

    this.emit('debug', `Sending voice state update: ${JSON.stringify(options)}`);

    return this.channel.client.ws.broadcast({
      op: Opcodes.VOICE_STATE_UPDATE,
      d: options,
    });
  }

  /**
   * Set the token and endpoint required to connect to the voice servers.
   * @param {string} token The voice token
   * @param {string} endpoint The voice endpoint
   * @returns {void}
   * @private
   */
  setTokenAndEndpoint(token, endpoint) {
    this.emit('debug', `Token "${token}" and endpoint "${endpoint}"`);
    if (!endpoint) {
      // Signifies awaiting endpoint stage
      return;
    }

    if (!token) {
      this.authenticateFailed('VOICE_TOKEN_ABSENT');
      return;
    }

    endpoint = endpoint.replace(/\/$/, '');
    this.emit('debug', `Endpoint resolved as ${endpoint}`);

    if (!endpoint) {
      this.authenticateFailed('VOICE_INVALID_ENDPOINT');
      return;
    }

    if (this.status === VoiceStatus.AUTHENTICATING) {
      this.authentication.token = token;
      this.authentication.endpoint = endpoint;
      this.checkAuthenticated();
    } else if (token !== this.authentication.token || endpoint !== this.authentication.endpoint) {
      this.reconnect(token, endpoint);
    }
  }

  /**
   * Sets the Session ID for the connection.
   * @param {string} sessionId The voice session ID
   * @private
   */
  setSessionId(sessionId) {
    this.emit('debug', `Setting sessionId ${sessionId} (stored as "${this.authentication.sessionId}")`);
    if (!sessionId) {
      this.authenticateFailed('VOICE_SESSION_ABSENT');
      return;
    }

    if (this.status === VoiceStatus.AUTHENTICATING) {
      this.authentication.sessionId = sessionId;
      this.checkAuthenticated();
    } else if (sessionId !== this.authentication.sessionId) {
      this.authentication.sessionId = sessionId;
      /**
       * Emitted when a new session ID is received.
       * @event VoiceConnection#newSession
       * @private
       */
      this.emit('newSession', sessionId);
    }
  }

  /**
   * Checks whether the voice connection is authenticated.
   * @private
   */
  checkAuthenticated() {
    const { token, endpoint, sessionId } = this.authentication;
    this.emit('debug', `Authenticated with sessionId ${sessionId}`);
    if (token && endpoint && sessionId) {
      this.status = VoiceStatus.CONNECTING;
      // Snapshot credentials now — subsequent VOICE_STATE_UPDATEs must not
      // overwrite authentication.sessionId while the WS is mid-handshake.
      this._identifySnapshot = { token, endpoint, sessionId };
      /**
       * Emitted when we successfully initiate a voice connection.
       * @event VoiceConnection#authenticated
       */
      this.emit('authenticated');
      this.connect();
    }
  }

  /**
   * Invoked when we fail to initiate a voice connection.
   * @param {string} reason The reason for failure
   * @private
   */
  authenticateFailed(reason) {
    clearTimeout(this.connectTimeout);
    this.emit('debug', `Authenticate failed - ${reason}`);
    if (this.status === VoiceStatus.AUTHENTICATING) {
      /**
       * Emitted when we fail to initiate a voice connection.
       * @event VoiceConnection#failed
       * @param {Error} error The encountered error
       */
      this.emit('failed', new Error(reason));
    } else {
      /**
       * Emitted whenever the connection encounters an error.
       * @event VoiceConnection#error
       * @param {Error} error The encountered error
       */
      this.emit('error', new Error(reason));
    }
    this.status = VoiceStatus.DISCONNECTED;
  }

  /**
   * Move to a different voice channel in the same guild.
   * @param {VoiceChannel} channel The channel to move to
   * @private
   */
  updateChannel(channel) {
    this.channel = channel;
    this.sendVoiceStateUpdate();
  }

  /**
   * Attempts to authenticate to the voice server.
   * @param {Object} options Join config
   * @private
   */
  authenticate(options = {}) {
    this.sendVoiceStateUpdate(options);
    this.connectTimeout = setTimeout(() => this.authenticateFailed('VOICE_CONNECTION_TIMEOUT'), 15_000).unref();
  }

  /**
   * Attempts to reconnect to the voice server (typically after a region change).
   * @param {string} token The voice token
   * @param {string} endpoint The voice endpoint
   * @private
   */
  reconnect(token, endpoint) {
    this.authentication.token = token;
    this.authentication.endpoint = endpoint;
    this.speaking = new Speaking().freeze();
    this.status = VoiceStatus.RECONNECTING;
    this.emit('debug', `Reconnecting to ${endpoint}`);
    /**
     * Emitted when the voice connection is reconnecting (typically after a region change).
     * @event VoiceConnection#reconnecting
     */
    this.emit('reconnecting');
    this.connect();
  }

  /**
   * Disconnects the voice connection, causing a disconnect and closing event to be emitted.
   */
  disconnect() {
    this.emit('closing');
    this.emit('debug', 'disconnect() triggered');
    clearTimeout(this.connectTimeout);
    const conn = this.voiceManager.connection;
    if (conn === this) this.voiceManager.connection = null;
    this.sendVoiceStateUpdate({
      channel_id: null,
    });
    this._disconnect();
  }

  /**
   * Internally disconnects (doesn't send disconnect packet).
   * @private
   */
  _disconnect() {
    this.cleanup();
    this.status = VoiceStatus.DISCONNECTED;
    /**
     * Emitted when the voice connection disconnects.
     * @event VoiceConnection#disconnect
     */
    this.emit('disconnect');
  }

  /**
   * Cleans up after disconnect.
   * @private
   */
  cleanup() {
    this.player.destroy();
    this.speaking = new Speaking().freeze();
    const { ws, udp } = this.sockets;

    this.emit('debug', 'Connection clean up');

    if (ws) {
      ws.removeAllListeners('error');
      ws.removeAllListeners('ready');
      ws.removeAllListeners('sessionDescription');
      ws.removeAllListeners('speaking');
      ws.shutdown();
    }

    if (udp) udp.removeAllListeners('error');

    this.sockets.ws = null;
    this.sockets.udp = null;
  }

  /**
   * Connect the voice connection.
   * @private
   */
  connect() {
    this.emit('debug', `Connect triggered`);
    if (this.status !== VoiceStatus.RECONNECTING) {
      if (this.sockets.ws) throw new Error('WS_CONNECTION_EXISTS');
      if (this.sockets.udp) throw new Error('UDP_CONNECTION_EXISTS');
    }

    if (this.sockets.ws) this.sockets.ws.shutdown();
    if (this.sockets.udp) this.sockets.udp.shutdown();

    this.sockets.ws = new VoiceWebSocket(this);
    this.sockets.udp = new VoiceUDP(this);

    const { ws, udp } = this.sockets;

    ws.on('debug', msg => this.emit('debug', msg));
    udp.on('debug', msg => this.emit('debug', msg));
    ws.on('error', err => this.emit('error', err));
    udp.on('error', err => this.emit('error', err));
    ws.on('ready', this.onReady.bind(this));
    ws.on('sessionDescription', this.onSessionDescription.bind(this));
    ws.on('startSpeaking', this.onStartSpeaking.bind(this));
    ws.on('startStreaming', this.onStartStreaming.bind(this));

    // DAVE E2EE handlers — session is init'd in onSessionDescription after dave_protocol_version is known
    ws.on('davePrepareTransition', this._onDavePrepareTransition.bind(this));
    ws.on('davePrepareEpoch', this._onDavePrepareEpoch.bind(this));
    ws.on('daveExecuteTransition', this._onDaveExecuteTransition.bind(this));
    ws.on('daveMlsExternalSender', this._onDaveMlsExternalSender.bind(this));
    ws.on('daveMlsProposals', this._onDaveMlsProposals.bind(this));
    ws.on('daveMlsAnnounceCommitTransition', this._onDaveMlsAnnounceCommitTransition.bind(this));
    ws.on('daveMlsWelcome', this._onDaveMlsWelcome.bind(this));

    this.sockets.ws.connect();
  }

  // ─── DAVE E2EE ────────────────────────────────────────────────────────────

  /**
   * Creates or reinitialises the DAVE session for the given protocol version.
   * Called from onSessionDescription after dave_protocol_version is known.
   * @param {number} version
   * @private
   */
  _reinitDaveSession(version) {
    this.daveProtocolVersion = version;
    if (version > 0) {
      let DAVESession;
      try {
        ({ DAVESession } = require('@snazzah/davey'));
      } catch {
        this.emit('debug', '[DAVE] @snazzah/davey not found — audio will be inaudible');
        return;
      }
      const channelId = this.serverId || this.channel.guild?.id || this.channel.id;
      if (this.daveSession) {
        this.daveSession.reinit(version, this.client.user.id, channelId);
        this.emit('debug', `[DAVE] session reinitialized for protocol version ${version}`);
      } else {
        this.daveSession = new DAVESession(version, this.client.user.id, channelId);
        this.emit('debug', `[DAVE] session initialized for protocol version ${version}`);
      }
      // Send key package immediately after init, per USAGE.md
      const keyPackage = Buffer.from(this.daveSession.getSerializedKeyPackage());
      this.sockets.ws?.sendBinaryPacket(VoiceOpcodes.DAVE_MLS_KEY_PACKAGE, keyPackage)
        .catch(e => this.emit('debug', `[DAVE] key_package send failed: ${e}`));
    } else {
      // Downgraded to transport-only
      if (this.daveSession) {
        this.daveSession.reset();
        this.daveSession.setPassthroughMode(true, 10);
        this.emit('debug', '[DAVE] session reset (transport-only)');
      }
    }
  }

  /** @private */
  _executePendingTransition(transitionId) {
    if (!this._davePendingTransitions.has(transitionId)) {
      this.emit('debug', `[DAVE] execute transition ${transitionId} not in pending set`);
      return;
    }
    const oldVersion = this.daveProtocolVersion;
    const newVersion = this._davePendingTransitions.get(transitionId);
    this.daveProtocolVersion = newVersion;
    if (oldVersion !== newVersion && newVersion === 0) {
      this.emit('debug', '[DAVE] protocol downgraded to transport-only');
    } else if (transitionId > 0 && oldVersion === 0 && newVersion > 0) {
      this.daveSession?.setPassthroughMode(true, 10);
      this.emit('debug', '[DAVE] protocol upgraded from transport-only');
    }
    this.emit('debug', `[DAVE] transition executed (v${oldVersion} → v${newVersion}, id: ${transitionId})`);
    this._davePendingTransitions.delete(transitionId);
  }

  /** op 21 – @private */
  _onDavePrepareTransition(d) {
    // d is a JSON packet (non-binary)
    const transitionId = d?.transition_id ?? 0;
    const protocolVersion = d?.protocol_version ?? 0;
    this.emit('debug', `[DAVE] prepare transition (id: ${transitionId}, v${protocolVersion})`);
    this._davePendingTransitions.set(transitionId, protocolVersion);
    if (transitionId === 0) {
      this._executePendingTransition(transitionId);
    } else {
      if (protocolVersion === 0) {
        this.daveSession?.setPassthroughMode(true, 120);
      }
      this.sockets.ws?.sendPacket({
        op: VoiceOpcodes.DAVE_TRANSITION_READY,
        d: { transition_id: transitionId },
      }).catch(e => this.emit('debug', `[DAVE] transition_ready send failed: ${e}`));
    }
  }

  /** op 22 – @private */
  _onDaveExecuteTransition(d) {
    const transitionId = d?.transition_id ?? 0;
    this.emit('debug', `[DAVE] execute transition (id: ${transitionId})`);
    this._executePendingTransition(transitionId);
  }

  /** op 24 – @private */
  _onDavePrepareEpoch(d) {
    this.emit('debug', `[DAVE] prepare epoch (epoch: ${d?.epoch}, v${d?.protocol_version})`);
    if (d?.epoch === 1) {
      this._reinitDaveSession(d?.protocol_version ?? 1);
    }
  }

  /** op 25 – @private */
  _onDaveMlsExternalSender(data) {
    if (!this.daveSession) return;
    try {
      this.daveSession.setExternalSender(Buffer.isBuffer(data) ? data : Buffer.from(data));
      this.emit('debug', '[DAVE] external sender set');
    } catch (e) {
      this.emit('debug', `[DAVE] external_sender error: ${e}`);
    }
  }

  /** op 27 – @private */
  _onDaveMlsProposals(data) {
    if (!this.daveSession) return;
    try {
      // Binary payload (after seq+op stripped by onMessage): [optype:u8][proposals...]
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const optype = buf.readUInt8(0);
      const raw = buf.slice(1);
      const recognizedUserIds = [...this.ssrcMap.values()].map(v => v.userId).filter(Boolean);
      const { commit, welcome } = this.daveSession.processProposals(optype, raw, recognizedUserIds);
      if (commit) {
        const out = welcome ? Buffer.concat([Buffer.from(commit), Buffer.from(welcome)]) : Buffer.from(commit);
        this.sockets.ws?.sendBinaryPacket(VoiceOpcodes.DAVE_MLS_COMMIT_WELCOME, out)
          .catch(e => this.emit('debug', `[DAVE] commit_welcome send failed: ${e}`));
      }
    } catch (e) {
      this.emit('debug', `[DAVE] proposals error: ${e}`);
    }
  }

  /** op 29 – @private */
  _onDaveMlsAnnounceCommitTransition(data) {
    if (!this.daveSession) return;
    // Binary payload: [transition_id:u16be][MLSMessage commit...]
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const transitionId = buf.length >= 2 ? buf.readUInt16BE(0) : 0;
    const commitBytes = buf.slice(2);
    try {
      this.daveSession.processCommit(commitBytes);
      this.emit('debug', `[DAVE] commit processed (transition id: ${transitionId})`);
      if (transitionId !== 0) {
        this._davePendingTransitions.set(transitionId, this.daveProtocolVersion);
        this.sockets.ws?.sendPacket({
          op: VoiceOpcodes.DAVE_TRANSITION_READY,
          d: { transition_id: transitionId },
        }).catch(e => this.emit('debug', `[DAVE] transition_ready send failed: ${e}`));
      }
    } catch (e) {
      this.emit('debug', `[DAVE] commit error: ${e}`);
      this._recoverFromInvalidCommit(transitionId);
    }
  }

  /** op 30 – @private */
  _onDaveMlsWelcome(data) {
    if (!this.daveSession) return;
    // Binary payload: [transition_id:u16be][Welcome message...]
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const transitionId = buf.length >= 2 ? buf.readUInt16BE(0) : 0;
    const welcomeBytes = buf.slice(2);
    try {
      this.daveSession.processWelcome(welcomeBytes);
      this.emit('debug', `[DAVE] welcome processed (transition id: ${transitionId})`);
      if (transitionId !== 0) {
        this._davePendingTransitions.set(transitionId, this.daveProtocolVersion);
        this.sockets.ws?.sendPacket({
          op: VoiceOpcodes.DAVE_TRANSITION_READY,
          d: { transition_id: transitionId },
        }).catch(e => this.emit('debug', `[DAVE] transition_ready send failed: ${e}`));
      }
    } catch (e) {
      this.emit('debug', `[DAVE] welcome error: ${e}`);
      this._recoverFromInvalidCommit(transitionId);
    }
  }

  /** @private */
  _recoverFromInvalidCommit(transitionId) {
    this.sockets.ws?.sendPacket({
      op: VoiceOpcodes.DAVE_MLS_INVALID_COMMIT_WELCOME,
      d: { transition_id: transitionId },
    }).catch(() => {});
    const channelId = this.serverId || this.channel.guild?.id || this.channel.id;
    this._reinitDaveSession(this.daveProtocolVersion);
  }

  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Invoked when the voice websocket is ready.
   * @param {Object} data The received data
   * @private
   */
  onReady(data) {
    Object.assign(this.authentication, data);
    for (let mode of data.modes) {
      if (SUPPORTED_MODES.includes(mode)) {
        this.authentication.mode = mode;
        this.emit('debug', `Selecting the ${mode} mode`);
        break;
      }
    }
    this.sockets.udp.createUDPSocket(data.ip);
  }

  /**
   * Invoked when a session description is received.
   * @param {Object} data The received data
   * @private
   */
  onSessionDescription(data) {
    Object.assign(this.authentication, data);
    this.status = VoiceStatus.CONNECTED;

    // Reinit DAVE session with the protocol version the voice server chose.
    // Per USAGE.md, this is the correct place to init/reinit and send the key package.
    const negotiatedVersion = data.dave_protocol_version ?? 0;
    this._reinitDaveSession(negotiatedVersion);
    const ready = () => {
      clearTimeout(this.connectTimeout);
      this.emit('debug', `Ready with authentication details: ${JSON.stringify(this.authentication)}`);
      /**
       * Emitted once the connection is ready, when a promise to join a voice channel resolves,
       * the connection will already be ready.
       * @event VoiceConnection#ready
       */
      this.emit('ready');
    };
    if (this.dispatcher || this.videoDispatcher) {
      ready();
    } else {
      // This serves to provide support for voice receive, sending audio is required to receive it.
      const dispatcher = this.playAudio(new SingleSilence(), { type: 'opus', volume: false });
      dispatcher.once('finish', ready);
    }
  }

  onStartSpeaking({ user_id, ssrc, speaking }) {
    this.ssrcMap.set(+ssrc, {
      ...(this.ssrcMap.get(+ssrc) || {}),
      userId: user_id,
      speaking: speaking,
    });
  }

  onStartStreaming({ video_ssrc, user_id, audio_ssrc }) {
    this.ssrcMap.set(+audio_ssrc, {
      ...(this.ssrcMap.get(+audio_ssrc) || {}),
      userId: user_id,
      hasVideo: Boolean(video_ssrc), // Maybe ?
    });
    /**
{
  video_ssrc: 0,
  user_id: 'uid',
  streams: [
    {
      ssrc: 27734,
      rtx_ssrc: 27735,
      rid: '100',
      quality: 100,
      max_resolution: { width: 0, type: 'source', height: 0 },,
      max_framerate: 60,
      active: false
    }
  ],
  audio_ssrc: 27733
}
     */
  }

  /**
   * Invoked when a speaking event is received.
   * @param {Object} data The received data
   * @private
   */
  onSpeaking({ user_id, speaking }) {
    speaking = new Speaking(speaking).freeze();
    const guild = this.channel.guild;
    const user = this.client.users.cache.get(user_id);
    const old = this._speaking.get(user_id) || new Speaking(0).freeze();
    this._speaking.set(user_id, speaking);
    /**
     * Emitted whenever a user changes speaking state.
     * @event VoiceConnection#speaking
     * @param {User} user The user that has changed speaking state
     * @param {Readonly<Speaking>} speaking The speaking state of the user
     */
    if (this.status === VoiceStatus.CONNECTED) {
      this.emit('speaking', user, speaking);
      if (!speaking.has(Speaking.FLAGS.SPEAKING)) {
        this.receiver.packets._stoppedSpeaking(user_id);
      }
    }

    if (guild && user && !speaking.equals(old)) {
      const member = guild.members.cache.get(user);
      if (member) {
        /**
         * Emitted once a guild member changes speaking state.
         * @event Client#guildMemberSpeaking
         * @param {GuildMember} member The member that started/stopped speaking
         * @param {Readonly<Speaking>} speaking The speaking state of the member
         */
        this.client.emit(Events.GUILD_MEMBER_SPEAKING, member, speaking);
      }
    }
  }

  playAudio() {} // eslint-disable-line no-empty-function
  playVideo() {} // eslint-disable-line no-empty-function

  /**
   * Create new connection to screenshare stream
   * @returns {Promise<StreamConnection>}
   */
  createStreamConnection() {
    // eslint-disable-next-line consistent-return
    return new Promise((resolve, reject) => {
      if (this.streamConnection) {
        return resolve(this.streamConnection);
      } else {
        const connection = (this.streamConnection = new StreamConnection(this.voiceManager, this.channel, this));
        connection.setVideoCodec(this.videoCodec); // Sync :?
        // Setup event...
        if (!this.eventHook) {
          this.eventHook = true; // Dont listen this event two times :/
          this.channel.client.on('raw', packet => {
            if (typeof packet !== 'object' || !packet.t || !packet.d || !packet.d?.stream_key) {
              return;
            }
            const { t: event, d: data } = packet;
            const StreamKey = parseStreamKey(data.stream_key);
            if (
              StreamKey.userId === this.channel.client.user.id &&
              this.channel.id == StreamKey.channelId &&
              this.streamConnection
            ) {
              // Current user stream
              switch (event) {
                case 'STREAM_CREATE': {
                  this.streamConnection.setSessionId(this.authentication.sessionId);
                  this.streamConnection.serverId = data.rtc_server_id;
                  break;
                }
                case 'STREAM_SERVER_UPDATE': {
                  this.streamConnection.setTokenAndEndpoint(data.token, data.endpoint);
                  break;
                }
                case 'STREAM_DELETE': {
                  this.streamConnection.disconnect();
                  break;
                }
                case 'STREAM_UPDATE': {
                  this.streamConnection.update(data);
                  break;
                }
              }
            }
            if (this.streamWatchConnection.has(StreamKey.userId) && this.channel.id == StreamKey.channelId) {
              const streamConnection = this.streamWatchConnection.get(StreamKey.userId);
              // Watch user stream
              switch (event) {
                case 'STREAM_CREATE': {
                  streamConnection.setSessionId(this.authentication.sessionId);
                  streamConnection.serverId = data.rtc_server_id;
                  break;
                }
                case 'STREAM_SERVER_UPDATE': {
                  streamConnection.setTokenAndEndpoint(data.token, data.endpoint);
                  break;
                }
                case 'STREAM_DELETE': {
                  streamConnection.disconnect();
                  streamConnection.receiver.packets.destroyAllStream();
                  break;
                }
                case 'STREAM_UPDATE': {
                  streamConnection.update(data);
                  break;
                }
              }
            }
          });
        }

        connection.sendSignalScreenshare();
        connection.sendScreenshareState(true);

        connection.on('debug', msg =>
          this.channel.client.emit(
            'debug',
            `[VOICE STREAM (${this.channel.guild?.id || this.channel.id}:${connection.status})]: ${msg}`,
          ),
        );
        connection.once('failed', reason => {
          this.streamConnection = null;
          reject(reason);
        });

        connection.on('error', reject);

        connection.once('authenticated', () => {
          connection.once('ready', () => {
            resolve(connection);
            connection.removeListener('error', reject);
          });
          connection.once('disconnect', () => {
            this.streamConnection = null;
          });
        });
      }
    });
  }

  /**
   * Watch user stream
   * @param {UserResolvable} user Discord user
   * @returns {Promise<StreamConnectionReadonly>}
   */
  async joinStreamConnection(user) {
    const userId = this.client.users.resolveId(user);
    // Check if user is streaming
    if (!userId) {
      throw new Error('VOICE_USER_MISSING');
    }
    const voiceState = this.channel.guild?.voiceStates.cache.get(userId) || this.client.voiceStates.cache.get(userId);
    if (!voiceState || !voiceState.streaming) {
      throw new Error('VOICE_USER_NOT_STREAMING');
    }
    // eslint-disable-next-line consistent-return
    return new Promise((resolve, reject) => {
      if (this.streamWatchConnection.has(userId)) {
        return resolve(this.streamWatchConnection.get(userId));
      } else {
        const connection = new StreamConnectionReadonly(this.voiceManager, this.channel, this, userId);
        this.streamWatchConnection.set(userId, connection);
        connection.setVideoCodec(this.videoCodec);
        // Setup event...
        if (!this.eventHook) {
          this.eventHook = true; // Dont listen this event two times :/
          this.channel.client.on('raw', packet => {
            if (typeof packet !== 'object' || !packet.t || !packet.d || !packet.d?.stream_key) {
              return;
            }
            const { t: event, d: data } = packet;
            const StreamKey = parseStreamKey(data.stream_key);
            if (
              StreamKey.userId === this.channel.client.user.id &&
              this.channel.id == StreamKey.channelId &&
              this.streamConnection
            ) {
              // Current user stream
              switch (event) {
                case 'STREAM_CREATE': {
                  this.streamConnection.setSessionId(this.authentication.sessionId);
                  this.streamConnection.serverId = data.rtc_server_id;
                  break;
                }
                case 'STREAM_SERVER_UPDATE': {
                  this.streamConnection.setTokenAndEndpoint(data.token, data.endpoint);
                  break;
                }
                case 'STREAM_DELETE': {
                  this.streamConnection.disconnect();
                  break;
                }
                case 'STREAM_UPDATE': {
                  this.streamConnection.update(data);
                  break;
                }
              }
            }
            if (this.streamWatchConnection.has(StreamKey.userId) && this.channel.id == StreamKey.channelId) {
              const streamConnection = this.streamWatchConnection.get(StreamKey.userId);
              // Watch user stream
              switch (event) {
                case 'STREAM_CREATE': {
                  streamConnection.setSessionId(this.authentication.sessionId);
                  streamConnection.serverId = data.rtc_server_id;
                  break;
                }
                case 'STREAM_SERVER_UPDATE': {
                  streamConnection.setTokenAndEndpoint(data.token, data.endpoint);
                  break;
                }
                case 'STREAM_DELETE': {
                  streamConnection.disconnect();
                  streamConnection.receiver.packets.destroyAllStream();
                  break;
                }
                case 'STREAM_UPDATE': {
                  streamConnection.update(data);
                  break;
                }
              }
            }
          });
        }

        connection.sendSignalScreenshare();

        connection.on('debug', msg =>
          this.channel.client.emit(
            'debug',
            `[VOICE STREAM WATCH (${userId}>${this.channel.guild?.id || this.channel.id}:${
              connection.status
            })]: ${msg}`,
          ),
        );
        connection.once('failed', reason => {
          this.streamWatchConnection.delete(userId);
          reject(reason);
        });

        connection.on('error', reject);

        connection.once('authenticated', () => {
          connection.once('ready', () => {
            resolve(connection);
            connection.removeListener('error', reject);
          });
          connection.once('disconnect', () => {
            this.streamWatchConnection.delete(userId);
          });
        });
      }
    });
  }

  /**
   * @event VoiceConnection#streamUpdate
   * @description Emitted when the StreamConnection or StreamConnectionReadonly
   * state changes, providing the previous and current stream state.
   *
   * @param {StreamState} oldData - The previous state of the stream.
   * @param {StreamState} newData - The current state of the stream.
   *
   * @typedef {Object} StreamState
   * @property {boolean} isPaused - Indicates whether the stream is currently paused.
   * @property {string|null} region - The region where the stream is hosted, or null if not specified.
   * @property {Snowflake[]} viewerIds - An array of Snowflake IDs representing the viewers connected to the stream.
   */
}

/**
 * Represents a connection to a guild's voice server.
 * ```js
 * // Obtained using:
 * client.voice.joinChannel(channel)
 *   .then(connection => connection.createStreamConnection())
 *    .then(connection => {
 *
 *   });
 * ```
 * @extends {VoiceConnection}
 */
class StreamConnection extends VoiceConnection {
  #requestDisconnect = false;
  /**
   * @param {ClientVoiceManager} voiceManager Voice manager
   * @param {Channel} channel any channel (joinable)
   * @param {VoiceConnection} voiceConnection parent
   */
  constructor(voiceManager, channel, voiceConnection) {
    super(voiceManager, channel);

    /**
     * Current voice connection
     * @type {VoiceConnection}
     */
    this.voiceConnection = voiceConnection;

    Object.defineProperty(this, 'voiceConnection', {
      value: voiceConnection,
      writable: false,
    });

    /**
     * Server Id
     * @type {string | null}
     */
    this.serverId = null;

    /**
     * Stream state
     * @type {boolean | null}
     */
    this.isPaused = null;

    /**
     * Viewer IDs
     * @type {Snowflake[]}
     */
    this.viewerIds = [];

    /**
     * Voice region name
     * @type {string | null}
     */
    this.region = null;
  }

  createStreamConnection() {
    return Promise.resolve(this);
  }

  joinStreamConnection() {
    throw new Error('STREAM_CANNOT_JOIN');
  }

  get streamConnection() {
    return this;
  }

  set streamConnection(value) {
    // Why ?
  }

  get streamWatchConnection() {
    return new Collection();
  }

  set streamWatchConnection(value) {
    // Why ?
  }

  disconnect() {
    if (this.#requestDisconnect) return;
    this.emit('closing');
    this.emit('debug', 'Stream: disconnect() triggered');
    clearTimeout(this.connectTimeout);
    if (this.voiceConnection.streamConnection === this) this.voiceConnection.streamConnection = null;
    this.sendStopScreenshare();
    this._disconnect();
  }

  /**
   * Create new stream connection (WS packet)
   * @returns {void}
   */
  sendSignalScreenshare() {
    const data = {
      type: ['DM', 'GROUP_DM'].includes(this.channel.type) ? 'call' : 'guild',
      guild_id: this.channel.guild?.id || null,
      channel_id: this.channel.id,
      preferred_region: null,
    };
    this.emit('debug', `Signal Stream: ${JSON.stringify(data)}`);
    return this.channel.client.ws.broadcast({
      op: Opcodes.STREAM_CREATE,
      d: data,
    });
  }

  /**
   * Send screenshare state... (WS)
   * @param {boolean} isPaused screenshare paused ?
   * @returns {void}
   */
  sendScreenshareState(isPaused = false) {
    if (isPaused == this.isPaused) return;
    this.emit(
      'streamUpdate',
      {
        isPaused: this.isPaused,
        region: this.region,
        viewerIds: this.viewerIds,
      },
      {
        isPaused,
        region: this.region,
        viewerIds: this.viewerIds,
      },
    );
    this.isPaused = isPaused;
    this.channel.client.ws.broadcast({
      op: Opcodes.STREAM_SET_PAUSED,
      d: {
        stream_key: this.streamKey,
        paused: isPaused,
      },
    });
  }

  /**
   * Stop screenshare, delete this connection (WS)
   * @returns {void}
   * @private Using StreamConnection#disconnect()
   */
  sendStopScreenshare() {
    this.#requestDisconnect = true;
    this.channel.client.ws.broadcast({
      op: Opcodes.STREAM_DELETE,
      d: {
        stream_key: this.streamKey,
      },
    });
  }

  update(data) {
    this.emit(
      'streamUpdate',
      {
        isPaused: this.isPaused,
        region: this.region,
        viewerIds: this.viewerIds.slice(),
      },
      {
        isPaused: data.paused,
        region: data.region,
        viewerIds: data.viewer_ids,
      },
    );
    this.viewerIds = data.viewer_ids;
    this.region = data.region;
  }

  /**
   * Current stream key
   * @type {string}
   */
  get streamKey() {
    return `${['DM', 'GROUP_DM'].includes(this.channel.type) ? 'call' : `guild:${this.channel.guild.id}`}:${
      this.channel.id
    }:${this.channel.client.user.id}`;
  }
}

/**
 * Represents a connection to a guild's voice server.
 * ```js
 * // Obtained using:
 * client.voice.joinChannel(channel)
 *   .then(connection => connection.createStreamConnection())
 *    .then(connection => {
 *
 *   });
 * ```
 * @extends {VoiceConnection}
 */
class StreamConnectionReadonly extends VoiceConnection {
  #requestDisconnect = false;
  /**
   * @param {ClientVoiceManager} voiceManager Voice manager
   * @param {Channel} channel any channel (joinable)
   * @param {VoiceConnection} voiceConnection parent
   * @param {Snowflake} userId User ID
   */
  constructor(voiceManager, channel, voiceConnection, userId) {
    super(voiceManager, channel);

    /**
     * Current voice connection
     * @type {VoiceConnection}
     */
    this.voiceConnection = voiceConnection;

    /**
     * User ID (who started the stream)
     * @type {Snowflake}
     */
    this.userId = userId;

    Object.defineProperty(this, 'voiceConnection', {
      value: voiceConnection,
      writable: false,
    });

    /**
     * Server Id
     * @type {string | null}
     */
    this.serverId = null;

    /**
     * Stream state
     * @type {boolean}
     */
    this.isPaused = false;

    /**
     * Viewer IDs
     * @type {Snowflake[]}
     */
    this.viewerIds = [];

    /**
     * Voice region name
     * @type {string | null}
     */
    this.region = null;
  }

  createStreamConnection() {
    throw new Error('STREAM_CONNECTION_READONLY');
  }

  joinStreamConnection() {
    return Promise.resolve(this);
  }

  get streamConnection() {
    return null;
  }

  set streamConnection(value) {
    // Why ?
  }

  get streamWatchConnection() {
    return new Collection();
  }

  set streamWatchConnection(value) {
    // Why ?
  }

  disconnect() {
    if (this.#requestDisconnect) return;
    this.emit('closing');
    this.emit('debug', 'Stream: disconnect() triggered');
    clearTimeout(this.connectTimeout);
    this.voiceConnection.streamWatchConnection.delete(this.userId);
    this.sendStopScreenshare();
    this._disconnect();
  }

  /**
   * Create new stream connection (WS packet)
   * @returns {void}
   */
  sendSignalScreenshare() {
    this.emit('debug', `Signal Stream Watch: ${this.streamKey}`);
    return this.channel.client.ws.broadcast({
      op: Opcodes.STREAM_WATCH,
      d: {
        stream_key: this.streamKey,
      },
    });
  }

  /**
   * Stop screenshare, delete this connection (WS)
   * @returns {void}
   * @private Using StreamConnection#disconnect()
   */
  sendStopScreenshare() {
    this.#requestDisconnect = true;
    this.channel.client.ws.broadcast({
      op: Opcodes.STREAM_DELETE,
      d: {
        stream_key: this.streamKey,
      },
    });
  }

  update(data) {
    this.emit(
      'streamUpdate',
      {
        isPaused: this.isPaused,
        region: this.region,
        viewerIds: this.viewerIds.slice(),
      },
      {
        isPaused: data.paused,
        region: data.region,
        viewerIds: data.viewer_ids,
      },
    );
    this.isPaused = data.paused;
    this.viewerIds = data.viewer_ids;
    this.region = data.region;
  }

  /**
   * Current stream key
   * @type {string}
   */
  get streamKey() {
    return `${['DM', 'GROUP_DM'].includes(this.channel.type) ? 'call' : `guild:${this.channel.guild.id}`}:${
      this.channel.id
    }:${this.userId}`;
  }
}

PlayInterface.applyToClass(VoiceConnection);
PlayInterface.applyToClass(StreamConnection);

module.exports = VoiceConnection;
