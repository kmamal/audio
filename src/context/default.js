
let defaultContext = null

const getDefaultContext = () => {
	if (defaultContext === null || defaultContext.state === 'closed') {
		const { AudioContext } = require('./audio-context')
		defaultContext = new AudioContext()
	}
	return defaultContext
}

const setDefaultContext = (context) => {
	defaultContext = context
}

module.exports = { getDefaultContext, setDefaultContext }
