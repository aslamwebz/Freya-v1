import type { TurnExperience } from '../mind/turn-types'
import type { ExperienceRecord } from './types'

/** Only metadata derived from real turns. Never copy private transcripts to Brain. */
export function turnExperienceRecord(experience: TurnExperience): Omit<ExperienceRecord, 'experienceId' | 'verification'> {
  return {
    goalSummary: 'answered a conversation turn',
    startedAt: experience.startedAt,
    endedAt: experience.endedAt,
    modelsUsed: experience.model === null ? [] : [experience.model],
    toolsUsed: [...new Set((experience.toolSteps ?? []).filter(step => step.executed).map(step => step.name))].slice(0, 32),
    actions: [
      { at: experience.startedAt, summary: 'compiled context and requested one bounded cognition',
        outcome: experience.providerContacted ? 'succeeded' : 'skipped' },
      ...(experience.toolSteps ?? []).slice(0, 32).map(step => ({
        at: experience.endedAt, summary: `tool ${step.name}: ${step.capability}`.slice(0, 160),
        outcome: (step.outcome === 'ok' && step.executed ? 'succeeded' : step.outcome === 'denied' || !step.executed ? 'skipped' : 'failed') as 'succeeded' | 'failed' | 'skipped',
      })),
    ],
    observations: [experience.referenceUsed
      ? `used ${experience.referenceItemCount} recalled item(s) as reference`
      : 'no reference memory was used'],
    evidenceRefs: experience.answerPersisted ? [experience.turnId] : [],
    result: experience.outcome,
    humanCorrection: null,
    relatedEntities: [],
    relatedMemories: [],
    resourceUsage: {
      providerId: experience.providerId,
      model: experience.model,
      providerContacted: experience.providerContacted,
      // Null is unknown usage, never proof of a free call.
      inputTokens: null, outputTokens: null, usageUnknown: true,
    },
    answerPersisted: experience.answerPersisted,
    conversationId: experience.conversationId,
    turnId: experience.turnId,
  }
}
