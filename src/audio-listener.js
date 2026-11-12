const { AudioParam, defineParamAccessors } = require('./audio-param')
const { checkFloat } = require('./errors')

class AudioListener {
	constructor (context) {
		this._context = context
		const param = (name, defaultValue) => new AudioParam(context, { name: `AudioListener.${name}`, defaultValue })
		this._positionX = param('positionX', 0)
		this._positionY = param('positionY', 0)
		this._positionZ = param('positionZ', 0)
		this._forwardX = param('forwardX', 0)
		this._forwardY = param('forwardY', 0)
		this._forwardZ = param('forwardZ', -1)
		this._upX = param('upX', 0)
		this._upY = param('upY', 1)
		this._upZ = param('upZ', 0)

		this._blockId = -1
		this._blocks = { values: new Array(9), constant: true }
	}

	_mirrorChildren () {
		return [ this.positionX, this.positionY, this.positionZ, this.forwardX, this.forwardY, this.forwardZ, this.upX, this.upY, this.upZ ]
	}

	setPosition (x, y, z) {
		const values = [ checkFloat(x, 'x'), checkFloat(y, 'y'), checkFloat(z, 'z') ]
		this.positionX.value = values[0]
		this.positionY.value = values[1]
		this.positionZ.value = values[2]
	}

	setOrientation (x, y, z, xUp, yUp, zUp) {
		const values = [ checkFloat(x, 'x'), checkFloat(y, 'y'), checkFloat(z, 'z'), checkFloat(xUp, 'xUp'), checkFloat(yUp, 'yUp'), checkFloat(zUp, 'zUp') ]
		this.forwardX.value = values[0]
		this.forwardY.value = values[1]
		this.forwardZ.value = values[2]
		this.upX.value = values[3]
		this.upY.value = values[4]
		this.upZ.value = values[5]
	}

	_block () {
		const context = this._context
		const blocks = this._blocks
		if (this._blockId === context._blockId) { return blocks }
		this._blockId = context._blockId
		const params = [ this.positionX, this.positionY, this.positionZ, this.forwardX, this.forwardY, this.forwardZ, this.upX, this.upY, this.upZ ]
		let constant = true
		for (let k = 0; k < 9; k++) {
			blocks.values[k] = params[k]._block()
			if (!params[k]._isConstant()) { constant = false }
		}
		blocks.constant = constant
		return blocks
	}
}

defineParamAccessors(AudioListener, [ 'positionX', 'positionY', 'positionZ', 'forwardX', 'forwardY', 'forwardZ', 'upX', 'upY', 'upZ' ])

module.exports = { AudioListener }
