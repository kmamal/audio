const { MAX_CHANNELS, MAX_BUFFER_LENGTH, MIN_SAMPLE_RATE, MAX_SAMPLE_RATE } = require('./constants')
const { notSupportedError, indexSizeError, toUnsignedLong } = require('./errors')
const { currentClient } = require('./remote/client')

const checkSampleRate = (sampleRate) => {
	const rate = Number(sampleRate)
	if (!Number.isFinite(rate) || rate < MIN_SAMPLE_RATE || rate > MAX_SAMPLE_RATE) {
		throw notSupportedError(`sampleRate must be between ${MIN_SAMPLE_RATE} and ${MAX_SAMPLE_RATE}`)
	}
	return rate
}

const channelMemory = new WeakSet()

const checkCopyArray = (array, name) => {
	if (!(array instanceof Float32Array)) { throw new TypeError(`${name} must be a Float32Array`) }
	if (array.buffer instanceof SharedArrayBuffer && !channelMemory.has(array.buffer)) { throw new TypeError(`${name} must not be backed by a SharedArrayBuffer`) }
}

const copyChannel = (channel) => channel.buffer.detached ? channel : channel.slice()

class AudioBuffer {
	constructor (options) {
		if (typeof options !== 'object' || options === null) { throw new TypeError("AudioBuffer options must be an object") }
		if (options.length === undefined || options.sampleRate === undefined) { throw new TypeError("AudioBuffer options need length and sampleRate") }
		const { sampleRate } = options
		const numberOfChannels = options.numberOfChannels === undefined ? 1 : toUnsignedLong(options.numberOfChannels)
		const length = toUnsignedLong(options.length)

		if (!Number.isInteger(numberOfChannels) || numberOfChannels < 1 || numberOfChannels > MAX_CHANNELS) {
			throw notSupportedError(`numberOfChannels must be between 1 and ${MAX_CHANNELS}`)
		}
		if (!Number.isInteger(length) || length < 1 || length > MAX_BUFFER_LENGTH) { throw notSupportedError(`length must be between 1 and ${MAX_BUFFER_LENGTH}`) }

		this._sampleRate = checkSampleRate(sampleRate)
		this._length = length
		this._channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length))
		this._exposed = false
		this._acquired = false
		this._stale = false
	}

	static _fromChannels (channels, sampleRate) {
		const buffer = Object.create(AudioBuffer.prototype)
		buffer._sampleRate = sampleRate
		buffer._length = channels[0].length
		buffer._channels = channels
		buffer._exposed = false
		buffer._acquired = false
		buffer._stale = false
		for (const channel of channels) {
			if (channel.buffer instanceof SharedArrayBuffer) { channelMemory.add(channel.buffer) }
		}
		return buffer
	}

	_snapshot () {
		this._stale = false
		return { cls: 'AudioBuffer', args: [ { sampleRate: this._sampleRate, channels: this._channels } ] }
	}

	_content () {
		return this._channels.some((channel) => channel.buffer.detached) ? null : this._channels
	}

	_acquire (local) {
		if (this._content() === null) { return null }
		if (this._exposed) {
			this._channels = this._channels.map(copyChannel)
			this._exposed = false
			this._acquired = false
			this._stale = true
		}
		if (this._stale) {
			this._stale = false
			const client = currentClient()
			if (client !== null && client.owns(this)) { client.assign(this, '_channels', this._channels) }
		}
		if (local) { this._acquired = true }
		return this._channels
	}

	_fork () {
		if (!this._acquired) { return }
		this._channels = this._channels.map(copyChannel)
		this._acquired = false
	}

	_index (rawChannel) {
		const channel = toUnsignedLong(rawChannel)
		if (channel >= this._channels.length) { throw indexSizeError(`channel index ${rawChannel} is out of range`) }
		return channel
	}

	get sampleRate () { return this._sampleRate }
	get length () { return this._length }
	get duration () { return this._length / this._sampleRate }
	get numberOfChannels () { return this._channels.length }

	getChannelData (rawChannel) {
		const channel = this._index(rawChannel)
		this._fork()
		this._exposed = true
		return this._channels[channel]
	}

	copyFromChannel (destination, channelNumber, rawOffset = 0) {
		checkCopyArray(destination, 'destination')
		const source = this._channels[this._index(channelNumber)]
		const bufferOffset = toUnsignedLong(rawOffset)
		if (bufferOffset >= this._length) { return }
		const count = Math.min(destination.length, this._length - bufferOffset)
		destination.set(source.subarray(bufferOffset, bufferOffset + count))
	}

	copyToChannel (source, channelNumber, rawOffset = 0) {
		checkCopyArray(source, 'source')
		const channel = this._index(channelNumber)
		this._fork()
		this._stale = true
		const destination = this._channels[channel]
		const bufferOffset = toUnsignedLong(rawOffset)
		if (bufferOffset >= this._length) { return }
		const count = Math.min(source.length, this._length - bufferOffset)
		destination.set(source.subarray(0, count), bufferOffset)
	}
}

module.exports = { AudioBuffer, checkSampleRate }
