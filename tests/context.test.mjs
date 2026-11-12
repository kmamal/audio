import T from '@kmamal/testing'
import { audio, assert, near, throwsName, rejectsName, sleep, tick, RATE } from './helpers.mjs'

T.test("audio::context::realtime playback", async (t) => {
	t.timeout(20e3)
	const context = new audio.AudioContext({ sampleRate: RATE })
	assert.equal(context.sampleRate, RATE)
	assert.equal(context.state, 'suspended')
	await new Promise((resolve) => { context.onstatechange = resolve })
	assert.equal(context.state, 'running')
	context.onstatechange = null
	assert.ok(context.baseLatency > 0)

	const osc = context.createOscillator()
	const gain = context.createGain()
	gain.gain.value = 0.02
	osc.connect(gain).connect(context.destination)
	osc.start()

	while (context.currentTime === 0) { await sleep(5) }
	const started = context.currentTime
	await sleep(300)
	assert.ok(context.currentTime - started > 0.2, `currentTime advanced ${context.currentTime - started}`)
	assert.ok(context.outputLatency > 0 && context.outputLatency < 0.06, `outputLatency ${context.outputLatency}`)
	const stamp = context.getOutputTimestamp()
	assert.ok(stamp.contextTime <= context.currentTime)
	assert.ok(stamp.performanceTime > 0)

	const states = []
	context.onstatechange = () => { states.push(context.state) }
	await context.suspend()
	const frozen = context.currentTime
	await sleep(50)
	assert.equal(context.currentTime, frozen)
	await context.resume()
	await sleep(50)
	assert.ok(context.currentTime > frozen)
	await context.close()
	assert.equal(context.state, 'closed')
	await tick()
	assert.deepEqual(states, [ 'suspended', 'running', 'closed' ])
	await rejectsName(context.close(), 'InvalidStateError')
	await rejectsName(context.resume(), 'InvalidStateError')
})

T.test("audio::context::state changes happen in a later task", async (t) => {
	t.timeout(20e3)
	const context = new audio.AudioContext({ sinkId: { type: 'none' } })
	const states = []
	context.onstatechange = () => { states.push(context.state) }
	assert.equal(context.state, 'suspended')
	const suspended = context.suspend()
	assert.equal(context.state, 'suspended')
	await suspended
	assert.deepEqual(states, [], 'statechange fires in a later task')
	await tick()
	assert.deepEqual(states, [ 'suspended', 'suspended' ], 'the handler reads the state at dispatch time')
	const resumed = context.resume()
	assert.equal(context.state, 'suspended')
	await resumed
	assert.equal(context.state, 'running')
	const closed = context.close()
	assert.equal(context.state, 'running')
	await rejectsName(context.resume(), 'InvalidStateError')
	await closed
	assert.equal(context.state, 'closed')
	await tick()
	assert.deepEqual(states, [ 'suspended', 'suspended', 'running', 'closed' ])
})

T.test("audio::context::sink changes happen in a later task", async (t) => {
	t.timeout(20e3)
	const context = new audio.AudioContext({ sinkId: { type: 'none' } })
	await new Promise((resolve) => { context.onstatechange = resolve })
	const events = []
	context.onstatechange = () => { events.push(context.state) }
	context.onsinkchange = () => { events.push('sinkchange') }
	const change = context.setSinkId('')
	assert.deepEqual(context.sinkId, { type: 'none' })
	await change
	assert.equal(context.sinkId, '')
	assert.deepEqual(events, [])
	await tick()
	assert.deepEqual(events, [ 'suspended', 'sinkchange', 'running' ])
	await context.suspend()
	await tick()
	events.length = 0
	await context.setSinkId({ type: 'none' })
	await tick()
	assert.deepEqual(events, [ 'sinkchange' ])

	const outputs = (await audio.getMediaDevices().enumerateDevices()).filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default')
	for (const output of outputs.slice(0, 1)) {
		await rejectsName(context.setSinkId(output.label), 'NotFoundError')
		await context.setSinkId(output.deviceId)
		assert.equal(context.sinkId, output.deviceId)
	}
	await context.close()
})

T.test("audio::context::options and sinks", async (t) => {
	t.timeout(20e3)
	throwsName(() => new audio.AudioContext({ sampleRate: 1 }), 'NotSupportedError')
	throwsName(() => new audio.AudioContext({ latencyHint: 'fast' }), 'TypeError')

	const context = new audio.AudioContext({ sinkId: { type: 'none' }, latencyHint: 'playback' })
	assert.deepEqual(context.sinkId, { type: 'none' })
	near(context.baseLatency, 4096 / context.sampleRate, 1e-9, 'playback hint buffers 4096 frames')
	await sleep(100)
	assert.ok(context.currentTime > 0.05, 'the null sink keeps time')
	await rejectsName(context.setSinkId('no-such-device'), 'NotFoundError')
	let changed = 0
	context.onsinkchange = () => { changed++ }
	await context.setSinkId('')
	assert.equal(context.sinkId, '')
	await tick()
	assert.equal(changed, 1)
	await context.close()

	const numeric = new audio.AudioContext({ sinkId: { type: 'none' }, latencyHint: 0.02 })
	near(numeric.baseLatency, 1024 / numeric.sampleRate, 1e-9, 'numeric hint rounds up to a power of two')
	await numeric.close()
})

T.test("audio::context::destination channel count", async (t) => {
	t.timeout(10e3)
	audio.configure({ workers: false })
	const context = new audio.AudioContext({ sinkId: { type: 'none' } })
	audio.configure({ workers: true })
	assert.equal(context.destination.channelCount, 2)
	assert.equal(context.destination.maxChannelCount, 8)
	context.destination.channelCount = 6
	assert.equal(context._sink.channels, 6)
	throwsName(() => { context.destination.channelCount = 9 }, 'IndexSizeError')
	throwsName(() => { context.destination.channelCountMode = 'max' }, 'NotSupportedError')
	await context.close()
})

T.test("audio::context::small render quanta keep up with the clock", async (t) => {
	t.timeout(20e3)
	for (const quantum of [ 1, 3 ]) {
		const context = new audio.AudioContext({ sinkId: { type: 'none' }, renderSizeHint: quantum })
		assert.equal(context.renderQuantumSize, quantum)
		await sleep(100)
		const before = context.currentTime
		await sleep(400)
		const advanced = context.currentTime - before
		assert.ok(advanced > 0.35, `quantum ${quantum} advanced ${advanced}s in 0.4s`)
		await context.close()
	}
})
