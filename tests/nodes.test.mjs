import T from '@kmamal/testing'
import { audio, render, assert, near, rms, peak, throwsName, RATE } from './helpers.mjs'

T.test("audio::nodes::buffer source acquires its buffer", async (t) => {
	t.timeout(10e3)
	const buffer = new audio.AudioBuffer({ length: 256, sampleRate: RATE })
	const before = buffer.getChannelData(0)
	assert.ok(before.buffer instanceof ArrayBuffer && !(before.buffer instanceof SharedArrayBuffer), 'channel data is a plain ArrayBuffer')
	before.fill(1)
	const rendered = await render(256 / RATE, (ctx) => {
		const source = ctx.createBufferSource()
		source.buffer = buffer
		source.connect(ctx.destination)
		source.start()
		before.fill(0.5)
		const after = buffer.getChannelData(0)
		assert.notEqual(after, before, 'the old array is no longer the buffer data')
		assert.equal(after[0], 1, 'getChannelData() returns the acquired content')
		after.fill(0.25)
		buffer.copyToChannel(new Float32Array([ 0.125 ]), 0)
	}, { channels: 1 })
	assert.ok(rendered.getChannelData(0).every((x) => x === 1), 'edits after start are not heard')
	assert.equal(buffer.getChannelData(0)[0], 0.125)
	assert.equal(buffer.getChannelData(0)[1], 0.25)

	const replay = await render(256 / RATE, (ctx) => {
		const source = ctx.createBufferSource()
		source.buffer = buffer
		source.connect(ctx.destination)
		source.start()
	}, { channels: 1 })
	assert.equal(replay.getChannelData(0)[0], 0.125, 'a later start plays the edited content')
	assert.equal(replay.getChannelData(0)[1], 0.25)

	const detached = new audio.AudioBuffer({ numberOfChannels: 2, length: 256, sampleRate: RATE })
	detached.getChannelData(0).fill(1)
	detached.getChannelData(1).fill(1)
	const memory = detached.getChannelData(0).buffer
	structuredClone(memory, { transfer: [ memory ] })
	const silent = await render(256 / RATE, (ctx) => {
		const source = ctx.createBufferSource()
		source.buffer = detached
		source.connect(ctx.destination)
		source.start()
		const convolver = new audio.ConvolverNode(ctx, { buffer: detached, disableNormalization: true })
		const constant = ctx.createConstantSource()
		constant.connect(convolver).connect(ctx.destination)
		constant.start()
	}, { channels: 1 })
	assert.ok(silent.getChannelData(0).every((x) => x === 0), 'a buffer with a detached channel plays and convolves as silence')
})

T.test("audio::nodes::cycles without a delay are muted", async (t) => {
	t.timeout(10e3)
	const ctx = new audio.OfflineAudioContext(1, 1280, RATE)
	const osc = ctx.createOscillator()
	const a = ctx.createGain()
	const b = ctx.createGain()
	const dry = ctx.createGain()
	osc.connect(a).connect(b).connect(a)
	b.connect(ctx.destination)
	osc.connect(dry).connect(ctx.destination)
	osc.start()
	const first = ctx.suspend(640 / RATE)
	const rendering = ctx.startRendering()
	await first
	assert.ok(a._muted && b._muted, 'both nodes of the cycle are muted')
	assert.ok(!dry._muted && !osc._muted, 'nodes outside the cycle are not')
	b.disconnect(a)
	await ctx.resume()
	const data = (await rendering).getChannelData(0)
	near(peak(data, 0, 640), 1, 1e-3, 'only the dry path is heard while the cycle exists')
	assert.ok(!a._muted && !b._muted, 'breaking the cycle unmutes the nodes')
	assert.ok(peak(data, 640, 1280) > 1.5, 'the former cycle passes signal again')
	const loopback = ctx.createGain()
	loopback.connect(loopback)
	loopback.connect(ctx.destination)
	ctx._updateGraph()
	assert.ok(loopback._muted, 'a node connected to itself is muted')
})

T.test("audio::nodes::dynamics compressor", async (t) => {
	t.timeout(10e3)
	let compressor
	const buffer = await render(0.5, (ctx) => {
		const osc = ctx.createOscillator()
		osc.frequency.value = 200
		compressor = ctx.createDynamicsCompressor()
		compressor.threshold.value = -40
		compressor.ratio.value = 20
		compressor.knee.value = 0
		osc.connect(compressor).connect(ctx.destination)
		osc.start()
		throwsName(() => { compressor.channelCount = 3 }, 'NotSupportedError')
		throwsName(() => { compressor.channelCountMode = 'max' }, 'NotSupportedError')
	}, { channels: 1 })
	const data = buffer.getChannelData(0)
	assert.ok(compressor.reduction < -10, `reduction ${compressor.reduction}`)
	const late = rms(data, 0.3 * RATE)
	assert.ok(late > 0.01 && late < Math.SQRT1_2, `compressed level ${late}`)
})

T.test("audio::nodes::panner HRTF", async (t) => {
	t.timeout(30e3)
	const run = async (x) => {
		const buffer = await render(0.3, (ctx) => {
			const osc = ctx.createOscillator()
			osc.frequency.value = 1000
			const panner = ctx.createPanner()
			panner.panningModel = 'HRTF'
			panner.setPosition(x, 0, -1)
			osc.connect(panner).connect(ctx.destination)
			osc.start()
		})
		return [ rms(buffer.getChannelData(0), 0.1 * RATE), rms(buffer.getChannelData(1), 0.1 * RATE) ]
	}
	const [ ll, lr ] = await run(-3)
	const [ rl, rr ] = await run(3)
	assert.ok(Number.isFinite(ll) && Number.isFinite(lr))
	assert.ok(ll > lr * 1.5, `source on the left is louder in the left ear: ${ll} vs ${lr}`)
	assert.ok(rr > rl * 1.5, `source on the right is louder in the right ear: ${rl} vs ${rr}`)
	assert.ok(ll > 0.01)

	const moving = await render(0.5, (ctx) => {
		const osc = ctx.createOscillator()
		const panner = ctx.createPanner()
		panner.panningModel = 'HRTF'
		panner.positionX.setValueAtTime(-5, 0)
		panner.positionX.linearRampToValueAtTime(5, 0.5)
		osc.connect(panner).connect(ctx.destination)
		osc.start()
	})
	const data = moving.getChannelData(0)
	assert.ok(data.every(Number.isFinite), 'no NaN while moving')
	assert.ok(peak(data) < 2, 'no blow-up while crossfading')
})

T.test("audio::nodes::script processor", async (t) => {
	t.timeout(10e3)
	let events = 0
	const buffer = await render(0.2, (ctx) => {
		const source = ctx.createConstantSource()
		const processor = ctx.createScriptProcessor(256, 1, 1)
		processor.onaudioprocess = (event) => {
			events++
			assert.equal(event.inputBuffer.length, 256)
			const input = event.inputBuffer.getChannelData(0)
			const output = event.outputBuffer.getChannelData(0)
			for (let i = 0; i < 256; i++) { output[i] = input[i] * 0.5 }
		}
		source.connect(processor).connect(ctx.destination)
		source.start()
		throwsName(() => ctx.createScriptProcessor(100), 'IndexSizeError')
	}, { channels: 1 })
	const data = buffer.getChannelData(0)
	assert.ok(events >= 36, `events ${events}`)
	assert.equal(data[511], 0)
	near(data[512], 0.5, 1e-6, 'processed output starts at the playbackTime of the first event')
	near(data[1000], 0.5, 1e-6, 'processed output continues')
})

