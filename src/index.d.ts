export type AudioContextState = 'suspended' | 'running' | 'closed'
export type AudioContextLatencyCategory = 'balanced' | 'interactive' | 'playback'
export type AudioSinkOptions = { type: 'none' }
export type AutomationRate = 'a-rate' | 'k-rate'
export type ChannelCountMode = 'max' | 'clamped-max' | 'explicit'
export type ChannelInterpretation = 'speakers' | 'discrete'
export type BiquadFilterType = 'lowpass' | 'highpass' | 'bandpass' | 'lowshelf' | 'highshelf' | 'peaking' | 'notch' | 'allpass'
export type OscillatorType = 'sine' | 'square' | 'sawtooth' | 'triangle' | 'custom'
export type OverSampleType = 'none' | '2x' | '4x'
export type PanningModelType = 'equalpower' | 'HRTF'
export type DistanceModelType = 'linear' | 'inverse' | 'exponential'
export type MediaStreamTrackState = 'live' | 'ended'

export type AudioContextRenderSizeCategory = 'default' | 'hardware'

export interface AudioContextOptions {
	latencyHint?: AudioContextLatencyCategory | number
	sampleRate?: number
	sinkId?: string | AudioSinkOptions
	renderSizeHint?: AudioContextRenderSizeCategory | number
}

export interface OfflineAudioContextOptions {
	numberOfChannels?: number
	length?: number | null
	sampleRate: number
	renderSizeHint?: AudioContextRenderSizeCategory | number
}

export interface AudioTimestamp {
	contextTime: number
	performanceTime: number
}

export interface AudioBufferOptions {
	numberOfChannels?: number
	length: number
	sampleRate: number
}

export interface PeriodicWaveConstraints {
	disableNormalization?: boolean
}

export interface PeriodicWaveOptions extends PeriodicWaveConstraints {
	real?: number[] | Float32Array
	imag?: number[] | Float32Array
}

export interface AudioNodeOptions {
	channelCount?: number
	channelCountMode?: ChannelCountMode
	channelInterpretation?: ChannelInterpretation
}

export interface AudioBufferSourceOptions {
	buffer?: AudioBuffer | null
	detune?: number
	loop?: boolean
	loopEnd?: number
	loopStart?: number
	playbackRate?: number
}

export interface AnalyserOptions extends AudioNodeOptions {
	fftSize?: number
	maxDecibels?: number
	minDecibels?: number
	smoothingTimeConstant?: number
}

export interface BiquadFilterOptions extends AudioNodeOptions {
	type?: BiquadFilterType
	Q?: number
	detune?: number
	frequency?: number
	gain?: number
}

export interface ChannelMergerOptions extends AudioNodeOptions {
	numberOfInputs?: number
}

export interface ChannelSplitterOptions extends AudioNodeOptions {
	numberOfOutputs?: number
}

export interface ConstantSourceOptions {
	offset?: number
}

export interface ConvolverOptions extends AudioNodeOptions {
	buffer?: AudioBuffer | null
	disableNormalization?: boolean
}

export interface DelayOptions extends AudioNodeOptions {
	delayTime?: number
	maxDelayTime?: number
}

export interface DynamicsCompressorOptions extends AudioNodeOptions {
	attack?: number
	knee?: number
	ratio?: number
	release?: number
	threshold?: number
}

export interface GainOptions extends AudioNodeOptions {
	gain?: number
}

export interface IIRFilterOptions extends AudioNodeOptions {
	feedforward: number[] | Float32Array
	feedback: number[] | Float32Array
}

export interface OscillatorOptions extends AudioNodeOptions {
	detune?: number
	frequency?: number
	periodicWave?: PeriodicWave
	type?: OscillatorType
}

export interface PannerOptions extends AudioNodeOptions {
	coneInnerAngle?: number
	coneOuterAngle?: number
	coneOuterGain?: number
	distanceModel?: DistanceModelType
	maxDistance?: number
	orientationX?: number
	orientationY?: number
	orientationZ?: number
	panningModel?: PanningModelType
	positionX?: number
	positionY?: number
	positionZ?: number
	refDistance?: number
	rolloffFactor?: number
}

export interface StereoPannerOptions extends AudioNodeOptions {
	pan?: number
}

export interface WaveShaperOptions extends AudioNodeOptions {
	curve?: number[] | Float32Array
	oversample?: OverSampleType
}

export interface MediaElementAudioSourceOptions {
	mediaElement: HTMLMediaElement
}

export interface MediaStreamAudioSourceOptions {
	mediaStream: MediaStream
}

export interface MediaStreamTrackAudioSourceOptions {
	mediaStreamTrack: MediaStreamTrack
}

export interface AudioWorkletNodeOptions extends AudioNodeOptions {
	numberOfInputs?: number
	numberOfOutputs?: number
	outputChannelCount?: number[]
	parameterData?: Record<string, number>
	processorOptions?: any
}

export interface AudioParamDescriptor {
	name: string
	automationRate?: AutomationRate
	defaultValue?: number
	maxValue?: number
	minValue?: number
}

export class BaseAudioContext extends EventTarget {
	readonly audioWorklet: AudioWorklet
	readonly currentTime: number
	readonly destination: AudioDestinationNode
	readonly listener: AudioListener
	readonly sampleRate: number
	readonly renderQuantumSize: number
	readonly state: AudioContextState
	onstatechange: ((this: BaseAudioContext, event: Event) => any) | null

	createAnalyser(): AnalyserNode
	createBiquadFilter(): BiquadFilterNode
	createBuffer(numberOfChannels: number, length: number, sampleRate: number): AudioBuffer
	createBufferSource(): AudioBufferSourceNode
	createChannelMerger(numberOfInputs?: number): ChannelMergerNode
	createChannelSplitter(numberOfOutputs?: number): ChannelSplitterNode
	createConstantSource(): ConstantSourceNode
	createConvolver(): ConvolverNode
	createDelay(maxDelayTime?: number): DelayNode
	createDynamicsCompressor(): DynamicsCompressorNode
	createGain(): GainNode
	createIIRFilter(feedforward: number[] | Float32Array, feedback: number[] | Float32Array): IIRFilterNode
	createMediaElementSource(mediaElement: HTMLMediaElement): MediaElementAudioSourceNode
	createMediaStreamDestination(): MediaStreamAudioDestinationNode
	createMediaStreamSource(mediaStream: MediaStream): MediaStreamAudioSourceNode
	createMediaStreamTrackSource(mediaStreamTrack: MediaStreamTrack): MediaStreamTrackAudioSourceNode
	createOscillator(): OscillatorNode
	createPanner(): PannerNode
	createPeriodicWave(real: number[] | Float32Array, imag: number[] | Float32Array, constraints?: PeriodicWaveConstraints): PeriodicWave
	createScriptProcessor(bufferSize?: number, numberOfInputChannels?: number, numberOfOutputChannels?: number): ScriptProcessorNode
	createStereoPanner(): StereoPannerNode
	createWaveShaper(): WaveShaperNode
	decodeAudioData(
		audioData: ArrayBuffer,
		successCallback?: ((decodedData: AudioBuffer) => void) | null,
		errorCallback?: ((error: DOMException) => void) | null,
	): Promise<AudioBuffer>
}

export class AudioContext extends BaseAudioContext {
	constructor(options?: AudioContextOptions)
	readonly baseLatency: number
	readonly outputLatency: number
	readonly sinkId: string | AudioSinkOptions
	readonly renderCapacity: AudioRenderCapacity
	readonly playbackStats: AudioPlaybackStats
	onsinkchange: ((this: AudioContext, event: Event) => any) | null
	onerror: ((this: AudioContext, event: Event) => any) | null

	getOutputTimestamp(): AudioTimestamp
	setSinkId(sinkId: string | AudioSinkOptions): Promise<void>
	resume(): Promise<void>
	suspend(): Promise<void>
	close(): Promise<void>
}

export interface AudioPlaybackStatsJSON {
	totalDuration: number
	underrunDuration: number
	underrunEvents: number
	minimumLatency: number
	maximumLatency: number
	averageLatency: number
}

export class AudioPlaybackStats {
	readonly totalDuration: number
	readonly underrunDuration: number
	readonly underrunEvents: number
	readonly minimumLatency: number
	readonly maximumLatency: number
	readonly averageLatency: number
	resetLatency(): void
	toJSON(): AudioPlaybackStatsJSON
}

export interface AudioRenderCapacityOptions {
	updateInterval?: number
}

export interface AudioRenderCapacityEventInit {
	timestamp?: number
	averageLoad?: number
	peakLoad?: number
	underrunRatio?: number
}

export class AudioRenderCapacityEvent extends Event {
	constructor(type: string, eventInitDict?: AudioRenderCapacityEventInit)
	readonly timestamp: number
	readonly averageLoad: number
	readonly peakLoad: number
	readonly underrunRatio: number
}

export class AudioRenderCapacity extends EventTarget {
	onupdate: ((this: AudioRenderCapacity, event: AudioRenderCapacityEvent) => any) | null
	start(options?: AudioRenderCapacityOptions): void
	stop(): void
}

export class OfflineAudioCompletionEvent extends Event {
	constructor(type: string, eventInitDict: { renderedBuffer: AudioBuffer })
	readonly renderedBuffer: AudioBuffer
}

export class OfflineAudioContext extends BaseAudioContext {
	constructor(options: OfflineAudioContextOptions)
	constructor(numberOfChannels: number, length: number, sampleRate: number)
	readonly length: number | null
	oncomplete: ((this: OfflineAudioContext, event: OfflineAudioCompletionEvent) => any) | null

	startRendering(chunkSize?: number): Promise<AudioBuffer>
	suspend(suspendTime: number): Promise<void>
	resume(): Promise<void>
	close(): Promise<void>
}

export class AudioBuffer {
	constructor(options: AudioBufferOptions)
	readonly duration: number
	readonly length: number
	readonly numberOfChannels: number
	readonly sampleRate: number

	copyFromChannel(destination: Float32Array, channelNumber: number, bufferOffset?: number): void
	copyToChannel(source: Float32Array, channelNumber: number, bufferOffset?: number): void
	getChannelData(channel: number): Float32Array
}

export class AudioParam {
	readonly defaultValue: number
	readonly maxValue: number
	readonly minValue: number
	automationRate: AutomationRate
	value: number

	cancelAndHoldAtTime(cancelTime: number): AudioParam
	cancelScheduledValues(cancelTime: number): AudioParam
	exponentialRampToValueAtTime(value: number, endTime: number): AudioParam
	linearRampToValueAtTime(value: number, endTime: number): AudioParam
	setTargetAtTime(target: number, startTime: number, timeConstant: number): AudioParam
	setValueAtTime(value: number, startTime: number): AudioParam
	setValueCurveAtTime(values: number[] | Float32Array, startTime: number, duration: number): AudioParam
}

export class AudioParamMap {
	readonly size: number
	get(name: string): AudioParam | undefined
	has(name: string): boolean
	keys(): IterableIterator<string>
	values(): IterableIterator<AudioParam>
	entries(): IterableIterator<[ string, AudioParam ]>
	forEach(callback: (value: AudioParam, key: string, parent: AudioParamMap) => void, thisArg?: any): void
	[Symbol.iterator](): IterableIterator<[ string, AudioParam ]>
}

export class AudioListener {
	readonly forwardX: AudioParam
	readonly forwardY: AudioParam
	readonly forwardZ: AudioParam
	readonly positionX: AudioParam
	readonly positionY: AudioParam
	readonly positionZ: AudioParam
	readonly upX: AudioParam
	readonly upY: AudioParam
	readonly upZ: AudioParam

	setOrientation(x: number, y: number, z: number, xUp: number, yUp: number, zUp: number): void
	setPosition(x: number, y: number, z: number): void
}

export class PeriodicWave {
	constructor(context: BaseAudioContext, options?: PeriodicWaveOptions)
}

export class AudioNode extends EventTarget {
	readonly context: BaseAudioContext
	readonly numberOfInputs: number
	readonly numberOfOutputs: number
	channelCount: number
	channelCountMode: ChannelCountMode
	channelInterpretation: ChannelInterpretation

	connect<T extends AudioNode>(destinationNode: T, output?: number, input?: number): T
	connect(destinationParam: AudioParam, output?: number): void
	disconnect(): void
	disconnect(output: number): void
	disconnect(destinationNode: AudioNode, output?: number, input?: number): void
	disconnect(destinationParam: AudioParam, output?: number): void
}

export class AudioScheduledSourceNode extends AudioNode {
	onended: ((this: AudioScheduledSourceNode, event: Event) => any) | null
	start(when?: number): void
	stop(when?: number): void
}

export class AudioDestinationNode extends AudioNode {
	readonly maxChannelCount: number
}

export class GainNode extends AudioNode {
	constructor(context: BaseAudioContext, options?: GainOptions)
	readonly gain: AudioParam
}

export class DelayNode extends AudioNode {
	constructor(context: BaseAudioContext, options?: DelayOptions)
	readonly delayTime: AudioParam
}

export class AudioBufferSourceNode extends AudioScheduledSourceNode {
	constructor(context: BaseAudioContext, options?: AudioBufferSourceOptions)
	readonly detune: AudioParam
	readonly playbackRate: AudioParam
	buffer: AudioBuffer | null
	loop: boolean
	loopEnd: number
	loopStart: number
	start(when?: number, offset?: number, duration?: number): void
}

export class OscillatorNode extends AudioScheduledSourceNode {
	constructor(context: BaseAudioContext, options?: OscillatorOptions)
	readonly detune: AudioParam
	readonly frequency: AudioParam
	type: OscillatorType
	setPeriodicWave(periodicWave: PeriodicWave): void
}

export class ConstantSourceNode extends AudioScheduledSourceNode {
	constructor(context: BaseAudioContext, options?: ConstantSourceOptions)
	readonly offset: AudioParam
}

export class BiquadFilterNode extends AudioNode {
	constructor(context: BaseAudioContext, options?: BiquadFilterOptions)
	readonly Q: AudioParam
	readonly detune: AudioParam
	readonly frequency: AudioParam
	readonly gain: AudioParam
	type: BiquadFilterType
	getFrequencyResponse(frequencyHz: Float32Array, magResponse: Float32Array, phaseResponse: Float32Array): void
}

export class IIRFilterNode extends AudioNode {
	constructor(context: BaseAudioContext, options: IIRFilterOptions)
	getFrequencyResponse(frequencyHz: Float32Array, magResponse: Float32Array, phaseResponse: Float32Array): void
}

export class WaveShaperNode extends AudioNode {
	constructor(context: BaseAudioContext, options?: WaveShaperOptions)
	curve: Float32Array | null
	oversample: OverSampleType
}

export class DynamicsCompressorNode extends AudioNode {
	constructor(context: BaseAudioContext, options?: DynamicsCompressorOptions)
	readonly attack: AudioParam
	readonly knee: AudioParam
	readonly ratio: AudioParam
	readonly reduction: number
	readonly release: AudioParam
	readonly threshold: AudioParam
}

export class ConvolverNode extends AudioNode {
	constructor(context: BaseAudioContext, options?: ConvolverOptions)
	buffer: AudioBuffer | null
	normalize: boolean
}

export class ChannelSplitterNode extends AudioNode {
	constructor(context: BaseAudioContext, options?: ChannelSplitterOptions)
}

export class ChannelMergerNode extends AudioNode {
	constructor(context: BaseAudioContext, options?: ChannelMergerOptions)
}

export class StereoPannerNode extends AudioNode {
	constructor(context: BaseAudioContext, options?: StereoPannerOptions)
	readonly pan: AudioParam
}

export class PannerNode extends AudioNode {
	constructor(context: BaseAudioContext, options?: PannerOptions)
	readonly orientationX: AudioParam
	readonly orientationY: AudioParam
	readonly orientationZ: AudioParam
	readonly positionX: AudioParam
	readonly positionY: AudioParam
	readonly positionZ: AudioParam
	coneInnerAngle: number
	coneOuterAngle: number
	coneOuterGain: number
	distanceModel: DistanceModelType
	maxDistance: number
	panningModel: PanningModelType
	refDistance: number
	rolloffFactor: number
	setOrientation(x: number, y: number, z: number): void
	setPosition(x: number, y: number, z: number): void
}

export class AnalyserNode extends AudioNode {
	constructor(context: BaseAudioContext, options?: AnalyserOptions)
	readonly frequencyBinCount: number
	fftSize: number
	maxDecibels: number
	minDecibels: number
	smoothingTimeConstant: number
	getByteFrequencyData(array: Uint8Array): void
	getByteTimeDomainData(array: Uint8Array): void
	getFloatFrequencyData(array: Float32Array): void
	getFloatTimeDomainData(array: Float32Array): void
}

export class AudioProcessingEvent extends Event {
	constructor(type: string, eventInitDict: { playbackTime: number, inputBuffer: AudioBuffer, outputBuffer: AudioBuffer })
	readonly inputBuffer: AudioBuffer
	readonly outputBuffer: AudioBuffer
	readonly playbackTime: number
}

export class ScriptProcessorNode extends AudioNode {
	readonly bufferSize: number
	onaudioprocess: ((this: ScriptProcessorNode, event: AudioProcessingEvent) => any) | null
}

export class MediaElementAudioSourceNode extends AudioNode {
	constructor(context: BaseAudioContext, options: MediaElementAudioSourceOptions)
	readonly mediaElement: HTMLMediaElement
}

export class MediaStreamAudioSourceNode extends AudioNode {
	constructor(context: BaseAudioContext, options: MediaStreamAudioSourceOptions)
	readonly mediaStream: MediaStream
}

export class MediaStreamTrackAudioSourceNode extends AudioNode {
	constructor(context: BaseAudioContext, options: MediaStreamTrackAudioSourceOptions)
}

export class MediaStreamAudioDestinationNode extends AudioNode {
	constructor(context: BaseAudioContext, options?: AudioNodeOptions)
	readonly stream: MediaStream
}

export class AudioWorkletNode extends AudioNode {
	constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions)
	readonly parameters: AudioParamMap
	readonly port: MessagePort
	onprocessorerror: ((this: AudioWorkletNode, event: ErrorEvent) => any) | null
}

export class AudioWorklet {
	readonly port: MessagePort
	addModule(moduleURL: string | URL): Promise<void>
}

export class AudioWorkletProcessor {
	constructor()
	readonly port: MessagePort
	process(
		inputs: Float32Array[][],
		outputs: Float32Array[][],
		parameters: Record<string, Float32Array>,
	): boolean
}

export function registerProcessor(
	name: string,
	processorCtor: (new (options?: any) => AudioWorkletProcessor) & {
		parameterDescriptors?: AudioParamDescriptor[]
	},
): void

export interface MediaTrackSettings {
	deviceId?: string
	channelCount?: number
	[key: string]: any
}

export class MediaStreamTrack extends EventTarget {
	constructor(init?: { kind?: string, label?: string, source?: any, settings?: MediaTrackSettings })
	readonly contentHint: string
	readonly id: string
	readonly kind: string
	readonly label: string
	readonly muted: boolean
	readonly readyState: MediaStreamTrackState
	enabled: boolean
	onended: ((this: MediaStreamTrack, event: Event) => any) | null
	onmute: ((this: MediaStreamTrack, event: Event) => any) | null
	onunmute: ((this: MediaStreamTrack, event: Event) => any) | null

	applyConstraints(constraints?: any): Promise<void>
	clone(): MediaStreamTrack
	getCapabilities(): Record<string, any>
	getConstraints(): Record<string, any>
	getSettings(): MediaTrackSettings
	stop(): void
}

export class MediaStream extends EventTarget {
	constructor(init?: MediaStream | MediaStreamTrack[])
	readonly active: boolean
	readonly id: string
	onaddtrack: ((this: MediaStream, event: Event) => any) | null
	onremovetrack: ((this: MediaStream, event: Event) => any) | null
	onactive: ((this: MediaStream, event: Event) => any) | null
	oninactive: ((this: MediaStream, event: Event) => any) | null

	addTrack(track: MediaStreamTrack): void
	clone(): MediaStream
	getAudioTracks(): MediaStreamTrack[]
	getTrackById(trackId: string): MediaStreamTrack | null
	getTracks(): MediaStreamTrack[]
	getVideoTracks(): MediaStreamTrack[]
	removeTrack(track: MediaStreamTrack): void
}

export interface MediaDeviceInfo {
	readonly deviceId: string
	readonly groupId: string
	readonly kind: 'audioinput' | 'audiooutput'
	readonly label: string
}

export interface MediaTrackConstraintSet {
	deviceId?: string | { exact?: string, ideal?: string }
	channelCount?: number | { exact?: number, ideal?: number }
	sampleRate?: number | { exact?: number, ideal?: number }
}

export interface MediaStreamConstraints {
	audio?: boolean | MediaTrackConstraintSet
	video?: false
}

export class MediaDevices extends EventTarget {
	ondevicechange: ((this: MediaDevices, event: Event) => any) | null
	enumerateDevices(): Promise<MediaDeviceInfo[]>
	getSupportedConstraints(): { deviceId: boolean, channelCount: boolean, sampleRate: boolean }
	getUserMedia(constraints?: MediaStreamConstraints): Promise<MediaStream>
}

export class MediaError {
	static readonly MEDIA_ERR_ABORTED: 1
	static readonly MEDIA_ERR_NETWORK: 2
	static readonly MEDIA_ERR_DECODE: 3
	static readonly MEDIA_ERR_SRC_NOT_SUPPORTED: 4
	constructor(code: number, message?: string)
	readonly code: number
	readonly message: string
}

type MediaElementHandler = ((this: HTMLMediaElement, event: Event) => any) | null

export class HTMLMediaElement extends EventTarget {
	static readonly HAVE_NOTHING: 0
	static readonly HAVE_METADATA: 1
	static readonly HAVE_CURRENT_DATA: 2
	static readonly HAVE_FUTURE_DATA: 3
	static readonly HAVE_ENOUGH_DATA: 4
	static readonly NETWORK_EMPTY: 0
	static readonly NETWORK_IDLE: 1
	static readonly NETWORK_LOADING: 2
	static readonly NETWORK_NO_SOURCE: 3
	readonly HAVE_NOTHING: 0
	readonly HAVE_METADATA: 1
	readonly HAVE_CURRENT_DATA: 2
	readonly HAVE_FUTURE_DATA: 3
	readonly HAVE_ENOUGH_DATA: 4
	readonly NETWORK_EMPTY: 0
	readonly NETWORK_IDLE: 1
	readonly NETWORK_LOADING: 2
	readonly NETWORK_NO_SOURCE: 3

	readonly buffered: { readonly length: number, start(index: number): number, end(index: number): number }
	readonly seekable: { readonly length: number, start(index: number): number, end(index: number): number }
	readonly played: { readonly length: number, start(index: number): number, end(index: number): number }
	readonly currentSrc: string
	readonly duration: number
	readonly ended: boolean
	readonly error: MediaError | null
	readonly networkState: number
	readonly paused: boolean
	readonly readyState: number
	readonly seeking: boolean
	autoplay: boolean
	controls: boolean
	crossOrigin: string | null
	currentTime: number
	defaultMuted: boolean
	defaultPlaybackRate: number
	loop: boolean
	muted: boolean
	playbackRate: number
	preload: string
	preservesPitch: boolean
	src: string
	srcObject: MediaStream | null
	volume: number

	onabort: MediaElementHandler
	oncanplay: MediaElementHandler
	oncanplaythrough: MediaElementHandler
	ondurationchange: MediaElementHandler
	onemptied: MediaElementHandler
	onended: MediaElementHandler
	onerror: MediaElementHandler
	onloadeddata: MediaElementHandler
	onloadedmetadata: MediaElementHandler
	onloadstart: MediaElementHandler
	onpause: MediaElementHandler
	onplay: MediaElementHandler
	onplaying: MediaElementHandler
	onprogress: MediaElementHandler
	onratechange: MediaElementHandler
	onseeked: MediaElementHandler
	onseeking: MediaElementHandler
	onstalled: MediaElementHandler
	onsuspend: MediaElementHandler
	ontimeupdate: MediaElementHandler
	onvolumechange: MediaElementHandler
	onwaiting: MediaElementHandler

	canPlayType(type: string): '' | 'maybe' | 'probably'
	load(): void
	pause(): void
	play(): Promise<void>
}

export class HTMLAudioElement extends HTMLMediaElement {
	constructor(src?: string)
}

export { HTMLAudioElement as Audio }

export interface DecodedAudio {
	channelData: Float32Array[]
	sampleRate: number
}

export interface ConfigureOptions {
	fetch?: ((url: string | URL, init?: RequestInit) => Promise<Response>) | null
	workers?: boolean
}

export function getMediaDevices(): MediaDevices
export function getDefaultContext(): AudioContext
export function setDefaultContext(context: AudioContext | null): void
export function decodeAudio(data: ArrayBuffer | ArrayBufferView): Promise<DecodedAudio>
export function configure(options?: ConfigureOptions): void
