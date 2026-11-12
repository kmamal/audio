const { MAX_CHANNELS } = require('./constants')
const { AudioParam } = require('./audio-param')
const { indexSizeError, invalidAccessError, notSupportedError, isEnum, toUnsignedLong } = require('./errors')
const { mixAdd, makeChannels, resizeChannels, zeroChannels } = require('./mixing')

const COUNT_MODES = [ 'max', 'clamped-max', 'explicit' ]
const INTERPRETATIONS = [ 'speakers', 'discrete' ]

class AudioNode extends EventTarget {
	constructor (context, options = {}) {
		super()
		if (!context || typeof context !== 'object' || typeof context._renderBlock !== 'function') { throw new TypeError("context must be a BaseAudioContext") }

		const {
			numberOfInputs = 1,
			numberOfOutputs = 1,
			channelCount = 2,
			channelCountMode = 'max',
			channelInterpretation = 'speakers',
		} = options

		this._context = context
		this._numberOfInputs = numberOfInputs
		this._numberOfOutputs = numberOfOutputs
		this._channelCount = channelCount
		this._channelCountMode = channelCountMode
		this._channelInterpretation = channelInterpretation

		const quantum = context._quantum
		this._inputs = new Array(numberOfInputs)
		this._inputMixes = new Array(numberOfInputs)
		this._inputBlocks = new Array(numberOfInputs)
		for (let i = 0; i < numberOfInputs; i++) {
			this._inputs[i] = []
			this._inputMixes[i] = makeChannels(1, quantum)
			this._inputBlocks[i] = this._inputMixes[i]
		}

		this._outputs = new Array(numberOfOutputs)
		this._outputConnections = new Array(numberOfOutputs)
		for (let i = 0; i < numberOfOutputs; i++) {
			this._outputs[i] = makeChannels(1, quantum)
			this._outputConnections[i] = []
		}

		this._pulled = new Array(numberOfInputs)
		for (let i = 0; i < numberOfInputs; i++) { this._pulled[i] = [] }

		this._blockId = -1
		this._busy = false
		this._muted = false
		this._activeBlockId = -1
		this._activeValue = false
		this._activeBusy = false
		this._lastActiveFrame = null
	}

	_mirrorChildren () {
		return Object.values(this).filter((value) => value instanceof AudioParam)
	}

	get context () { return this._context }
	get numberOfInputs () { return this._numberOfInputs }
	get numberOfOutputs () { return this._numberOfOutputs }

	get channelCount () { return this._channelCount }
	set channelCount (rawCount) {
		const count = toUnsignedLong(rawCount)
		if (count < 1 || count > MAX_CHANNELS) { throw notSupportedError(`channelCount must be between 1 and ${MAX_CHANNELS}`) }
		this._setChannelCount(count)
	}

	_setChannelCount (count) { this._channelCount = count }

	get channelCountMode () { return this._channelCountMode }
	set channelCountMode (mode) {
		if (!isEnum(mode, COUNT_MODES)) { return }
		this._setChannelCountMode(mode)
	}

	_setChannelCountMode (mode) { this._channelCountMode = mode }

	get channelInterpretation () { return this._channelInterpretation }
	set channelInterpretation (interpretation) {
		if (!isEnum(interpretation, INTERPRETATIONS)) { return }
		this._setChannelInterpretation(interpretation)
	}

	_setChannelInterpretation (interpretation) { this._channelInterpretation = interpretation }

	connect (destination, rawOutput = 0, rawInput = 0) {
		if (!(destination instanceof AudioNode) && !(destination instanceof AudioParam)) {
			throw new TypeError("destination must be an AudioNode or an AudioParam")
		}
		const output = toUnsignedLong(rawOutput)
		const input = toUnsignedLong(rawInput)
		if (destination._context !== this._context) { throw invalidAccessError("destination belongs to a different AudioContext") }
		if (output >= this._numberOfOutputs) { throw indexSizeError(`output index ${rawOutput} is out of range`) }

		if (destination instanceof AudioParam) {
			for (const record of destination._inputs) {
				if (record.node === this && record.output === output) { return undefined }
			}
			const record = { node: this, output }
			destination._inputs.add(record)
			this._outputConnections[output].push({ target: destination, record })
			this._context._graphChanged()
			return undefined
		}

		if (input >= destination._numberOfInputs) { throw indexSizeError(`input index ${rawInput} is out of range`) }

		const connections = destination._inputs[input]
		for (const record of connections) {
			if (record.node === this && record.output === output) { return destination }
		}
		const record = { node: this, output }
		connections.push(record)
		this._outputConnections[output].push({ target: destination, input, record })
		destination._onInputChanged?.()
		this._context._graphChanged()
		return destination
	}

	_removeConnection (entry) {
		if (entry.target instanceof AudioParam) {
			entry.target._inputs.delete(entry.record)
		}
		else {
			const connections = entry.target._inputs[entry.input]
			const index = connections.indexOf(entry.record)
			if (index !== -1) { connections.splice(index, 1) }
			entry.target._onInputChanged?.()
		}
		this._context._graphChanged()
	}

	_predecessors () {
		const nodes = []
		for (const connections of this._inputs) {
			for (const { node } of connections) { nodes.push(node) }
		}
		for (const child of this._mirrorChildren()) {
			if (!(child instanceof AudioParam)) { continue }
			for (const { node } of child._inputs) { nodes.push(node) }
		}
		return nodes
	}

	disconnect (...args) {
		if (args.length === 0) {
			for (let o = 0; o < this._numberOfOutputs; o++) {
				for (const entry of this._outputConnections[o]) { this._removeConnection(entry) }
				this._outputConnections[o] = []
			}
			return
		}

		const [ first ] = args

		if (!(first instanceof AudioNode) && !(first instanceof AudioParam)) {
			const index = toUnsignedLong(first)
			if (index >= this._numberOfOutputs) { throw indexSizeError(`output index ${first} is out of range`) }
			for (const entry of this._outputConnections[index]) { this._removeConnection(entry) }
			this._outputConnections[index] = []
			return
		}

		const output = args.length > 1 ? toUnsignedLong(args[1]) : null
		const input = args.length > 2 ? toUnsignedLong(args[2]) : null
		if (output !== null && output >= this._numberOfOutputs) { throw indexSizeError(`output index ${args[1]} is out of range`) }
		if (input !== null && first instanceof AudioNode && input >= first._numberOfInputs) { throw indexSizeError(`input index ${args[2]} is out of range`) }

		let found = false
		for (let o = 0; o < this._numberOfOutputs; o++) {
			if (output !== null && o !== output) { continue }
			const remaining = []
			for (const entry of this._outputConnections[o]) {
				const matches = entry.target === first && (input === null || entry.input === input)
				if (matches) {
					this._removeConnection(entry)
					found = true
				}
				else {
					remaining.push(entry)
				}
			}
			this._outputConnections[o] = remaining
		}

		if (!found) { throw invalidAccessError("the given destination is not connected") }
	}

	_computedInputChannels (connections) {
		if (this._channelCountMode === 'explicit') { return this._channelCount }
		let max = 1
		for (const { node, output } of connections) { max = Math.max(max, node._outputs[output].length) }
		if (this._channelCountMode === 'clamped-max') { return Math.min(max, this._channelCount) }
		return max
	}

	_pull (output = 0) {
		const context = this._context
		if (this._blockId === context._blockId) { return this._outputs[output] }

		if (this._muted) {
			this._blockId = context._blockId
			for (const channels of this._outputs) { zeroChannels(channels) }
			return this._outputs[output]
		}

		if (this._busy) { return this._cycleOutput(output) }

		this._busy = true
		try {
			this._render()
		}
		finally {
			this._busy = false
		}
		this._blockId = context._blockId
		return this._outputs[output]
	}

	_cycleOutput (output) {
		const channels = this._outputs[output]
		zeroChannels(channels)
		return channels
	}

	_render () {
		this._gatherInputs()
		this._process(this._inputBlocks, this._outputs)
	}

	_gatherInputs () {
		const inputs = this._inputBlocks
		for (let i = 0; i < this._numberOfInputs; i++) {
			const connections = this._inputs[i]
			const pulled = this._pulled[i]
			pulled.length = connections.length
			for (let c = 0; c < connections.length; c++) {
				const { node, output } = connections[c]
				pulled[c] = node._pull(output)
			}

			const count = this._computedInputChannels(connections)
			if (connections.length === 1 && pulled[0].length === count) {
				inputs[i] = pulled[0]
				continue
			}

			const mix = resizeChannels(this._inputMixes[i], count, this._context._quantum)
			zeroChannels(mix)
			for (const channels of pulled) { mixAdd(mix, channels, this._channelInterpretation) }
			inputs[i] = mix
		}
	}

	_process (inputs, outputs) {
		for (let o = 0; o < outputs.length; o++) {
			const input = inputs[o]
			if (input) {
				const out = this._setOutputChannels(o, input.length)
				for (let c = 0; c < input.length; c++) { out[c].set(input[c]) }
			}
			else {
				zeroChannels(this._setOutputChannels(o, 1))
			}
		}
	}

	_setOutputChannels (index, count) {
		const channels = resizeChannels(this._outputs[index], count, this._context._quantum)
		this._outputs[index] = channels
		return channels
	}

	_silence (index = 0, count = 1) {
		const channels = this._setOutputChannels(index, count)
		zeroChannels(channels)
		return channels
	}

	_hasInputConnections () {
		for (const connections of this._inputs) {
			if (connections.length > 0) { return true }
		}
		return false
	}

	_hasActiveInputs () {
		for (const connections of this._inputs) {
			for (const { node } of connections) {
				if (node._isActive()) { return true }
			}
		}
		return false
	}

	_isActive () {
		const context = this._context
		if (this._activeBlockId === context._blockId) { return this._activeValue }
		if (this._activeBusy) { return false }
		this._activeBusy = true
		let active
		try { active = this._computeActive() }
		finally { this._activeBusy = false }
		this._activeBlockId = context._blockId
		this._activeValue = active
		return active
	}

	_tailFrames () { return 0 }

	_computeActive () {
		const frame = this._context._frame
		if (this._hasActiveInputs()) {
			this._lastActiveFrame = frame
			return true
		}
		return this._lastActiveFrame !== null && frame - this._lastActiveFrame <= this._tailFrames()
	}
}

module.exports = { AudioNode }
