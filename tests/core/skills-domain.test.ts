// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { WorkRegistry } from '../../core/work/capability'
import {
  FAILING_CAPABILITY,
  RECORD_CAPABILITY,
  RECORD_VERIFIER,
  ALWAYS_FAILING_VERIFIER,
  EXIT_VERIFIER,
} from '../../core/work/capability'
import { admitSkill } from '../../core/skills/admission'
import { deriveSkillId, skillContentHash } from '../../core/skills/identity'
import { findSkill, initialSkillState, reduceSkillState, targetIsProtected } from '../../core/skills/state'
import {
  PROTECTED_DOMAINS,
  SKILL_FORBIDDEN_CAPABILITIES,
  SKILL_TRANSITIONS,
  canTransitionSkill,
  isSkillStatus,
  normaliseContractEntry,
  normaliseSkillName,
  normaliseTag,
  sanitiseSkillText,
  SKILL_LIMITS,
} from '../../core/skills/types'
import { CAPABILITIES, WORKER_CAPABILITIES } from '../../core/protocol/core-protocol'
import { validateDurableEvent } from '../../core/events/validate'

/**
 * THE SKILL DOMAIN — Phase 17's vocabulary, identity, admission and fold.
 *
 * The claims under test are the ones the rest of the phase leans on:
 *
 * 1. Identity is **deterministic and derived from a normalised name**, so admitting the
 *    same name twice is one skill and not two that disagree.
 * 2. A content hash is **deterministic**, so an identical revision is detectable.
 * 3. Admission **refuses rather than repairs**, and it refuses capability laundering
 *    and unverifiable steps before anything else.
 * 4. The transition table is **the only** thing that can move a skill, and the fold
 *    refuses a line whose `from` disagrees with its own history.
 * 5. Every protected domain is protected, by a closed table and not by a prefix.
 */

function registry(): WorkRegistry {
  const built = new WorkRegistry()
  built.register(RECORD_CAPABILITY)
  built.register(FAILING_CAPABILITY)
  built.registerVerifier(RECORD_VERIFIER)
  built.registerVerifier(EXIT_VERIFIER)
  built.registerVerifier(ALWAYS_FAILING_VERIFIER)
  return built
}

const VALID_BODY = {
  name: 'summarise-a-file',
  kind: 'procedure',
  summary: 'Reads a file and produces a bounded summary of it.',
  contract: {
    inputs: [{ name: 'path', description: 'The file to read.' }],
    outputs: [{ name: 'summary', description: 'A bounded summary.' }],
    preconditions: [],
    postconditions: [{ name: 'recorded', description: 'The step closed on its verifier.' }],
  },
  applicability: ['research'],
  requiredCapabilities: ['work.execute'],
  steps: [{ key: 'read', capability: 'test.record', verifier: 'test.record.matches' }],
} as const

function admit(overrides: Record<string, unknown> = {}) {
  return admitSkill({
    source: 'owner',
    trustClass: 'owner-declared',
    admittedBy: 'owner',
    originRef: 'renderer',
    registry: registry(),
    payload: { ...VALID_BODY, ...overrides },
    existing: null,
  })
}

describe('skill identity is deterministic and derived from the name', () => {
  it('gives the same id for the same normalised name on every call', () => {
    expect(deriveSkillId('summarise-a-file')).toBe(deriveSkillId('summarise-a-file'))
    // Different spellings that normalise to the same name are the same skill, which is
    // what makes a retried admission idempotent instead of a silent duplicate.
    expect(normaliseSkillName('Summarise A File')).toBe('summarise-a-file')
    expect(normaliseSkillName('  summarise__a  file ')).toBe('summarise-a-file')
    expect(deriveSkillId(normaliseSkillName('Summarise A File')!)).toBe(
      deriveSkillId('summarise-a-file'),
    )
  })

  it('gives different ids for different names, and never collides with another domain', () => {
    expect(deriveSkillId('a')).not.toBe(deriveSkillId('b'))
    // The domain label is inside the digest, so a skill id cannot be confused with a
    // context id or a work item id even with the same short suffix.
    expect(deriveSkillId('a').startsWith('sk_')).toBe(true)
  })

  it('refuses a name that could traverse, collide or impersonate', () => {
    for (const bad of [
      '../../etc/passwd',
      'Constitution §1',
      'core/security/guard.ts',
      '',
      '   ',
      'a'.repeat(SKILL_LIMITS.maxNameChars + 1),
      '-leading-dash',
      'trailing-',
      'slash/name',
      'emoji🙂',
      42,
      null,
    ]) {
      expect(normaliseSkillName(bad)).toBeNull()
    }
  })

  it('normalises case rather than refusing it, so two spellings are one skill', () => {
    // Case is *normalised*, not rejected: refusing `UPPER CASE` would mean the same
    // procedure admitted twice under two spellings becomes two skills that disagree,
    // which is the exact problem the derived identity exists to prevent.
    expect(normaliseSkillName('UPPER CASE')).toBe('upper-case')
    expect(deriveSkillId(normaliseSkillName('UPPER CASE')!)).toBe(deriveSkillId('upper-case'))
  })

  it('collapses separators and rejects doubles', () => {
    expect(normaliseSkillName('a__b')).toBe('a-b')
    expect(normaliseSkillName('a - b')).toBe('a-b')
    expect(normaliseSkillName('a---b')).toBe('a-b')
  })
})

describe('the content hash is deterministic', () => {
  it('is stable for the same semantic body and changes when anything changes', () => {
    const base = {
      name: 'x',
      kind: 'procedure' as const,
      summary: 's',
      contract: VALID_BODY.contract,
      steps: VALID_BODY.steps,
      requiredCapabilities: ['work.execute'],
      applicability: ['research'],
    }
    const same = skillContentHash({ ...base })
    expect(skillContentHash({ ...base })).toBe(same)
    expect(skillContentHash({ ...base, summary: 's ' })).not.toBe(same)
    expect(skillContentHash({ ...base, applicability: ['research', 'other'] })).not.toBe(same)
    expect(skillContentHash({ ...base, requiredCapabilities: ['cognition.request'] })).not.toBe(same)
  })

  it('does not depend on the order of the contract keys', () => {
    const forward = skillContentHash({
      name: 'x',
      kind: 'procedure',
      summary: 's',
      contract: VALID_BODY.contract,
      steps: VALID_BODY.steps,
      requiredCapabilities: ['work.execute'],
      applicability: ['research'],
    })
    const backward = skillContentHash({
      applicability: ['research'],
      requiredCapabilities: ['work.execute'],
      steps: VALID_BODY.steps,
      contract: VALID_BODY.contract,
      summary: 's',
      kind: 'procedure',
      name: 'x',
    })
    expect(backward).toBe(forward)
  })
})

describe('admission refuses rather than repairs', () => {
  it('admits a well-formed procedure at version 1', () => {
    const outcome = admit()
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.record.skillId).toBe(deriveSkillId('summarise-a-file'))
    expect(outcome.record.version).toBe(1)
    expect(outcome.record.trustClass).toBe('owner-declared')
    expect(outcome.record.source).toBe('owner')
    // A *candidate*. Admission proves that a contract exists, nothing else.
    expect(outcome.record.steps).toHaveLength(1)
  })

  it('refuses a missing contract element rather than defaulting it', () => {
    for (const missing of ['inputs', 'outputs', 'preconditions', 'postconditions']) {
      const contract = { ...VALID_BODY.contract } as Record<string, unknown>
      delete contract[missing]
      const outcome = admit({ contract })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) return
      expect(outcome.code).toBe('contract-incomplete')
    }
  })

  it('allows empty preconditions, because nothing-must-be-true is a claim', () => {
    const outcome = admit({
      contract: { ...VALID_BODY.contract, preconditions: [] },
    })
    expect(outcome.ok).toBe(true)
  })

  it('refuses empty inputs, outputs or postconditions', () => {
    for (const key of ['inputs', 'outputs', 'postconditions']) {
      const outcome = admit({
        contract: { ...VALID_BODY.contract, [key]: [] },
      })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) return
      expect(outcome.code).toBe('contract-incomplete')
    }
  })

  it('refuses a kind it does not know, rather than storing the string', () => {
    const outcome = admit({ kind: 'whatever-the-caller-wanted' })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('invalid-skill-kind')
  })

  it('refuses an oversized list instead of trimming it', () => {
    const many = Array.from({ length: SKILL_LIMITS.maxContractEntries + 1 }, (_, index) => ({
      name: `input-${index}`,
      description: 'too many',
    }))
    const outcome = admit({ contract: { ...VALID_BODY.contract, inputs: many } })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('contract-oversize')
  })

  it('refuses a step with no verifier — verification is not optional', () => {
    const outcome = admit({ steps: [{ key: 'read', capability: 'test.record' }] })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('step-verifier-missing')
  })

  it('refuses a step whose verifier this Core does not have', () => {
    const outcome = admit({
      steps: [{ key: 'read', capability: 'test.record', verifier: 'nonexistent.verifier' }],
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('step-verifier-missing')
  })

  it('refuses a step whose capability this Core never registered', () => {
    const outcome = admit({
      steps: [{ key: 'read', capability: 'test.nonexistent', verifier: 'test.record.matches' }],
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('capability-not-registered')
  })

  it('refuses a required capability outside the closed vocabulary', () => {
    const outcome = admit({ requiredCapabilities: ['mind.control'] })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('unknown-capability-required')
  })

  it('refuses an empty applicability list, because nothing could ever select it', () => {
    const outcome = admit({ applicability: [] })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('contract-incomplete')
  })

  it('refuses a duplicate step key', () => {
    const outcome = admit({
      steps: [
        { key: 'read', capability: 'test.record', verifier: 'test.record.matches' },
        { key: 'read', capability: 'test.record', verifier: 'test.record.matches' },
      ],
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('step-verifier-missing')
  })
})

describe('capability laundering is refused at admission', () => {
  it('names every capability a procedure may never require', () => {
    // The list is derived from the closed vocabulary rather than hand-written, so a
    // capability added later is either covered by a prefix rule or loudly absent.
    for (const capability of CAPABILITIES) {
      const forbidden =
        capability.startsWith('security.') ||
        capability === 'cognition.grant.manage' ||
        capability === 'work.approval.decide' ||
        capability === 'mission.manage' ||
        capability === 'work.run.manage'
      expect(SKILL_FORBIDDEN_CAPABILITIES.includes(capability)).toBe(forbidden)
    }
    expect(SKILL_FORBIDDEN_CAPABILITIES).toContain('security.stop')
    expect(SKILL_FORBIDDEN_CAPABILITIES).toContain('cognition.grant.manage')
    expect(SKILL_FORBIDDEN_CAPABILITIES).toContain('work.approval.decide')
    expect(SKILL_FORBIDDEN_CAPABILITIES).toContain('mission.manage')
  })

  it('refuses a skill that requires one of them', () => {
    for (const capability of ['security.stop', 'security.resume', 'cognition.grant.manage', 'work.approval.decide', 'mission.manage', 'work.run.manage']) {
      const outcome = admit({ requiredCapabilities: [capability] })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) continue
      expect(outcome.code).toBe('forbidden-capability-required')
    }
  })

  it('refuses a step that names one of them, even when the list is clean', () => {
    const outcome = admit({
      requiredCapabilities: ['work.execute'],
      steps: [{ key: 'stop', capability: 'security.stop', verifier: 'test.record.matches' }],
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('forbidden-capability-required')
  })

  it('keeps the worker vocabulary disjoint from anything a skill may require', () => {
    // A worker-run may only hold `cognition.request` today. A skill requiring anything
    // beyond that can never be planned into a worker's Run, which is checked at
    // execution time against the real principal rather than assumed here.
    expect(WORKER_CAPABILITIES).toEqual(['cognition.request'])
    expect(SKILL_FORBIDDEN_CAPABILITIES).not.toContain('cognition.request')
  })
})

describe('the lifecycle table is the only way a status moves', () => {
  it('refuses candidate → promoted and every other skipped edge', () => {
    expect(canTransitionSkill('candidate', 'promoted')).toBe(false)
    expect(canTransitionSkill('candidate', 'verified')).toBe(false)
    expect(canTransitionSkill('draft', 'promoted')).toBe(false)
    expect(canTransitionSkill('retired', 'candidate')).toBe(false)
    expect(canTransitionSkill('blocked', 'draft')).toBe(false)
  })

  it('allows the honest path and the honest retreats', () => {
    expect(canTransitionSkill('candidate', 'draft')).toBe(true)
    expect(canTransitionSkill('draft', 'trial')).toBe(true)
    expect(canTransitionSkill('trial', 'verified')).toBe(true)
    expect(canTransitionSkill('verified', 'promoted')).toBe(true)
    // Withdrawing a promotion is a decision, not a failure, so there is a way back.
    expect(canTransitionSkill('promoted', 'trial')).toBe(true)
    // And a version whose evidence went stale returns to a status it cannot be
    // selected from.
    expect(canTransitionSkill('verified', 'draft')).toBe(true)
  })

  it('keeps retirement terminal', () => {
    for (const from of ['retired', 'blocked'] as const) {
      expect(SKILL_TRANSITIONS[from]).toHaveLength(0)
    }
  })

  it('recognises every status it declares and no others', () => {
    for (const value of ['candidate', 'draft', 'trial', 'verified', 'promoted', 'retired', 'blocked']) {
      expect(isSkillStatus(value)).toBe(true)
    }
    for (const value of ['promoted!', 'PROMOTED', '', null, 7]) {
      expect(isSkillStatus(value)).toBe(false)
    }
  })
})

describe('the fold refuses an illegal or forged line', () => {
  const admitPayload = {
    skillId: deriveSkillId('summarise-a-file'),
    name: 'summarise-a-file',
    nameLength: 'summarise-a-file'.length,
    kind: 'procedure',
    version: 1,
    contentHash: 'a'.repeat(32),
    source: 'owner',
    trustClass: 'owner-declared',
    admittedBy: 'owner',
    originRef: 'renderer',
    stepCount: 1,
    requiredCapabilityCount: 1,
    applicabilityCount: 1,
    applicability: ['research'],
    inputCount: 1,
    outputCount: 1,
    preconditionCount: 0,
    postconditionCount: 1,
    summaryLength: 40,
  }

  function event(type: string, payload: unknown, sequence = 1) {
    return {
      eventId: `e${sequence}`,
      sequence,
      type,
      schemaVersion: 1,
      occurredAt: '2026-10-02T09:00:00.000Z',
      source: 'system',
      actor: 'system',
      correlationId: 'c',
      causationId: null,
      payload,
    } as never
  }

  it('creates a candidate from an admission', () => {
    const state = reduceSkillState(initialSkillState(), event('skill.admitted', admitPayload))
    expect(state.records).toHaveLength(1)
    expect(state.records[0]?.status).toBe('candidate')
    expect(state.records[0]?.version).toBe(1)
    expect(state.records[0]?.applicability).toEqual(['research'])
    expect(findSkill(state, admitPayload.skillId)).not.toBeNull()
  })

  it('refuses a second record with the same name', () => {
    let state = reduceSkillState(initialSkillState(), event('skill.admitted', admitPayload))
    state = reduceSkillState(state, event('skill.admitted', admitPayload, 2))
    expect(state.records).toHaveLength(1)
    // The duplicate is *recorded as a refusal* rather than silently dropped, so a
    // probing pattern is visible.
    expect(state.rejectedAdmissions.at(-1)?.code).toBe('duplicate-identity')
  })

  it('refuses a transition whose from disagrees with the record', () => {
    let state = reduceSkillState(initialSkillState(), event('skill.admitted', admitPayload))
    state = reduceSkillState(
      state,
      event(
        'skill.transitioned',
        { skillId: admitPayload.skillId, from: 'promoted', to: 'trial', reason: 'evaluation-basis', evidence: null },
        2,
      ),
    )
    expect(state.records[0]?.status).toBe('candidate')
  })

  it('refuses a lifecycle line that tries to reach a terminal status', () => {
    let state = reduceSkillState(initialSkillState(), event('skill.admitted', admitPayload))
    state = reduceSkillState(
      state,
      event(
        'skill.transitioned',
        { skillId: admitPayload.skillId, from: 'candidate', to: 'retired', reason: 'evaluation-basis', evidence: null },
        2,
      ),
    )
    // Retirement is its own event family, so a lifecycle line cannot hide the reason.
    expect(state.records[0]?.status).toBe('candidate')
  })

  it('refuses a revision that does not advance the version by exactly one', () => {
    let state = reduceSkillState(initialSkillState(), event('skill.admitted', admitPayload))
    state = reduceSkillState(state, event('skill.revised', { ...admitPayload, version: 1 }, 2))
    expect(state.records[0]?.version).toBe(1)
    state = reduceSkillState(state, event('skill.revised', { ...admitPayload, version: 3 }, 3))
    expect(state.records[0]?.version).toBe(1)
    state = reduceSkillState(state, event('skill.revised', { ...admitPayload, version: 2 }, 4))
    expect(state.records[0]?.version).toBe(2)
    expect(state.records[0]?.status).toBe('candidate')
    expect(state.records[0]?.verification).toBe('unverified')
  })

  it('never raises a trust class on revision', () => {
    let state = reduceSkillState(
      initialSkillState(),
      event('skill.admitted', { ...admitPayload, trustClass: 'untrusted-content' }, 1),
    )
    state = reduceSkillState(
      state,
      event('skill.revised', { ...admitPayload, version: 2, trustClass: 'code-owned', source: 'improvement' }, 2),
    )
    // Trust is inherited from the record, not from the line that claims it.
    expect(state.records[0]?.trustClass).toBe('untrusted-content')
    expect(state.records[0]?.source).toBe('improvement')
  })

  it('ignores every non-skill event without allocating', () => {
    const before = initialSkillState()
    const after = reduceSkillState(before, event('core.ready', {}))
    expect(after).toBe(before)
  })
})

describe('the durable validator refuses a malformed skill line', () => {
  const base = {
    eventId: 'e1',
    sequence: 1,
    type: 'skill.admitted',
    schemaVersion: 1,
    occurredAt: '2026-10-02T09:00:00.000Z',
    source: 'system',
    actor: 'owner',
    correlationId: 'c',
    causationId: null,
    payload: {
      skillId: deriveSkillId('summarise-a-file'),
      name: 'summarise-a-file',
      nameLength: 17,
      kind: 'procedure',
      version: 1,
      contentHash: 'a'.repeat(32),
      source: 'owner',
      trustClass: 'owner-declared',
      admittedBy: 'owner',
      originRef: 'renderer',
      stepCount: 1,
      requiredCapabilityCount: 1,
      applicabilityCount: 1,
      applicability: ['research'],
      inputCount: 1,
      outputCount: 1,
      preconditionCount: 0,
      postconditionCount: 1,
      summaryLength: 40,
    },
  }

  it('accepts the shape this Core writes', () => {
    expect(validateDurableEvent(base, 0).ok).toBe(true)
  })

  it('refuses an extra field, which is where a summary would hide', () => {
    const forged = {
      ...base,
      payload: { ...base.payload, summary: 'the whole procedure in plain text' },
    }
    const result = validateDurableEvent(forged, 0)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/shape of skill.admitted/)
  })

  it('refuses a non-slug name and an applicability tag that is not a slug', () => {
    expect(validateDurableEvent({ ...base, payload: { ...base.payload, name: 'Not A Slug' } }, 0).ok).toBe(false)
    expect(
      validateDurableEvent(
        { ...base, payload: { ...base.payload, applicability: ['a sentence pretending to be a tag'] } },
        0,
      ).ok,
    ).toBe(false)
  })

  it('refuses a tag count that disagrees with the list', () => {
    const result = validateDurableEvent(
      { ...base, payload: { ...base.payload, applicabilityCount: 5 } },
      0,
    )
    expect(result.ok).toBe(false)
  })

  it('refuses a protected domain as an improvement target', () => {
    const proposal = {
      eventId: 'e2',
      sequence: 2,
      type: 'skill.improvement.proposed',
      schemaVersion: 1,
      occurredAt: '2026-10-02T09:00:00.000Z',
      source: 'system',
      actor: 'owner',
      correlationId: 'p',
      causationId: null,
      payload: {
        proposalId: 'p',
        target: 'implementation-artifact',
        targetRef: 'core/security/guard.ts',
        skillId: null,
        baseVersion: null,
        summaryLength: 10,
        basisEvaluationIds: [],
        proposedBy: 'owner',
        openProposalsAt: 0,
      },
    }
    expect(validateDurableEvent(proposal, 1).ok).toBe(false)
    expect(validateDurableEvent({ ...proposal, payload: { ...proposal.payload, targetRef: 'my-helper' } }, 1).ok).toBe(
      true,
    )
  })

  it('refuses an evaluation authored by a model, because there is no such spelling', () => {
    const evaluation = {
      eventId: 'e3',
      sequence: 3,
      type: 'skill.evaluation.recorded',
      schemaVersion: 1,
      occurredAt: '2026-10-02T09:00:00.000Z',
      source: 'system',
      actor: 'system',
      correlationId: 'c',
      causationId: null,
      payload: {
        evaluationId: 'v',
        skillId: 'sk',
        version: 1,
        subjectKind: 'trial-run',
        subjectRef: 'run-1',
        author: 'model',
        verdict: 'established',
        reason: 'verification-passed',
        deterministicCount: 1,
        positiveCount: 1,
        negativeCount: 0,
        commentaryChars: 400,
      },
    }
    expect(validateDurableEvent(evaluation, 2).ok).toBe(false)
    expect(
      validateDurableEvent({ ...evaluation, payload: { ...evaluation.payload, author: 'system' } }, 2).ok,
    ).toBe(true)
  })

  it('refuses a runtime promotion that claims anything other than a refusal', () => {
    const refusal = {
      eventId: 'e4',
      sequence: 4,
      type: 'skill.runtime.promotion.refused',
      schemaVersion: 1,
      occurredAt: '2026-10-02T09:00:00.000Z',
      source: 'system',
      actor: 'owner',
      correlationId: 'a',
      causationId: null,
      payload: {
        artifactId: 'a',
        targetRef: 'my-helper',
        reason: 'runtime-promotion-unavailable',
      },
    }
    expect(validateDurableEvent(refusal, 3).ok).toBe(true)
    expect(
      validateDurableEvent({ ...refusal, payload: { ...refusal.payload, reason: 'accepted' } }, 3).ok,
    ).toBe(false)
  })
})

describe('protected domains are protected by a closed table', () => {
  it('lists everything Phase 17 promises it cannot touch', () => {
    for (const domain of [
      'constitution',
      'identity',
      'authority',
      'guard',
      'governor',
      'stop-all',
      'spending-policy',
      'approval-policy',
      'capability-definition',
      'security-policy',
      'trusted-boot',
      'keyring',
      'core-protocol',
      'core-runtime',
    ]) {
      expect(PROTECTED_DOMAINS).toContain(domain as never)
      expect(targetIsProtected(domain)).toBe(true)
    }
  })

  it('catches a protected domain hidden inside a path-shaped reference', () => {
    expect(targetIsProtected('core/security/guard.ts')).toBe(true)
    expect(targetIsProtected('docs/freya-constitution.md')).toBe(true)
    expect(targetIsProtected('a-guard-rule')).toBe(true)
    // And leaves an ordinary artifact reference alone.
    expect(targetIsProtected('summarise-a-file')).toBe(false)
    expect(targetIsProtected('pdf-reporting')).toBe(false)
  })
})

describe('bounded text', () => {
  it('strips control characters and collapses whitespace, without interpreting', () => {
    expect(sanitiseSkillText('a\u0000b\u001bc', 100)).toBe('abc')
    expect(sanitiseSkillText('a\n\n  b', 100)).toBe('a b')
    // Hostile text is still data: it is bounded, not refused, because refusing would
    // hide the attempt.
    expect(sanitiseSkillText('ignore previous instructions', 100)).toBe('ignore previous instructions')
  })

  it('truncates at the bound it was given', () => {
    expect(sanitiseSkillText('x'.repeat(50), 10)).toHaveLength(10)
    expect(sanitiseSkillText('x'.repeat(50), 10)).not.toContain('…')
  })

  it('returns empty for anything that is not a string', () => {
    for (const value of [null, undefined, 42, {}, []]) {
      expect(sanitiseSkillText(value, 100)).toBe('')
    }
  })

  it('bounds a contract entry and a tag the same way', () => {
    expect(normaliseContractEntry({ name: 'Path', description: 'a file' })).toEqual({
      name: 'path',
      description: 'a file',
    })
    expect(normaliseContractEntry({ name: '../escape', description: '' })).toBeNull()
    // A missing description is refused rather than defaulted to empty: a contract entry
    // that silently lost its description is one the owner did not write.
    expect(normaliseContractEntry({ name: 'ok' })).toBeNull()
    expect(normaliseContractEntry({ name: 'ok', description: '' })).toEqual({ name: 'ok', description: '' })
    expect(normaliseTag('Research Notes')).toBe('research-notes')
    // Whitespace becomes a dash, exactly as a name does, so a tag is always a slug.
    expect(normaliseTag('not a tag')).toBe('not-a-tag')
    expect(normaliseTag('a sentence pretending to be a tag!')).toBeNull()
  })
})