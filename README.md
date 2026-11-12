# @kmamal/audio

Web Audio for Node.js. Implemented via [`@kmamal/sdl`](https://github.com/kmamal/node-sdl).

```js
const { AudioContext, Audio } = require('@kmamal/audio')

const context = new AudioContext()
const oscillator = context.createOscillator()
const gain = context.createGain()
gain.gain.value = 0.2
oscillator.connect(gain).connect(context.destination)
oscillator.start()
oscillator.stop(context.currentTime + 1)

const song = new Audio('music.mp3')
song.loop = true
song.play()
```

Microphone input goes through `getMediaDevices()`:

```js
const { AudioContext, getMediaDevices } = require('@kmamal/audio')

const context = new AudioContext()
const stream = await getMediaDevices().getUserMedia({ audio: true })
context.createMediaStreamSource(stream).connect(context.destination)
```

## Loading files

Relative paths and `file:` URLs are read from disk, `http(s):` and `data:` URLs go through `fetch`. To change that, for example to resolve paths relative to an asset directory:

```js
const { configure } = require('@kmamal/audio')
configure({ fetch: (url) => myFetch(url) })
```

The function must return a `Response`. It is used by `Audio` elements and by `audioWorklet.addModule()`.

## Threads

The main thread must import `@kmamal/sdl` before the worker opens a device.

```js
// main.js
require('@kmamal/sdl')
const { Worker } = require('node:worker_threads')
new Worker('./synth.js')

// synth.js
const { AudioContext } = require('@kmamal/audio')
const context = new AudioContext()
```


All contexts share one render thread, which also runs the `AudioWorklet` processors and owns the playback and recording devices.
`OfflineAudioContext` renders on the calling thread.
To render everything on the calling thread instead, call `configure({ workers: false })` before creating any context or element.
That is the default inside a `worker_thread`.


## Differences from browsers

### Contexts and devices

- An `AudioContext` starts rendering as soon as it is created and becomes `running` without a user gesture.
  There is no autoplay policy.
- Device ids are `default`, `playback:<id>` and `recording:<id>`, and they are the same in every process.
  A `sinkId` that names no device makes `setSinkId()` reject with `NotFoundError`; in the constructor it falls back to the default device and fires `error`.
- There are no permission prompts: `enumerateDevices()` always returns labels, and `getUserMedia()` opens the microphone at once.
  Only audio is captured, and a `video` constraint rejects.
- `renderSizeHint` is honoured by both context types, so `renderQuantumSize` can be anything from 1 frame to 6 seconds.
  `ConvolverNode` and HRTF panning add up to 127 frames of latency when the quantum is not a multiple of 128.
- `OfflineAudioContext` supports incremental rendering: `length: null` makes an unbounded context, `startRendering(chunkSize)` renders one chunk at a time, and `close()` stops it.
- The process stays alive while a context is running on a real device, while a decode or `addModule()` is pending, while a `devicechange` listener is attached, and while a port of `AudioWorkletNode`, `audioWorklet` or a processor has a `message` listener and its context is not closed.
  A context with `sinkId: { type: 'none' }` does not keep it alive.

### Worklets and script processors

- Processors registered with `registerProcessor()` on your own thread are only available to an `OfflineAudioContext`, or to every context after `configure({ workers: false })`.
  Load processors into an `AudioContext` with `audioWorklet.addModule()`.
- Each context gets its own `AudioWorkletGlobalScope`, so two contexts can register different processors under the same name.
  `context.audioWorklet.port` talks to the global `port` of that scope.
  When a context renders on the calling thread, modules that use `import` or `export` only get their own scope under `node --experimental-vm-modules`; without the flag they are loaded with `import()` and share one registry.
- `onaudioprocess` of a `ScriptProcessorNode` runs on your thread.
  Its output is played at the event's `playbackTime`, one buffer after the input was collected, and a buffer that arrives after that time is dropped.
  A node with an `audioprocess` listener is not garbage collected while its context is open, as in Chrome.
  `createScriptProcessor(0)` picks 4096 frames, or the smallest listed size that is a multiple of the render quantum, and a size that is not a multiple throws `NotSupportedError`.

### Media

- The supported formats are wav, aiff, mp3, ogg vorbis, ogg opus and flac, for `decodeAudioData()` and media elements alike.
  `canPlayType()` reports exactly those.
- Setting `src` loads and decodes the whole file right away, whatever `preload` says: about 1.4 GB per hour of stereo audio at 48 kHz.
- `preservesPitch` has no effect, so changing `playbackRate` changes the pitch.
- `controls` and `crossOrigin` have no effect.
- Elements play through one shared `AudioContext` on the default playback device until `createMediaElementSource()` takes them over.
  `getDefaultContext()` returns that context and `setDefaultContext()` replaces it.
- Microphone tracks honour only the `deviceId` and `channelCount` constraints, with up to 8 channels.
  `applyConstraints()` does nothing, `getCapabilities()` is empty and `muted` is always false.

### Processing

- When a source starts it takes the content of its `AudioBuffer`, as the spec requires, so editing a buffer while it plays is not audible, but the arrays returned by `getChannelData()` before the start are not detached as they are in Firefox.
  They stay readable and keep their values, writes to them are no longer part of the buffer, and the next `getChannelData()` returns a fresh copy of the content.
- `WaveShaperNode` oversampling is a plain up-sample and average, and `DynamicsCompressorNode` follows the spec's shape but is not bit-exact with any browser.

## Conformance

`npm run wpt` runs the Web Audio part of the web-platform-tests against `OfflineAudioContext`.
`npm run wpt-fetch` downloads the pinned test files into `wpt/upstream/` first.
Known failures are listed in `wpt/expectations.json`, and the run fails on any change from that list.
`npm run wpt-realtime` runs the same tests with every `OfflineAudioContext` replaced by an `AudioContext` on the render thread that renders as fast as it can into memory, so the objects on your thread and their copies on the render thread are tested too.
Its known failures are in `wpt/expectations-realtime.json`.
Files that need an iframe, navigation, an autoplay gesture or a page that is not cross-origin isolated are skipped, as is one test that streams between contexts with different sample rates.
