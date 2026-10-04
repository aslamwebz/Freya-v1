import { describe, expect, it } from 'vitest'
import { createDeviceHandsActivation, DEVICE_HANDS_BLOCKED_ACTIONS } from '../../../electron/devicehands/activation'
import {
  ALLOWED_HOST,
  ALLOWED_ROOT,
  defaultGrant,
  hostHarness,
  PRINCIPAL,
  T0,
  T_PLUS_30S,
  VAULT_ROOT,
} from './harness'

const browserInput = { url: `https://${ALLOWED_HOST}/about` }
const terminalInput = { command: 'git', args: ['status'], workingDirectory: ALLOWED_ROOT, env: {} }
const downloadInput = {
  url: `https://${ALLOWED_HOST}/note.txt`,
  mediaType: 'text/plain',
  bytes: 11,
  destinationPath: ALLOWED_ROOT,
  fileName: 'note.txt',
}

describe('Device Hands activation — grants and precedence', () => {
  it('performs an approval-free browser action and observes it', async () => {
    const h = await hostHarness()
    const outcome = await h.perform('browser.navigate', browserInput)
    expect(outcome.performed).toBe(true)
    expect(outcome.verdict).toBe('passed')
    expect(outcome.refusedAt).toBeNull()
    expect(h.counts.browserNavigate).toBe(1)
  })

  it('refuses with no grant and reaches no effect', async () => {
    const h = await hostHarness()
    h.authority.grant = null
    const outcome = await h.perform('browser.navigate', browserInput)
    expect(outcome.performed).toBe(false)
    expect(outcome.refusedAt).toBe('grant')
    expect(outcome.code).toBe('grant-missing')
    expect(h.counts.browserNavigate).toBe(0)
  })

  it('refuses a grant that was revoked after it was registered', async () => {
    const h = await hostHarness()
    h.authority.grant = defaultGrant({ revokedAt: T0 })
    const outcome = await h.perform('browser.navigate', browserInput)
    expect(outcome.refusedAt).toBe('grant')
    expect(h.counts.browserNavigate).toBe(0)
  })

  it('lets STOP ALL win before any effect', async () => {
    const h = await hostHarness()
    h.authority.stopped = true
    const outcome = await h.perform('browser.navigate', browserInput)
    expect(outcome.refusedAt).toBe('stop-all')
    expect(outcome.code).toBe('stop-all-latched')
    expect(h.counts.browserNavigate).toBe(0)
  })

  it('refuses everything when the owner switch is off', async () => {
    const h = await hostHarness({ enabled: false })
    const outcome = await h.perform('browser.navigate', browserInput)
    expect(outcome.refusedAt).toBe('enabled')
    expect(h.counts.browserNavigate).toBe(0)
  })

  it('halts further effects immediately when deactivated', async () => {
    const h = await hostHarness()
    const first = await h.perform('browser.navigate', browserInput)
    expect(first.performed).toBe(true)
    await h.activation.deactivate('owner pressed stop')
    const second = await h.perform('browser.navigate', browserInput)
    expect(second.refusedAt).toBe('enabled')
    expect(h.counts.browserNavigate).toBe(1)
  })

  it('refuses a replayed action id before it can consume a budget slot', async () => {
    const h = await hostHarness()
    const first = await h.perform('browser.navigate', browserInput, { actionId: 'dup-1' })
    expect(first.performed).toBe(true)
    const second = await h.perform('browser.navigate', browserInput, { actionId: 'dup-1' })
    expect(second.refusedAt).toBe('replay')
    expect(second.code).toBe('replay-detected')
    expect(h.counts.browserNavigate).toBe(1)
  })

  it('consumes an id even when the first attempt was refused', async () => {
    const h = await hostHarness()
    const bad = await h.perform('browser.navigate', { url: 'http://not-allowed.example/' }, { actionId: 'refused-1' })
    expect(bad.performed).toBe(false)
    const retry = await h.perform('browser.navigate', browserInput, { actionId: 'refused-1' })
    expect(retry.refusedAt).toBe('replay')
    expect(h.counts.browserNavigate).toBe(0)
  })

  it('refuses an action whose deadline has already passed', async () => {
    const h = await hostHarness()
    const outcome = await h.perform('browser.navigate', browserInput, { deadlineAt: '2026-07-01T08:59:00.000Z' })
    expect(outcome.refusedAt).toBe('deadline')
    expect(outcome.code).toBe('deadline-expired')
    expect(h.counts.browserNavigate).toBe(0)
  })
})

describe('Device Hands activation — approvals and observed evidence', () => {
  it('refuses terminal.run without an owner approval', async () => {
    const h = await hostHarness()
    const outcome = await h.perform('terminal.run', terminalInput, { actionId: 'term-no-approval' })
    expect(outcome.refusedAt).toBe('approval')
    expect(h.counts.spawn).toBe(0)
  })

  it('runs terminal.run with an approval and observes the exit', async () => {
    const h = await hostHarness()
    const approval = await h.approve('terminal.run', terminalInput, 'term-1')
    expect(approval.ok).toBe(true)
    const pending = h.perform('terminal.run', terminalInput, { actionId: 'term-1' })
    // The gate pipeline journals before it reaches the port, so the process appears a
    // few microtasks later. Wait for it rather than assuming a tick is enough.
    for (let attempt = 0; attempt < 200 && h.terminal.children.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    h.terminal.children[0]?.emitExit(0)
    const outcome = await pending
    expect(outcome.performed).toBe(true)
    expect(outcome.verdict).toBe('passed')
    expect(h.counts.spawn).toBe(1)
  })

  it('records a report without an observation as unverified, never complete', async () => {
    const h = await hostHarness()
    // A clipboard whose read-back does not confirm the write: the adapter reports
    // success but did not observe it, so the runtime must not call it done.
    h.clipboard.readText = () => 'something else'
    const approval = await h.approve('clipboard.write', { text: 'hello' }, 'clip-1')
    expect(approval.ok).toBe(true)
    const outcome = await h.perform('clipboard.write', { text: 'hello' }, { actionId: 'clip-1' })
    expect(outcome.performed).toBe(true)
    expect(outcome.verdict).toBe('unverified')
    expect(outcome.code).toBe('claim-not-evidence')
  })

  it('refuses the browser actions this architecture will not run, with a stated code', async () => {
    const h = await hostHarness()
    const input = { url: `https://${ALLOWED_HOST}/about`, selector: '#submit' }
    const approval = await h.approve('browser.click', input, 'click-1')
    expect(approval.ok).toBe(true)
    const outcome = await h.perform('browser.click', input, { actionId: 'click-1' })
    expect(outcome.performed).toBe(true)
    expect(outcome.verdict).toBe('failed')
    // The runtime closes a failed port as `port-reported-failure`; the adapter's own
    // code, which names exactly why, is in the reason and the journal.
    expect(outcome.code).toBe('port-reported-failure')
    expect(outcome.reason).toContain('browser-action-unsupported')
    expect(h.counts.browserOpen).toBe(0)
    expect(h.counts.browserNavigate).toBe(0)
  })
})

describe('Device Hands activation — paths, journal and restart', () => {
  it('refuses a transfer into the Vault by name and reaches no transport', async () => {
    const h = await hostHarness()
    const outcome = await h.perform('transfer.download', { ...downloadInput, destinationPath: VAULT_ROOT })
    expect(outcome.performed).toBe(false)
    expect(outcome.refusedAt).toBe('policy')
    expect(outcome.code).toBe('vault-path-denied')
    expect(h.counts.httpGet).toBe(0)
  })

  it('refuses a transfer into a credential store', async () => {
    const h = await hostHarness()
    const outcome = await h.perform('transfer.download', {
      ...downloadInput,
      destinationPath: `${ALLOWED_ROOT}/.ssh`,
    })
    expect(outcome.performed).toBe(false)
    expect(h.counts.httpGet).toBe(0)
  })

  it('refuses to open a journal that does not chain', async () => {
    const h = await hostHarness()
    h.journal.setTrustworthy(false)
    const fresh = createDeviceHandsActivation({
      effects: h.effects,
      journal: h.journal,
      authority: h.authority,
      now: () => T0,
      newId: () => 'x',
    })
    await expect(fresh.open()).rejects.toThrow(/journal-untrustworthy/)
  })

  it('reconciles an action the journal left running as interrupted on restart', async () => {
    const h = await hostHarness()
    h.journal.entries.push({
      type: 'hands.action.started',
      recordedAt: T0,
      payload: {
        actionId: 'ghost',
        actionKey: 'browser.navigate',
        surface: 'browser',
        principalId: PRINCIPAL,
        grantId: 'grant-1',
        deadlineAt: T_PLUS_30S,
        at: T0,
      },
    })
    const restarted = await h.restart()
    const ghost = restarted.runtime.snapshot().actions['ghost']
    expect(ghost?.state).toBe('settled')
    expect(ghost?.outcome).toBe('interrupted')
    expect(h.journal.entries.some((entry) => entry.type === 'hands.reconciled')).toBe(true)
  })

  it('a probe grants nothing', async () => {
    const h = await hostHarness()
    const probe = await h.activation.runtime.probe('browser')
    expect(probe.ok).toBe(true)
    expect(probe.outcome?.available).toBe(true)
    // Nothing about the successful probe is a permission.
    h.authority.grant = null
    const outcome = await h.perform('browser.navigate', browserInput)
    expect(outcome.refusedAt).toBe('grant')
    expect(h.counts.browserNavigate).toBe(0)
  })

  it('exposes no capture port and names the blocked actions exactly', async () => {
    const h = await hostHarness()
    const names = Object.keys(h.effects)
    expect(names.some((name) => /capture|screenshot|image/i.test(name))).toBe(false)
    expect(DEVICE_HANDS_BLOCKED_ACTIONS.map((entry) => entry.actionKey)).toEqual([
      'browser.click',
      'browser.type-text',
    ])
    expect(DEVICE_HANDS_BLOCKED_ACTIONS.every((entry) => entry.reason.length > 0)).toBe(true)
  })

  it('reports its own status without inventing an active surface', async () => {
    const h = await hostHarness()
    const status = h.activation.status()
    expect(status.active).toBe(true)
    expect(status.enabled).toBe(true)
    expect(status.grants).toBe(1)
    expect(status.blocked.map((entry) => entry.actionKey)).toEqual(['browser.click', 'browser.type-text'])
  })
})
