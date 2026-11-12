import T from '@kmamal/testing'
import Fs from 'node:fs'
import Path from 'node:path'
import { audio, assets, assert, near, dominantFrequency, rejectsName, RATE } from './helpers.mjs'

const read = (name) => {
	const bytes = Fs.readFileSync(Path.join(assets, name))
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

T.test("audio::decode::formats", async (t) => {
	t.timeout(60e3)
	const context = new audio.OfflineAudioContext(1, 128, RATE)
	for (const name of [ 'tone.wav', 'tone-f32.wav', 'tone-u8-mono-22k.wav', 'tone.aiff', 'tone.mp3', 'tone.ogg', 'tone.opus', 'tone.flac' ]) {
		const buffer = await context.decodeAudioData(read(name))
		assert.equal(buffer.sampleRate, RATE, `${name} resampled to the context rate`)
		near(buffer.duration, 1, 0.1, `${name} duration`)
		near(dominantFrequency(buffer.getChannelData(0), RATE, { start: 4096 }), 440, 8, `${name} frequency`)
		assert.ok(buffer.getChannelData(0).every(Number.isFinite), `${name} finite`)
		assert.ok(!(buffer.getChannelData(0).buffer instanceof SharedArrayBuffer), `${name} channel data is a plain ArrayBuffer`)
	}
})

T.test("audio::decode::native rate and callbacks", async (t) => {
	t.timeout(30e3)
	const decoded = await audio.decodeAudio(new Uint8Array(read('tone-u8-mono-22k.wav')))
	assert.equal(decoded.sampleRate, 22050)
	assert.equal(decoded.channelData.length, 1)

	const context = new audio.OfflineAudioContext(1, 128, 44100)
	const data = read('tone.wav')
	const buffer = await new Promise((resolve, reject) => { context.decodeAudioData(data, resolve, reject) })
	assert.equal(buffer.sampleRate, 44100)
	assert.equal(buffer.length, 44100)
	assert.equal(data.byteLength, 0, 'the input buffer is detached')

	await rejectsName(context.decodeAudioData(new Uint8Array([ 1, 2, 3, 4, 5, 6, 7, 8 ]).buffer), 'EncodingError')
	await rejectsName(context.decodeAudioData(data), 'DataCloneError')
	await rejectsName(context.decodeAudioData('nope'), 'TypeError')
})
