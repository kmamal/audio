
const make = (name) => (message) => new DOMException(message, name)

const checkFinite = (value, what) => {
	const number = Number(value)
	if (!Number.isFinite(number)) { throw new TypeError(`${what} must be a finite number`) }
	return number
}

const toUnsignedLong = (value) => {
	const number = Number(value)
	if (!Number.isFinite(number)) { return 0 }
	const truncated = Math.trunc(number)
	return ((truncated % 2 ** 32) + 2 ** 32) % 2 ** 32
}

const FLOAT_MAX = 3.4028234663852886e38

const checkFloat = (value, what) => {
	const number = Number(value)
	if (!Number.isFinite(number) || Math.abs(number) > FLOAT_MAX) { throw new TypeError(`${what} must be a finite float`) }
	return Math.fround(number)
}

const isEnum = (value, allowed) => allowed.includes(value)

const checkEnum = (value, allowed, what) => {
	if (!allowed.includes(value)) { throw new TypeError(`${what} must be one of ${allowed.map((x) => `'${x}'`).join(', ')}`) }
	return value
}

module.exports = {
	indexSizeError: make('IndexSizeError'),
	invalidStateError: make('InvalidStateError'),
	notSupportedError: make('NotSupportedError'),
	invalidAccessError: make('InvalidAccessError'),
	encodingError: make('EncodingError'),
	notAllowedError: make('NotAllowedError'),
	notFoundError: make('NotFoundError'),
	syntaxError: make('SyntaxError'),
	abortError: make('AbortError'),
	dataCloneError: make('DataCloneError'),
	checkFinite,
	checkFloat,
	checkEnum,
	isEnum,
	toUnsignedLong,
}
