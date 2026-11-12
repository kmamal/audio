const { AudioNode } = require('../audio-node')
const { invalidStateError } = require('../errors')
const { applyChannelOptions, checkOptions } = require('./options')
const { copyChannel } = require('../mixing')
const { MediaStream, MediaStreamTrack } = require('../media/stream')
const { created } = require('../remote/client')

class MediaElementAudioSourceNode extends AudioNode {
	constructor (context, rawOptions) {
		const options = checkOptions(rawOptions, 'MediaElementAudioSourceNode')
		const element = options.mediaElement
		if (!element || typeof element._attachSource !== 'function') { throw new TypeError("mediaElement must be an HTMLMediaElement") }
		if (element._captured) { throw invalidStateError("the media element is already connected to a MediaElementAudioSourceNode") }
		super(context, { numberOfInputs: 0, numberOfOutputs: 1 })
		this._element = element
		element._attachSource(this)
		created(context, this, 'MediaElementAudioSourceNode', [ context, rawOptions ])
	}

	get mediaElement () { return this._element }

	_computeActive () { return !this._element._paused }

	_process () {
		const channels = this._element._render(this._context)
		const out = this._setOutputChannels(0, channels.length)
		for (let c = 0; c < channels.length; c++) { copyChannel(out[c], channels[c]) }
	}
}

class MediaStreamAudioSourceNode extends AudioNode {
	constructor (context, rawOptions) {
		const options = checkOptions(rawOptions, 'MediaStreamAudioSourceNode')
		const stream = options.mediaStream
		if (!(stream instanceof MediaStream)) { throw new TypeError("mediaStream must be a MediaStream") }
		const tracks = stream.getAudioTracks()
		if (tracks.length === 0) { throw invalidStateError("the MediaStream has no audio tracks") }
		super(context, { numberOfInputs: 0, numberOfOutputs: 1 })
		this._stream = stream
		this._track = tracks.slice().sort((a, b) => a.id < b.id ? -1 : 1)[0]
		created(context, this, 'MediaStreamAudioSourceNode', [ context, rawOptions ])
	}

	get mediaStream () { return this._stream }

	_computeActive () { return this._track.readyState === 'live' && this._track.enabled }

	_process () {
		const channels = this._track._render(this._context)
		const out = this._setOutputChannels(0, channels.length)
		for (let c = 0; c < channels.length; c++) { copyChannel(out[c], channels[c]) }
	}
}

class MediaStreamTrackAudioSourceNode extends AudioNode {
	constructor (context, rawOptions) {
		const options = checkOptions(rawOptions, 'MediaStreamTrackAudioSourceNode')
		const track = options.mediaStreamTrack
		if (!(track instanceof MediaStreamTrack)) { throw new TypeError("mediaStreamTrack must be a MediaStreamTrack") }
		if (track.kind !== 'audio') { throw invalidStateError("the MediaStreamTrack is not an audio track") }
		super(context, { numberOfInputs: 0, numberOfOutputs: 1 })
		this._track = track
		created(context, this, 'MediaStreamTrackAudioSourceNode', [ context, rawOptions ])
	}

	_computeActive () { return this._track.readyState === 'live' && this._track.enabled }

	_process () {
		const channels = this._track._render(this._context)
		const out = this._setOutputChannels(0, channels.length)
		for (let c = 0; c < channels.length; c++) { copyChannel(out[c], channels[c]) }
	}
}

class MediaStreamAudioDestinationNode extends AudioNode {
	constructor (context, rawOptions) {
		const options = checkOptions(rawOptions, 'MediaStreamAudioDestinationNode')
		super(context, { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit' })
		this._rendered = this._inputMixes[0]
		this._track = new MediaStreamTrack({ kind: 'audio', label: 'MediaStreamAudioDestinationNode', source: this })
		this._stream = new MediaStream([ this._track ])
		context._addSideNode(this)
		applyChannelOptions(this, options)
		created(context, this, 'MediaStreamAudioDestinationNode', [ context, rawOptions ])
		context._remote?.assign(this._track, '_id', this._track.id)
	}

	_mirrorChildren () { return [ this._track, this._stream ] }

	get stream () { return this._stream }

	_process (inputs) {
		this._rendered = inputs[0]
	}

	_pull () {
		const context = this._context
		if (this._blockId === context._blockId) { return this._rendered }
		this._busy = true
		try {
			this._render()
		}
		finally {
			this._busy = false
		}
		this._blockId = context._blockId
		return this._rendered
	}

	_cycleOutput () {
		return this._rendered
	}

	_renderTrack (context) {
		if (context === this._context) { return this._pull() }
		return this._rendered
	}
}

module.exports = {
	MediaElementAudioSourceNode,
	MediaStreamAudioSourceNode,
	MediaStreamTrackAudioSourceNode,
	MediaStreamAudioDestinationNode,
}
