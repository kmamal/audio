const { parentPort } = require('node:worker_threads')
const { decodeAudio } = require('../decode')
const { resample } = require('../dsp/resample')
const { toShared, ownChannels } = require('./shared')

const handlers = {
	async decode ({ bytes, sampleRate, shared }) {
		const decoded = await decodeAudio(bytes)
		const rate = sampleRate ?? decoded.sampleRate
		const resampled = resample(decoded.channelData, decoded.sampleRate, rate)
		if (shared) { return { result: { channels: resampled.map(toShared), sampleRate: rate }, transfer: [] } }
		const channels = ownChannels(resampled)
		return { result: { channels, sampleRate: rate }, transfer: channels.map((channel) => channel.buffer) }
	},
}

parentPort.on('message', async ({ id, type, ...payload }) => {
	try {
		const { result, transfer } = await handlers[type](payload)
		parentPort.postMessage({ id, result }, transfer)
	}
	catch (error) {
		parentPort.postMessage({ id, error: error.message })
	}
})
