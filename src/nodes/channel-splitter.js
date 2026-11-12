const { MAX_CHANNELS } = require('../constants')
const { AudioNode } = require('../audio-node')
const { toUnsignedLong, indexSizeError, invalidStateError } = require('../errors')
const { applyChannelOptions, checkOptions } = require('./options')
const { created } = require('../remote/client')

class ChannelSplitterNode extends AudioNode {
	constructor (context, rawOptions) {
		const options = checkOptions(rawOptions, 'ChannelSplitterNode')
		const numberOfOutputs = options.numberOfOutputs === undefined ? 6 : toUnsignedLong(options.numberOfOutputs)
		if (numberOfOutputs < 1 || numberOfOutputs > MAX_CHANNELS) {
			throw indexSizeError(`numberOfOutputs must be between 1 and ${MAX_CHANNELS}`)
		}
		super(context, {
			numberOfInputs: 1,
			numberOfOutputs,
			channelCount: numberOfOutputs,
			channelCountMode: 'explicit',
			channelInterpretation: 'discrete',
		})
		applyChannelOptions(this, options)
		created(context, this, 'ChannelSplitterNode', [ context, rawOptions ])
	}

	_setChannelCount (count) {
		if (count !== this._channelCount) { throw invalidStateError("ChannelSplitterNode channelCount can not be changed") }
	}

	_setChannelCountMode (mode) {
		if (mode !== 'explicit') { throw invalidStateError("ChannelSplitterNode channelCountMode can not be changed") }
	}

	_setChannelInterpretation (interpretation) {
		if (interpretation !== 'discrete') { throw invalidStateError("ChannelSplitterNode channelInterpretation can not be changed") }
	}

	_process (inputs) {
		const input = inputs[0]
		for (let o = 0; o < this._numberOfOutputs; o++) {
			const out = this._setOutputChannels(o, 1)[0]
			if (o < input.length) { out.set(input[o]) }
			else { out.fill(0) }
		}
	}
}

module.exports = { ChannelSplitterNode }
