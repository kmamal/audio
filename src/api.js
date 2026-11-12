const { BaseAudioContext } = require('./context/base')
const { AudioContext } = require('./context/audio-context')
const { AudioPlaybackStats } = require('./context/playback-stats')
const { AudioRenderCapacity, AudioRenderCapacityEvent } = require('./context/render-capacity')
const { OfflineAudioContext, OfflineAudioCompletionEvent } = require('./context/offline-audio-context')
const { AudioBuffer } = require('./audio-buffer')
const { AudioParam } = require('./audio-param')
const { AudioNode } = require('./audio-node')
const { AudioListener } = require('./audio-listener')
const { PeriodicWave } = require('./periodic-wave')
const { AudioScheduledSourceNode } = require('./nodes/scheduled-source')
const { AudioDestinationNode } = require('./nodes/destination')
const { GainNode } = require('./nodes/gain')
const { DelayNode } = require('./nodes/delay')
const { AudioBufferSourceNode } = require('./nodes/buffer-source')
const { OscillatorNode } = require('./nodes/oscillator')
const { ConstantSourceNode } = require('./nodes/constant-source')
const { BiquadFilterNode } = require('./nodes/biquad-filter')
const { IIRFilterNode } = require('./nodes/iir-filter')
const { WaveShaperNode } = require('./nodes/wave-shaper')
const { DynamicsCompressorNode } = require('./nodes/dynamics-compressor')
const { ConvolverNode } = require('./nodes/convolver')
const { ChannelSplitterNode } = require('./nodes/channel-splitter')
const { ChannelMergerNode } = require('./nodes/channel-merger')
const { StereoPannerNode } = require('./nodes/stereo-panner')
const { PannerNode } = require('./nodes/panner')
const { AnalyserNode } = require('./nodes/analyser')
const { ScriptProcessorNode, AudioProcessingEvent } = require('./nodes/script-processor')
const {
	MediaElementAudioSourceNode,
	MediaStreamAudioSourceNode,
	MediaStreamTrackAudioSourceNode,
	MediaStreamAudioDestinationNode,
} = require('./nodes/media-nodes')
const { AudioWorkletNode, AudioParamMap } = require('./nodes/audio-worklet-node')
const { AudioWorklet, AudioWorkletProcessor, registerProcessor } = require('./worklet')
const { MediaStream, MediaStreamTrack } = require('./media/stream')
const { MediaDevices, getMediaDevices } = require('./media/devices')
const { HTMLMediaElement, HTMLAudioElement, MediaError } = require('./media/element')
const { getDefaultContext, setDefaultContext } = require('./context/default')
const { decodeAudio } = require('./decode')
const { configure } = require('./config')
const { installMirrors } = require('./remote/mirror')

installMirrors([
	[ AudioNode, [ 'connect', 'disconnect' ], [ 'channelCount', 'channelCountMode', 'channelInterpretation' ] ],
	[
		AudioParam,
		[ 'setValueAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime', 'setTargetAtTime', 'setValueCurveAtTime', 'cancelScheduledValues', 'cancelAndHoldAtTime' ],
		[ 'value', 'automationRate' ],
	],
	[ AudioScheduledSourceNode, [ 'start', 'stop' ], [] ],
	[ AudioBufferSourceNode, [ 'start' ], [ 'buffer', 'loop', 'loopStart', 'loopEnd' ] ],
	[ OscillatorNode, [ 'setPeriodicWave' ], [ 'type' ] ],
	[ BiquadFilterNode, [], [ 'type' ] ],
	[ WaveShaperNode, [], [ 'curve', 'oversample' ] ],
	[ ConvolverNode, [], [ 'normalize' ] ],
	[
		PannerNode,
		[ 'setPosition', 'setOrientation' ],
		[ 'panningModel', 'distanceModel', 'refDistance', 'maxDistance', 'rolloffFactor', 'coneInnerAngle', 'coneOuterAngle', 'coneOuterGain' ],
	],
	[ AudioListener, [ 'setPosition', 'setOrientation' ], [] ],
	[ MediaStream, [ 'addTrack', 'removeTrack' ], [] ],
	[ MediaStreamTrack, [ 'stop' ], [ 'enabled' ] ],
])

module.exports = {
	BaseAudioContext,
	AudioContext,
	AudioRenderCapacity,
	AudioPlaybackStats,
	AudioRenderCapacityEvent,
	OfflineAudioContext,
	OfflineAudioCompletionEvent,
	AudioBuffer,
	AudioParam,
	AudioParamMap,
	AudioNode,
	AudioListener,
	PeriodicWave,
	AudioScheduledSourceNode,
	AudioDestinationNode,
	GainNode,
	DelayNode,
	AudioBufferSourceNode,
	OscillatorNode,
	ConstantSourceNode,
	BiquadFilterNode,
	IIRFilterNode,
	WaveShaperNode,
	DynamicsCompressorNode,
	ConvolverNode,
	ChannelSplitterNode,
	ChannelMergerNode,
	StereoPannerNode,
	PannerNode,
	AnalyserNode,
	ScriptProcessorNode,
	AudioProcessingEvent,
	MediaElementAudioSourceNode,
	MediaStreamAudioSourceNode,
	MediaStreamTrackAudioSourceNode,
	MediaStreamAudioDestinationNode,
	AudioWorklet,
	AudioWorkletNode,
	AudioWorkletProcessor,
	registerProcessor,
	MediaStream,
	MediaStreamTrack,
	MediaDevices,
	MediaError,
	HTMLMediaElement,
	HTMLAudioElement,
	Audio: HTMLAudioElement,
	getMediaDevices,
	getDefaultContext,
	setDefaultContext,
	decodeAudio,
	configure,
}
