import type { CoreCommandName, CoreCommandResult } from '../protocol/core-protocol'
import type { MindTool } from './tools'

export interface WorkManagementToolOptions {
  /** Must use Core's command dispatcher; each mutation remains Guard-evaluated. */
  dispatch(command: CoreCommandName, payload?: unknown): Promise<CoreCommandResult>
}

const actions = new Set(['create', 'read', 'update', 'delete', 'activate', 'pause', 'resume', 'cancel', 'requestCompletion'])

/** Tools carry owner intent to the same command path used by the desktop. */
export function createWorkManagementTools(options: WorkManagementToolOptions): readonly MindTool[] {
  const record = (kind: 'mission' | 'goal'): MindTool => ({
    name: `${kind}_manage`,
    capability: kind === 'mission' ? 'mission.manage' : 'goal.manage',
    description: `Create, read, edit a draft, activate, pause, resume, cancel, delete or verify a ${kind} in the actual Core system. `
      + 'Use only for the owner’s requested record action. Editing is allowed only while draft; deletion requires draft or terminal state. '
      + 'Creating a record does not start execution. Completion asks the verifier and never asserts success.',
    parameters: [
      { name: 'action', description: 'create, read, update, delete, activate, pause, resume, cancel, requestCompletion', required: true },
      { name: 'id', description: `Existing ${kind} ID. Required except for create.`, required: false },
      { name: 'title', description: 'Record title. Required for create/update.', required: false },
      { name: kind === 'mission' ? 'intent' : 'description', description: 'Record purpose. Required for create/update.', required: false, multiline: true },
      { name: kind === 'mission' ? 'success_criteria' : 'completion_criteria', description: 'Criteria, one per line.', required: false, multiline: true },
    ],
    async run(request) {
      if (request.signal?.aborted) return observation('Record action aborted before dispatch.')
      const args = request.arguments
      const action = args.action ?? ''
      if (!actions.has(action)) return observation('Refused: unknown record action.')
      const idKey = kind === 'goal' ? 'goalId' : 'missionId'
      const id = args.id?.trim()
      if (action !== 'create' && !id) return observation('Refused: a record ID is required.')
      const payload: Record<string, unknown> = action === 'create' ? {} : { [idKey]: id }
      if (action === 'create' || action === 'update') {
        const textKey = kind === 'goal' ? 'description' : 'intent'
        const text = args[textKey]?.trim()
        const title = args.title?.trim()
        if (!title || !text) return observation(`Refused: title and ${textKey} are required.`)
        payload.title = title
        payload[textKey] = text
        payload[kind === 'goal' ? 'completionCriteria' : 'successCriteria'] = lines(args[kind === 'goal' ? 'completion_criteria' : 'success_criteria'])
      }
      const result = await options.dispatch(`${kind}.${action}` as CoreCommandName, payload)
      const outcome = kind === 'mission' ? result.mission : result.goal
      if (!result.ok || !outcome?.ok) return observation(`Refused: ${outcome?.reason ?? result.refusal?.reason ?? result.error?.message ?? 'Core returned no record outcome.'}`)
      return observation(JSON.stringify(outcome))
    },
  })
  const reminder: MindTool = {
    name: 'reminder_manage',
    capability: 'attention.schedule.manage',
    description: 'Create or cancel a real reminder in Core Attention. Daily reminders persist encrypted and repeat every 24 hours until cancelled. '
      + 'The host checks due reminders only while Freya is running; attention/focus/voice policy decides the cue. '
      + 'Do not promise operating-system notifications or execution while the app is closed. Ask for missing reminder time. '
      + 'due_at must have an explicit timezone offset or Z; daily cadence uses that instant and does not follow daylight-saving clock changes.',
    parameters: [
      { name: 'action', description: 'create or cancel', required: true },
      { name: 'schedule_id', description: 'Existing schedule ID for cancel.', required: false },
      { name: 'text', description: 'Reminder message for create.', required: false },
      { name: 'due_at', description: 'First due ISO timestamp with Z or timezone offset.', required: false },
      { name: 'recurrence', description: 'once (default) or daily (every 24 hours until cancelled).', required: false },
    ],
    async run(request) {
      if (request.signal?.aborted) return observation('Reminder action aborted before dispatch.')
      const args = request.arguments
      if (args.action === 'cancel') {
        if (!args.schedule_id?.trim()) return observation('Refused: schedule_id is required.')
        const result = await options.dispatch('attention.schedule.cancel', { scheduleId: args.schedule_id.trim() })
        if (!result.ok || !result.attention?.ok) return observation(`Refused: ${result.attention?.reason ?? result.refusal?.reason ?? result.error?.message ?? 'Core returned no reminder outcome.'}`)
        return observation(`Reminder ${args.schedule_id} cancelled in Core.`)
      }
      if (args.action !== 'create') return observation('Refused: reminder action must be create or cancel.')
      const due = args.due_at ?? ''
      const recurrence = args.recurrence ?? 'once'
      if (!args.text?.trim()) return observation('Refused: reminder text is required.')
      if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(due) || !Number.isFinite(Date.parse(due))) return observation('Refused: due_at needs an ISO date and explicit timezone.')
      if (recurrence !== 'once' && recurrence !== 'daily') return observation('Refused: recurrence must be once or daily.')
      const result = await options.dispatch('attention.schedule.register', {
        kind: 'reminder', text: args.text.trim(), dueAt: new Date(due).toISOString(),
        intervalMs: recurrence === 'daily' ? 86_400_000 : null,
        maxRepeats: recurrence === 'daily' ? null : 0, condition: 'always',
      })
      if (!result.ok || !result.attention?.ok || !result.attention.scheduleId) return observation(`Refused: ${result.attention?.reason ?? result.refusal?.reason ?? result.error?.message ?? 'Core returned no confirmed reminder ID.'}`)
      return observation(`Reminder ${result.attention.scheduleId} saved in Core, first due ${new Date(due).toISOString()}${recurrence === 'daily' ? ', repeating every 24 hours until cancelled' : ''}. Delivery requires Freya to be running and follows Attention settings.`)
    },
  }
  return [record('mission'), record('goal'), reminder]
}

function lines(value: string | undefined): string[] { return (value ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean) }
function observation(summary: string) { return { summary, sources: [], provenance: { actor: 'core.work-management', steps: ['Used the Core command boundary; no independent model authority.'] } } }
