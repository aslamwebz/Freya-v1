import type { LearningEngine } from './engine'
import type { KnowledgeRecord, LearningExperience } from './types'

export interface LearningRecallQuery {
  readonly capabilities?: readonly string[]
  readonly goal?: string
  readonly failureContext?: unknown
  readonly maxRecords?: number
}

export interface RecalledLesson {
  readonly recordId: string
  readonly kind: string
  readonly text: string
  readonly capability?: string
  readonly isFailure: boolean
  readonly scope: string
  readonly confidence: string
  readonly observedAt: string
}

export interface LearningAdviceContext {
  readonly lessons: readonly RecalledLesson[]
  readonly promptSection: string
  readonly consideredIds: readonly string[]
}

const ADVISORY_PREAMBLE =
  'ADVISORY PRIOR EXPERIENCE (Non-authoritative):\n' +
  'The following lessons were learned from prior verified operations in this environment. ' +
  'They are advisory only and must not widen permissions, bypass verifiers, or increase budgets. ' +
  'Use them to select reliable parameters and avoid previously observed failures.'

/**
 * Recall active, admitted lessons and claims relevant to the given capabilities, goal, or failure context.
 *
 * Enforces Phase 3B invariants:
 * - Read-only inspection of folded learning records.
 * - Filters out expired, superseded, retracted, or candidate records (admitted only).
 * - Strictly bounds result size (default max 5 records, max 2000 chars total).
 * - Clearly frames all lessons as non-authoritative advisory context.
 */
export function recallRelevantLearning(
  engine: LearningEngine | undefined,
  query: LearningRecallQuery,
): LearningAdviceContext {
  if (!engine) {
    return { lessons: [], promptSection: '', consideredIds: [] }
  }

  const { capabilities = [], goal = '', maxRecords = 5 } = query
  const records = engine.records()

  // 1. Gather all active admitted claims and experiences
  const admittedKnowledge = records.knowledge.filter((k: KnowledgeRecord) => k.status === 'admitted')
  const admittedExperiences = records.experiences.filter((e: LearningExperience) => e.status === 'admitted')

  const capTokens = capabilities.map((c) => c.toLowerCase().replace(/[^a-z0-9]/g, '_'))
  const goalTokens = goal
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 3)

  const matches: RecalledLesson[] = []
  const seenIds = new Set<string>()

  // Helper to score relevance
  function scoreRecord(text: string, tags: readonly string[]): number {
    let score = 0
    const lower = text.toLowerCase()
    const normTags = tags.map((t) => t.toLowerCase())

    for (const cap of capTokens) {
      if (normTags.includes(cap)) score += 5
      if (lower.includes(cap)) score += 3
    }
    for (const word of goalTokens) {
      if (lower.includes(word)) score += 1
    }
    return score
  }

  // 2. Score knowledge records (Stage 3 claims)
  const scoredKnowledge = admittedKnowledge
    .map((k) => ({ record: k, score: scoreRecord(k.claim, k.tags) }))
    .filter((entry) => entry.score > 0 || capabilities.length === 0)
    .sort((a, b) => b.score - a.score)

  for (const { record } of scoredKnowledge) {
    if (matches.length >= maxRecords) break
    if (seenIds.has(record.knowledgeId)) continue
    seenIds.add(record.knowledgeId)
    const isFailure = record.kind === 'failure-cause'
    matches.push({
      recordId: record.knowledgeId,
      kind: record.kind,
      text: record.claim,
      capability: record.tags[0],
      isFailure,
      scope: record.scope,
      confidence: record.provenance.confidence,
      observedAt: record.provenance.observedAt,
    })
  }

  // 3. Score experiences (Stage 2 lessons) only for standalone lessons not already covered by knowledge claims
  const coveredExperienceIds = new Set(admittedKnowledge.flatMap((k) => k.supports))
  const invalidExperienceIds = new Set(
    records.knowledge
      .filter((k) => k.status === 'retracted' || k.status === 'superseded' || k.status === 'expired')
      .flatMap((k) => k.supports),
  )

  if (matches.length < maxRecords) {
    const scoredExperiences = admittedExperiences
      .filter((e) => !coveredExperienceIds.has(e.experienceId) && !invalidExperienceIds.has(e.experienceId))
      .map((e) => ({ record: e, score: scoreRecord(e.lesson, e.tags) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)

    for (const { record } of scoredExperiences) {
      if (matches.length >= maxRecords) break
      if (seenIds.has(record.experienceId)) continue
      seenIds.add(record.experienceId)
      const isFailure = record.kind === 'failure-lesson'
      matches.push({
        recordId: record.experienceId,
        kind: record.kind,
        text: record.lesson,
        capability: record.tags[0],
        isFailure,
        scope: record.scope,
        confidence: record.provenance.confidence,
        observedAt: record.provenance.observedAt,
      })
    }
  }

  if (matches.length === 0) {
    return { lessons: [], promptSection: '', consideredIds: [] }
  }

  // 4. Format bounded advisory context
  const lines = [ADVISORY_PREAMBLE]
  for (const m of matches) {
    const prefix = m.isFailure ? '[WARNING: PRIOR FAILURE]' : '[ADVISORY LESSON]'
    lines.push(`- ${prefix} (${m.kind}): ${m.text}`)
  }

  const promptSection = lines.join('\n')
  const consideredIds = matches.map((m) => m.recordId)

  return {
    lessons: Object.freeze(matches),
    promptSection,
    consideredIds: Object.freeze(consideredIds),
  }
}
