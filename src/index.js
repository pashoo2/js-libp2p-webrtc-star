'use strict'

const debug = require('debug')
const log = debug('libp2p:webrtc-star')
const multiaddr = require('multiaddr')
const mafmt = require('mafmt')
const io = require('socket.io-client')
const EE = require('events').EventEmitter
const SimplePeer = require('simple-peer')
const PeerId = require('peer-id')
const PeerInfo = require('peer-info')
const Connection = require('interface-connection').Connection
const toPull = require('stream-to-pull-stream')
const once = require('once')
const setImmediate = require('async/setImmediate')
const webrtcSupport = require('webrtcsupport')
const utils = require('./utils')
const {cleanUrlSIO, cleanMultiaddr} = utils
const crypto = require('libp2p-crypto')

const noop = once(() => {})

const sioOptions = {
  transports: ['websocket'],
  'force new connection': true
}

class WebRTCStar {
  constructor (options) {
    options = options || {}

    this.maSelf = undefined

    this.sioOptions = {
      transports: ['websocket'],
      'force new connection': true
    }

    if (options.wrtc) {
      this.wrtc = options.wrtc
    }

    if (options.id) {
      this.id = options.id
      this.canCrypto = true
    }

    this.flag = options.allowJoinWithDisabledChallenge // let's just refer to it as "flag"

    this.discovery = new EE()
    this.discovery.start = (callback) => { setImmediate(callback) }
    this.discovery.stop = (callback) => { setImmediate(callback) }

    this.listenersRefs = {}
    this._peerDiscovered = this._peerDiscovered.bind(this)
  }

  dial (ma, options, callback) {
    if (typeof options === 'function') {
      callback = options
      options = {}
    }

    callback = callback ? once(callback) : noop

    const intentId = (~~(Math.random() * 1e9)).toString(36) + Date.now()

    const sioClient = this
      .listenersRefs[Object.keys(this.listenersRefs)[0]].io

    const spOptions = { initiator: true, trickle: false }

    // Use custom WebRTC implementation
    if (this.wrtc) { spOptions.wrtc = this.wrtc }

    const channel = new SimplePeer(spOptions)

    const conn = new Connection(toPull.duplex(channel))
    let connected = false

    channel.on('signal', (signal) => {
      sioClient.emit('ss-handshake', {
        intentId: intentId,
        srcMultiaddr: this.maSelf.toString(),
        dstMultiaddr: ma.toString(),
        signal: signal
      })
    })

    channel.once('timeout', () => callback(new Error('timeout')))

    channel.once('error', (err) => {
      if (!connected) { callback(err) }
    })

    // NOTE: aegir segfaults if we do .once on the socket.io event emitter and we
    // are clueless as to why.
    sioClient.on('ws-handshake', (offer) => {
      if (offer.intentId === intentId && offer.err) {
        return callback(new Error(offer.err))
      }

      if (offer.intentId !== intentId || !offer.answer) {
        return
      }

      channel.once('connect', () => {
        connected = true
        conn.destroy = channel.destroy.bind(channel)

        channel.once('close', () => conn.destroy())

        conn.getObservedAddrs = (callback) => callback(null, [ma])

        callback(null, conn)
      })

      channel.signal(offer.signal)
    })

    return conn
  }

  createListener (options, handler) {
    if (typeof options === 'function') {
      handler = options
      options = {}
    }

    const listener = new EE()

    listener.listen = (ma, callback) => {
      callback = callback ? once(callback) : noop

      if (!webrtcSupport.support && !this.wrtc) {
        return setImmediate(() => callback(new Error('no WebRTC support')))
      }

      this.maSelf = ma

      const sioUrl = cleanUrlSIO(ma)

      log('Dialing to Signalling Server on: ' + sioUrl)

      listener.io = io.connect(sioUrl, sioOptions)

      listener.io.once('connect_error', callback)
      listener.io.once('error', (err) => {
        listener.emit('error', err)
        listener.emit('close')
      })

      listener.io.on('ws-handshake', incommingDial)
      listener.io.on('ws-peer', this._peerDiscovered)

      const pubKeyStr = this.canCrypto ? crypto.keys.marshalPublicKey(this.id.pubKey).toString('hex') : ''

      const maStr = ma.toString()

      listener.io.on('connect', () => {
        listener.io.emit('ss-join', maStr, pubKeyStr, (err, sig) => {
          if (err) { return callback(err) }

          if (sig) {
            if (!this.canCrypto) {
              return callback(new Error("Can't sign cryptoChallenge: No id provided"))
            }

            log('performing cryptoChallenge')

            this.id.privKey.sign(Buffer.from(sig), (err, signature) => {
              if (err) {
                return callback(err)
              }
              this.signature = signature.toString('hex')
              log('do join')
              listener.io.emit('ss-join', this.ma.toString(), this.signature, err => {
                if (err) {
                  return callback(err)
                }

                listener.emit('listening')
                callback()
              })
            })
          } else {
            /* if (!this.flag) {
              return callback(new Error('Tried to listen on a server with crypto challenge disabled!\n    This is prohibited by default and can lead to security issues!\n    Please set "allowJoinWithDisabledChallenge" to true in the constructor options (but only if you know what you are doing)!'))
            } */
            log('do join')
            listener.emit('listening')
            this.signature = '_'
            callback()
          }
        })
      })
      const self = this
      function incommingDial (offer) {
        if (offer.answer || offer.err) {
          return
        }

        const spOptions = { trickle: false }

        // Use custom WebRTC implementation
        if (self.wrtc) { spOptions.wrtc = self.wrtc }

        const channel = new SimplePeer(spOptions)

        const conn = new Connection(toPull.duplex(channel))

        channel.once('connect', () => {
          conn.getObservedAddrs = (callback) => {
            return callback(null, [offer.srcMultiaddr])
          }

          listener.emit('connection', conn)
          handler(conn)
        })

        channel.once('signal', (signal) => {
          offer.signal = signal
          offer.answer = true
          listener.io.emit('ss-handshake', offer)
        })

        channel.signal(offer.signal)
      }
    }

    listener.close = (callback) => {
      callback = callback ? once(callback) : noop

      listener.io.emit('ss-leave')

      setImmediate(() => {
        listener.emit('close')
        callback()
      })
    }

    listener.getAddrs = (callback) => {
      setImmediate(() => callback(null, [this.maSelf]))
    }

    this.listenersRefs[multiaddr.toString()] = listener
    return listener
  }

  filter (multiaddrs) {
    if (!Array.isArray(multiaddrs)) {
      multiaddrs = [multiaddrs]
    }

    return multiaddrs.filter((ma) => {
      if (ma.protoNames().indexOf('p2p-circuit') > -1) {
        return false
      }

      return mafmt.WebRTCStar.matches(ma)
    })
  }

  _peerDiscovered (maStr) {
    log('Peer Discovered:', maStr)
    maStr = cleanMultiaddr(maStr)

    const split = maStr.split('/ipfs/')
    const peerIdStr = split[split.length - 1]
    const peerId = PeerId.createFromB58String(peerIdStr)
    const peerInfo = new PeerInfo(peerId)
    peerInfo.multiaddrs.add(multiaddr(maStr))
    this.discovery.emit('peer', peerInfo)
  }
}

module.exports = WebRTCStar
