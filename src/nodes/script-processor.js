const { MAX_CHANNELS } = require('../constants')
const { AudioNode } = require('../audio-node')
const { AudioBuffer } = require('../audio-buffer')
const { indexSizeError, notSupportedError, toUnsignedLong } = require('../errors')
const { defineEventHandlers } = require('../events')
const { forwarding, notify, remoteSide } = require('../remote/notify')
const { created } = require('../remote/client')
const { sharedFloat32 } = require('../remote/shared')

const SIZES = [ 256, 512, 1024, 2048, 4096, 8192, 16384 ]

const sharedBuffer = (count, length, sampleRate) => AudioBuffer._fromChannels(Array.from({ length: count }, () => sharedFloat32(length)), sampleRate)

class AudioProcessingEvent extends Event {
	constructor (type, { playbackTime, inputBuffer, outputBuffer }) {
		super(type)
		this.playbackTime = playbackTime
		this.inputBuffer = inputBuffer
		this.outputBuffer = outputBuffer
	}
}

class ScriptProcessorNode extends AudioNode {
	constructor (context, rawSize = 0, rawInputChannels = 2, rawOutputChannels = 2) {
		const requestedSize = toUnsignedLong(rawSize)
		const numberOfInputChannels = toUnsignedLong(rawInputChannels)
		const numberOfOutputChannels = toUnsignedLong(rawOutputChannels)
		const quantum = context._quantum
		const bufferSize = requestedSize === 0 ? SIZES.find((size) => size >= 4096 && size % quantum === 0) ?? SIZES.find((size) => size % quantum === 0) ?? 1024 : requestedSize
		if (!SIZES.includes(bufferSize)) { throw indexSizeError("bufferSize must be 0 or one of 256, 512, 1024, 2048, 4096, 8192, 16384") }
		if (bufferSize % quantum !== 0) { throw notSupportedError(`bufferSize must be a multiple of the render quantum (${quantum})`) }
		if (numberOfInputChannels > MAX_CHANNELS) { throw indexSizeError("invalid numberOfInputChannels") }
		if (numberOfOutputChannels > MAX_CHANNELS) { throw indexSizeError("invalid numberOfOutputChannels") }
		if (numberOfInputChannels === 0 && numberOfOutputChannels === 0) { throw indexSizeError("numberOfInputChannels and numberOfOutputChannels can not both be zero") }

		super(context, {
			numberOfInputs: 1,
			numberOfOutputs: 1,
			channelCount: Math.max(numberOfInputChannels, 1),
			channelCountMode: 'explicit',
			channelInterpretation: 'speakers',
		})

		this._bufferSize = bufferSize
		this._inputChannels = numberOfInputChannels
		this._outputChannels = numberOfOutputChannels
		this._inputBuffer = null
		this._outputQueue = []
		this._spareOutputs = []
		this._position = 0
		this._listeners = 0

		context._addSideNode(this)
		created(context, this, 'ScriptProcessorNode', [ context, requestedSize, numberOfInputChannels, numberOfOutputChannels ])
	}

	get bufferSize () { return this._bufferSize }

	addEventListener (type, listener, options) {
		super.addEventListener(type, listener, options)
		if (type === 'audioprocess') { this._listen(1) }
	}

	removeEventListener (type, listener, options) {
		super.removeEventListener(type, listener, options)
		if (type === 'audioprocess') { this._listen(-1) }
	}

	_listen (delta) {
		this._listeners = Math.max(this._listeners + delta, 0)
		if (remoteSide()) { return }
		const live = this._context._liveNodes
		if (this._listeners > 0) { live.add(this) }
		else { live.delete(this) }
	}

	_setChannelCount (count) {
		if (count !== this._channelCount) { throw notSupportedError("ScriptProcessorNode channelCount can not be changed") }
	}

	_setChannelCountMode (mode) {
		if (mode !== 'explicit') { throw notSupportedError("ScriptProcessorNode channelCountMode can not be changed") }
	}

	_dispatch (playbackTime, inputBuffer) {
		const outCount = Math.max(this._outputChannels, 1)
		const spare = this._spareOutputs.pop()
		let outputBuffer
		if (spare !== undefined) {
			for (const channel of spare) { channel.fill(0) }
			outputBuffer = AudioBuffer._fromChannels(spare, this._context.sampleRate)
		}
		else {
			outputBuffer = sharedBuffer(outCount, this._bufferSize, this._context.sampleRate)
		}
		const event = new AudioProcessingEvent('audioprocess', { playbackTime, inputBuffer, outputBuffer })
		this.dispatchEvent(event)
		return outputBuffer
	}

	_onRemote (type, data) {
		if (type !== 'audioprocess') { return }
		const inputBuffer = AudioBuffer._fromChannels(data.input, this._context.sampleRate)
		const outputBuffer = this._dispatch(data.playbackTime, inputBuffer)
		this._context._remote.send(this, '_pushOutput', [ outputBuffer._channels, data.frame ])
	}

	_pushOutput (channels, frame, recycle = false) {
		this._outputQueue.push({ frame, channels, recycle })
	}

	_retire (entry) {
		if (entry.recycle && this._spareOutputs.length < 2) { this._spareOutputs.push(entry.channels) }
	}

	_makeInputBuffer () {
		return sharedBuffer(Math.max(this._inputChannels, 1), this._bufferSize, this._context.sampleRate)
	}

	_process (inputs) {
		const context = this._context
		const N = context._quantum
		const input = inputs[0]
		const outCount = Math.max(this._outputChannels, 1)
		const out = this._silence(0, outCount)
		const size = this._bufferSize
		const blockStart = context._frame

		if (this._inputBuffer === null) { this._inputBuffer = this._makeInputBuffer() }

		let i = 0
		while (i < N) {
			const take = Math.min(N - i, size - this._position)
			const inputBuffer = this._inputBuffer
			for (let c = 0; c < this._inputChannels; c++) {
				inputBuffer.getChannelData(c).set(input[Math.min(c, input.length - 1)].subarray(i, i + take), this._position)
			}
			this._position += take

			if (this._position >= size) {
				this._position = 0
				const frame = blockStart + i + take + size
				const playbackTime = frame / context.sampleRate
				if (forwarding(this)) {
					notify(this, 'audioprocess', { playbackTime, frame, input: inputBuffer._channels })
				}
				else {
					this._pushOutput(this._dispatch(playbackTime, inputBuffer)._channels, frame, true)
				}
				this._inputBuffer = this._makeInputBuffer()
			}

			this._readOutput(blockStart + i, out, i, take)
			i += take
		}
	}

	_readOutput (frame, out, offset, count) {
		const queue = this._outputQueue
		const size = this._bufferSize
		let done = 0
		while (done < count) {
			const at = frame + done
			while (queue.length > 0 && queue[0].frame + size <= at) { this._retire(queue.shift()) }
			if (queue.length === 0) { return }
			const { frame: start, channels } = queue[0]
			if (start > at) {
				done += Math.min(start - at, count - done)
				continue
			}
			const from = at - start
			const n = Math.min(count - done, size - from)
			if (this._outputChannels > 0) {
				for (let c = 0; c < out.length; c++) { out[c].set(channels[c].subarray(from, from + n), offset + done) }
			}
			done += n
			if (from + n >= size) { this._retire(queue.shift()) }
		}
	}
}

defineEventHandlers(ScriptProcessorNode.prototype, [ 'audioprocess' ])

module.exports = { ScriptProcessorNode, AudioProcessingEvent }
