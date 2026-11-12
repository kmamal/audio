const { indexSizeError, notSupportedError, checkFinite, toUnsignedLong } = require('../errors')
const { queueTask, defineEventHandlers } = require('../events')
const { makeChannels, resizeChannels, zeroChannels } = require('../mixing')
const { decode } = require('../remote/decoder')
const { getFetch } = require('../config')
const { currentClient } = require('../remote/client')
const { forwarding, notify } = require('../remote/notify')
const { sharedFloat64, toShared } = require('../remote/shared')
const { MediaStream } = require('./stream')

const HAVE_NOTHING = 0
const HAVE_METADATA = 1
const HAVE_CURRENT_DATA = 2
const HAVE_FUTURE_DATA = 3
const HAVE_ENOUGH_DATA = 4

const NETWORK_EMPTY = 0
const NETWORK_IDLE = 1
const NETWORK_LOADING = 2
const NETWORK_NO_SOURCE = 3

const TIMEUPDATE_INTERVAL = 0.25

class MediaError {
	constructor (code, message) {
		this.code = code
		this.message = message
	}
}

MediaError.MEDIA_ERR_ABORTED = 1
MediaError.MEDIA_ERR_NETWORK = 2
MediaError.MEDIA_ERR_DECODE = 3
MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED = 4

const EVENTS = [
	'abort',
	'canplay',
	'canplaythrough',
	'durationchange',
	'emptied',
	'ended',
	'error',
	'loadeddata',
	'loadedmetadata',
	'loadstart',
	'pause',
	'play',
	'playing',
	'progress',
	'ratechange',
	'seeked',
	'seeking',
	'stalled',
	'suspend',
	'timeupdate',
	'volumechange',
	'waiting',
]

const checkRate = (value, name) => {
	const rate = checkFinite(value, name)
	if (rate < 0) { throw notSupportedError(`${name} must be non-negative`) }
	return rate
}

const timeRanges = (ranges) => {
	const check = (index) => {
		const i = toUnsignedLong(index)
		if (i >= ranges.length) { throw indexSizeError("index out of range") }
		return ranges[i]
	}
	return { length: ranges.length, start: (index) => check(index)[0], end: (index) => check(index)[1] }
}

const addRange = (ranges, start, end) => {
	if (!(end > start)) { return }
	const merged = []
	let [ lo, hi ] = [ start, end ]
	for (const [ a, b ] of ranges) {
		if (b < lo || a > hi) { merged.push([ a, b ]) }
		else {
			lo = Math.min(lo, a)
			hi = Math.max(hi, b)
		}
	}
	merged.push([ lo, hi ])
	merged.sort((x, y) => x[0] - y[0])
	ranges.length = 0
	ranges.push(...merged)
}

class HTMLMediaElement extends EventTarget {
	constructor () {
		super()
		this._src = ''
		this._currentSrc = ''
		this._srcObject = null
		this._autoplay = false
		this._loop = false
		this._muted = false
		this._defaultMuted = false
		this._volume = 1
		this._playbackRate = 1
		this._defaultPlaybackRate = 1
		this._preservesPitch = true
		this._preload = 'auto'
		this._crossOrigin = null

		this._channels = null
		this._sampleRate = 0
		this._length = 0
		this._positionCell = sharedFloat64(1)
		this._heldPosition = null
		this._generation = 0
		this._paused = true
		this._ended = false
		this._seeking = false
		this._readyState = HAVE_NOTHING
		this._networkState = NETWORK_EMPTY
		this._error = null
		this._loadId = 0
		this._pendingPlay = []
		this._lastTimeUpdate = 0
		this._played = []
		this._runStart = null

		this._capture = null
		this._attachedContext = null
		this._out = makeChannels(2)
		this._blockId = -1
		this._blockContext = null
	}

	get src () { return this._src }
	set src (value) {
		this._src = String(value)
		this.load()
	}

	get currentSrc () { return this._currentSrc }

	get srcObject () { return this._srcObject }
	set srcObject (value) {
		if (value !== null && !(value instanceof MediaStream)) { throw new TypeError("srcObject must be a MediaStream or null") }
		this._srcObject = value
		this.load()
	}

	get autoplay () { return this._autoplay }
	set autoplay (value) {
		this._autoplay = Boolean(value)
		if (this._autoplay && this._readyState >= HAVE_FUTURE_DATA && this._paused) { this.play().catch(() => {}) }
	}

	get loop () { return this._loop }
	set loop (value) {
		this._loop = Boolean(value)
		this._sync()
	}

	get muted () { return this._muted }
	set muted (value) {
		const muted = Boolean(value)
		if (muted === this._muted) { return }
		this._muted = muted
		this._sync()
		this._fire('volumechange')
	}

	get defaultMuted () { return this._defaultMuted }
	set defaultMuted (value) { this._defaultMuted = Boolean(value) }

	get volume () { return this._volume }
	set volume (value) {
		const v = checkFinite(value, 'volume')
		if (v < 0 || v > 1) { throw indexSizeError("volume must be between 0 and 1") }
		if (v === this._volume) { return }
		this._volume = v
		this._sync()
		this._fire('volumechange')
	}

	get playbackRate () { return this._playbackRate }
	set playbackRate (value) {
		const v = checkRate(value, 'playbackRate')
		if (v === this._playbackRate) { return }
		this._playbackRate = v
		this._sync()
		this._fire('ratechange')
	}

	get defaultPlaybackRate () { return this._defaultPlaybackRate }
	set defaultPlaybackRate (value) {
		const v = checkRate(value, 'defaultPlaybackRate')
		if (v === this._defaultPlaybackRate) { return }
		this._defaultPlaybackRate = v
		this._fire('ratechange')
	}

	get preservesPitch () { return this._preservesPitch }
	set preservesPitch (value) { this._preservesPitch = Boolean(value) }

	get preload () { return this._preload }
	set preload (value) { this._preload = String(value) }

	get crossOrigin () { return this._crossOrigin }
	set crossOrigin (value) { this._crossOrigin = value === null ? null : String(value) }

	get controls () { return false }
	set controls (_) {}

	get paused () { return this._paused }
	get ended () { return this._ended }
	get seeking () { return this._seeking }
	get readyState () { return this._readyState }
	get networkState () { return this._networkState }
	get error () { return this._error }

	get duration () {
		if (this._srcObject !== null) { return Infinity }
		if (this._channels === null) { return NaN }
		return this._length / this._sampleRate
	}

	get currentTime () {
		if (this._channels === null) { return 0 }
		return (this._heldPosition ?? this._position) / this._sampleRate
	}

	set currentTime (value) {
		const time = checkFinite(value, 'currentTime')
		if (this._channels === null) { return }
		this._seeking = true
		this._fire('seeking')
		this._setPosition(Math.min(Math.max(time, 0), this.duration) * this._sampleRate)
		if (this._ended && this._position < this._length) { this._ended = false }
		this._startRun()
		this._sync()
		this._seeking = false
		this._fire('timeupdate')
		this._fire('seeked')
	}

	get buffered () { return { length: this._channels === null ? 0 : 1, start: () => 0, end: () => this.duration } }
	get seekable () { return this.buffered }
	get played () {
		const ranges = this._played.map((range) => [ ...range ])
		this._addRun(ranges, this.currentTime)
		return timeRanges(ranges)
	}

	_addRun (ranges, now) {
		const start = this._runStart
		if (start === null) { return }
		if (now < start) {
			addRange(ranges, start, this.duration)
			addRange(ranges, 0, now)
		}
		else {
			addRange(ranges, start, now)
		}
	}

	_endRun () {
		if (this._runStart === null) { return }
		this._addRun(this._played, this.currentTime)
		this._runStart = null
	}

	_startRun () {
		if (!this._paused && this._channels !== null) { this._runStart = this.currentTime }
	}

	get _position () { return this._positionCell[0] }
	set _position (position) { this._positionCell[0] = position }

	_mirrored () { return this._ridOwner !== undefined && this._ridOwner === currentClient() }

	_setPosition (position) {
		this._endRun()
		this._position = position
		this._generation++
		if (this._heldPosition !== null) { this._heldPosition = position }
		if (this._mirrored()) { currentClient().send(this, '_seek', [ position ]) }
	}

	_state () {
		return {
			channels: this._channels,
			sampleRate: this._sampleRate,
			length: this._length,
			paused: this._paused,
			ended: this._ended,
			loop: this._loop,
			muted: this._muted,
			volume: this._volume,
			playbackRate: this._playbackRate,
			srcObject: this._srcObject,
			position: this._positionCell,
			generation: this._generation,
		}
	}

	_sync () {
		if (this._mirrored()) { currentClient().send(this, '_applyState', [ this._state() ]) }
	}

	_snapshot () {
		return { cls: 'HTMLMediaElement', args: [ this._state() ] }
	}

	static _twin (state) {
		const element = new HTMLMediaElement()
		element._applyState(state)
		return element
	}

	_applyState (state) {
		this._channels = state.channels
		this._sampleRate = state.sampleRate
		this._length = state.length
		this._paused = state.paused
		this._ended = state.ended
		this._loop = state.loop
		this._muted = state.muted
		this._volume = state.volume
		this._playbackRate = state.playbackRate
		this._srcObject = state.srcObject
		this._positionCell = state.position
		this._generation = state.generation
	}

	_seek (position) {
		this._position = position
	}

	_onRemote (type, data) {
		if (data.generation !== this._generation) { return }
		if (type === 'fire') { this._fire(data.type) }
		else if (type === 'finish' && !this._ended) { this._finish() }
	}

	_fire (type) {
		if (forwarding(this)) {
			notify(this, 'fire', { type, generation: this._generation })
			return
		}
		queueTask(() => { this.dispatchEvent(new Event(type)) })
	}

	_fail (code, message) {
		this._error = new MediaError(code, message)
		this._networkState = NETWORK_NO_SOURCE
		this._fire('error')
		const error = new DOMException(message, code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED ? 'NotSupportedError' : 'AbortError')
		for (const { reject } of this._pendingPlay.splice(0)) { reject(error) }
	}

	load () {
		const loadId = ++this._loadId
		const wasActive = this._channels !== null || this._srcObject !== null

		this._pause(false)
		this._channels = null
		this._length = 0
		this._played = []
		this._setPosition(0)
		this._heldPosition = null
		this._ended = false
		this._error = null
		this._readyState = HAVE_NOTHING
		this._playbackRate = this._defaultPlaybackRate

		if (wasActive) { this._fire('emptied') }

		if (this._srcObject !== null) {
			this._currentSrc = ''
			this._networkState = NETWORK_IDLE
			this._readyState = HAVE_ENOUGH_DATA
			this._sampleRate = 0
			this._fire('loadstart')
			this._fire('durationchange')
			this._fire('loadedmetadata')
			this._fire('loadeddata')
			this._fire('canplay')
			this._fire('canplaythrough')
			this._sync()
			this._afterLoad()
			return
		}

		this._sync()

		if (this._src === '') {
			this._currentSrc = ''
			this._networkState = NETWORK_EMPTY
			return
		}

		this._currentSrc = this._src
		this._networkState = NETWORK_LOADING
		this._fire('loadstart')

		const task = (async () => {
			const response = await getFetch()(this._src)
			if (loadId !== this._loadId) { return }
			if (!response.ok) {
				this._fail(MediaError.MEDIA_ERR_NETWORK, `failed to load ${this._src} (${response.status})`)
				return
			}
			const bytes = new Uint8Array(await response.arrayBuffer())
			if (loadId !== this._loadId) { return }
			let decoded
			try {
				decoded = await decode(bytes, null, { transfer: true, shared: true })
			}
			catch (error) {
				if (loadId !== this._loadId) { return }
				this._fail(MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED, error.message)
				return
			}
			if (loadId !== this._loadId) { return }

			this._channels = decoded.channels.map(toShared)
			this._sampleRate = decoded.sampleRate
			this._length = this._channels[0].length
			this._sync()
			this._networkState = NETWORK_IDLE
			this._readyState = HAVE_ENOUGH_DATA
			this._fire('durationchange')
			this._fire('loadedmetadata')
			this._fire('loadeddata')
			this._fire('canplay')
			this._fire('canplaythrough')
			this._afterLoad()
		})()

		task.catch((error) => {
			if (loadId !== this._loadId) { return }
			this._fail(MediaError.MEDIA_ERR_NETWORK, error.message)
		})
	}

	_afterLoad () {
		if (this._pendingPlay.length > 0 || this._autoplay) {
			this._begin()
			for (const { resolve } of this._pendingPlay.splice(0)) { resolve() }
		}
	}

	canPlayType (type) {
		const t = String(type).toLowerCase()
		if ((/audio\/(?:wav|wave|x-wav|mpeg|mp3|ogg|flac|opus|aiff|x-aiff)/u).test(t)) { return 'probably' }
		if ((/^audio\//u).test(t)) { return 'maybe' }
		return ''
	}

	play () {
		if (this._error && this._error.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
			return Promise.reject(notSupportedError(this._error.message))
		}
		if (this._src === '' && this._srcObject === null) {
			return Promise.reject(notSupportedError("the media element has no source"))
		}

		if (this._readyState >= HAVE_FUTURE_DATA) {
			if (this._ended) {
				this._setPosition(0)
				this._ended = false
			}
			this._begin()
			return Promise.resolve()
		}

		return new Promise((resolve, reject) => { this._pendingPlay.push({ resolve, reject }) })
	}

	_begin () {
		if (!this._paused) { return }
		this._paused = false
		this._ended = false
		this._heldPosition = null
		this._generation++
		this._startRun()
		this._sync()
		this._fire('play')
		this._fire('playing')
		this._attach()
	}

	pause () {
		if (this._readyState < HAVE_FUTURE_DATA && this._pendingPlay.length > 0) {
			const error = new DOMException("The play() request was interrupted by a call to pause()", 'AbortError')
			for (const { reject } of this._pendingPlay.splice(0)) { reject(error) }
		}
		this._pause(true)
	}

	_pause (fire) {
		if (this._paused) { return }
		this._paused = true
		this._heldPosition = this._position
		this._endRun()
		if (this._mirrored()) { currentClient().send(this, '_seek', [ this._heldPosition ]) }
		this._sync()
		if (fire) {
			this._fire('timeupdate')
			this._fire('pause')
		}
		this._detach()
	}

	_attach () {
		if (this._capture !== null) { return }
		const { getDefaultContext } = require('../context/default')
		const context = getDefaultContext()
		this._attachedContext = context
		context._attachElement(this)
	}

	_detach () {
		if (this._attachedContext !== null) {
			this._attachedContext._detachElement(this)
			this._attachedContext = null
		}
	}

	get _captured () { return this._capture !== null }

	_attachSource (node) {
		this._capture = node
		this._detach()
	}

	_render (context) {
		if (this._blockId === context._blockId && this._blockContext === context) { return this._out }
		this._blockId = context._blockId
		this._blockContext = context
		const N = context._quantum

		if (this._srcObject !== null) {
			const tracks = this._srcObject.getAudioTracks()
			const channels = tracks.length > 0 ? tracks[0]._render(context) : null
			const out = resizeChannels(this._out, channels ? channels.length : 1, N)
			this._out = out
			zeroChannels(out)
			if (channels && !this._paused) {
				const volume = this._muted ? 0 : this._volume
				const count = Math.min(N, channels[0].length)
				for (let c = 0; c < channels.length; c++) {
					for (let i = 0; i < count; i++) { out[c][i] = channels[c][i] * volume }
				}
			}
			return out
		}

		const data = this._channels
		const out = resizeChannels(this._out, data === null ? 1 : data.length, N)
		this._out = out
		zeroChannels(out)

		if (data === null || this._paused || this._ended) { return out }

		const rate = this._playbackRate * this._sampleRate / context.sampleRate
		const length = this._length
		const volume = this._muted ? 0 : this._volume
		let position = this._position

		for (let i = 0; i < N; i++) {
			if (position >= length || position < 0) {
				if (this._loop) {
					position = position >= length ? position - length : position + length
					if (position >= length || position < 0) { position = 0 }
				}
				else {
					this._position = Math.min(Math.max(position, 0), length)
					this._finish()
					return out
				}
			}

			const i0 = Math.floor(position)
			const frac = position - i0
			for (let c = 0; c < data.length; c++) {
				const src = data[c]
				const a = src[i0]
				const next = i0 + 1 < length ? src[i0 + 1] : this._loop ? src[0] : a
				out[c][i] = (a + (next - a) * frac) * volume
			}

			position += rate
		}

		this._position = position

		const time = position / this._sampleRate
		if (time - this._lastTimeUpdate >= TIMEUPDATE_INTERVAL || time < this._lastTimeUpdate) {
			this._lastTimeUpdate = time
			this._fire('timeupdate')
		}

		return out
	}

	_finish () {
		this._paused = true
		this._ended = true
		if (forwarding(this)) {
			notify(this, 'finish', { generation: this._generation })
			return
		}
		this._heldPosition = this._position
		this._endRun()
		this._sync()
		this._detach()
		this._fire('timeupdate')
		this._fire('pause')
		this._fire('ended')
	}
}

for (const [ name, value ] of Object.entries({ HAVE_NOTHING, HAVE_METADATA, HAVE_CURRENT_DATA, HAVE_FUTURE_DATA, HAVE_ENOUGH_DATA, NETWORK_EMPTY, NETWORK_IDLE, NETWORK_LOADING, NETWORK_NO_SOURCE })) {
	HTMLMediaElement[name] = value
	HTMLMediaElement.prototype[name] = value
}

defineEventHandlers(HTMLMediaElement.prototype, EVENTS)

class HTMLAudioElement extends HTMLMediaElement {
	constructor (src) {
		super()
		if (src !== undefined) { this.src = src }
	}
}

module.exports = { HTMLMediaElement, HTMLAudioElement, MediaError }
