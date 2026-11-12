const { AudioNode } = require('../audio-node')
const { AudioParam, defineParamAccessors } = require('../audio-param')
const { notSupportedError } = require('../errors')
const { applyChannelOptions, applyParamOptions, checkOptions } = require('./options')
const { created } = require('../remote/client')

const HALF_PI = Math.PI / 2

class StereoPannerNode extends AudioNode {
	constructor (context, rawOptions) {
		const options = checkOptions(rawOptions, 'StereoPannerNode')
		super(context, { channelCountMode: 'clamped-max' })
		this._pan = new AudioParam(context, { name: 'StereoPannerNode.pan', defaultValue: 0, minValue: -1, maxValue: 1 })
		applyChannelOptions(this, options)
		applyParamOptions(this, options, [ 'pan' ])
		created(context, this, 'StereoPannerNode', [ context, rawOptions ])
	}

	_setChannelCount (count) {
		if (count > 2) { throw notSupportedError("StereoPannerNode channelCount must be 1 or 2") }
		this._channelCount = count
	}

	_setChannelCountMode (mode) {
		if (mode === 'max') { throw notSupportedError("StereoPannerNode does not support channelCountMode 'max'") }
		this._channelCountMode = mode
	}

	_process (inputs) {
		const input = inputs[0]
		const N = this._context._quantum
		const out = this._setOutputChannels(0, 2)
		const pan = this.pan._block()
		const left = out[0]
		const right = out[1]

		const constant = this.pan._isConstant()

		if (input.length === 1) {
			const mono = input[0]
			if (constant) {
				const x = (pan[0] + 1) / 2
				const gl = Math.cos(x * HALF_PI)
				const gr = Math.sin(x * HALF_PI)
				for (let i = 0; i < N; i++) {
					left[i] = mono[i] * gl
					right[i] = mono[i] * gr
				}
				return
			}
			for (let i = 0; i < N; i++) {
				const x = (pan[i] + 1) / 2
				left[i] = mono[i] * Math.cos(x * HALF_PI)
				right[i] = mono[i] * Math.sin(x * HALF_PI)
			}
			return
		}

		const inL = input[0]
		const inR = input[1]
		if (constant) {
			const p = pan[0]
			const x = p <= 0 ? p + 1 : p
			const gl = Math.cos(x * HALF_PI)
			const gr = Math.sin(x * HALF_PI)
			if (p <= 0) {
				for (let i = 0; i < N; i++) {
					left[i] = inL[i] + inR[i] * gl
					right[i] = inR[i] * gr
				}
			}
			else {
				for (let i = 0; i < N; i++) {
					left[i] = inL[i] * gl
					right[i] = inR[i] + inL[i] * gr
				}
			}
			return
		}

		for (let i = 0; i < N; i++) {
			const p = pan[i]
			if (p <= 0) {
				const x = p + 1
				const gl = Math.cos(x * HALF_PI)
				const gr = Math.sin(x * HALF_PI)
				left[i] = inL[i] + inR[i] * gl
				right[i] = inR[i] * gr
			}
			else {
				const gl = Math.cos(p * HALF_PI)
				const gr = Math.sin(p * HALF_PI)
				left[i] = inL[i] * gl
				right[i] = inR[i] + inL[i] * gr
			}
		}
	}
}

defineParamAccessors(StereoPannerNode, [ 'pan' ])

module.exports = { StereoPannerNode }
