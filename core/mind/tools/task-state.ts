import type { MindTool } from './types'

/** A model decision channel in the existing registry, not a second executor. */
export function createMindTaskTool(): MindTool {
  return {
    name: 'mind_task', capability: 'cognition.request',
    description: 'Update Mind execution state. Use plan to declare objective requirements and revise approach/outstanding work; satisfy with actual observation IDs; complete with the final answer only when all requirements are satisfied; block with a precise limitation; resume with a supplied saved taskId. Simple answers need no state call. After external actions use structured completion. decision is JSON: {action:"plan",approach?,constraints?,outstanding?,requirements?:[{id,description,kind:"answer"|"snippet"|"observation"|"verification"|"artifact"}]} or {action:"satisfy",requirementId,evidenceIds:["o1"]} or {action:"complete",answer} or {action:"block",reason,answer?} or {action:"resume",taskId}. Requirements cannot be deleted or weakened. Snippets are not primary observations or verification.',
    parameters: [{ name: 'decision', description: 'Structured task decision JSON', required: true, maxChars: 32_000, multiline: true }],
    async run({ arguments: args }) {
      let decision: unknown
      try { decision = JSON.parse(args.decision ?? '') } catch { throw new Error('Task decision is not valid JSON.') }
      return { summary: 'Mind received a task decision for validation.', sources: [], taskDecision: decision }
    },
  }
}
