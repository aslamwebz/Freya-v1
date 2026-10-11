import { MATRIX_COMMANDS, MATRIX_LIMITS } from '../core/protocol/matrix'
import type { CoreCommandName } from '../core/protocol/core-protocol'

export const OWNER_COMMANDS = [
  ...MATRIX_COMMANDS, 'mission.read', 'mission.update', 'mission.delete',
  'goal.status.read', 'goal.create', 'goal.read', 'goal.update', 'goal.delete',
  'goal.activate', 'goal.pause', 'goal.resume', 'goal.cancel', 'goal.fail', 'goal.requestCompletion',
] as const
type Result = { ok: true; payload?: unknown } | { ok: false; reason: string }

/** Copy only named, bounded owner fields. Core validates domain rules again. */
export function ownerPayload(command: CoreCommandName, raw: unknown): Result | null {
  if (!OWNER_COMMANDS.includes(command as typeof OWNER_COMMANDS[number])) return null
  const p = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  const out: Record<string, unknown> = {}
  const text = (key: string, max: number, required = false) => {
    if (p[key] === undefined && !required) return
    if (typeof p[key] !== 'string' || (p[key] as string).length > max || (required && !(p[key] as string).trim())) throw new Error(`${key} is invalid.`)
    out[key] = p[key]
  }
  try {
    if (command === 'goal.status.read') return { ok: true }
    if (command.startsWith('matrix.')) {
      if (command === 'matrix.spaces.read') text('conversationId', 256)
      else if (command === 'matrix.spaces.attach') {
        text('conversationId', 256, true)
        if (!Array.isArray(p.spaceIds) || p.spaceIds.length > MATRIX_LIMITS.attachments || p.spaceIds.some(v => typeof v !== 'string' || !v || v.length > 256)) throw new Error('Invalid Matrix spaces.')
        out.spaceIds = [...p.spaceIds]
      } else {
        const entry = command.startsWith('matrix.entries.')
        if (command !== 'matrix.spaces.create') text('spaceId', 256, true)
        if (/entries\.(update|delete)$/.test(command)) text('entryId', 256, true)
        if (command === 'matrix.entries.read') { text('entryId', 256); text('kind', 16); text('query', MATRIX_LIMITS.contentChars) }
        if (/\.(create|update)$/.test(command)) {
          text(entry ? 'title' : 'name', MATRIX_LIMITS.titleChars, true)
          if (entry) {
            text('kind', 16, command.endsWith('.create')); text('content', MATRIX_LIMITS.contentChars)
            text('mimeType', 160); text('dataBase64', Math.ceil(MATRIX_LIMITS.fileBytes / 3) * 4)
            if (p.sizeBytes !== undefined) {
              if (!Number.isSafeInteger(p.sizeBytes) || (p.sizeBytes as number) < 0 || (p.sizeBytes as number) > MATRIX_LIMITS.fileBytes) throw new Error('File size is invalid.')
              out.sizeBytes = p.sizeBytes
            }
          } else text('description', MATRIX_LIMITS.descriptionChars)
        }
      }
    } else {
      const goal = command.startsWith('goal.')
      if (!command.endsWith('.create')) text(goal ? 'goalId' : 'missionId', 256, true)
      if (/\.(create|update)$/.test(command)) {
        text('title', 160, true); text(goal ? 'description' : 'intent', 8000, true)
        const key = goal ? 'completionCriteria' : 'successCriteria'
        if (p[key] !== undefined) {
          if (!Array.isArray(p[key]) || (p[key] as unknown[]).length > 16 || (p[key] as unknown[]).some(v => typeof v !== 'string' || v.length > 1000)) throw new Error('Criteria are invalid.')
          out[key] = [...p[key] as string[]]
        }
      }
    }
    return { ok: true, payload: out }
  } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : 'Invalid owner request.' } }
}

export function rendererTurnIntents(raw: unknown): Record<string, boolean | string> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const p = raw as Record<string, unknown>
  const result: Record<string, boolean | string> = {}
  for (const key of ['webSearch', 'browserUse']) if (typeof p[key] === 'boolean') result[key] = p[key]
  if (typeof p.reasoningEffort === 'string' && /^[a-z0-9_-]{1,32}$/i.test(p.reasoningEffort)) result.reasoningEffort = p.reasoningEffort
  return Object.keys(result).length ? result : undefined
}
