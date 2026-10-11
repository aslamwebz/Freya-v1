// Tarjan SCCs identify every cyclic edge, including type-only and self imports.
// Baseline exact edges rather than SCC names: merging two old SCCs is new debt.
export function cyclicEdges(edges) {
  const adjacency = new Map()
  for (const edge of edges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, [])
    adjacency.get(edge.from).push(edge.to)
    if (!adjacency.has(edge.to)) adjacency.set(edge.to, [])
  }
  const indices = new Map()
  const low = new Map()
  const stack = []
  const active = new Set()
  const groups = new Map()
  const sizes = new Map()
  let index = 0
  let group = 0
  function visit(node) {
    indices.set(node, index)
    low.set(node, index++)
    stack.push(node)
    active.add(node)
    for (const target of adjacency.get(node)) {
      if (!indices.has(target)) {
        visit(target)
        low.set(node, Math.min(low.get(node), low.get(target)))
      } else if (active.has(target)) low.set(node, Math.min(low.get(node), indices.get(target)))
    }
    if (indices.get(node) !== low.get(node)) return
    let member
    let count = 0
    do {
      member = stack.pop()
      active.delete(member)
      groups.set(member, group)
      count++
    } while (member !== node)
    sizes.set(group++, count)
  }
  for (const node of adjacency.keys()) if (!indices.has(node)) visit(node)
  return edges.filter(edge => groups.get(edge.from) === groups.get(edge.to) && (sizes.get(groups.get(edge.from)) > 1 || edge.from === edge.to)).map(edge => edge.key)
}
