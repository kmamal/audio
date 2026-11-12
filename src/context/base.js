const { RENDER_QUANTUM, MAX_RENDER_QUANTUM_SECONDS } = require('../constants')
const { AudioBuffer, checkSampleRate } = require('../audio-buffer')
const { AudioListener } = require('../audio-listener')
const { PeriodicWave } = require('../periodic-wave')
const { AudioWorklet } = require('../worklet')
const { decode } = require('../remote/decoder')
const { sharedFloat64 } = require('../remote/shared')
const { CLOCK_SLOTS } = require('./clock')
const { HRTFDatabase } = require('../dsp/hrtf')
const { encodingError, indexSizeError, notSupportedError, toUnsignedLong } = require('../errors')
const { defineEventHandlers, queueTask } = require('../events')
const { releasePorts } = require('../port')

const { AudioDestinationNode } = require('../nodes/destination')
const { GainNode } = require('../nodes/gain')
const { DelayNode } = require('../nodes/delay')
const { AudioBufferSourceNode } = require('../nodes/buffer-source')
const { OscillatorNode } = require('../nodes/oscillator')
const { ConstantSourceNode } = require('../nodes/constant-source')
const { BiquadFilterNode } = require('../nodes/biquad-filter')
const { IIRFilterNode } = require('../nodes/iir-filter')
const { WaveShaperNode } = require('../nodes/wave-shaper')
const { DynamicsCompressorNode } = require('../nodes/dynamics-compressor')
const { ConvolverNode } = require('../nodes/convolver')
const { ChannelSplitterNode } = require('../nodes/channel-splitter')
const { ChannelMergerNode } = require('../nodes/channel-merger')
const { StereoPannerNode } = require('../nodes/stereo-panner')
const { PannerNode } = require('../nodes/panner')
const { AnalyserNode } = require('../nodes/analyser')
const { ScriptProcessorNode } = require('../nodes/script-processor')
const { MediaStreamAudioSourceNode, MediaStreamTrackAudioSourceNode, MediaStreamAudioDestinationNode, MediaElementAudioSourceNode } = require('../nodes/media-nodes')
const { stronglyConnectedComponents } = require('../graph')

const resolveRenderQuantum = (hint, sampleRate) => {
	if (hint === undefined || hint === 'default' || hint === 'hardware') { return RENDER_QUANTUM }
	if (typeof hint === 'string') { throw new TypeError("renderSizeHint must be 'default', 'hardware' or a number of frames") }
	const size = toUnsignedLong(hint)
	if (size < 1 || size > Math.floor(MAX_RENDER_QUANTUM_SECONDS * sampleRate)) {
		throw notSupportedError(`renderSizeHint must be between 1 and ${MAX_RENDER_QUANTUM_SECONDS} seconds of frames`)
	}
	return size
}

class BaseAudioContext extends EventTarget {
	constructor ({ sampleRate, destination, renderSizeHint }) {
		super()
		this._sampleRate = checkSampleRate(sampleRate)
		this._quantum = resolveRenderQuantum(renderSizeHint, this._sampleRate)
		this._clock = sharedFloat64(CLOCK_SLOTS)
		this._remote = null
		this._state = 'suspended'
		this._activeSources = new Set()
		this._sideNodes = new Set()
		this._liveNodes = new Set()
		this._audioWorklet = null
		this._graphDirty = false
		this._deferred = []
		this._sharedHRTF = false
		this._sharedWaves = null
		this._ports = new Set()

		this._destination = new AudioDestinationNode(this, destination)
		this._listener = new AudioListener(this)
	}

	get _frame () { return this._clock[0] }
	set _frame (frame) { this._clock[0] = frame }

	get _blockId () { return this._clock[1] }
	set _blockId (id) { this._clock[1] = id }

	get _shared () { return this._clock }

	_adoptShared (clock) {
		clock.set(this._clock)
		this._clock = clock
	}

	_mirrorChildren () { return [ this._destination, this._listener ] }

	get destination () { return this._destination }
	get listener () { return this._listener }
	get sampleRate () { return this._sampleRate }
	get renderQuantumSize () { return this._quantum }
	get currentTime () { return this._frame / this._sampleRate }
	get state () { return this._state }

	get audioWorklet () {
		if (this._audioWorklet === null) { this._audioWorklet = new AudioWorklet(this) }
		return this._audioWorklet
	}

	_applyState (state) {
		if (this._state === state || this._state === 'closed') { return false }
		this._state = state
		if (state === 'closed') {
			releasePorts(this)
			this._liveNodes.clear()
		}
		return true
	}

	_setState (state) {
		if (!this._applyState(state)) { return }
		queueTask(() => { this.dispatchEvent(new Event('statechange')) })
	}

	_graphChanged () { this._graphDirty = true }

	_prepareHRTF () {
		const database = HRTFDatabase.for(this._sampleRate)
		if (this._remote === null || this._sharedHRTF) { return }
		this._sharedHRTF = true
		this._remote.send(this, '_adoptHRTF', [ database._shared() ])
	}

	_adoptHRTF (parts) { HRTFDatabase.adopt(this._sampleRate, parts) }

	_prepareWave (type, wave) {
		const tables = wave._getTables()
		if (this._remote === null) { return }
		if (this._sharedWaves === null) { this._sharedWaves = new Set() }
		if (this._sharedWaves.has(type)) { return }
		this._sharedWaves.add(type)
		this._remote.send(this, '_adoptBasicWave', [ type, tables ])
	}

	_adoptBasicWave (type, tables) { PeriodicWave._adoptBasic(type, tables) }

	_addSideNode (node) { this._sideNodes.add(new WeakRef(node)) }

	_liveSideNodes () {
		const nodes = []
		for (const ref of this._sideNodes) {
			const node = ref.deref()
			if (node === undefined) { this._sideNodes.delete(ref) }
			else { nodes.push(node) }
		}
		return nodes
	}

	_graphRoots () {
		return [ this._destination, ...this._liveSideNodes(), ...this._activeSources ]
	}

	_updateGraph () {
		this._graphDirty = false
		const components = stronglyConnectedComponents(this._graphRoots())
		for (const component of components) {
			for (const node of component) {
				node._muted = false
				if (node._breaksCycles) { node._inCycle = false }
			}
		}
		for (const component of components) {
			const cyclic = component.length > 1 || component[0]._predecessors().includes(component[0])
			if (!cyclic) { continue }
			const delays = component.filter((node) => node._breaksCycles)
			if (delays.length > 0) {
				for (const node of delays) { node._inCycle = true }
			}
			else {
				for (const node of component) { node._muted = true }
			}
		}
	}

	_renderBlock () {
		if (this._graphDirty) { this._updateGraph() }
		this._blockId++
		const output = this._destination._pull()
		for (const ref of this._sideNodes) {
			const node = ref.deref()
			if (node === undefined) {
				this._sideNodes.delete(ref)
				this._graphDirty = true
			}
			else if (node._blockId !== this._blockId) { node._pull(0) }
		}
		for (const source of this._activeSources) {
			if (source._blockId !== this._blockId) { source._pull(0) }
		}
		const deferred = this._deferred
		for (let i = 0; i < deferred.length; i++) { deferred[i]._deferredProcess() }
		deferred.length = 0
		this._frame += this._quantum
		return output
	}

	createBuffer (numberOfChannels, length, sampleRate) {
		return new AudioBuffer({ numberOfChannels, length, sampleRate })
	}

	createBufferSource () { return new AudioBufferSourceNode(this) }
	createConstantSource () { return new ConstantSourceNode(this) }
	createOscillator () { return new OscillatorNode(this) }
	createGain () { return new GainNode(this) }
	createDelay (maxDelayTime = 1) { return new DelayNode(this, { maxDelayTime }) }
	createBiquadFilter () { return new BiquadFilterNode(this) }
	createIIRFilter (feedforward, feedback) { return new IIRFilterNode(this, { feedforward, feedback }) }
	createWaveShaper () { return new WaveShaperNode(this) }
	createDynamicsCompressor () { return new DynamicsCompressorNode(this) }
	createConvolver () { return new ConvolverNode(this) }
	createChannelSplitter (numberOfOutputs = 6) { return new ChannelSplitterNode(this, { numberOfOutputs }) }
	createChannelMerger (numberOfInputs = 6) { return new ChannelMergerNode(this, { numberOfInputs }) }
	createStereoPanner () { return new StereoPannerNode(this) }
	createPanner () { return new PannerNode(this) }
	createAnalyser () { return new AnalyserNode(this) }

	createScriptProcessor (bufferSize = 0, numberOfInputChannels = 2, numberOfOutputChannels = 2) {
		return new ScriptProcessorNode(this, bufferSize, numberOfInputChannels, numberOfOutputChannels)
	}

	createPeriodicWave (real, imag, constraints = {}) {
		if (real === undefined || imag === undefined) { throw new TypeError("createPeriodicWave() needs real and imag arrays") }
		if (real.length !== imag.length) { throw indexSizeError("real and imag must have the same length") }
		return new PeriodicWave(this, { real, imag, disableNormalization: Boolean(constraints.disableNormalization) })
	}

	createMediaElementSource (mediaElement) { return new MediaElementAudioSourceNode(this, { mediaElement }) }
	createMediaStreamSource (mediaStream) { return new MediaStreamAudioSourceNode(this, { mediaStream }) }
	createMediaStreamTrackSource (mediaStreamTrack) { return new MediaStreamTrackAudioSourceNode(this, { mediaStreamTrack }) }
	createMediaStreamDestination () { return new MediaStreamAudioDestinationNode(this) }

	decodeAudioData (audioData, successCallback, errorCallback) {
		const promise = (async () => {
			if (!(audioData instanceof ArrayBuffer)) { throw new TypeError("decodeAudioData() needs an ArrayBuffer") }
			if (audioData.detached) { throw new DOMException("the ArrayBuffer is detached", 'DataCloneError') }

			let decoded
			try {
				decoded = await decode(new Uint8Array(audioData), this._sampleRate, { transfer: true, detach: true })
			}
			catch (error) {
				throw encodingError(error.message)
			}

			return AudioBuffer._fromChannels(decoded.channels, this._sampleRate)
		})()

		if (typeof successCallback === 'function' || typeof errorCallback === 'function') {
			promise.then(
				(buffer) => { if (typeof successCallback === 'function') { successCallback(buffer) } },
				(error) => { if (typeof errorCallback === 'function') { errorCallback(error) } },
			)
		}

		return promise
	}
}

defineEventHandlers(BaseAudioContext.prototype, [ 'statechange' ])

module.exports = { BaseAudioContext }
