
class ThrowingProcessor extends globalThis.AudioWorkletProcessor {
	process () {
		throw new RangeError("processor failed")
	}
}

globalThis.registerProcessor('throwing-processor', ThrowingProcessor)
