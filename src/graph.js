
const stronglyConnectedComponents = (roots) => {
	const index = new Map()
	const low = new Map()
	const onStack = new Set()
	const stack = []
	const components = []
	let counter = 0

	const visit = (root) => {
		const work = [ { node: root, edges: null, position: 0 } ]
		while (work.length > 0) {
			const frame = work[work.length - 1]
			const { node } = frame
			if (frame.edges === null) {
				index.set(node, counter)
				low.set(node, counter)
				counter++
				stack.push(node)
				onStack.add(node)
				frame.edges = node._predecessors()
			}

			if (frame.position < frame.edges.length) {
				const next = frame.edges[frame.position++]
				if (!index.has(next)) {
					work.push({ node: next, edges: null, position: 0 })
				}
				else if (onStack.has(next)) {
					low.set(node, Math.min(low.get(node), index.get(next)))
				}
				continue
			}

			if (low.get(node) === index.get(node)) {
				const component = []
				let member
				do {
					member = stack.pop()
					onStack.delete(member)
					component.push(member)
				} while (member !== node)
				components.push(component)
			}

			work.pop()
			if (work.length > 0) {
				const parent = work[work.length - 1].node
				low.set(parent, Math.min(low.get(parent), low.get(node)))
			}
		}
	}

	for (const root of roots) {
		if (!index.has(root)) { visit(root) }
	}

	return components
}

module.exports = { stronglyConnectedComponents }
