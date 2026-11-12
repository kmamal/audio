import T from '@kmamal/testing'
import Path from 'node:path'
import { spawnSync } from 'node:child_process'
import { audio, fixtures, assert, near, throwsName, rejectsName, RATE } from './helpers.mjs'

T.test("audio::worklet::processor module", async (t) => {
	t.timeout(20e3)
	const context = new audio.OfflineAudioContext(1, RATE / 10, RATE)
	throwsName(() => new audio.AudioWorkletNode(context, 'gain-processor'), 'InvalidStateError')
	await rejectsName(context.audioWorklet.addModule(Path.join(fixtures, 'missing.js')), 'AbortError')
	await context.audioWorklet.addModule(Path.join(fixtures, 'gain-processor.js'))

	const node = new audio.AudioWorkletNode(context, 'gain-processor', { processorOptions: { answer: 42 } })
	assert.equal(node.parameters.size, 1)
	const gain = node.parameters.get('gain')
	assert.ok(gain instanceof audio.AudioParam)
	assert.equal(gain.defaultValue, 1)
	assert.equal(gain.maxValue, 10)

	const reply = new Promise((resolve) => {
		node.port.onmessage = (event) => { resolve(event.data) }
	})
	node.port.postMessage({ hello: 'processor' })
	const message = await reply
	assert.deepEqual(message.echo, { hello: 'processor' })
	assert.equal(message.sampleRate, RATE)
	assert.deepEqual(message.processorOptions, { answer: 42 })

	const source = context.createConstantSource()
	gain.setValueAtTime(0.5, 0)
	gain.linearRampToValueAtTime(1, 0.1)
	source.connect(node).connect(context.destination)
	source.start()
	const buffer = await context.startRendering()
	const data = buffer.getChannelData(0)
	near(data[0], 0.5, 1e-6, 'start gain')
	near(data[2400], 0.75, 1e-3, 'ramped gain')
	assert.ok(data[4799] > 0.99)
})

T.test("audio::worklet::validation", async (t) => {
	t.timeout(10e3)
	const context = new audio.OfflineAudioContext(1, 128, RATE)
	await context.audioWorklet.addModule(Path.join(fixtures, 'gain-processor.js'))
	throwsName(() => new audio.AudioWorkletNode(context, 'gain-processor', { numberOfInputs: 0, numberOfOutputs: 0 }), 'NotSupportedError')
	throwsName(() => new audio.AudioWorkletNode(context, 'gain-processor', { outputChannelCount: [ 1, 2 ] }), 'IndexSizeError')
	throwsName(() => new audio.AudioWorkletNode(context, 'gain-processor', { outputChannelCount: [ 0 ] }), 'NotSupportedError')
	audio.registerProcessor('global-processor', class { process () { return false } })
	throwsName(() => audio.registerProcessor('global-processor', class { process () { return false } }), 'NotSupportedError')
	throwsName(() => audio.registerProcessor('', class { process () { return false } }), 'NotSupportedError')
	throwsName(() => audio.registerProcessor('not-a-class', 42), 'TypeError')
	throwsName(() => new audio.AudioWorkletProcessor(), 'TypeError')
	assert.ok(new audio.AudioWorkletNode(context, 'global-processor') instanceof audio.AudioNode)
})

T.test("audio::worklet::each context has its own scope", async (t) => {
	t.timeout(10e3)
	const a = new audio.OfflineAudioContext(1, 256, RATE)
	const b = new audio.OfflineAudioContext(1, 256, 2 * RATE)
	const module = (value) => `data:text/javascript,${encodeURIComponent(`
		class P extends AudioWorkletProcessor {
			process (inputs, outputs) {
				outputs[0][0].fill(${value} + (sampleRate === ${RATE} ? 0 : 100))
				return true
			}
		}
		registerProcessor('same-name', P)
	`)}`
	await a.audioWorklet.addModule(module(1))
	await b.audioWorklet.addModule(module(2))
	await rejectsName(a.audioWorklet.addModule(module(3)), 'NotSupportedError')
	new audio.AudioWorkletNode(a, 'same-name').connect(a.destination)
	new audio.AudioWorkletNode(b, 'same-name').connect(b.destination)
	const [ outA, outB ] = await Promise.all([ a.startRendering(), b.startRendering() ])
	assert.equal(outA.getChannelData(0)[200], 1)
	assert.equal(outB.getChannelData(0)[200], 102)
})

T.test("audio::worklet::processors get copies of their inputs", async (t) => {
	t.timeout(10e3)
	const context = new audio.OfflineAudioContext(1, 256, RATE)
	await context.audioWorklet.addModule(`data:text/javascript,${encodeURIComponent(`
		registerProcessor('clobber', class extends AudioWorkletProcessor {
			process (inputs, outputs) {
				if (inputs[0].length > 0) { inputs[0][0].fill(0) }
				return true
			}
		})
	`)}`)
	const source = context.createConstantSource()
	const clobber = new audio.AudioWorkletNode(context, 'clobber')
	source.connect(clobber)
	source.connect(context.destination)
	source.start()
	const out = await context.startRendering()
	assert.equal(out.getChannelData(0)[200], 1)
})

T.test("audio::worklet::a throwing message handler does not stop the processor", async (t) => {
	t.timeout(10e3)
	const context = new audio.OfflineAudioContext(1, 48000, RATE)
	await context.audioWorklet.addModule(`data:text/javascript,${encodeURIComponent(`
		registerProcessor('thrower', class extends AudioWorkletProcessor {
			constructor () {
				super()
				this.count = 0
				this.port.onmessage = () => { throw new Error("handler failed") }
				this.port.postMessage({ isPort: this.port instanceof MessagePort, hasOn: typeof this.port.onmessage })
			}
			process (inputs, outputs) {
				this.port.postMessage(++this.count)
				return true
			}
		})
	`)}`)
	const node = new audio.AudioWorkletNode(context, 'thrower')
	node.connect(context.destination)
	const info = await new Promise((resolve) => {
		node.port.onmessage = (event) => { resolve(event.data) }
	})
	assert.deepEqual(info, { isPort: true, hasOn: 'function' })
	let errors = 0
	node.onprocessorerror = () => { errors++ }
	const { error } = console
	const reported = []
	console.error = (value) => { reported.push(value) }
	try {
		node.port.postMessage('boom')
		let last = 0
		node.port.onmessage = (event) => { last = event.data }
		await context.startRendering()
		await new Promise((resolve) => { setTimeout(resolve, 50) })
		assert.equal(last, 48000 / 128)
	}
	finally {
		console.error = error
	}
	assert.equal(errors, 0)
	assert.equal(reported.length, 1)
	assert.equal(reported[0].message, 'handler failed')
})

T.test("audio::worklet::processorOptions that the scope can not deserialize fail the node", async (t) => {
	t.timeout(10e3)
	const context = new audio.OfflineAudioContext(1, 256, RATE)
	await context.audioWorklet.addModule(`data:text/javascript,${encodeURIComponent(`
		registerProcessor('plain', class extends AudioWorkletProcessor {
			process () { return true }
		})
	`)}`)
	const blob = new Blob([ 'x' ])
	const node = new audio.AudioWorkletNode(context, 'plain', { processorOptions: { nested: [ { blob } ] } })
	const event = await new Promise((resolve) => { node.onprocessorerror = resolve })
	assert.equal(event.error.name, 'DataCloneError')
	const fine = new audio.AudioWorkletNode(context, 'plain', { processorOptions: { bytes: new Uint8Array(4), map: new Map([ [ 'a', 1 ] ]) } })
	fine.onprocessorerror = () => { assert.fail('plain options should deserialize') }
	await context.startRendering()
})

T.test("audio::worklet::ports do not keep the process alive", (t) => {
	t.timeout(60e3)
	const script = `
		const audio = require(${JSON.stringify(Path.join(import.meta.dirname, '../src/index.js'))})
		const workers = process.argv[1] === 'workers'
		audio.configure({ workers })
		;(async () => {
			const context = workers
				? new audio.AudioContext({ sinkId: { type: 'none' } })
				: new audio.OfflineAudioContext({ numberOfChannels: 1, length: 4800, sampleRate: 48000 })
			await context.audioWorklet.addModule(${JSON.stringify(Path.join(fixtures, 'gain-processor.js'))})
			const node = new audio.AudioWorkletNode(context, 'gain-processor')
			node.port.onmessage = () => {}
			context.audioWorklet.port.onmessage = () => {}
			node.connect(context.destination)
			if (workers) {
				await new Promise((resolve) => { setTimeout(resolve, 100) })
				await context.close()
			}
			else {
				await context.startRendering()
			}
			console.log('done')
		})()
	`
	for (const mode of [ 'offline', 'workers' ]) {
		const { status, stdout, stderr, error } = spawnSync(process.execPath, [ '-e', script, mode ], { encoding: 'utf8', timeout: 20e3 })
		assert.equal(error, undefined, `${mode}: the process did not exit (${error?.code})`)
		assert.equal(status, 0, `${mode}: ${stderr}`)
		assert.match(stdout, /done/u, mode)
	}
})
