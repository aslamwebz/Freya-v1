import { basename } from 'node:path'

export function component(path) {
  const first = path.split('/')[0]
  if (['electron', 'src'].includes(first)) return 'superapp'
  if (['core', 'freya', 'shared', 'runtimes'].includes(first)) return first
  return 'tooling'
}

export function forbiddenEdge(edge) {
  const from = component(edge.from)
  const to = component(edge.to)
  if (from === 'shared') return to !== 'shared'
  if (to === 'shared') return false
  if (from === 'runtimes') {
    const owner = edge.from.split('/')[1]
    if (to === 'runtimes') return edge.to.split('/')[1] !== owner
    return owner !== to
  }
  if (to === 'runtimes') return true
  return from !== to
}

export function sizeLimit(path) {
  if (/^freya\/runtime\/domains\//.test(path)
    || /^core\/runtime\/(?:boot|shutdown)\./.test(path)
    || /^electron\/app\/(?:windows|display|surfaces|tray|shutdown)(?:\/|\.)/.test(path)) return 250
  // Explicit naming convention; index barrels and runtime assembly are included.
  const stem = basename(path).replace(/\.(?:[cm]?[jt]s|[jt]sx)$/, '')
  return /(?:^|[-_.])(?:index|main|entry|router|routes|assemble|assembly|bootstrap|composition)(?:$|[-_.])/i.test(stem)
    || /(?:Main|Entry|Router|Routes|Assembly|Assemble|Bootstrap|Composition)$/.test(stem) ? 250 : 600
}
