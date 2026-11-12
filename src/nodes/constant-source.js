const { AudioScheduledSourceNode } = require('./scheduled-source')
const { AudioParam, defineParamAccessors } = require('../audio-param')
const { applyParamOptions, checkOptions } = require('./options')
const { created } = require('../remote/client')

class ConstantSourceNode extends AudioScheduledSourceNode {
	constructor (context, rawOptions) {
		const options = checkOptions(rawOptions, 'ConstantSourceNode')
		super(context)
		this._offset = new AudioParam(context, { name: 'ConstantSourceNode.offset', defaultValue: 1 })
		applyParamOptions(this, options, [ 'offset' ])
		created(context, this, 'ConstantSourceNode', [ context, rawOptions ])
	}

	_process () {
		const context = this._context
		const N = context._quantum
		const out = this._silence(0, 1)[0]

		if (!this._started || this._ended) { return }

		const blockStart = context._frame
		const blockEnd = blockStart + N
		if (this._startFrame >= blockEnd) { return }
		if (this._stopFrame <= blockStart || this._stopFrame <= this._startFrame) {
			this._finish()
			return
		}

		const offset = this.offset._block()
		const first = Math.max(Math.ceil(this._startFrame - blockStart), 0)

		for (let i = first; i < N; i++) {
			if (blockStart + i >= this._stopFrame) {
				this._finish()
				break
			}
			out[i] = offset[i]
		}
	}
}

defineParamAccessors(ConstantSourceNode, [ 'offset' ])

module.exports = { ConstantSourceNode }
