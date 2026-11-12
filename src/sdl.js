const { isMainThread } = require('node:worker_threads')

const loadSDL = () => require('@kmamal/sdl')

const { MIN_SAMPLE_RATE, MAX_SAMPLE_RATE } = require('./constants')

const loadHostSDL = () => {
	if (!isMainThread) { return }
	try { loadSDL() }
	catch {}
}

const preferredSampleRate = (type, device) => {
	try {
		const { frequency } = device ?? loadSDL().audio[type].devices[0]
		return Number.isInteger(frequency) && frequency >= MIN_SAMPLE_RATE && frequency <= MAX_SAMPLE_RATE ? frequency : null
	}
	catch {
		return null
	}
}

const isDefaultId = (wanted) => wanted === '' || wanted === 'default' || wanted === null || wanted === undefined

const findDevice = (type, wanted) => {
	if (isDefaultId(wanted)) { return null }
	const devices = loadSDL().audio[type].devices
	const string = String(wanted)
	const device = devices.find((d) => d.id !== null && `${type}:${d.id}` === string)
	return device ?? undefined
}

const listDevices = (type) => loadSDL().audio[type].devices

module.exports = { loadSDL, loadHostSDL, preferredSampleRate, findDevice, listDevices }
