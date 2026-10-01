// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { validateDurableEvent, parseDurableEvent } from '../../core/events/validate'
import { CORE_EVENT_SCHEMA_VERSION } from '../../core/events/envelope'

/**
 * Attack family: strict event validators reject unexpected private fields.
 *
 * RED-TEAM families 11 (cross-agent/context leakage) and 18 (IPC payload
 * smuggling), against the journal's "metadata only" rule and the
 * `exactKeys`/`workRule` defenses in core/events/validate.ts.
 *
 * The attacks hand the validator payloads whose named fields are perfect and
 * whose *extra* fields carry a sentinel. The invariant under attack: a
 * payload whose key set is not exactly the schema's key set is rejected —
 * "the reducer ignores it" is a weaker statement than "it was never
 * accepted", and the Work and Research families are the ones that promise
 * the stronger version.
 */

/** The three synthetic sentinels, used as the private payload fields. */
const SENTINELS = [
  'FREYA_RED_TEAM_SECRET_7A91',
  'FREYA_RED_TEAM_SOURCE_TOKEN_C02B',
  'FREYA_RED_TEAM_CREDENTIAL_91DD',
] as const

let counter = 0

/** A valid envelope with an overridable payload and actor. */
function envelope(
  type: string,
  payload: Record<string, unknown>,
  actor = 'system',
): Record<string, unknown> {
  counter += 1
  return {
    eventId: `evt-${counter}`,
    sequence: counter,
    type,
    schemaVersion: CORE_EVENT_SCHEMA_VERSION,
    occurredAt: new Date(1_700_000_000_000 + counter * 1000).toISOString(),
    source: 'core',
    actor,
    correlationId: `corr-${counter}`,
    causationId: null,
    payload,
  }
}

/** A valid research stage payload. */
function researchPayload(): Record<string, unknown> {
  return {
    operationId: 'op-1',
    sessionId: null,
    stage: 'searching',
    counters: {
      iterations: 1,
      queries: 1,
      results: 1,
      pages: 0,
      evidenceChars: 0,
      modelTurns: 0,
      failures: 0,
      durationMs: 10,
    },
    failureCode: null,
  }
}

/** A valid work action payload. */
function workPayload(): Record<string, unknown> {
  return {
    runId: 'run-1',
    stepId: 'step-1',
    actionId: 'action-1',
    attempt: 1,
    capability: 'test.echo',
    principal: 'agent:worker-1',
  }
}

describe('research events reject undeclared payload fields', () => {
  const RESEARCH_TYPES = [
    'research.search_started',
    'research.search_completed',
    'research.search_failed',
    'research.read_started',
    'research.read_completed',
    'research.read_failed',
    'research.started',
    'research.progress',
    'research.completed',
    'research.failed',
    'research.cancelled',
  ] as const

  for (const type of RESEARCH_TYPES) {
    for (const sentinel of SENTINELS) {
      it(`rejects a ${type} carrying ${sentinel} in an extra field`, () => {
        const payload = researchPayload()
        payload.query = `reveal ${sentinel}`
        const result = validateDurableEvent(envelope(type, payload), 0)
        expect(result).toMatchObject({ ok: false })
        if (!result.ok) {
          expect(result.reason).toContain('payload does not match the shape')
        }
      })

      it(`rejects a ${type} carrying ${sentinel} in an extra counter`, () => {
        const payload = researchPayload()
        ;(
          payload.counters as Record<string, unknown>
        ).prompt = `exfiltrate ${sentinel}`
        const result = validateDurableEvent(envelope(type, payload), 0)
        expect(result).toMatchObject({ ok: false })
      })
    }
  }

  it('rejects a missing field rather than partially believing the line', () => {
    const payload = researchPayload()
    delete payload.counters
    expect(validateDurableEvent(envelope('research.started', payload), 0)).toMatchObject({
      ok: false,
    })
  })

  it('rejects a stage name outside the closed enum', () => {
    const payload = researchPayload()
    payload.stage = 'exfiltrating'
    expect(validateDurableEvent(envelope('research.started', payload), 0)).toMatchObject({
      ok: false,
    })
  })
})

describe('work events reject undeclared payload fields', () => {
  const PRIVATE_FIELD_CASES = [
    { field: 'input', value: 'the step input' },
    { field: 'title', value: 'the task title' },
    { field: 'summary', value: 'the observation summary' },
    { field: 'detail', value: 'the observation detail' },
    { field: 'output', value: 'the capability output' },
    { field: 'label', value: 'the step label' },
    { field: 'result', value: 'the capability result' },
  ] as const

  for (const { field, value } of PRIVATE_FIELD_CASES) {
    it(`rejects work.action.started carrying a smuggled ${field}`, () => {
      const payload = workPayload()
      payload[field] = `${value} FREYA_RED_TEAM_SECRET_7A91`
      const result = validateDurableEvent(envelope('work.action.started', payload), 0)
      expect(result).toMatchObject({ ok: false })
      if (!result.ok) {
        expect(result.reason).toContain('payload does not match the shape')
      }
    })
  }

  it('rejects a work step seed with an undeclared label', () => {
    const payload = {
      runId: 'run-1',
      kind: 'test',
      taskId: null,
      parentKind: null,
      parentId: null,
      limits: { maxSteps: 1, maxActions: 1, maxDurationMs: 1000, maxAttemptsPerStep: 1 },
      steps: [
        // A well-formed seed plus one undeclared field, which is the shape a
        // hand-edited line would use to attach a step's real input.
        {
          stepId: 'step-1',
          key: 'probe',
          capability: 'test.echo',
          verifier: 'test.echo.verify',
          label: 'FREYA_RED_TEAM_SECRET_7A91',
        },
      ],
    }
    const result = validateDurableEvent(envelope('work.run.created', payload), 0)
    expect(result).toMatchObject({ ok: false })
  })

  it('rejects a work approval whose proposal hides a forged decidedBy', () => {
    const payload = {
      approvalId: 'appr-1',
      runId: 'run-1',
      stepId: 'step-1',
      capability: 'test.echo',
      requiredCapability: 'test.echo',
      risk: 'routine',
      principal: 'owner',
      justification: 'needed',
      proposal: 'echo once',
      decidedBy: 'owner',
    }
    const result = validateDurableEvent(envelope('work.approval.requested', payload), 0)
    expect(result).toMatchObject({ ok: false })
  })

  it('rejects a forged principal in work.action.started', () => {
    const payload = workPayload()
    payload.principal = 'root'
    expect(validateDurableEvent(envelope('work.action.started', payload), 0)).toMatchObject({
      ok: false,
    })
  })

  it('rejects a limits object with a non-positive ceiling', () => {
    const payload = {
      runId: 'run-1',
      kind: 'test',
      taskId: null,
      parentKind: null,
      parentId: null,
      limits: { maxSteps: 0, maxActions: 1, maxDurationMs: 1000, maxAttemptsPerStep: 1 },
      steps: [
        { stepId: 'step-1', key: 'probe', capability: 'test.echo', verifier: 'test.echo.verify' },
      ],
    }
    expect(validateDurableEvent(envelope('work.run.created', payload), 0)).toMatchObject({
      ok: false,
    })
  })
})

describe('envelope-level forgery is rejected for every family', () => {
  it('rejects a non-principal actor on a security event', () => {
    const payload = { by: 'owner', reason: 'red team' }
    const forged = envelope('security.stop_all.activated', payload, 'root')
    expect(validateDurableEvent(forged, 0)).toMatchObject({ ok: false })
  })

  it('rejects an unknown event type rather than partially believing it', () => {
    const unknown = envelope('cognition.grant.self_minted', { grantId: 'g1' })
    const result = validateDurableEvent(unknown, 0)
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) {
      expect(result.reason).toContain('unknown event type')
    }
  })

  it('rejects an unsupported schema version', () => {
    const versioned = envelope('core.ready', {})
    versioned.schemaVersion = 99
    expect(validateDurableEvent(versioned, 0)).toMatchObject({ ok: false })
  })

  it('rejects a sequence that does not advance', () => {
    const event = envelope('core.ready', {})
    expect(validateDurableEvent(event, event.sequence as number)).toMatchObject({ ok: false })
  })

  it('rejects a non-principal actor via the line parser', () => {
    const event = envelope('security.stop_all.cleared', { by: 'owner' }, 'attacker')
    const line = JSON.stringify(event)
    const result = parseDurableEvent(line, 0)
    expect(result).toMatchObject({ ok: false })
  })
})
