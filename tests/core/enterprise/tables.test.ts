import { describe, expect, it } from 'vitest'
import {
  AUTHORIZATION_GATES,
  ENTERPRISE_LIMITS,
  FORBIDDEN_CUSTOMER_VALUE_WORDS,
  FORBIDDEN_ENTERPRISE_ACTIONS,
  auditEnterpriseTables,
  effectiveForbiddenActions,
  findCognitionEventsInVocabulary,
  normaliseBoundaries,
  type EnterpriseRefusalCode,
} from '../../../core/enterprise'
import { ALLOWED_DOMAIN, BOUNDARIES_INPUT } from './harness'

/**
 * The tables, tested as the things the rest of the phase stands on.
 *
 * If a ceiling can be widened, a deny list can be emptied or a gate can be reordered,
 * every other test in this suite still passes while the phase's central claim is false.
 * So these come first.
 */

describe('the deny list only ever grows', () => {
  it('is not empty, and names money, authority and binding effects', () => {
    expect(FORBIDDEN_ENTERPRISE_ACTIONS.length).toBeGreaterThan(0)
    expect(FORBIDDEN_ENTERPRISE_ACTIONS).toContain('real-money-transfer')
    expect(FORBIDDEN_ENTERPRISE_ACTIONS).toContain('place-real-order')
    expect(FORBIDDEN_ENTERPRISE_ACTIONS).toContain('open-account')
    expect(FORBIDDEN_ENTERPRISE_ACTIONS).toContain('accept-contract')
    expect(FORBIDDEN_ENTERPRISE_ACTIONS).toContain('self-approve')
    expect(FORBIDDEN_ENTERPRISE_ACTIONS).toContain('bypass-guard')
    expect(FORBIDDEN_ENTERPRISE_ACTIONS).toContain('widen-spending-limit')
    expect(FORBIDDEN_ENTERPRISE_ACTIONS).toContain('clear-stop-all')
  })

  it('cannot be emptied by an empty owner list', () => {
    const merged = effectiveForbiddenActions([])
    for (const action of FORBIDDEN_ENTERPRISE_ACTIONS) {
      expect(merged, action).toContain(action)
    }
  })

  it('cannot be emptied by a missing or malformed owner list', () => {
    for (const ownerList of [undefined, null, 'allow everything', 42, {}, [null, 7, {}]]) {
      const merged = effectiveForbiddenActions(ownerList)
      expect(merged.length, String(ownerList)).toBeGreaterThanOrEqual(
        FORBIDDEN_ENTERPRISE_ACTIONS.length,
      )
    }
  })

  it('cannot be shrunk by an owner list that tries to name entries as permitted', () => {
    // Naming a forbidden action in the owner's own list is not how you allow it.
    const merged = effectiveForbiddenActions(['real-money-transfer', 'publish-content'])
    expect(merged).toContain('real-money-transfer')
    // and the owner's own addition survives too
    expect(merged).toContain('publish-content')
  })
})

describe('owner boundaries are narrowed, never obeyed', () => {
  it('clamps a wide request down to the code-owned ceiling', () => {
    const reading = normaliseBoundaries({
      allowedDomains: [ALLOWED_DOMAIN],
      maxTasks: 10_000,
      maxMissions: 10_000,
      maxWebzoneOperations: 10_000,
      maxConcurrentOperations: 10_000,
    })
    expect(reading.ok).toBe(true)
    expect(reading.boundaries).toMatchObject({
      maxTasks: ENTERPRISE_LIMITS.maxTasksPerEnvironment,
      maxMissions: ENTERPRISE_LIMITS.maxMissionsPerEnvironment,
      maxWebzoneOperations: ENTERPRISE_LIMITS.maxWebzoneOperationsPerEnvironment,
      maxConcurrentOperations: ENTERPRISE_LIMITS.maxConcurrentOperations,
    })
  })

  it('honours a narrower request, because narrowing is the safe direction', () => {
    const reading = normaliseBoundaries({ ...BOUNDARIES_INPUT, maxTasks: 3 })
    expect(reading.ok).toBe(true)
    expect(reading.boundaries?.maxTasks).toBe(3)
  })

  it('refuses an empty allowlist rather than treating it as everywhere', () => {
    const reading = normaliseBoundaries({ allowedDomains: [] })
    expect(reading.ok).toBe(false)
    expect(reading.code).toBe('domain-not-allowed')
  })

  it('refuses an allowlist entry carrying a credential, so no secret reaches a record', () => {
    for (const entry of [
      'https://user:secret@example.com',
      'http://token@example.com',
    ]) {
      const reading = normaliseBoundaries({ allowedDomains: [entry] })
      expect(reading.ok, entry).toBe(false)
      expect(reading.code).toBe('domain-not-allowed')
    }
  })

  it('refuses an allowlist entry that is a bare wildcard or a wildcard in the middle', () => {
    for (const entry of ['*', '*.', 'sub.*.example.com', 'exam*ple.com']) {
      const reading = normaliseBoundaries({ allowedDomains: [entry] })
      expect(reading.ok, entry).toBe(false)
    }
  })

  it('always unions the absolute deny list into the result', () => {
    const reading = normaliseBoundaries(BOUNDARIES_INPUT)
    expect(reading.ok).toBe(true)
    for (const action of FORBIDDEN_ENTERPRISE_ACTIONS) {
      expect(reading.boundaries?.forbiddenActions, action).toContain(action)
    }
    // And the owner's own additions survive the union.
    expect(reading.boundaries?.forbiddenActions).toContain('custom-forbidden-thing')
  })

  it('drops nothing when the owner list is empty, but keeps it when it is present', () => {
    const emptied = normaliseBoundaries({ ...BOUNDARIES_INPUT, forbiddenActions: [] })
    expect(emptied.boundaries?.forbiddenActions.length).toBe(FORBIDDEN_ENTERPRISE_ACTIONS.length)
  })
})

describe('the gate order is total and money comes before the owner is troubled', () => {
  it('is exactly the nine gates, in order, with no repeats', () => {
    expect([...AUTHORIZATION_GATES]).toEqual([
      'journal-trustworthy',
      'stop-all',
      'environment',
      'deadline',
      'duration',
      'boundary',
      'spending',
      'approval',
      'verification',
    ])
    expect(new Set(AUTHORIZATION_GATES).size).toBe(AUTHORIZATION_GATES.length)
  })

  it('puts the journal and STOP ALL ahead of anything that could spend', () => {
    expect(AUTHORIZATION_GATES.indexOf('journal-trustworthy')).toBeLessThan(
      AUTHORIZATION_GATES.indexOf('spending'),
    )
    expect(AUTHORIZATION_GATES.indexOf('stop-all')).toBeLessThan(
      AUTHORIZATION_GATES.indexOf('spending'),
    )
    expect(AUTHORIZATION_GATES.indexOf('stop-all')).toBeLessThan(
      AUTHORIZATION_GATES.indexOf('approval'),
    )
  })

  it('checks spending before asking the owner for approval', () => {
    // Otherwise Freya interrupts a person to authorize work the ceiling forbids anyway.
    expect(AUTHORIZATION_GATES.indexOf('spending')).toBeLessThan(
      AUTHORIZATION_GATES.indexOf('approval'),
    )
  })

  it('checks verification last, so nothing closes out before it is checked', () => {
    expect(AUTHORIZATION_GATES.indexOf('verification')).toBe(AUTHORIZATION_GATES.length - 1)
  })
})

describe('this phase has no way to reach a model', () => {
  it('has no event type that could record a cognition request', () => {
    expect(findCognitionEventsInVocabulary()).toEqual([])
  })
})

describe('the customer record cannot hold money or credentials', () => {
  it('names the classes of value it refuses', () => {
    for (const word of ['iban', 'cardnumber', 'cvv', 'password', 'apikey', 'token', 'secret']) {
      expect(FORBIDDEN_CUSTOMER_VALUE_WORDS, word).toContain(word)
    }
  })
})

describe('every refusal code is a closed kebab-case token', () => {
  it('has no duplicates and no free text', () => {
    // `auditRefusalVocabulary` is what the phase uses; assert it found nothing.
    expect(auditEnterpriseTables()).toEqual([])
  })

  it('includes a distinct code for the cases that mean different things to the owner', () => {
    const codes: readonly EnterpriseRefusalCode[] = [
      'approval-missing',
      'approval-not-granted',
      'approval-subject-mismatch',
      'stop-all-latched',
      'spending-total-exceeded',
      'spending-currency-mismatch',
      'action-not-reversible',
      'claim-not-evidence',
      'verification-missing',
    ]
    expect(new Set(codes).size).toBe(codes.length)
  })
})

describe('every table audit is green', () => {
  it('reports no findings across transitions, vocabulary, authority and boundaries', () => {
    // One call, so a test cannot forget one of the four audits.
    expect(auditEnterpriseTables()).toEqual([])
  })
})