
const REF = '__kmamal_audio_ref__'

const walk = (root) => {
	const out = []
	const visit = (object) => {
		out.push(object)
		const children = object._mirrorChildren?.()
		if (!children) { return }
		for (const child of children) { visit(child) }
	}
	visit(root)
	return out
}

module.exports = { REF, walk }
