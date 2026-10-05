import type {
  MissionEvidenceCounts,
  MissionEvidenceRecord,
  MissionStepCounts,
  MissionStepRecord,
} from './autonomy/types'

/** Renderer-safe factual counts for one Mission's evidence. */
export function evidenceCounts(
  evidence: readonly MissionEvidenceRecord[],
  now: Date,
): MissionEvidenceCounts & { uncertain: number } {
  const at = now.getTime()
  let observed = 0
  let reported = 0
  let expired = 0
  let total = 0

  for (const item of evidence) {
    total += 1
    const stale = item.expiresAt !== null && Date.parse(item.expiresAt) <= at
    if (item.origin === 'reported') {
      reported += 1
      continue
    }
    if (item.kind !== 'result') continue
    if (stale) expired += 1
    else observed += 1
  }

  return { total, observed, reported, expired, uncertain: 0 }
}

/** Renderer-safe factual step counts for one Mission plan. */
export function countPlanSteps(steps: readonly MissionStepRecord[]): MissionStepCounts {
  const counts = {
    total: steps.length,
    pending: 0,
    blocked: 0,
    delegated: 0,
    running: 0,
    verified: 0,
    failed: 0,
    cancelled: 0,
    skipped: 0,
  }

  for (const step of steps) {
    switch (step.status) {
      case 'pending':
        counts.pending += 1
        break
      case 'blocked':
        counts.blocked += 1
        break
      case 'delegated':
        counts.delegated += 1
        break
      case 'running':
        counts.running += 1
        break
      case 'verified':
        counts.verified += 1
        break
      case 'failed':
        counts.failed += 1
        break
      case 'cancelled':
        counts.cancelled += 1
        break
      case 'skipped':
        counts.skipped += 1
        break
    }
  }

  return Object.freeze(counts)
}
