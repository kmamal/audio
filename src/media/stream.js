const { randomUUID } = require('node:crypto')
const { defineEventHandlers } = require('../events')
const { makeChannels, zeroChannels } = require('../mixing')

class MediaStreamTrack extends EventTarget {
	constructor ({ kind = 'audio', label = '', source = null, settings = {}, id = randomUUID() } = {}) {
		super()
		this._id = id
		this._kind = kind
		this._label = label
		this._source = source
		this._settings = settings
		this._enabled = true
		this._readyState = 'live'
		this._silence = makeChannels(1)
		if (source?._tracks instanceof Set) { source._tracks.add(this) }
	}

	get id () { return this._id }
	get kind () { return this._kind }
	get label () { return this._label }
	get muted () { return false }
	get readyState () { return this._readyState }
	get contentHint () { return '' }

	get enabled () { return this._enabled }
	set enabled (value) { this._enabled = Boolean(value) }

	stop () {
		if (this._readyState === 'ended') { return }
		this._readyState = 'ended'
		this._source?._stopTrack?.(this)
	}

	clone () {
		return new MediaStreamTrack({ kind: this._kind, label: this._label, source: this._source, settings: this._settings })
	}

	_snapshot () {
		return {
			cls: 'MediaStreamTrack',
			args: [
				{ kind: this._kind, label: this._label, source: this._source, settings: this._settings, id: this._id },
				{ enabled: this._enabled, readyState: this._readyState },
			],
		}
	}

	_onRemote (type) {
		if (type !== 'ended' || this._readyState === 'ended') { return }
		this._readyState = 'ended'
		this.dispatchEvent(new Event('ended'))
	}

	getSettings () { return { ...this._settings } }
	getCapabilities () { return {} }
	getConstraints () { return {} }
	applyConstraints () { return Promise.resolve() }

	_render (context) {
		if (this._readyState === 'ended' || !this._enabled || this._source === null) {
			if (this._silence[0].length !== context._quantum) { this._silence = makeChannels(1, context._quantum) }
			zeroChannels(this._silence)
			return this._silence
		}
		return this._source._renderTrack(context, this)
	}
}

defineEventHandlers(MediaStreamTrack.prototype, [ 'ended', 'mute', 'unmute' ])

class MediaStream extends EventTarget {
	constructor (init) {
		super()
		this._id = randomUUID()
		this._tracks = []
		if (init instanceof MediaStream) {
			this._tracks = init.getTracks()
		}
		else if (Array.isArray(init)) {
			for (const track of init) { this.addTrack(track) }
		}
	}

	get id () { return this._id }
	get active () { return this._tracks.some((track) => track.readyState === 'live') }

	_snapshot () {
		return { cls: 'MediaStream', args: [ this._tracks ] }
	}

	getTracks () { return this._tracks.slice() }
	getAudioTracks () { return this._tracks.filter((track) => track.kind === 'audio') }
	getVideoTracks () { return this._tracks.filter((track) => track.kind === 'video') }
	getTrackById (id) { return this._tracks.find((track) => track.id === id) ?? null }

	addTrack (track) {
		if (!(track instanceof MediaStreamTrack)) { throw new TypeError("track must be a MediaStreamTrack") }
		if (!this._tracks.includes(track)) { this._tracks.push(track) }
	}

	removeTrack (track) {
		const index = this._tracks.indexOf(track)
		if (index !== -1) { this._tracks.splice(index, 1) }
	}

	clone () {
		return new MediaStream(this._tracks.map((track) => track.clone()))
	}
}

defineEventHandlers(MediaStream.prototype, [ 'addtrack', 'removetrack', 'active', 'inactive' ])

module.exports = { MediaStream, MediaStreamTrack }
