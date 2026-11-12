const { checkEnum } = require('../errors')

const COUNT_MODES = [ 'max', 'clamped-max', 'explicit' ]
const INTERPRETATIONS = [ 'speakers', 'discrete' ]

const checkContext = (context) => {
	if (!context || typeof context !== 'object' || typeof context._renderBlock !== 'function') { throw new TypeError("context must be a BaseAudioContext") }
	return context
}

const applyChannelOptions = (node, options) => {
	if (!options) { return }
	if (options.channelCount !== undefined) { node.channelCount = options.channelCount }
	if (options.channelCountMode !== undefined) { node.channelCountMode = checkEnum(options.channelCountMode, COUNT_MODES, 'channelCountMode') }
	if (options.channelInterpretation !== undefined) { node.channelInterpretation = checkEnum(options.channelInterpretation, INTERPRETATIONS, 'channelInterpretation') }
}
const applyParamOptions = (node, options, names) => {
	if (!options) { return }
	for (const name of names) {
		if (options[name] !== undefined) { node[name].value = options[name] }
	}
}

const checkOptions = (options, what) => {
	if (options === undefined || options === null) { return {} }
	if (typeof options !== 'object' || options === null) { throw new TypeError(`${what} options must be an object`) }
	return options
}

module.exports = { applyChannelOptions, applyParamOptions, checkOptions, checkContext, COUNT_MODES, INTERPRETATIONS }
