import T from '@kmamal/testing'
import Path from 'node:path'
import { audio, assets, assert, near, rms, dominantFrequency, throwsName, rejectsName, sleep, RATE } from './helpers.mjs'

const silentContext = () => new audio.AudioContext({ sinkId: { type: 'none' }, sampleRate: RATE })

T.test("audio::media::audio element", async (t) => {
	t.timeout(20e3)
	const context = silentContext()
	audio.setDefaultContext(context)

	const element = new audio.Audio(Path.join(assets, 'tone.wav'))
	assert.equal(element.paused, true)
	assert.equal(Number.isNaN(element.duration), true)
	const events = []
	for (const type of [ 'loadstart', 'loadedmetadata', 'canplaythrough', 'play', 'playing', 'pause', 'ended', 'timeupdate' ]) {
		element.addEventListener(type, () => { events.push(type) })
	}

	await element.play()
	near(element.duration, 1, 1e-3, 'duration')
	assert.equal(element.paused, false)
	assert.ok(context._elements.has(element), 'plays through the default context when not captured')

	await sleep(300)
	assert.ok(element.currentTime > 0.1, `currentTime advanced to ${element.currentTime}`)
	element.pause()
	assert.equal(element.paused, true)
	const paused = element.currentTime
	await sleep(50)
	assert.equal(element.currentTime, paused)
	assert.equal(element.played.length, 1)
	assert.equal(element.played.start(0), 0)
	near(element.played.end(0), paused, 1e-6, 'played covers the first run')

	element.currentTime = 0.95
	element.playbackRate = 2
	await element.play()
	await sleep(200)
	assert.equal(element.ended, true)
	assert.equal(element.paused, true)
	assert.ok(events.includes('ended') && events.includes('loadstart') && events.includes('canplaythrough'))
	assert.equal(element.played.length, 2)
	near(element.played.start(1), 0.95, 1e-3, 'played records the seek')
	near(element.played.end(1), 1, 1e-3, 'played runs to the end')
	throwsName(() => element.played.start(2), 'IndexSizeError')

	throwsName(() => { element.volume = 2 }, 'IndexSizeError')
	throwsName(() => { element.playbackRate = -1 }, 'NotSupportedError')
	throwsName(() => { element.defaultPlaybackRate = -1 }, 'NotSupportedError')
	assert.equal(element.canPlayType('audio/mpeg'), 'probably')
	assert.equal(element.canPlayType('video/mp4'), '')

	const missing = new audio.Audio(Path.join(assets, 'missing.wav'))
	await rejectsName(missing.play(), 'AbortError')
	assert.equal(missing.error.code, audio.MediaError.MEDIA_ERR_NETWORK)

	await context.close()
})

T.test("audio::media::media element source node", async (t) => {
	t.timeout(20e3)
	const context = new audio.OfflineAudioContext(2, RATE / 2, RATE)
	const element = new audio.Audio(Path.join(assets, 'tone.mp3'))
	element.loop = true
	const node = context.createMediaElementSource(element)
	assert.equal(node.mediaElement, element)
	throwsName(() => context.createMediaElementSource(element), 'InvalidStateError')
	node.connect(context.destination)
	await element.play()
	const buffer = await context.startRendering()
	const data = buffer.getChannelData(0)
	assert.ok(rms(data) > 0.03, `rms ${rms(data)}`)
	near(dominantFrequency(data, RATE, { start: 4096 }), 440, 8, 'element audio resampled on the fly')
	element.pause()
})

T.test("audio::media::stream destination and source", async (t) => {
	t.timeout(20e3)
	const context = new audio.OfflineAudioContext(1, RATE / 10, RATE)
	const source = context.createConstantSource()
	source.offset.value = 0.5
	const destination = context.createMediaStreamDestination()
	source.connect(destination)
	source.start()
	assert.ok(destination.stream instanceof audio.MediaStream)
	const track = destination.stream.getAudioTracks()[0]
	assert.equal(track.kind, 'audio')

	const streamSource = context.createMediaStreamSource(destination.stream)
	streamSource.connect(context.destination)
	const trackSource = context.createMediaStreamTrackSource(track)
	trackSource.connect(context.destination)

	const buffer = await context.startRendering()
	near(buffer.getChannelData(0)[1000], 1, 1e-6, 'stream round trip through two source nodes')

	track.stop()
	assert.equal(track.readyState, 'ended')
	assert.equal(destination.stream.active, false)
	throwsName(() => context.createMediaStreamSource(new audio.MediaStream()), 'InvalidStateError')
})

T.test("audio::media::devices", async (t) => {
	t.timeout(20e3)
	const devices = audio.getMediaDevices()
	const list = await devices.enumerateDevices()
	assert.ok(Array.isArray(list))
	assert.ok(list.some((d) => d.kind === 'audiooutput'))
	await rejectsName(devices.getUserMedia({ video: true }), 'NotSupportedError')
	await rejectsName(devices.getUserMedia({}), 'TypeError')

	let stream
	try {
		stream = await devices.getUserMedia({ audio: true })
	}
	catch (error) {
		assert.ok([ 'NotFoundError', 'AbortError' ].includes(error.name), `unexpected ${error.name}: ${error.message}`)
		return
	}

	const context = silentContext()
	const node = context.createMediaStreamSource(stream)
	const analyser = context.createAnalyser()
	node.connect(analyser)
	await sleep(300)
	const data = new Float32Array(analyser.fftSize)
	analyser.getFloatTimeDomainData(data)
	assert.ok(data.every(Number.isFinite))
	const track = stream.getAudioTracks()[0]
	const clone = track.clone()
	track.stop()
	assert.equal(clone.readyState, 'live')
	clone.stop()
	assert.equal(track.readyState, 'ended')
	assert.equal(clone.readyState, 'ended')
	await context.close()
})
