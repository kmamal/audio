const { AudioNode } = require('../audio-node')
const { indexSizeError, invalidStateError, notSupportedError } = require('../errors')
const { MAX_CHANNELS } = require('../constants')

class AudioDestinationNode extends AudioNode {
	constructor (context, { channelCount = 2, maxChannelCount = MAX_CHANNELS, fixed = false } = {}) {
		super(context, {
			numberOfInputs: 1,
			numberOfOutputs: 1,
			channelCount,
			channelCountMode: 'explicit',
			channelInterpretation: 'speakers',
		})
		this._maxChannelCount = maxChannelCount
		this._fixed = fixed
		this._rendered = this._inputMixes[0]
	}

	get maxChannelCount () { return this._maxChannelCount }

	_setChannelCount (count) {
		if (this._fixed) {
			if (count !== this._channelCount) { throw invalidStateError("the channelCount of an OfflineAudioContext destination can not be changed") }
			return
		}
		if (count > this._maxChannelCount) { throw indexSizeError(`channelCount must be at most ${this._maxChannelCount}`) }
		const previous = this._channelCount
		this._channelCount = count
		if (previous !== count) { this._context._onDestinationChannelsChanged?.(count) }
	}

	_setChannelCountMode (mode) {
		if (this._fixed && mode !== 'explicit') { throw invalidStateError("the channelCountMode of an OfflineAudioContext destination can not be changed") }
		if (mode === 'max') { throw notSupportedError("AudioDestinationNode does not support channelCountMode 'max'") }
		this._channelCountMode = mode
	}

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
}

module.exports = { AudioDestinationNode }
