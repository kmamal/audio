
class GainProcessor extends globalThis.AudioWorkletProcessor {
	static get parameterDescriptors () {
		return [ { name: 'gain', defaultValue: 1, minValue: 0, maxValue: 10, automationRate: 'a-rate' } ]
	}

	constructor (options) {
		super()
		this.options = options
		this.port.onmessage = (event) => {
			this.port.postMessage({ echo: event.data, sampleRate: globalThis.sampleRate, processorOptions: options.processorOptions })
		}
	}

	process (inputs, outputs, parameters) {
		const input = inputs[0]
		const output = outputs[0]
		const gain = parameters.gain
		for (let c = 0; c < output.length; c++) {
			const source = input[c]
			if (!source) { continue }
			const target = output[c]
			for (let i = 0; i < target.length; i++) {
				target[i] = source[i] * (gain.length > 1 ? gain[i] : gain[0])
			}
		}
		return true
	}
}

globalThis.registerProcessor('gain-processor', GainProcessor)
