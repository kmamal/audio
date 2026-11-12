import T from '@kmamal/testing'
import Path from 'node:path'
import { Worker } from 'node:worker_threads'
import { require, assert } from './helpers.mjs'

const sdl = require('@kmamal/sdl')

const indexPath = Path.join(import.meta.dirname, '../src/index.js')

const runWorker = (body, workerData) => new Promise((resolve, reject) => {
	const worker = new Worker(`
		const audio = require(${JSON.stringify(indexPath)})
		const { SDLSink } = require(${JSON.stringify(Path.join(import.meta.dirname, '../src/sink/sdl.js'))})
		const { parentPort, workerData } = require('node:worker_threads')
		const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })
		;(async () => { ${body} })().then(
			(result) => { parentPort.postMessage({ result }) },
			(error) => { parentPort.postMessage({ error: { name: error.name, message: error.message } }) },
		)
	`, { eval: true, workerData })
	let message = null
	worker.on('message', (m) => { message = m })
	worker.on('error', reject)
	worker.on('exit', () => {
		if (message?.error) { reject(Object.assign(new Error(message.error.message), { name: message.error.name })) }
		else { resolve(message?.result) }
	})
})

T.test("audio::worker::playback", async (t) => {
	t.timeout(20e3)
	const device = sdl.audio.playback.devices[0] ?? null
	const result = await runWorker(`
		const out = []
		for (const sinkId of [ '', workerData.sinkId ]) {
			const context = new audio.AudioContext({ sinkId })
			const osc = context.createOscillator()
			const gain = context.createGain()
			gain.gain.value = 0.02
			osc.connect(gain).connect(context.destination)
			osc.start()
			await sleep(200)
			out.push({
				sdl: context._sink instanceof SDLSink,
				sinkId: context.sinkId,
				currentTime: context.currentTime,
				outputLatency: context.outputLatency,
			})
			await context.close()
		}
		return out
	`, { sinkId: device === null || device.id === null ? 'default' : `playback:${device.id}` })

	for (const entry of result) {
		assert.ok(entry.sdl, 'the worker plays through SDL')
		assert.ok(entry.currentTime > 0.1, `currentTime ${entry.currentTime}`)
		assert.ok(entry.outputLatency > 0 && entry.outputLatency < 1, `outputLatency ${entry.outputLatency}`)
	}
})

T.test("audio::worker::devices", async (t) => {
	t.timeout(20e3)
	const result = await runWorker(`
		const context = new audio.AudioContext({ sinkId: { type: 'none' } })
		let rejected = null
		try { await context.setSinkId('Some Device Name') }
		catch (error) { rejected = error.name }
		await context.close()
		const list = await audio.getMediaDevices().enumerateDevices()
		return { rejected, list }
	`)
	assert.equal(result.rejected, 'NotFoundError')
	const expected = [
		...sdl.audio.recording.devices.map((d) => [ d.id === null ? 'default' : `recording:${d.id}`, 'audioinput', d.name ?? 'Default' ]),
		...sdl.audio.playback.devices.map((d) => [ d.id === null ? 'default' : `playback:${d.id}`, 'audiooutput', d.name ?? 'Default' ]),
	]
	assert.deepEqual(result.list.map((d) => [ d.deviceId, d.kind, d.label ]), expected)
})

T.test("audio::worker::offline rendering", async (t) => {
	t.timeout(20e3)
	const result = await runWorker(`
		const context = new audio.OfflineAudioContext({ numberOfChannels: 1, length: 4800, sampleRate: 48000 })
		const source = context.createConstantSource()
		source.offset.value = 0.5
		source.connect(context.destination)
		source.start()
		const buffer = await context.startRendering()
		return buffer.getChannelData(0)[100]
	`)
	assert.equal(result, 0.5)
})
