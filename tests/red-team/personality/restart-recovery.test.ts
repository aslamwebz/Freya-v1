// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  buildExpressionPlan,
  createRelationshipCandidate,
  admitRelationshipItem,
  emptyCueLedger,
  interpretSocialContext,
  recordCueUse,
  restoreCueLedger,
  selectCues,
  serializeExpressionPlan,
  type CueCandidate,
  type RelationshipItem,
} from '../../../core/personality'
import { startRedTeamCore, stopRedTeamCore, type RedTeamCore } from '../harness'
import { afterEach, beforeEach } from 'vitest'
import { createCore } from '../../../core/index'
import { FakeModelProvider } from '../../../core/model/fake-provider'
import { MemoryConversationStore } from '../../../core/conversation/memory-store'
import { workerAuthority } from '../../../core/testing'

/**
 * Attack family: restart / recovery inconsistencies.
 *
 * RED-TEAM family 21 (restart / replay / corrupt-journal manipulation), against
 * the Slice A determinism contract: same input, same output, field for field,
 * with no dependence on a clock or insertion order — so a restart cannot
 * change what Freya remembers, offers or holds.
 *
 * The attacks rebuild every artefact from stored data after a "restart"
 * (restore the ledger, re-run interpretation, re-plan) and try to make the
 * recovered state disagree with the pre-restart state. The invariant under
 * attack: a restored ledger makes the same eligibility decisions, the same
 * interpretation renders the same plan, and a hostile stored payload is
 * sanitized on the way in.
 */

const NOW = '2026-10-02T09:00:00.000Z'
const NOW_MS = Date.parse(NOW)

function cueCandidate(cueId: string): CueCandidate {
  return Object.freeze({ cueId, key: cueId, kind: 'inside-joke', confidence: 'low' })
}

function admittedItem(itemId: string): RelationshipItem {
  const created = createRelationshipCandidate({
    itemId,
    kind: 'inside-joke',
    key: itemId,
    text: `shared shorthand ${itemId}`,
    tags: ['greeting'],
    cueKind: 'inside-joke',
    source: 'model-inference',
    sourceRef: 'turn-restart',
    observedAt: NOW,
    recordedAt: NOW,
    proposedConfidence: 'verified',
    actor: 'model',
  })
  expect(created.ok).toBe(true)
  if (!created.ok) throw new Error(created.reason)
  const admitted = admitRelationshipItem(created.item, { now: NOW, reason: 'owner reviewed' })
  expect(admitted.ok).toBe(true)
  if (!admitted.ok) throw new Error(admitted.reason)
  return admitted.item
}

describe('attack: the recovered ledger disagrees with the pre-restart one', () => {
  it('a restored ledger makes the same eligibility decisions', () => {
    let ledger = emptyCueLedger()
    ledger = recordCueUse(ledger, 'cue-a', 'inside-joke', NOW)
    ledger = recordCueUse(ledger, 'cue-b', 'habit', new Date(NOW_MS + 1_000).toISOString())
    // "Restart": the ledger is serialised to stored data and restored.
    const restored = restoreCueLedger(JSON.parse(JSON.stringify(ledger)))
    const at = new Date(NOW_MS + 60_000).toISOString()
    const candidates = [cueCandidate('cue-a'), cueCandidate('cue-b'), cueCandidate('cue-c')]
    const before = selectCues(candidates, ledger, at)
    const after = selectCues(candidates, restored, at)
    expect(after).toEqual(before)
  })

  it('recording then restoring preserves the use count and instant', () => {
    let ledger = emptyCueLedger()
    ledger = recordCueUse(ledger, 'cue-count', 'inside-joke', NOW)
    ledger = recordCueUse(ledger, 'cue-count', 'inside-joke', new Date(NOW_MS + 1_000).toISOString())
    const restored = restoreCueLedger(JSON.parse(JSON.stringify(ledger)))
    expect(restored.entries.length).toBe(1)
    expect(restored.entries[0]?.uses).toBe(2)
    expect(restored.entries[0]?.lastUsedAt).toBe(new Date(NOW_MS + 1_000).toISOString())
  })

  it('a hostile stored payload is sanitized on restore', () => {
    const hostile = {
      schemaVersion: 1,
      maxEntries: 999,
      entries: [
        null,
        'not-an-object',
        { cueHash: 'ffffffff', kind: 'inside-joke', lastUsedAt: NOW, uses: 3, extra: 'FREYA_RED_TEAM_SECRET_7A91' },
        { cueHash: '0000000a', kind: 'greeting', lastUsedAt: NOW, uses: 1 },
      ],
    }
    const restored = restoreCueLedger(hostile)
    expect(restored.maxEntries).toBeGreaterThan(0)
    expect(restored.maxEntries).toBeLessThanOrEqual(64)
    // The valid entries survive; the hostile extra field is dropped.
    expect(restored.entries.length).toBe(2)
    expect(JSON.stringify(restored)).not.toContain('FREYA_RED_TEAM_SECRET_7A91')
    for (const entry of restored.entries) {
      expect(Object.keys(entry).sort()).toEqual(['cueHash', 'kind', 'lastUsedAt', 'uses'])
    }
  })
})

describe('attack: the recovered interpretation disagrees with the original', () => {
  it('the same records render the same interpretation after a restart', () => {
    const items = ['ra', 'rb', 'rc'].map(admittedItem)
    const input = { now: NOW, facts: [], relationship: items, contextTokens: ['greeting'] as const }
    const before = interpretSocialContext(input)
    // "Restart": rebuild from the same records.
    const after = interpretSocialContext(input)
    expect(serializeExpressionPlan(buildExpressionPlan({ interpretation: before, at: NOW }))).toBe(
      serializeExpressionPlan(buildExpressionPlan({ interpretation: after, at: NOW })),
    )
    expect(after).toEqual(before)
  })

  it('the plan is identical for the same interpretation and ledger', () => {
    const items = ['pa', 'pb'].map(admittedItem)
    const interpretation = interpretSocialContext({ now: NOW, facts: [], relationship: items })
    let ledger = emptyCueLedger()
    for (const cue of interpretation.cueCandidates) {
      ledger = recordCueUse(ledger, cue.cueId, cue.kind, NOW)
    }
    const plan1 = buildExpressionPlan({ interpretation, at: NOW, ledger })
    const plan2 = buildExpressionPlan({ interpretation, at: NOW, ledger: restoreCueLedger(JSON.parse(JSON.stringify(ledger))) })
    expect(serializeExpressionPlan(plan1)).toBe(serializeExpressionPlan(plan2))
  })

  it('insertion order does not change the interpretation', () => {
    const items = ['ia', 'ib', 'ic'].map(admittedItem)
    const forward = interpretSocialContext({ now: NOW, facts: [], relationship: items })
    const reversed = interpretSocialContext({ now: NOW, facts: [], relationship: [...items].reverse() })
    // Ordering is by explicit keys (confidence rank, then id), never by
    // insertion order.
    expect(forward.cueCandidates.map((c) => c.cueId)).toEqual(reversed.cueCandidates.map((c) => c.cueId))
    expect(forward.preferenceHits.map((p) => p.itemId)).toEqual(reversed.preferenceHits.map((p) => p.itemId))
  })
})

describe('attack: a Core restart changes what Freya holds', () => {
  let fixture: RedTeamCore | null = null

  beforeEach(async () => {
    fixture = await startRedTeamCore()
  })

  afterEach(async () => {
    await stopRedTeamCore(fixture)
    fixture = null
  })

  it('a restart performs no provider calls and keeps cognition refused without a grant', async () => {
    const f = fixture!
    await f.core.stop('restart-teardown')
    const replayed = createCoreOnJournal(f.journalPath)
    try {
      const status = await replayed.start()
      expect(status.lifecycle).toBe('ready')
      const fake = (replayed as unknown as { providers?: { calls: number }[] }).providers?.[0]
      expect(fake?.calls ?? 0).toBe(0)
      const worker = workerAuthority(replayed)
      const outcome = await worker.request({ kind: 'agent_step', prompt: 'any text', maxOutputTokens: 100 })
      expect(outcome.status).toBe('denied')
    } finally {
      await replayed.stop('replay teardown')
    }
  })
})

function createCoreOnJournal(journalPath: string) {
  return createCore({
    dataPath: journalPath,
    providers: [new FakeModelProvider()],
    conversationStore: new MemoryConversationStore({ mode: 'memory' }),
  })
}
