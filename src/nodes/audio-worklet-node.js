const { MAX_CHANNELS } = require('../constants')
const { AudioNode } = require('../audio-node')
const { AudioParam } = require('../audio-param')
const { invalidStateError, indexSizeError, notSupportedError } = require('../errors')
const { defineEventHandlers, queueTask } = require('../events')
const { makeChannels, resizeChannels, zeroChannels } = require('../mixing')
const { PROCESSOR_PORT, getProcessor, construct, withScope, describeError } = require('../worklet')
const { forwarding, remoteSide, notify } = require('../remote/notify')
const { created } = require('../remote/client')
const { detachPort } = require('../port')
const { applyChannelOptions, checkOptions } = require('./options')

const EMPTY = Object.freeze([])

const paramsObjects = new WeakMap()

const validParamArray = (array, size) => array instanceof Float32Array && array.length === size && !array.buffer.detached

const frozenList = (realm, cache, key, items) => {
	const cached = cache[key]
	if (cached !== undefined && cached.length === items.length) {
		let same = true
		for (let i = 0; i < items.length; i++) {
			if (cached[i] !== items[i]) {
				same = false
				break
			}
		}
		if (same) { return cached }
	}
	const frozen = Object.freeze(realm.Array.from(items))
	cache[key] = frozen
	return frozen
}

class AudioParamMap {
	constructor (entries) {
		this._map = new Map(entries)
	}

	get size () { return this._map.size }
	get (name) { return this._map.get(name) }
	has (name) { return this._map.has(name) }
	keys () { return this._map.keys() }
	values () { return this._map.values() }
	entries () { return this._map.entries() }
	forEach (callback, thisArg) { this._map.forEach((value, key) => callback.call(thisArg, value, key, this)) }
	[Symbol.iterator] () { return this._map.entries() }
}

class AudioWorkletNode extends AudioNode {
	constructor (context, name, rawOptions) {
		const options = checkOptions(rawOptions, 'AudioWorkletNode')
		const entry = getProcessor(String(name), context)
		if (entry === null) { throw invalidStateError(`no AudioWorkletProcessor named '${name}' is registered`) }

		const numberOfInputs = options.numberOfInputs ?? 1
		const numberOfOutputs = options.numberOfOutputs ?? 1
		if (!Number.isInteger(numberOfInputs) || numberOfInputs < 0) { throw new TypeError("numberOfInputs must be a non-negative integer") }
		if (!Number.isInteger(numberOfOutputs) || numberOfOutputs < 0) { throw new TypeError("numberOfOutputs must be a non-negative integer") }
		if (numberOfInputs === 0 && numberOfOutputs === 0) { throw notSupportedError("numberOfInputs and numberOfOutputs can not both be zero") }

		let outputChannelCount = null
		if (options.outputChannelCount !== undefined) {
			outputChannelCount = Array.from(options.outputChannelCount, Number)
			if (outputChannelCount.length !== numberOfOutputs) { throw indexSizeError("outputChannelCount must have numberOfOutputs entries") }
			for (const count of outputChannelCount) {
				if (!Number.isInteger(count) || count < 1 || count > MAX_CHANNELS) { throw notSupportedError(`outputChannelCount entries must be between 1 and ${MAX_CHANNELS}`) }
			}
		}

		super(context, { numberOfInputs, numberOfOutputs })
		applyChannelOptions(this, options)
		context._addSideNode(this)

		this._outputChannelCount = outputChannelCount
		this._entry = entry
		this._failed = false
		this._keepAlive = true
		if (!remoteSide()) { context._liveNodes.add(this) }

		const params = []
		for (const descriptor of entry.descriptors) {
			const param = new AudioParam(context, {
				name: `${name}.${descriptor.name}`,
				defaultValue: descriptor.defaultValue,
				minValue: descriptor.minValue,
				maxValue: descriptor.maxValue,
				automationRate: descriptor.automationRate,
			})
			if (options.parameterData && options.parameterData[descriptor.name] !== undefined) {
				param.value = options.parameterData[descriptor.name]
			}
			params.push([ descriptor.name, param ])
		}
		this._parameters = new AudioParamMap(params)

		let processorPort = options[PROCESSOR_PORT]
		this._port = null
		if (processorPort === undefined) {
			const channel = new MessageChannel()
			this._port = detachPort(channel.port1, context)
			processorPort = channel.port2
		}
		detachPort(processorPort, context)

		const constructorOptions = { numberOfInputs, numberOfOutputs }
		if (outputChannelCount !== null) { constructorOptions.outputChannelCount = outputChannelCount }
		if (options.parameterData !== undefined) { constructorOptions.parameterData = structuredClone(options.parameterData) }
		if (options.processorOptions !== undefined) { constructorOptions.processorOptions = structuredClone(options.processorOptions) }
		for (const key of [ 'channelCount', 'channelCountMode', 'channelInterpretation' ]) {
			if (options[key] !== undefined) { constructorOptions[key] = this[key] }
		}

		this._processor = null
		this._inputLists = new Array(numberOfInputs)
		this._outputLists = new Array(numberOfOutputs)
		this._inputCache = {}
		this._outputCache = {}
		this._inputCopies = new Array(numberOfInputs)
		for (let i = 0; i < numberOfInputs; i++) { this._inputCopies[i] = makeChannels(1, context._quantum) }

		if (context._remote !== null) {
			created(context, this, 'AudioWorkletNode', [ context, name, rawOptions ], { port: processorPort }, { copyShared: false })
			return
		}

		try {
			this._processor = construct(context, entry, constructorOptions, processorPort)
		}
		catch (error) {
			this._fail(error)
		}
	}

	_setKeepAlive (value) {
		if (this._keepAlive === value) { return }
		this._keepAlive = value
		if (forwarding(this)) {
			notify(this, 'keepAlive', value)
			return
		}
		this._hold(value)
	}

	_hold (value) {
		const live = this._context._liveNodes
		if (value) { live.add(this) }
		else { live.delete(this) }
	}

	_fail (error) {
		this._failed = true
		this._setKeepAlive(false)
		for (const channels of this._outputs) { zeroChannels(channels) }
		const described = describeError(error, this._entry)
		queueTask(() => { this._error(described) })
	}

	_mirrorChildren () { return Array.from(this._parameters.values()) }

	_onRemote (type, data) {
		if (type === 'keepAlive') { this._hold(data) }
		else if (type === 'processorerror') { this._error(data) }
	}

	get parameters () { return this._parameters }
	get port () { return this._port }

	_error (described) {
		if (forwarding(this)) {
			notify(this, 'processorerror', described)
			return
		}
		const error = Object.assign(new Error(described.message), { name: described.name ?? 'Error', stack: described.stack ?? undefined })
		const init = { message: described.message, filename: described.filename, lineno: described.lineno, colno: described.colno, error }
		const event = typeof ErrorEvent === 'function'
			? new ErrorEvent('processorerror', init)
			: Object.assign(new Event('processorerror'), init)
		this.dispatchEvent(event)
	}

	_paramSize (param) {
		return param._isConstant() ? 1 : this._context._quantum
	}

	_paramsMatch (params) {
		for (const [ name, param ] of this._parameters) {
			if (!validParamArray(params[name], this._paramSize(param))) { return false }
		}
		return true
	}

	_cloneParams () {
		const params = new this._entry.realm.Object()
		for (const [ name, param ] of this._parameters) {
			const value = new Float32Array(this._paramSize(param))
			Object.defineProperty(params, name, { value, writable: true, enumerable: true, configurable: true })
		}
		return Object.freeze(params)
	}

	_copyParams (params) {
		for (const [ name, param ] of this._parameters) {
			const array = params[name]
			const size = this._paramSize(param)
			if (!validParamArray(array, size)) {
				this._fail(new TypeError(`parameters.${name} is not a Float32Array of ${size} values`))
				return false
			}
			const values = param._block()
			if (size === 1) { array[0] = values[0] }
			else { array.set(values) }
		}
		return true
	}

	_computeActive () {
		return !this._failed && (this._keepAlive || this._hasActiveInputs())
	}

	_process (inputs, outputs) {
		const context = this._context

		for (let o = 0; o < outputs.length; o++) {
			let count
			if (this._outputChannelCount !== null) { count = this._outputChannelCount[o] }
			else if (this._numberOfInputs === 1 && this._numberOfOutputs === 1) { count = inputs[0].length }
			else { count = 1 }
			zeroChannels(this._setOutputChannels(o, count))
		}

		if (this._failed || this._processor === null) { return }
		if (!this._keepAlive && !this._hasActiveInputs()) { return }

		const quantum = context._quantum
		const { realm } = this._entry
		const inputLists = this._inputLists
		for (let i = 0; i < inputs.length; i++) {
			if (!this._inputs[i].some(({ node }) => node._isActive())) {
				inputLists[i] = frozenList(realm, this._inputCache, i, EMPTY)
				continue
			}
			const input = inputs[i]
			const copy = resizeChannels(this._inputCopies[i], input.length, quantum)
			for (let c = 0; c < input.length; c++) {
				if (copy[c].buffer.detached) { copy[c] = new Float32Array(quantum) }
				copy[c].set(input[c])
			}
			this._inputCopies[i] = copy
			inputLists[i] = frozenList(realm, this._inputCache, i, copy)
		}
		const inputsArg = frozenList(realm, this._inputCache, 'all', inputLists)

		const outputLists = this._outputLists
		for (let o = 0; o < outputs.length; o++) {
			const channels = this._outputs[o]
			for (let c = 0; c < channels.length; c++) {
				if (channels[c].buffer.detached) { channels[c] = new Float32Array(quantum) }
			}
			outputLists[o] = frozenList(realm, this._outputCache, o, channels)
		}
		const outputsArg = frozenList(realm, this._outputCache, 'all', outputLists)

		for (const [ , param ] of this._parameters) { param._block() }
		const processor = this._processor
		let params = paramsObjects.get(processor)
		if (params === undefined || !this._paramsMatch(params)) {
			params = this._cloneParams()
			paramsObjects.set(processor, params)
		}
		if (!this._copyParams(params)) { return }

		let keepAlive
		try {
			keepAlive = withScope(context, () => {
				const fn = processor.process
				if (typeof fn !== 'function') { throw new TypeError(`process of '${this._entry.name ?? 'processor'}' is not a function`) }
				return fn.call(processor, inputsArg, outputsArg, params)
			})
		}
		catch (error) {
			this._fail(error)
			return
		}

		this._setKeepAlive(Boolean(keepAlive))

		for (const channels of this._outputs) {
			for (let c = 0; c < channels.length; c++) {
				if (channels[c].buffer.detached) { channels[c] = new Float32Array(quantum) }
			}
		}
	}
}

defineEventHandlers(AudioWorkletNode.prototype, [ 'processorerror' ])

module.exports = { AudioWorkletNode, AudioParamMap }
