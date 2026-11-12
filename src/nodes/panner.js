const { AudioNode } = require('../audio-node')
const { AudioParam, defineParamAccessors } = require('../audio-param')
const { notSupportedError, invalidStateError, checkEnum, isEnum, checkFinite, checkFloat } = require('../errors')
const { HRTFDatabase } = require('../dsp/hrtf')
const { planStages, Kernel, Input, Convolution } = require('../dsp/convolution')
const { BlockAdapter, BLOCK } = require('../dsp/blocks')
const { applyChannelOptions, applyParamOptions, checkOptions } = require('./options')
const { created } = require('../remote/client')

const PANNING_MODELS = [ 'equalpower', 'HRTF' ]
const DISTANCE_MODELS = [ 'linear', 'inverse', 'exponential' ]
const HALF_PI = Math.PI / 2
const RAD_TO_DEG = 180 / Math.PI

const clampUnit = (x) => Math.min(Math.max(x, -1), 1)

class HRTFState {
	constructor (length) {
		this.length = length
		this.stages = planStages(length)
		this.kernelL = new Float32Array(length)
		this.kernelR = new Float32Array(length)
		this.inputL = new Input(this.stages)
		this.inputR = new Input(this.stages)
		this.currentL = new Convolution(this.stages)
		this.currentR = new Convolution(this.stages)
		this.previousL = new Convolution(this.stages)
		this.previousR = new Convolution(this.stages)
		this.outL = new Float32Array(BLOCK)
		this.outR = new Float32Array(BLOCK)
		this.prevL = new Float32Array(BLOCK)
		this.prevR = new Float32Array(BLOCK)
		this.azimuth = null
		this.elevation = null
	}
}

class PannerNode extends AudioNode {
	constructor (context, rawOptions) {
		const options = checkOptions(rawOptions, 'PannerNode')
		super(context, { channelCountMode: 'clamped-max' })

		const param = (name, defaultValue) => new AudioParam(context, { name: `PannerNode.${name}`, defaultValue })
		this._positionX = param('positionX', 0)
		this._positionY = param('positionY', 0)
		this._positionZ = param('positionZ', 0)
		this._orientationX = param('orientationX', 1)
		this._orientationY = param('orientationY', 0)
		this._orientationZ = param('orientationZ', 0)

		this._panningModel = 'equalpower'
		this._distanceModel = 'inverse'
		this._refDistance = 1
		this._maxDistance = 10000
		this._rolloffFactor = 1
		this._coneInnerAngle = 360
		this._coneOuterAngle = 360
		this._coneOuterGain = 0

		this._ownBlocks = new Array(6)
		this._hrtfArgs = { azimuth: 0, elevation: 0, gain: 0 }
		this._hrtfBlock = (blockInputs, blockOutputs) => {
			const args = this._hrtfArgs
			this._processHRTF(blockInputs, blockOutputs, args.azimuth, args.elevation, args.gain)
		}
		this._gains = { gl: 0, gr: 0, gain: 0, mode: 0 }
		this._geo = { azimuth: 0, elevation: 0, gain: 0 }
		this._hrtf = null
		this._adapter = new BlockAdapter(context._quantum)

		applyChannelOptions(this, options)
		applyParamOptions(this, options, [ 'positionX', 'positionY', 'positionZ', 'orientationX', 'orientationY', 'orientationZ' ])
		if (options.panningModel !== undefined) { this.panningModel = checkEnum(options.panningModel, PANNING_MODELS, 'panningModel') }
		if (options.distanceModel !== undefined) { this.distanceModel = checkEnum(options.distanceModel, DISTANCE_MODELS, 'distanceModel') }
		for (const key of [ 'refDistance', 'maxDistance', 'rolloffFactor', 'coneInnerAngle', 'coneOuterAngle', 'coneOuterGain' ]) {
			if (options[key] !== undefined) { this[key] = options[key] }
		}
		created(context, this, 'PannerNode', [ context, rawOptions ])
	}

	_setChannelCount (count) {
		if (count > 2) { throw notSupportedError("PannerNode channelCount must be 1 or 2") }
		this._channelCount = count
	}

	_tailFrames () { return this._hrtf === null ? 0 : this._hrtf.length + BLOCK }

	_setChannelCountMode (mode) {
		if (mode === 'max') { throw notSupportedError("PannerNode does not support channelCountMode 'max'") }
		this._channelCountMode = mode
	}

	get panningModel () { return this._panningModel }
	set panningModel (value) {
		if (!isEnum(value, PANNING_MODELS)) { return }
		this._panningModel = value
		if (value === 'HRTF') { this._context._prepareHRTF() }
	}

	get distanceModel () { return this._distanceModel }
	set distanceModel (value) {
		if (!isEnum(value, DISTANCE_MODELS)) { return }
		this._distanceModel = value
	}

	get refDistance () { return this._refDistance }
	set refDistance (value) {
		const v = checkFinite(value, 'refDistance')
		if (v < 0) { throw new RangeError("refDistance must be non-negative") }
		this._refDistance = v
	}

	get maxDistance () { return this._maxDistance }
	set maxDistance (value) {
		const v = checkFinite(value, 'maxDistance')
		if (v <= 0) { throw new RangeError("maxDistance must be positive") }
		this._maxDistance = v
	}

	get rolloffFactor () { return this._rolloffFactor }
	set rolloffFactor (value) {
		const v = checkFinite(value, 'rolloffFactor')
		if (v < 0) { throw new RangeError("rolloffFactor must be non-negative") }
		this._rolloffFactor = v
	}

	get coneInnerAngle () { return this._coneInnerAngle }
	set coneInnerAngle (value) { this._coneInnerAngle = checkFinite(value, 'coneInnerAngle') }

	get coneOuterAngle () { return this._coneOuterAngle }
	set coneOuterAngle (value) { this._coneOuterAngle = checkFinite(value, 'coneOuterAngle') }

	get coneOuterGain () { return this._coneOuterGain }
	set coneOuterGain (value) {
		const v = checkFinite(value, 'coneOuterGain')
		if (v < 0 || v > 1) { throw invalidStateError("coneOuterGain must be between 0 and 1") }
		this._coneOuterGain = v
	}

	setPosition (x, y, z) {
		const values = [ checkFloat(x, 'x'), checkFloat(y, 'y'), checkFloat(z, 'z') ]
		this.positionX.value = values[0]
		this.positionY.value = values[1]
		this.positionZ.value = values[2]
	}

	setOrientation (x, y, z) {
		const values = [ checkFloat(x, 'x'), checkFloat(y, 'y'), checkFloat(z, 'z') ]
		this.orientationX.value = values[0]
		this.orientationY.value = values[1]
		this.orientationZ.value = values[2]
	}

	_distanceGain (distance) {
		const ref = this._refDistance
		const max = this._maxDistance
		const rolloff = this._rolloffFactor
		switch (this._distanceModel) {
			case 'linear': {
				const f = Math.min(Math.max(rolloff, 0), 1)
				const dRef = Math.min(ref, max)
				const dMax = Math.max(ref, max)
				if (dRef === dMax) { return 1 - f }
				const d = Math.min(Math.max(distance, dRef), dMax)
				return 1 - f * (d - dRef) / (dMax - dRef)
			}
			case 'exponential': {
				if (ref === 0) { return 0 }
				return (Math.max(distance, ref) / ref) ** -rolloff
			}
			default: {
				if (ref === 0) { return 0 }
				return ref / (ref + rolloff * (Math.max(distance, ref) - ref))
			}
		}
	}

	_coneGain (ox, oy, oz, tx, ty, tz) {
		if (this._coneInnerAngle === 360 && this._coneOuterAngle === 360) { return 1 }
		const om = Math.sqrt(ox * ox + oy * oy + oz * oz)
		if (om === 0) { return 1 }
		const tm = Math.sqrt(tx * tx + ty * ty + tz * tz)
		const projection = tm === 0 ? 0 : (ox / om) * (tx / tm) + (oy / om) * (ty / tm) + (oz / om) * (tz / tm)
		const angle = Math.acos(clampUnit(projection)) * RAD_TO_DEG
		const absAngle = Math.abs(angle)
		const inner = Math.abs(this._coneInnerAngle) / 2
		const outer = Math.abs(this._coneOuterAngle) / 2
		if (absAngle <= inner) { return 1 }
		if (absAngle >= outer) { return this._coneOuterGain }
		const x = (absAngle - inner) / (outer - inner)
		return (1 - x) + this._coneOuterGain * x
	}

	_geometry (own, listener, i, out) {
		const sx = Math.fround(own[0][i] - listener[0][i])
		const sy = Math.fround(own[1][i] - listener[1][i])
		const sz = Math.fround(own[2][i] - listener[2][i])
		const distance = Math.fround(Math.sqrt(sx * sx + sy * sy + sz * sz))

		let azimuth = 0
		let elevation = 0

		if (distance > 0) {
			const dx = sx / distance
			const dy = sy / distance
			const dz = sz / distance

			let fx = listener[3][i]
			let fy = listener[4][i]
			let fz = listener[5][i]
			const fm = Math.sqrt(fx * fx + fy * fy + fz * fz)
			if (fm === 0) {
				fx = 0
				fy = 0
				fz = 0
			}
			else {
				fx /= fm
				fy /= fm
				fz /= fm
			}

			let ux = listener[6][i]
			let uy = listener[7][i]
			let uz = listener[8][i]
			const um = Math.sqrt(ux * ux + uy * uy + uz * uz)
			if (um === 0) {
				ux = 0
				uy = 0
				uz = 0
			}
			else {
				ux /= um
				uy /= um
				uz /= um
			}

			let rx = fy * uz - fz * uy
			let ry = fz * ux - fx * uz
			let rz = fx * uy - fy * ux
			const rm = Math.sqrt(rx * rx + ry * ry + rz * rz)

			if (rm !== 0 && fm !== 0) {
				rx /= rm
				ry /= rm
				rz /= rm

				let vx = ry * fz - rz * fy
				let vy = rz * fx - rx * fz
				let vz = rx * fy - ry * fx
				const vm = Math.sqrt(vx * vx + vy * vy + vz * vz)
				if (vm === 0) {
					vx = 0
					vy = 0
					vz = 0
				}
				else {
					vx /= vm
					vy /= vm
					vz /= vm
				}

				const upProjection = dx * vx + dy * vy + dz * vz
				let qx = dx - vx * upProjection
				let qy = dy - vy * upProjection
				let qz = dz - vz * upProjection
				const qm = Math.sqrt(qx * qx + qy * qy + qz * qz)
				if (qm === 0) {
					qx = 0
					qy = 0
					qz = 0
				}
				else {
					qx /= qm
					qy /= qm
					qz /= qm
				}

				azimuth = Math.acos(clampUnit(qx * rx + qy * ry + qz * rz)) * RAD_TO_DEG
				const frontBack = qx * fx + qy * fy + qz * fz
				if (frontBack < 0) { azimuth = 360 - azimuth }
				azimuth = azimuth <= 270 ? 90 - azimuth : 450 - azimuth

				elevation = 90 - Math.acos(clampUnit(upProjection)) * RAD_TO_DEG
				if (elevation > 90) { elevation = 180 - elevation }
				else if (elevation < -90) { elevation = -180 - elevation }
			}
		}

		out.azimuth = azimuth
		out.elevation = elevation
		out.gain = Math.fround(Math.max(this._distanceGain(distance), 0) * this._coneGain(own[3][i], own[4][i], own[5][i], -sx, -sy, -sz))
		return out
	}

	_equalPowerGains (azimuth, gain, channels, out) {
		let a = Math.min(Math.max(azimuth, -180), 180)
		if (a < -90) { a = -180 - a }
		else if (a > 90) { a = 180 - a }

		if (channels === 1) {
			const x = (a + 90) / 180
			out.gl = Math.cos(x * HALF_PI)
			out.gr = Math.sin(x * HALF_PI)
			out.mode = 0
		}
		else if (a <= 0) {
			const x = (a + 90) / 90
			out.gl = Math.cos(x * HALF_PI)
			out.gr = Math.sin(x * HALF_PI)
			out.mode = 1
		}
		else {
			const x = a / 90
			out.gl = Math.cos(x * HALF_PI)
			out.gr = Math.sin(x * HALF_PI)
			out.mode = 2
		}
		out.gain = gain
		return out
	}

	_process (inputs) {
		const N = this._context._quantum
		const input = inputs[0]
		const out = this._setOutputChannels(0, 2)
		const listener = this._context.listener._block()
		const params = this._paramList ??= [ this._positionX, this._positionY, this._positionZ, this._orientationX, this._orientationY, this._orientationZ ]
		const own = this._ownBlocks
		let constant = listener.constant
		for (let k = 0; k < 6; k++) {
			own[k] = params[k]._block()
			if (!params[k]._isConstant()) { constant = false }
		}

		const geo = this._geo

		if (this._panningModel === 'HRTF') {
			const { azimuth, elevation, gain } = this._geometry(own, listener.values, 0, geo)
			const args = this._hrtfArgs
			args.azimuth = azimuth
			args.elevation = elevation
			args.gain = gain
			this._adapter.process(input, out, this._hrtfBlock)
			return
		}

		const left = out[0]
		const right = out[1]
		const gains = this._gains
		const inL = input[0]
		const inR = input.length > 1 ? input[1] : null

		if (constant) {
			const { azimuth, gain } = this._geometry(own, listener.values, 0, geo)
			this._equalPowerGains(azimuth, gain, input.length, gains)
			const { gl, gr, mode } = gains
			if (mode === 0) {
				for (let i = 0; i < N; i++) {
					left[i] = Math.fround(inL[i] * gl) * gain
					right[i] = Math.fround(inL[i] * gr) * gain
				}
			}
			else if (mode === 1) {
				for (let i = 0; i < N; i++) {
					left[i] = Math.fround(inL[i] + inR[i] * gl) * gain
					right[i] = Math.fround(inR[i] * gr) * gain
				}
			}
			else {
				for (let i = 0; i < N; i++) {
					left[i] = Math.fround(inL[i] * gl) * gain
					right[i] = Math.fround(inR[i] + inL[i] * gr) * gain
				}
			}
			return
		}

		for (let i = 0; i < N; i++) {
			this._geometry(own, listener.values, i, geo)
			this._equalPowerGains(geo.azimuth, geo.gain, input.length, gains)
			const { gl, gr, mode, gain } = gains
			if (mode === 0) {
				left[i] = Math.fround(inL[i] * gl) * gain
				right[i] = Math.fround(inL[i] * gr) * gain
			}
			else if (mode === 1) {
				left[i] = Math.fround(inL[i] + inR[i] * gl) * gain
				right[i] = Math.fround(inR[i] * gr) * gain
			}
			else {
				left[i] = Math.fround(inL[i] * gl) * gain
				right[i] = Math.fround(inR[i] + inL[i] * gr) * gain
			}
		}
	}

	_processHRTF (input, out, azimuth, elevation, gain) {
		const database = HRTFDatabase.for(this._context.sampleRate)
		let state = this._hrtf
		if (state === null) {
			state = new HRTFState(database.length)
			this._hrtf = state
		}

		const stereo = input.length > 1
		const inputL = state.inputL
		const inputR = stereo ? state.inputR : state.inputL
		inputL.push(input[0])
		if (stereo) { inputR.push(input[1]) }

		const firstTime = state.azimuth === null
		const changed = state.azimuth !== azimuth || state.elevation !== elevation
		if (changed) {
			const swapL = state.previousL
			const swapR = state.previousR
			state.previousL = state.currentL
			state.previousR = state.currentR
			state.currentL = swapL
			state.currentR = swapR
			database.kernels(azimuth, elevation, state.kernelL, state.kernelR)
			state.currentL.setKernel(Kernel.fromData(state.kernelL), inputL)
			state.currentR.setKernel(Kernel.fromData(state.kernelR), inputR)
			state.azimuth = azimuth
			state.elevation = elevation
		}

		const outL = state.outL
		const outR = state.outR
		outL.fill(0)
		outR.fill(0)
		state.currentL.process(inputL, outL)
		state.currentR.process(inputR, outR)

		const crossfade = changed && !firstTime
		const prevL = state.prevL
		const prevR = state.prevR
		if (crossfade) {
			prevL.fill(0)
			prevR.fill(0)
			state.previousL.process(inputL, prevL)
			state.previousR.process(inputR, prevR)
		}

		const left = out[0]
		const right = out[1]

		for (let i = 0; i < BLOCK; i++) {
			let l = outL[i]
			let r = outR[i]
			if (crossfade) {
				const t = i / BLOCK
				l = prevL[i] + (l - prevL[i]) * t
				r = prevR[i] + (r - prevR[i]) * t
			}
			left[i] = l * gain
			right[i] = r * gain
		}
	}
}

defineParamAccessors(PannerNode, [ 'positionX', 'positionY', 'positionZ', 'orientationX', 'orientationY', 'orientationZ' ])

module.exports = { PannerNode }
