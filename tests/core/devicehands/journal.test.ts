// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  DEVICE_HANDS_ACTION_TRANSITIONS,
  DEVICE_HANDS_APPROVAL_TRANSITIONS,
  DEVICE_HANDS_PAYLOAD_KEYS,
  DEVICE_HANDS_REFUSAL_REASONS,
  actionIsComplete,
  consumedActionIds,
  createDeviceHandsRuntime,
  initialDeviceHandsState,
  mayOpenJournal,
  mayTransitionApproval,
  recoveryReport,
  reduceDeviceHandsEntry,
  reduceDeviceHandsState,
  unresolvedActions,
  type DeviceHandsJournalEntry,
} from '../../../core/devicehands'
import {
  ALLOWED_ROOT,
  T0,
  T_PLUS_5M,
  defaultGrant,
  downloadInput,
  harness,
  POLICY_INPUT,
} from './harness'

/**
 * The journal, the fold, and what a restart is willing to claim.
 *
 * Everything this phase knows comes from the journal, so these tests are where the
 * claims about durability, idempotence and honest recovery are actually pinned down.
 * The tamper cases matter most: a fold that *repairs* a bad journal is worse than no
 * fold, because it produces confident fiction about what the machine has already done.
 */
describe('device hands journal and recovery', () => {
  it('derives all state from the journal and nothing else', async () => {
    const h = harness()
    await h.ready()
    await h.request({ actionId: 'act-1', actionKey: 'browser.navigate' })

    const replayed = reduceDeviceHandsState(h.entries)

    expect(replayed.anomalies).toEqual([])
    expect(Object.keys(replayed.state.actions)).toEqual(['act-1'])
    expect(replayed.state.actions['act-1']?.outcome).toBe('completed')
    expect(replayed.state.policyDigest).toBe(h.runtime.snapshot().policyDigest)
    expect(replayed.state.openedAt).toBe(T0)
  })

  it('builds the same state in a second runtime over the same journal', async () => {
    const h = harness()
    await h.ready()
    await h.request({ actionId: 'act-1', actionKey: 'browser.navigate' })
    await h.request({ actionId: 'act-2', actionKey: 'transfer.download', input: downloadInput() })

    const second = createDeviceHandsRuntime({ ports: h.ports })
    await second.open()

    expect(second.snapshot().actionCountThisSession).toBe(2)
    expect(second.snapshot().bytesThisSession).toBe(2048)
    expect(Object.keys(second.snapshot().actions).sort()).toEqual(['act-1', 'act-2'])
  })

  it('refuses to open an untrustworthy journal rather than repairing it', async () => {
    const h = harness({ journalTrustworthy: false })
    await expect(h.runtime.open()).rejects.toThrow(/journal-untrustworthy/)
  })

  it('refuses to open a journal with more actions than the ceiling', () => {
    const result = mayOpenJournal({ trustworthy: true, actionCount: 1_000 })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('action-count-exceeded')
  })

  it('records an action the process could not finish as interrupted, not as done', async () => {
    const h = harness()
    await h.ready()
    // A journal that stops in the middle: started, no verdict.
    h.seed([
      {
        type: 'hands.action.started',
        recordedAt: T0,
        payload: {
          actionId: 'act-lost',
          actionKey: 'browser.navigate',
          surface: 'browser',
          principalId: 'owner-1',
          grantId: 'grant-1',
          deadlineAt: T_PLUS_5M,
          at: T0,
        },
      },
    ])

    const reportBefore = recoveryReport(reduceDeviceHandsState(h.entries).state)
    expect(reportBefore.unresolved).toHaveLength(1)
    expect(reportBefore.completed).toBe(0)

    // A restart reconciles it as interrupted, and journals that decision.
    const restarted = createDeviceHandsRuntime({ ports: h.ports })
    await restarted.open()
    const state = restarted.snapshot()

    expect(state.actions['act-lost']?.outcome).toBe('interrupted')
    expect(actionIsComplete(state, 'act-lost')).toBe(false)
    expect(h.types()).toContain('hands.reconciled')
    expect(unresolvedActions(state)).toHaveLength(0)
  })

  it('does not retry an interrupted action under its old id', async () => {
    const h = harness()
    await h.ready()
    h.seed([
      {
        type: 'hands.action.started',
        recordedAt: T0,
        payload: {
          actionId: 'act-lost',
          actionKey: 'browser.navigate',
          surface: 'browser',
          principalId: 'owner-1',
          grantId: 'grant-1',
          deadlineAt: T_PLUS_5M,
          at: T0,
        },
      },
    ])
    // The *restarted* runtime is the one that knows: the original process folded the
    // journal before the entry above existed, which is the whole point of a restart.
    const restarted = createDeviceHandsRuntime({ ports: h.ports })
    await restarted.open()

    const outcome = await restarted.perform({
      actionId: 'act-lost',
      principalId: 'owner-1',
      scope: 'session-1',
      actionKey: 'browser.navigate',
      claimsAction: null,
      input: { url: 'https://example.com/about' },
      deadlineAt: T_PLUS_5M,
      at: T0,
    })

    expect(outcome.code).toBe('replay-detected')
    expect(h.calls('browser')).toBe(0)
  })

  it('records a refusal as consuming its id, so it cannot be re-presented', async () => {
    const h = harness()
    await h.ready()
    await h.request({ actionId: 'act-x', actionKey: 'terminal.run', input: { command: 'curl', args: [], workingDirectory: ALLOWED_ROOT, env: {} } })

    const replay = await h.request({ actionId: 'act-x', actionKey: 'terminal.run', input: { command: 'curl', args: [], workingDirectory: ALLOWED_ROOT, env: {} } })

    expect(replay.outcome.code).toBe('replay-detected')
    expect(consumedActionIds(h.runtime.snapshot()).has('act-x')).toBe(true)
  })

  describe('the fold refuses a tampered journal', () => {
    const base: DeviceHandsJournalEntry[] = [
      {
        type: 'hands.policy.set',
        recordedAt: T0,
        payload: { policyDigest: 'abc', rootCount: 1, hostCount: 1, commandCount: 1, envCount: 1, at: T0 },
      },
    ]

    it('records an unknown event type rather than ignoring it', () => {
      const folded = reduceDeviceHandsState([
        ...base,
        { type: 'hands.something.new', recordedAt: T0, payload: {} },
      ])
      expect(folded.anomalies.map((a) => a.code)).toContain('unknown-event-type')
    })

    it('refuses a payload key outside the published table', () => {
      const folded = reduceDeviceHandsState([
        ...base,
        {
          type: 'hands.action.refused',
          recordedAt: T0,
          payload: { actionId: 'a', actionKey: 'browser.navigate', gate: 'policy', code: 'x', reason: 'y', at: T0, extra: 'x' },
        },
      ])
      expect(folded.anomalies.map((a) => a.code)).toContain('unknown-payload-key')
    })

    it('refuses a payload key that names authority, in any event', () => {
      for (const key of ['capability', 'approved', 'token', 'screenshot', 'image', 'verdict']) {
        const folded = reduceDeviceHandsState([
          {
            type: 'hands.action.refused',
            recordedAt: T0,
            payload: { actionId: 'a', actionKey: 'browser.navigate', gate: 'policy', code: 'x', reason: 'y', at: T0, [key]: 'x' },
          },
        ])
        expect(folded.anomalies.map((a) => a.code)).toContain('forbidden-payload-key')
      }
    })

    it('refuses an oversized string, so the journal cannot become a transcript', () => {
      const folded = reduceDeviceHandsState([
        {
          type: 'hands.action.refused',
          recordedAt: T0,
          payload: { actionId: 'a', actionKey: 'browser.navigate', gate: 'policy', code: 'x', reason: 'y'.repeat(400), at: T0 },
        },
      ])
      expect(folded.anomalies.map((a) => a.code)).toContain('oversized-payload-text')
    })

    it('refuses a second start for one action id', () => {
      const started = {
        type: 'hands.action.started',
        recordedAt: T0,
        payload: {
          actionId: 'a',
          actionKey: 'browser.navigate',
          surface: 'browser',
          principalId: 'p',
          grantId: 'grant-1',
          deadlineAt: T_PLUS_5M,
          at: T0,
        },
      }
      const grant = {
        type: 'hands.grant.registered',
        recordedAt: T0,
        payload: {
          grantId: 'grant-1',
          principalId: 'p',
          scope: 's',
          surfaces: 'browser',
          actions: 'browser.navigate',
          issuedAt: T0,
          expiresAt: T_PLUS_5M,
        },
      }
      const folded = reduceDeviceHandsState([grant, started, started])
      expect(folded.anomalies.map((a) => a.code)).toContain('duplicate-record')
      expect(Object.keys(folded.state.actions)).toEqual(['a'])
    })

    it('refuses an action that names a grant the journal has never seen', () => {
      const folded = reduceDeviceHandsState([
        {
          type: 'hands.action.started',
          recordedAt: T0,
          payload: {
            actionId: 'a',
            actionKey: 'browser.navigate',
            surface: 'browser',
            principalId: 'p',
            grantId: 'grant-never-registered',
            deadlineAt: T_PLUS_5M,
            at: T0,
          },
        },
      ])
      expect(folded.anomalies.map((a) => a.code)).toContain('unknown-record')
      expect(Object.keys(folded.state.actions)).toEqual([])
    })

    it('refuses a second, different policy digest in one journal', () => {
      const folded = reduceDeviceHandsState([
        ...base,
        { ...(base[0] as DeviceHandsJournalEntry), payload: { policyDigest: 'different' } },
      ])
      expect(folded.anomalies.map((a) => a.code)).toContain('illegal-transition')
      expect(folded.state.policyDigest).toBe('abc')
    })

    it('refuses to rewrite a settled action', () => {
      const grant = {
        type: 'hands.grant.registered',
        recordedAt: T0,
        payload: {
          grantId: 'grant-1',
          principalId: 'p',
          scope: 's',
          surfaces: 'browser',
          actions: 'browser.navigate',
          issuedAt: T0,
          expiresAt: T_PLUS_5M,
        },
      }
      const folded = reduceDeviceHandsState([
        grant,
        {
          type: 'hands.action.started',
          recordedAt: T0,
          payload: {
            actionId: 'a',
            actionKey: 'browser.navigate',
            surface: 'browser',
            principalId: 'p',
            grantId: 'grant-1',
            deadlineAt: T_PLUS_5M,
            at: T0,
          },
        },
        {
          type: 'hands.verified',
          recordedAt: T0,
          payload: { verificationId: 'v1', actionId: 'a', result: 'passed', reason: 'observed', at: T0 },
        },
        {
          type: 'hands.verified',
          recordedAt: T0,
          payload: { verificationId: 'v2', actionId: 'a', result: 'failed', reason: 'no', at: T0 },
        },
      ])
      expect(folded.anomalies.map((a) => a.code)).toContain('terminal-state-re-entered')
      expect(folded.state.actions['a']?.outcome).toBe('completed')
      expect(folded.state.actions['a']?.verificationId).toBe('v1')
    })

    it('refuses to revive a denied approval', () => {
      const folded = reduceDeviceHandsState([
        {
          type: 'hands.approval.requested',
          recordedAt: T0,
          payload: { approvalId: 'ap', actionKey: 'terminal.run', subjectRef: 'a', digest: 'd', expiresAt: T_PLUS_5M, at: T0 },
        },
        { type: 'hands.approval.denied', recordedAt: T0, payload: { approvalId: 'ap', actionKey: 'terminal.run', decidedAt: T0 } },
        { type: 'hands.approval.granted', recordedAt: T0, payload: { approvalId: 'ap', actionKey: 'terminal.run', subjectRef: 'a', digest: 'd', decidedAt: T0 } },
      ])
      expect(folded.anomalies.map((a) => a.code)).toContain('terminal-state-re-entered')
      expect(folded.state.approvals['ap']?.state).toBe('denied')
    })

    it('refuses a grant naming an action this build does not route', () => {
      const folded = reduceDeviceHandsState([
        {
          type: 'hands.grant.registered',
          recordedAt: T0,
          payload: {
            grantId: 'g',
            principalId: 'p',
            scope: 's',
            surfaces: 'browser',
            actions: 'browser.screenshot',
            issuedAt: T0,
            expiresAt: T_PLUS_5M,
          },
        },
      ])
      expect(folded.anomalies.map((a) => a.code)).toContain('malformed-payload')
      expect(Object.keys(folded.state.grants)).toEqual([])
    })

    it('leaves the state untouched when an entry is refused, rather than half-applying it', () => {
      const before = initialDeviceHandsState()
      const result = reduceDeviceHandsEntry(before, { type: 'hands.grant.registered', payload: 'not an object' })
      expect(result.state.grants).toEqual({})
      expect(result.anomalies).toHaveLength(1)
    })
  })

  describe('machines', () => {
    it('has no outgoing edge out of a terminal action state', () => {
      expect(DEVICE_HANDS_ACTION_TRANSITIONS.settled).toEqual([])
      expect(canTransition(DEVICE_HANDS_ACTION_TRANSITIONS, 'settled', 'running')).toBe(false)
    })

    it('has no outgoing edge out of a denied or revoked approval', () => {
      expect(DEVICE_HANDS_APPROVAL_TRANSITIONS.denied).toEqual([])
      expect(DEVICE_HANDS_APPROVAL_TRANSITIONS.revoked).toEqual([])
      expect(DEVICE_HANDS_APPROVAL_TRANSITIONS.pending).toEqual(['granted', 'denied'])
    })

    it('says a terminal decision is history rather than repairing it', () => {
      const verdict = mayTransitionApproval('denied', 'granted')
      expect(verdict.allowed).toBe(false)
      expect(verdict.reason).toContain('history')
    })
  })

  describe('the audit vocabulary is honest', () => {
    it('gives every refusal code a sentence a person can act on', () => {
      for (const [code, reason] of Object.entries(DEVICE_HANDS_REFUSAL_REASONS)) {
        expect(typeof reason).toBe('string')
        expect(reason.length).toBeGreaterThan(10)
        expect(code).toMatch(/^[a-z][a-z0-9-]*$/)
      }
    })

    it('never lets a journal payload carry a key that names authority', () => {
      const forbidden = [
        'capability',
        'grant',
        'approved',
        'verdict',
        'screenshot',
        'image',
        'token',
        'secret',
      ]
      for (const keys of Object.values(DEVICE_HANDS_PAYLOAD_KEYS)) {
        for (const key of keys) expect(forbidden).not.toContain(key)
      }
    })

    it('journals no content: no clipboard text, page text, argument values or file bytes', () => {
      const all = Object.values(DEVICE_HANDS_PAYLOAD_KEYS).flat()
      for (const key of all) {
        expect(key).not.toMatch(/^(text|content|stdout|stderr|args|arguments|envValues|clipboardText)$/)
      }
    })
  })

  describe('recovery truthfulness', () => {
    it('counts each settle outcome separately and never folds unknown into done', async () => {
      const h = harness()
      await h.ready()
      await h.request({ actionId: 'act-ok', actionKey: 'browser.navigate' })
      await h.request({ actionId: 'act-refused', actionKey: 'terminal.run', input: { command: 'curl', args: [], workingDirectory: ALLOWED_ROOT, env: {} } })

      const report = recoveryReport(h.runtime.snapshot())

      expect(report.completed).toBe(1)
      expect(report.refused).toBe(1)
      expect(report.interrupted).toBe(0)
      expect(report.neverOpened).toBe(false)
      expect(report.policyOnRecord).toBe(true)
    })

    it('reports that a journal which was never opened is not an opened one', () => {
      const report = recoveryReport(initialDeviceHandsState())
      expect(report.neverOpened).toBe(true)
      expect(report.policyOnRecord).toBe(false)
    })

    it('never lets a grant outlive its window without the gate noticing', async () => {
      const h = harness()
      await h.ready()
      // Past the grant's expiry, with a fresh id.
      h.setClock(T_PLUS_5M)
      const { outcome } = await h.request({ actionId: 'act-late', actionKey: 'browser.navigate', at: T_PLUS_5M })
      expect(outcome.code).toBe('grant-expired')
      expect(h.calls('browser')).toBe(0)
    })

    it('refuses a grant whose window is longer than the ceiling, rather than shortening it', async () => {
      const h = harness()
      await h.runtime.open()
      await h.runtime.loadPolicy(POLICY_INPUT)
      const granted = await h.runtime.registerGrant(
        defaultGrant({ expiresAt: '2026-07-02T09:00:00.000Z' }),
      )
      expect(granted.ok).toBe(false)
      expect(granted.code).toBe('grant-expired')
      expect(granted.reason).toContain('refused rather than shortened')
    })
  })
})

function canTransition(
  table: Readonly<Record<string, readonly string[]>>,
  from: string,
  to: string,
): boolean {
  return (table[from] ?? []).includes(to)
}