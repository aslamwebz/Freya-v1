import type { WorldEntityKind } from './types'
import type { WorldGraphOptions } from './projection'

/** Read the closed `kind` filter accepted by World commands. */
export function worldKindFrom(raw: unknown): WorldEntityKind | null | undefined {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') return undefined
  const kinds = [
    'person',
    'project',
    'organisation',
    'place',
    'mission',
    'run',
    'task',
    'worker',
    'team',
    'skill',
    'artifact',
    'self',
  ] as const
  return (kinds as readonly string[]).includes(raw) ? (raw as WorldEntityKind) : undefined
}

/** Build the graph read's bounded options, refusing anything unbounded. */
export function worldGraphOptionsFrom(raw: unknown): WorldGraphOptions | { refusal: string } {
  if (raw === undefined || raw === null) {
    return { focusEntityId: null, kinds: null, maxDepth: 1 }
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { refusal: 'a graph read takes an object' }
  }
  const payload = raw as Record<string, unknown>
  const allowed = ['focusEntityId', 'kinds', 'maxDepth']
  for (const key of Object.keys(payload)) {
    if (!allowed.includes(key)) return { refusal: 'a graph read accepts only focusEntityId, kinds and maxDepth' }
  }
  const focus = payload.focusEntityId
  if (focus !== undefined && focus !== null && (typeof focus !== 'string' || focus.length > 128)) {
    return { refusal: 'focusEntityId is not a usable entity id' }
  }
  let kinds: readonly WorldEntityKind[] | null = null
  if (payload.kinds !== undefined && payload.kinds !== null) {
    if (!Array.isArray(payload.kinds) || payload.kinds.length > 12) {
      return { refusal: 'kinds must be a short list of entity kinds' }
    }
    const resolved: WorldEntityKind[] = []
    for (const entry of payload.kinds) {
      const kind = worldKindFrom(entry)
      if (kind === undefined || kind === null) return { refusal: 'kinds must contain only entity kinds' }
      resolved.push(kind)
    }
    kinds = resolved
  }
  const maxDepth = payload.maxDepth === undefined || payload.maxDepth === null ? 1 : payload.maxDepth
  if (typeof maxDepth !== 'number' || !Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 2) {
    return { refusal: 'maxDepth is 0, 1 or 2' }
  }
  return {
    focusEntityId: (focus as string | null | undefined) ?? null,
    kinds,
    maxDepth,
  }
}
