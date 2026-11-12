const { AudioNode } = require('../audio-node')
const { AudioParam, defineParamAccessors } = require('../audio-param')
const { applyChannelOptions, applyParamOptions, checkOptions } = require('./options')
const { created } = require('../remote/client')

class GainNode extends AudioNode {
	constructor (context, rawOptions) {
		const options = checkOptions(rawOptions, 'GainNode')
		super(context)
		this._gain = new AudioParam(context, { name: 'GainNode.gain', defaultValue: 1 })
		applyChannelOptions(this, options)
		applyParamOptions(this, options, [ 'gain' ])
		created(context, this, 'GainNode', [ context, rawOptions ])
	}

	_process (inputs) {
		const input = inputs[0]
		const N = this._context._quantum
		const out = this._setOutputChannels(0, input.length)
		const gain = this.gain._block()

		if (this.gain._isConstant()) {
			const g = gain[0]
			for (let c = 0; c < input.length; c++) {
				const src = input[c]
				const dst = out[c]
				for (let i = 0; i < N; i++) { dst[i] = src[i] * g }
			}
			return
		}

		for (let c = 0; c < input.length; c++) {
			const src = input[c]
			const dst = out[c]
			for (let i = 0; i < N; i++) { dst[i] = src[i] * gain[i] }
		}
	}
}

defineParamAccessors(GainNode, [ 'gain' ])

module.exports = { GainNode }
