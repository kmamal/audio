const { RENDER_QUANTUM: BLOCK } = require('../constants')

const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b))

class BlockAdapter {
	constructor (quantum) {
		this.quantum = quantum
		this.aligned = quantum % BLOCK === 0
		this.inputs = []
		this.outputs = []
		this.inputLength = BLOCK - gcd(quantum, BLOCK)
		this.outputLength = 0
		this.inputCapacity = BLOCK + quantum
		this.outputCapacity = 2 * (BLOCK + quantum)
	}

	process (input, out, callback) {
		const quantum = this.quantum
		if (this.aligned) {
			if (quantum === BLOCK) {
				callback(input, out)
				return
			}
			for (let k = 0; k < quantum; k += BLOCK) {
				callback(input.map((c) => c.subarray(k, k + BLOCK)), out.map((c) => c.subarray(k, k + BLOCK)))
			}
			return
		}

		const inputs = this.inputs
		const outputs = this.outputs
		while (inputs.length < input.length) { inputs.push(new Float32Array(this.inputCapacity)) }
		inputs.length = input.length
		while (outputs.length < out.length) { outputs.push(new Float32Array(this.outputCapacity)) }
		outputs.length = out.length

		let inputLength = this.inputLength
		for (let c = 0; c < input.length; c++) { inputs[c].set(input[c], inputLength) }
		inputLength += quantum

		let outputLength = this.outputLength
		while (inputLength >= BLOCK) {
			const blockInputs = inputs.map((f) => f.subarray(0, BLOCK))
			const blockOutputs = outputs.map((f) => f.subarray(outputLength, outputLength + BLOCK))
			for (const channel of blockOutputs) { channel.fill(0) }
			callback(blockInputs, blockOutputs)
			for (const f of inputs) { f.copyWithin(0, BLOCK, inputLength) }
			inputLength -= BLOCK
			outputLength += BLOCK
		}

		for (let c = 0; c < out.length; c++) {
			const f = outputs[c]
			out[c].set(f.subarray(0, quantum))
			f.copyWithin(0, quantum, outputLength)
		}
		outputLength -= quantum

		this.inputLength = inputLength
		this.outputLength = outputLength
	}
}

module.exports = { BlockAdapter, BLOCK }
