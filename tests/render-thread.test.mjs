import T from '@kmamal/testing'
import Fs from 'node:fs'
import Path from 'node:path'
import { spawnSync } from 'node:child_process'
import V8 from 'node:v8'
import Vm from 'node:vm'
import { audio, assets, fixtures, assert, near, peak, rms, sleep, tick, RATE } from './helpers.mjs'

const silentContext = () => new audio.AudioContext({ sinkId: { type: 'none' }, sampleRate: RATE })

const block = (ms) => {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

const latest = (analyser) => {
	const data = new Float32Array(analyser.fftSize)
	analyser.getFloatTimeDomainData(data)
	return data
}

const probe = (context, source) => {
	const analyser = context.createAnalyser()
	source.connect(analyser)
	return analyser
}

T.test("audio::render-thread::keeps rendering while the main thread is blocked", async (t) => {
	t.timeout(20e3)
	const context = silentContext()
	assert.ok(context._remote !== null)
	const osc = context.createOscillator()
	const analyser = probe(context, osc)
	osc.start()
	await sleep(100)

	const before = context.currentTime
	block(300)
	const advanced = context.currentTime - before
	assert.ok(advanced > 0.25, `currentTime advanced ${advanced}s while blocked`)
	assert.ok(peak(latest(analyser)) > 0.9, 'the analyser sees the oscillator')
	assert.ok(context.outputLatency > 0, `outputLatency ${context.outputLatency}`)
	await context.close()
})

T.test("audio::render-thread::ended events and automation", async (t) => {
	t.timeout(20e3)
	const context = silentContext()
	const source = context.createConstantSource()
	const gain = context.createGain()
	const analyser = probe(context, gain)
	source.connect(gain)
	await sleep(50)

	const now = context.currentTime
	gain.gain.setValueAtTime(0.25, now)
	gain.gain.linearRampToValueAtTime(0.75, now + 0.4)
	source.start()
	source.stop(now + 0.7)
	const ended = new Promise((resolve) => { source.onended = resolve })

	await sleep(150)
	assert.ok(gain.gain.value > 0.25 && gain.gain.value < 0.75, `ramping value ${gain.gain.value}`)
	await sleep(400)
	near(latest(analyser)[analyser.fftSize - 1], 0.75, 1e-3, 'ramp end reaches the output')
	near(gain.gain.value, 0.75, 1e-6, 'value getter after the ramp')

	gain.disconnect()
	await sleep(50)
	near(peak(latest(analyser)), 0, 1e-6, 'disconnect reaches the render thread')

	await ended
	assert.ok(context.currentTime >= now + 0.7)
	await context.close()
})

T.test("audio::render-thread::analyser frequency data", async (t) => {
	t.timeout(20e3)
	const context = silentContext()
	const osc = context.createOscillator()
	osc.frequency.value = 1500
	const analyser = probe(context, osc)
	analyser.fftSize = 4096
	osc.start()
	await sleep(200)
	const spectrum = new Float32Array(analyser.frequencyBinCount)
	analyser.getFloatFrequencyData(spectrum)
	let best = 0
	for (let k = 1; k < spectrum.length; k++) {
		if (spectrum[k] > spectrum[best]) { best = k }
	}
	near(best * RATE / analyser.fftSize, 1500, RATE / analyser.fftSize, 'peak bin')
	await context.close()
})

T.test("audio::render-thread::script processor round trip", async (t) => {
	t.timeout(20e3)
	const context = silentContext()
	const source = context.createConstantSource()
	source.offset.value = 0.25
	const processor = context.createScriptProcessor(512, 1, 1)
	const times = []
	processor.onaudioprocess = (event) => {
		times.push(event.playbackTime)
		const input = event.inputBuffer.getChannelData(0)
		const output = event.outputBuffer.getChannelData(0)
		for (let i = 0; i < input.length; i++) { output[i] = input[i] * 2 }
	}
	source.connect(processor)
	const analyser = probe(context, processor)
	source.start()
	await sleep(300)
	assert.ok(times.length > 10, `${times.length} audioprocess events`)
	near(times[1] - times[0], 512 / RATE, 1e-9, 'playbackTime steps by bufferSize')
	near(latest(analyser)[0], 0.5, 1e-6, 'processed output is played')
	await context.close()
})

T.test("audio::render-thread::audio worklet", async (t) => {
	t.timeout(20e3)
	const context = silentContext()
	await context.audioWorklet.addModule(Path.join(fixtures, 'gain-processor.js'))
	const node = new audio.AudioWorkletNode(context, 'gain-processor', { processorOptions: { answer: 42 }, parameterData: { gain: 3 } })
	assert.equal(node.parameters.get('gain').value, 3)

	const reply = new Promise((resolve) => {
		node.port.onmessage = (event) => { resolve(event.data) }
	})
	node.port.postMessage({ hello: 'processor' })
	const message = await reply
	assert.deepEqual(message.echo, { hello: 'processor' })
	assert.equal(message.sampleRate, RATE)
	assert.deepEqual(message.processorOptions, { answer: 42 })

	const source = context.createConstantSource()
	source.offset.value = 0.1
	source.connect(node)
	const analyser = probe(context, node)
	source.start()
	await sleep(150)
	near(latest(analyser)[0], 0.3, 1e-6, 'parameterData reaches the processor')
	node.parameters.get('gain').value = 5
	await sleep(100)
	near(latest(analyser)[0], 0.5, 1e-6, 'parameter changes reach the processor')

	await context.audioWorklet.addModule(Path.join(fixtures, 'throwing-processor.js'))
	const broken = new audio.AudioWorkletNode(context, 'throwing-processor')
	broken.connect(context.destination)
	const event = await new Promise((resolve) => { broken.onprocessorerror = resolve })
	assert.equal(event.error.name, 'RangeError')
	assert.equal(event.message, 'processor failed')

	await context.audioWorklet.addModule(`data:text/javascript,${encodeURIComponent(`
		registerProcessor('thrower', class extends AudioWorkletProcessor {
			constructor () {
				super()
				this.count = 0
				this.port.onmessage = () => { throw new Error("handler failed") }
			}
			process () {
				this.port.postMessage(++this.count)
				return true
			}
		})
	`)}`)
	const thrower = new audio.AudioWorkletNode(context, 'thrower')
	thrower.connect(context.destination)
	let last = 0
	thrower.port.onmessage = (e) => { last = e.data }
	thrower.onprocessorerror = () => { assert.fail('a throwing message handler must not fail the node') }
	await sleep(100)
	thrower.port.postMessage('boom')
	const before = last
	await sleep(100)
	assert.ok(last > before + 2, 'the processor keeps running after its message handler threw')
	await context.close()
})

T.test("audio::render-thread::compressor reduction", async (t) => {
	t.timeout(20e3)
	const context = silentContext()
	const osc = context.createOscillator()
	const compressor = context.createDynamicsCompressor()
	osc.connect(compressor).connect(context.destination)
	osc.start()
	await sleep(300)
	assert.ok(compressor.reduction < -1, `reduction ${compressor.reduction}`)
	await context.close()
})

T.test("audio::render-thread::media streams", async (t) => {
	t.timeout(20e3)
	const context = silentContext()
	const source = context.createConstantSource()
	source.offset.value = 0.5
	const destination = context.createMediaStreamDestination()
	source.connect(destination)
	source.start()
	const stream = new audio.MediaStream(destination.stream.getAudioTracks())
	const analyser = probe(context, context.createMediaStreamSource(stream))
	await sleep(150)
	near(latest(analyser)[0], 0.5, 1e-6, 'stream round trip')

	stream.getAudioTracks()[0].enabled = false
	await sleep(100)
	near(peak(latest(analyser)), 0, 1e-6, 'disabled track is silent')
	await context.close()
})

T.test("audio::render-thread::decoded and offline buffers", async (t) => {
	t.timeout(20e3)
	const offline = new audio.OfflineAudioContext(1, RATE, RATE)
	const constant = offline.createConstantSource()
	constant.offset.value = 0.125
	constant.connect(offline.destination)
	constant.start()
	const rendered = await offline.startRendering()

	const context = silentContext()
	const bytes = Fs.readFileSync(Path.join(assets, 'tone.wav'))
	const decoded = await context.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
	assert.equal(decoded.sampleRate, RATE)

	const tone = context.createBufferSource()
	tone.buffer = decoded
	tone.loop = true
	const toneAnalyser = probe(context, tone)
	const offset = context.createBufferSource()
	offset.buffer = rendered
	const offsetAnalyser = probe(context, offset)
	tone.start()
	offset.start()
	await sleep(200)
	near(peak(latest(toneAnalyser)), peak(decoded.getChannelData(0)), 1e-3, 'decoded buffer plays')
	near(latest(offsetAnalyser)[0], 0.125, 1e-6, 'offline buffer plays')

	rendered.getChannelData(0).fill(0.375)
	await sleep(100)
	near(latest(offsetAnalyser)[0], 0.125, 1e-6, 'edits after start are not heard')
	const edited = context.createBufferSource()
	edited.buffer = rendered
	const editedAnalyser = probe(context, edited)
	edited.start()
	await sleep(200)
	near(latest(editedAnalyser)[0], 0.375, 1e-6, 'a source started after the edit plays the new content')
	await context.close()
})

T.test("audio::render-thread::convolver and periodic wave", async (t) => {
	t.timeout(20e3)
	const context = silentContext()
	const impulse = context.createBuffer(1, 256, RATE)
	impulse.getChannelData(0)[0] = 1
	const convolver = new audio.ConvolverNode(context, { buffer: impulse, disableNormalization: true })
	const source = context.createConstantSource()
	source.offset.value = 0.5
	source.connect(convolver)
	const convolved = probe(context, convolver)

	const osc = context.createOscillator()
	osc.setPeriodicWave(context.createPeriodicWave(new Float32Array([ 0, 0, 1 ]), new Float32Array([ 0, 0, 0 ])))
	osc.frequency.value = 750
	const wave = probe(context, osc)
	wave.fftSize = 4096

	source.start()
	osc.start()
	await sleep(200)
	near(latest(convolved)[0], 0.5, 1e-4, 'the impulse response is computed on the render thread')
	const spectrum = new Float32Array(wave.frequencyBinCount)
	wave.getFloatFrequencyData(spectrum)
	let best = 0
	for (let k = 1; k < spectrum.length; k++) {
		if (spectrum[k] > spectrum[best]) { best = k }
	}
	near(best * RATE / wave.fftSize, 1500, RATE / wave.fftSize, 'custom wave plays its second harmonic')
	await context.close()
})

T.test("audio::render-thread::sinks", async (t) => {
	t.timeout(20e3)
	const context = silentContext()
	let changed = 0
	context.onsinkchange = () => { changed++ }
	await context.setSinkId('')
	assert.equal(context.sinkId, '')
	await context.setSinkId({ type: 'none' })
	assert.deepEqual(context.sinkId, { type: 'none' })
	await tick()
	assert.equal(changed, 2)
	await sleep(100)
	assert.equal(context._sinkKind, 'null')
	await context.close()
})

T.test("audio::render-thread::releases collected objects", async (t) => {
	t.timeout(20e3)
	V8.setFlagsFromString('--expose-gc')
	const gc = Vm.runInNewContext('gc')
	const context = silentContext()
	const count = async () => (await context._remote.request('stats')).objects

	const before = await count()
	for (let i = 0; i < 1000; i++) { context.createGain() }
	const created = await count()
	assert.ok(created >= before + 2000, `${created - before} objects created`)

	for (let i = 0; i < 5 && await count() > before + 100; i++) {
		gc()
		await sleep(50)
	}
	const after = await count()
	assert.ok(after < before + 100, `${after - before} objects left after gc`)
	await context.close()
})

T.test("audio::render-thread::workers skip the preloads of the host process", (t) => {
	t.timeout(20e3)
	const preload = 'data:text/javascript,import { isMainThread } from "node:worker_threads"; if (!isMainThread) { throw new Error("preload ran in a worker") }'
	const script = `
		const Fs = require('node:fs')
		const audio = require(${JSON.stringify(Path.join(import.meta.dirname, '../src/index.js'))})
		;(async () => {
			const context = new audio.AudioContext({ sinkId: { type: 'none' } })
			const data = Fs.readFileSync(${JSON.stringify(Path.join(assets, 'tone.wav'))})
			const buffer = await context.decodeAudioData(data.buffer.slice(data.byteOffset, data.byteOffset + data.length))
			const osc = context.createOscillator()
			osc.connect(context.destination)
			osc.start()
			await sleep(200)
			console.log(JSON.stringify({ length: buffer.length, currentTime: context.currentTime }))
			await context.close()
		})()
		const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })
	`
	const { status, stdout, stderr } = spawnSync(process.execPath, [ '--import', preload, '-e', script ], { encoding: 'utf8' })
	assert.equal(status, 0, stderr)
	assert.doesNotMatch(stderr, /render thread failed|preload ran in a worker/u)
	const { length, currentTime } = JSON.parse(stdout)
	assert.ok(length > 0)
	assert.ok(currentTime > 0.1, `currentTime ${currentTime}`)
})

T.test("audio::render-thread::HRTF panner", async (t) => {
	t.timeout(20e3)
	const context = silentContext()
	const osc = context.createOscillator()
	osc.frequency.value = 1000
	const panner = new audio.PannerNode(context, { panningModel: 'HRTF', positionX: -3, positionZ: -1 })
	const splitter = context.createChannelSplitter(2)
	const left = context.createAnalyser()
	const right = context.createAnalyser()
	osc.connect(panner).connect(splitter)
	splitter.connect(left, 0)
	splitter.connect(right, 1)
	osc.start()
	await sleep(300)
	const l = rms(latest(left))
	const r = rms(latest(right))
	assert.ok(l > 0.01, `the HRTF panner renders on the render thread: ${l}`)
	assert.ok(l > r * 1.5, `a source on the left is louder in the left ear: ${l} vs ${r}`)
	await context.close()
})
