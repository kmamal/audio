const { MAX_CHANNELS } = require('../constants')
const { AudioNode } = require('../audio-node')
const { toUnsignedLong, indexSizeError, invalidStateError } = require('../errors')
const { applyChannelOptions, checkOptions } = require('./options')
const { created } = require('../remote/client')

class ChannelMergerNode extends AudioNode {
	constructor (context, rawOptions) {
		const options = checkOptions(rawOptions, 'ChannelMergerNode')
		const numberOfInputs = options.numberOfInputs === undefined ? 6 : toUnsignedLong(options.numberOfInputs)
		if (numberOfInputs < 1 || numberOfInputs > MAX_CHANNELS) {
			throw indexSizeError(`numberOfInputs must be between 1 and ${MAX_CHANNELS}`)
		}
		super(context, {
			numberOfInputs,
			numberOfOutputs: 1,
			channelCount: 1,
			channelCountMode: 'explicit',
			channelInterpretation: 'speakers',
		})
		applyChannelOptions(this, options)
		created(context, this, 'ChannelMergerNode', [ context, rawOptions ])
	}

	_setChannelCount (count) {
		if (count !== 1) { throw invalidStateError("ChannelMergerNode channelCount can not be changed") }
	}

	_setChannelCountMode (mode) {
		if (mode !== 'explicit') { throw invalidStateError("ChannelMergerNode channelCountMode can not be changed") }
	}

	_process (inputs) {
		const out = this._setOutputChannels(0, this._numberOfInputs)
		for (let i = 0; i < this._numberOfInputs; i++) { out[i].set(inputs[i][0]) }
	}
}

module.exports = { ChannelMergerNode }
