import T from '@kmamal/testing'
import Fs from 'node:fs'
import Path from 'node:path'
import { spawnSync } from 'node:child_process'
import { audio, assert, near, render, sleep, throwsName, require, RATE } from './helpers.mjs'

const { currentClient } = require('../src/remote/client.js')
const { CLOCK } = require('../src/context/clock.js')

const silentContext = (options = {}) => new audio.AudioContext({ sinkId: { type: 'none' }, sampleRate: RATE, ...options })

const latest = (analyser, size = analyser.fftSize) => {
	const data = new Float32Array(size)
	analyser.getFloatTimeDomainData(data)
	return data
}

T.test("audio::regressions::worklet ports keep the process alive until the context closes", () => {
	const script = (listen) => `
		const audio = require(${JSON.stringify(Path.join(import.meta.dirname, '../src/index.js'))})
		const context = new audio.OfflineAudioContext({ length: 128, sampleRate: 48000 })
		${listen ? 'context.audioWorklet.port.onmessage = () => {}' : 'context.audioWorklet.port'}
		const start = Date.now()
		setTimeout(() => { context.close() }, 300).unref()
		process.on('exit', () => { process.stdout.write(String(Date.now() - start)) })
	`
	const run = (listen) => {
		const result = spawnSync(process.execPath, [ '-e', script(listen) ], { encoding: 'utf8', timeout: 10e3 })
		assert.equal(result.status, 0, result.stderr)
		return Number(result.stdout)
	}
	assert.ok(run(true) >= 300, 'a port with a message listener holds the process until close()')
	assert.ok(run(false) < 300, 'a port without a listener does not hold the process')
})

T.test("audio::regressions::an active worklet node survives garbage collection", () => {
	const script = `
		const audio = require(${JSON.stringify(Path.join(import.meta.dirname, '../src/index.js'))})
		audio.configure({ workers: process.env.WORKERS === '1' })
		const context = new audio.AudioContext({ sinkId: { type: 'none' } })
		const source = 'class P extends AudioWorkletProcessor { constructor () { super(); this.start = currentTime } process () { if (currentTime - this.start >= 0.3) { this.port.postMessage("done"); return false } return true } } registerProcessor("p", P)'
		context.audioWorklet.addModule('data:text/javascript,' + encodeURIComponent(source)).then(() => {
			const node = new audio.AudioWorkletNode(context, 'p')
			node.port.onmessage = () => { context.close().then(() => { process.stdout.write('done') }) }
		})
		setInterval(() => { globalThis.gc() }, 20).unref()
		setTimeout(() => { process.stdout.write('timeout'); process.exit(1) }, 5000).unref()
	`
	for (const workers of [ '0', '1' ]) {
		const result = spawnSync(process.execPath, [ '--expose-gc', '-e', script ], { encoding: 'utf8', timeout: 20e3, env: { ...process.env, WORKERS: workers } })
		assert.equal(result.stdout, 'done', `workers=${workers}: ${result.stderr}`)
	}
})

T.test("audio::regressions::a script processor with a listener survives garbage collection", () => {
	const script = `
		const audio = require(${JSON.stringify(Path.join(import.meta.dirname, '../src/index.js'))})
		audio.configure({ workers: process.env.WORKERS === '1' })
		const context = new audio.AudioContext({ sinkId: { type: 'none' } })
		const source = context.createConstantSource()
		let fired = false
		source.connect(context.createScriptProcessor(256, 1, 1)).onaudioprocess = () => {
			if (fired) { return }
			fired = true
			context.close().then(() => { process.stdout.write('done') })
		}
		source.start()
		setInterval(() => { globalThis.gc() }, 20).unref()
		setTimeout(() => { process.stdout.write('timeout'); process.exit(1) }, 5000).unref()
	`
	for (const workers of [ '0', '1' ]) {
		const result = spawnSync(process.execPath, [ '--expose-gc', '-e', script ], { encoding: 'utf8', timeout: 20e3, env: { ...process.env, WORKERS: workers } })
		assert.equal(result.stdout, 'done', `workers=${workers}: ${result.stderr}`)
	}
})

T.test("audio::regressions::shared arrays are copied when calls are mirrored", async (t) => {
	t.timeout(5e3)
	const context = silentContext()
	const scratch = new Float32Array(new SharedArrayBuffer(8))
	const source = context.createConstantSource()
	const shaper = context.createWaveShaper()
	const analyser = context.createAnalyser()
	scratch.set([ 0.25, 0.25 ])
	shaper.curve = scratch
	scratch.set([ 0.75, 0.75 ])

	const gain = context.createGain()
	const curve = new Float32Array(new SharedArrayBuffer(8))
	curve.set([ 0.5, 0.5 ])
	gain.gain.setValueCurveAtTime(curve, 0, 100)
	curve.set([ 2, 2 ])

	const second = context.createAnalyser()
	source.connect(shaper).connect(analyser)
	source.connect(gain).connect(second)
	source.start()
	await sleep(300)
	assert.equal(latest(analyser, 32)[31], 0.25)
	assert.equal(latest(second, 32)[31], 0.5)
	await context.close()
})

T.test("audio::regressions::a new render thread replaces a dead one", async (t) => {
	t.timeout(10e3)
	const first = silentContext()
	let errors = 0
	first.onerror = () => { errors++ }
	await sleep(100)
	const dead = currentClient()
	await dead._worker.terminate()
	await sleep(50)
	assert.equal(errors, 1)
	assert.equal(first.state, 'closed')

	const second = silentContext()
	assert.notEqual(second._remote, dead)
	const source = second.createConstantSource()
	const analyser = second.createAnalyser()
	source.connect(analyser)
	source.start()
	await sleep(200)
	assert.ok(second.currentTime > 0.05)
	assert.equal(latest(analyser, 32)[31], 1)
	await second.close()
})

T.test("audio::regressions::byte time domain data is floored", async () => {
	const context = new audio.OfflineAudioContext(1, 1024, RATE)
	const source = new audio.ConstantSourceNode(context, { offset: -1 / 256 })
	const analyser = new audio.AnalyserNode(context, { fftSize: 32 })
	source.connect(analyser).connect(context.destination)
	source.start()
	await context.startRendering()
	const bytes = new Uint8Array(32)
	analyser.getByteTimeDomainData(bytes)
	assert.equal(bytes[31], 127)
})

T.test("audio::regressions::numeric arguments use WebIDL conversions", async () => {
	await render(0.01, (context) => {
		const gain = context.createGain()
		gain.channelCount = '1'
		assert.equal(gain.channelCount, 1)
		gain.channelCount = 2.9
		assert.equal(gain.channelCount, 2)
		throwsName(() => { gain.channelCount = 0 }, 'NotSupportedError')

		const source = context.createConstantSource()
		assert.equal(source.connect(gain, '0', 0.5), gain)
		source.disconnect('0')
		source.connect(gain)
		throwsName(() => source.disconnect(1), 'IndexSizeError')
		source.disconnect(gain, '0', '0')
		throwsName(() => source.connect(gain, -1), 'IndexSizeError')

		const buffer = context.createBuffer(2, 4, RATE)
		assert.equal(buffer.getChannelData('1'), buffer.getChannelData(1))
		throwsName(() => buffer.getChannelData(2), 'IndexSizeError')

		const analyser = context.createAnalyser()
		analyser.fftSize = '64'
		assert.equal(analyser.fftSize, 64)
		assert.equal(context.createChannelMerger('3').numberOfInputs, 3)
		assert.equal(context.createChannelSplitter(2.5).numberOfOutputs, 2)
		assert.equal(context.createScriptProcessor('256', '1', '1').bufferSize, 256)
	})
})

T.test("audio::regressions::renderCapacity reports the render load", async (t) => {
	t.timeout(5e3)
	const context = silentContext()
	assert.equal(context.renderCapacity, context.renderCapacity)
	const events = []
	context.renderCapacity.onupdate = (event) => { events.push(event) }
	assert.throws(() => context.renderCapacity.start({ updateInterval: 0 }), RangeError)
	context.renderCapacity.start({ updateInterval: 0.1 })
	await sleep(450)
	context.renderCapacity.stop()
	const count = events.length
	assert.ok(count >= 3, `${count} updates`)
	for (const event of events) {
		assert.ok(event instanceof audio.AudioRenderCapacityEvent)
		for (const key of [ 'averageLoad', 'peakLoad', 'underrunRatio' ]) {
			assert.ok(event[key] >= 0 && event[key] <= 1, `${key} is ${event[key]}`)
		}
		assert.ok(event.timestamp >= 0)
	}
	await sleep(250)
	assert.equal(events.length, count)
	assert.ok(context._clock[CLOCK.RENDERED] > 0)
	await context.close()
})

T.test("audio::regressions::worklet imports go through the configured fetch", async (t) => {
	t.timeout(10e3)
	const files = {
		'http://modules.test/main.js': "import { level } from './level.js'\nregisterProcessor('fetched', class extends AudioWorkletProcessor { process (inputs, outputs) { outputs[0][0].fill(level); return true } })",
		'http://modules.test/level.js': 'export const level = 0.5',
	}
	const requested = []
	audio.configure({
		fetch: (url) => {
			requested.push(String(url))
			return Promise.resolve(files[url] ? new Response(files[url]) : new Response(null, { status: 404 }))
		},
	})
	try {
		const context = silentContext()
		await context.audioWorklet.addModule('http://modules.test/main.js')
		const node = new audio.AudioWorkletNode(context, 'fetched')
		const analyser = context.createAnalyser()
		node.connect(analyser)
		await sleep(200)
		assert.equal(latest(analyser, 32)[31], 0.5)
		assert.deepEqual(requested.sort(), Object.keys(files).sort())
		await context.close()
	}
	finally {
		audio.configure({ fetch: null })
	}
})

T.test("audio::regressions::processors registered after addModule() are known to the calling thread", async (t) => {
	t.timeout(10e3)
	const directory = Fs.mkdtempSync(Path.join(Fs.realpathSync(require('node:os').tmpdir()), 'audio-'))
	const file = Path.join(directory, 'dynamic.js')
	Fs.writeFileSync(file, `
		registerProcessor('outer', class extends AudioWorkletProcessor {
			constructor () {
				super()
				registerProcessor('inner', class extends AudioWorkletProcessor { process () { return true } })
				this.port.postMessage('registered')
			}
			process () { return true }
		})
	`)
	const context = silentContext()
	await context.audioWorklet.addModule(file)
	const outer = new audio.AudioWorkletNode(context, 'outer')
	const inner = await new Promise((resolve) => {
		outer.port.onmessage = () => { resolve(new audio.AudioWorkletNode(context, 'inner')) }
	})
	assert.ok(inner instanceof audio.AudioWorkletNode)
	outer.port.onmessage = null
	await context.close()
	Fs.rmSync(directory, { recursive: true })
})

T.test("audio::regressions::rendering starts after the graph is built", async (t) => {
	t.timeout(10e3)
	for (const workers of [ true, false ]) {
		audio.configure({ workers })
		try {
			const context = silentContext({ sampleRate: 16384 })
			assert.equal(context.currentTime, 0)
			const pulse = new audio.AudioBuffer({ length: 4096, sampleRate: 16384 })
			pulse.getChannelData(0).fill(1)
			const convolver = new audio.ConvolverNode(context, { buffer: pulse, disableNormalization: true })
			const source = new audio.ConstantSourceNode(context, { offset: 0 })
			const start = context.currentTime + 256 / 16384
			source.offset.setValueAtTime(1, start)
			const recorder = context.createScriptProcessor(1024, 1, 1)
			const captured = []
			recorder.onaudioprocess = (event) => { captured.push(Float32Array.from(event.inputBuffer.getChannelData(0))) }
			source.connect(convolver).connect(recorder).connect(context.destination)
			source.start()
			while (captured.length < 4) { await sleep(20) }
			const data = new Float32Array(4096)
			for (let i = 0; i < 4; i++) { data.set(captured[i], i * 1024) }
			near(data[255], 0, 1e-4, `workers: ${workers}`)
			near(data[256], 1, 1e-4, `workers: ${workers}`)
			near(data[256 + 1000], 1001, 1e-2, `workers: ${workers}`)
			await context.close()
		}
		finally {
			audio.configure({ workers: true })
		}
	}
})

T.test("audio::regressions::the default sample rate follows the device", async (t) => {
	t.timeout(10e3)
	let sdl
	try { sdl = require('@kmamal/sdl') }
	catch { return }
	if (!sdl.audio.isAvailable()) { return }
	const { frequency } = sdl.audio.playback.devices[0]
	const context = new audio.AudioContext()
	assert.equal(context.sampleRate, frequency)
	await sleep(300)
	if (sdl.audio.playback.devices.length > 1) { assert.equal(context._sinkKind, 'sdl') }
	await context.close()
})
