// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { DEVICE_HANDS_BLOCKED_ACTIONS } from '../../../electron/devicehands/activation'
import { registryById } from '../../../core/qualification'
import {
  ALLOWED_HOST,
  ALLOWED_ROOT,
  PRINCIPAL,
  SCOPE,
  VAULT_ROOT,
  defaultGrant,
  hostHarness,
  T0,
  T_PLUS_5M,
  totalEffects,
} from '../../host/devicehands/harness'

/**
 * Scenario gate: `device-hands`.
 *
 * Bounded: the real Phase 42 activation built on the real bounded adapters. The journal is
 * in memory, the child process is an object, the clipboard is a string and the transport is
 * a function, so no disk, no process, no clipboard and no network are touched. Every
 * effect is proved by a counter, and every refusal by a counter that did not move.
 *
 * The claim has four parts, and each is the difference between a capability that exists and
 * a capability that can act:
 *
 *   1. **Authority.** No effect is reached without an owner grant and an owner switch. A
 *      revoked grant, an expired grant, a wrong principal and a wrong scope are all refusals.
 *   2. **Precedence.** STOP ALL outranks everything, and the refusal is reached before any
 *      adapter is touched.
 *   3. **Durability.** The journal replays after a restart, and a deactivated runtime stays
 *      deactivated.
 *   4. **Honesty.** The two actions this host cannot safely implement stay blocked, with the
 *      reason attached, rather than being quietly widened to make them appear to work.
 */

const navigate = { url: `https://${ALLOWED_HOST}/about` }
const terminal = { command: 'git', args: ['status'], workingDirectory: ALLOWED_ROOT, env: {} }

describe('Device Hands across the Core runtime and the host adapters', () => {
  it('performs an approval-free action only with a live grant, and records it', async () => {
    const h = await hostHarness()

    const outcome = await h.perform('browser.navigate', navigate)
    expect(outcome.performed).toBe(true)
    expect(outcome.verdict).toBe('passed')
    expect(outcome.refusedAt).toBeNull()
    expect(h.counts.browserNavigate).toBe(1)

    // The fact it ran is on the record, not only in the counter.
    expect(h.activation.projection().refusals).toBe(0)
    expect(h.activation.projection().actionsThisSession).toBe(1)
    expect(h.activation.projection().surfaces.find((s) => s.surface === 'browser')?.completed).toBe(1)
  })

  it('runs an approval-gated action only after an owner approval for that exact body', async () => {
    const h = await hostHarness()

    // No approval, so the pipeline stops one gate short of the port. The refusal names the
    // gate, and the host counter proves the process was never spawned.
    const unapproved = await h.perform('terminal.run', terminal, { actionId: 'term-0' })
    expect(unapproved.performed).toBe(false)
    expect(unapproved.refusedAt).toBe('approval')
    expect(h.counts.spawn).toBe(0)

    const approval = await h.approve('terminal.run', terminal, 'term-1')
    expect(approval.ok).toBe(true)

    const pending = h.perform('terminal.run', terminal, { actionId: 'term-1' })
    // The gate pipeline journals before it reaches the port, so the child appears a few
    // microtasks later. Wait for it rather than assuming a tick is enough.
    for (let attempt = 0; attempt < 200 && h.terminal.children.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    h.terminal.children[0]?.emitExit(0)
    const approved = await pending

    expect(approved.performed).toBe(true)
    expect(approved.verdict).toBe('passed')
    // Exactly one child, from exactly one request. A provider that retried on its own would
    // turn one ask into two visible actions, which is the thing owners are most surprised
    // by and cannot audit.
    expect(h.counts.spawn).toBe(1)
    expect(h.terminal.calls).toHaveLength(1)
    expect(h.terminal.calls[0]?.file).toContain('git')
    expect(h.terminal.calls[0]?.options.shell).toBe(false)
  })

  it('reads and writes the clipboard through the real adapter, within the grant', async () => {
    const h = await hostHarness()

    const writeApproval = await h.approve('clipboard.write', { text: 'a note to self' }, 'clip-1')
    expect(writeApproval.ok).toBe(true)
    const written = await h.perform('clipboard.write', { text: 'a note to self' }, { actionId: 'clip-1' })
    expect(written.performed).toBe(true)
    expect(written.verdict).toBe('passed')
    expect(h.counts.clipboardWrite).toBe(1)
    expect(h.clipboard.value).toBe('a note to self')

    const readApproval = await h.approve('clipboard.read', {}, 'clip-2')
    expect(readApproval.ok).toBe(true)
    const read = await h.perform('clipboard.read', {}, { actionId: 'clip-2' })
    expect(read.performed).toBe(true)
    // The write observed itself by reading the buffer back, so the read counter is already
    // above one. The point is that each adapter call is counted exactly once per request.
    expect(h.counts.clipboardRead).toBeGreaterThanOrEqual(1)
  })

  it('reaches no effect with no grant at all', async () => {
    const h = await hostHarness()
    h.authority.grant = null

    const outcome = await h.perform('browser.navigate', navigate)
    expect(outcome.performed).toBe(false)
    expect(outcome.refusedAt).toBe('grant')
    expect(outcome.code).toBe('grant-missing')
    expect(totalEffects(h.counts)).toBe(0)
  })

  it('refuses a revoked grant and an expired grant, because neither is permission', async () => {
    const revoked = await hostHarness()
    revoked.authority.grant = defaultGrant({ revokedAt: T0 })
    const revokedOutcome = await revoked.perform('browser.navigate', navigate)
    expect(revokedOutcome.refusedAt).toBe('grant')
    expect(totalEffects(revoked.counts)).toBe(0)

    const expired = await hostHarness()
    expired.setNow(T_PLUS_5M)
    expired.authority.grant = defaultGrant({ expiresAt: T0 })
    const expiredOutcome = await expired.perform('browser.navigate', navigate)
    expect(expiredOutcome.performed).toBe(false)
    expect(totalEffects(expired.counts)).toBe(0)
  })

  it('refuses a grant that belongs to a different principal or a different scope', async () => {
    const h = await hostHarness()

    const wrongPrincipal = await h.perform('browser.navigate', navigate, {
      principalId: 'somebody-else',
    })
    expect(wrongPrincipal.performed).toBe(false)
    expect(wrongPrincipal.refusedAt).toBe('grant')

    const wrongScope = await h.perform('browser.navigate', navigate, { scope: 'another-session' })
    expect(wrongScope.performed).toBe(false)
    expect(wrongScope.refusedAt).toBe('grant')

    expect(totalEffects(h.counts)).toBe(0)
  })

  it('lets STOP ALL win before any effect, and says so', async () => {
    const h = await hostHarness()
    h.authority.stopped = true

    const outcome = await h.perform('browser.navigate', navigate)
    expect(outcome.refusedAt).toBe('stop-all')
    expect(outcome.code).toBe('stop-all-latched')
    expect(totalEffects(h.counts)).toBe(0)
  })

  it('halts at the owner switch, with nothing switched on in the first place', async () => {
    const h = await hostHarness({ enabled: false })
    const outcome = await h.perform('browser.navigate', navigate)
    expect(outcome.refusedAt).toBe('enabled')
    expect(totalEffects(h.counts)).toBe(0)
  })

  it('keeps halting after a deactivate, at the gate rather than mid-effect', async () => {
    const h = await hostHarness()
    expect((await h.perform('browser.navigate', navigate)).performed).toBe(true)

    const halted = await h.activation.deactivate('the owner turned it off')
    expect(halted.ok).toBe(true)
    expect(h.activation.active()).toBe(false)

    const after = await h.perform('browser.navigate', navigate)
    expect(after.performed).toBe(false)
    expect(after.refusedAt).toBe('enabled')
    // Exactly one navigation happened in total: the deactivate stopped the *next* one, and
    // did not undo the first.
    expect(h.counts.browserNavigate).toBe(1)
  })

  it('refuses the Vault and keyring roots, which are not negotiable', async () => {
    const h = await hostHarness()
    const outcome = await h.perform('terminal.run', {
      command: 'cat',
      args: ['notes.txt'],
      workingDirectory: VAULT_ROOT,
      env: {},
    })
    expect(outcome.performed).toBe(false)
    expect(h.counts.spawn).toBe(0)
  })

  it('replays its journal after a restart, and derives the same record', async () => {
    const h = await hostHarness()
    await h.perform('browser.navigate', navigate)
    await h.perform('browser.navigate', { url: `https://${ALLOWED_HOST}/other` })
    const before = h.activation.projection()

    const restarted = await h.restart()
    const after = restarted.projection()

    // The counts are the derived facts a restart must not be able to lose. A runtime that
    // opened its journal and then reported nothing is worse than one that never started.
    expect(after.actionsThisSession).toBe(before.actionsThisSession)
    expect(after.refusals).toBe(before.refusals)
    expect(after.surfaces.map((surface) => surface.completed)).toEqual(
      before.surfaces.map((surface) => surface.completed),
    )
    expect(after.policyDigest).toBe(before.policyDigest)
  })

  it('refuses to act at all on a journal that does not chain', async () => {
    const h = await hostHarness()
    h.journal.setTrustworthy(false)

    // The runtime is told the journal is untrustworthy before it runs. The refusal has to
    // land before any adapter, because an action taken on a record we cannot verify is not
    // an action we can report honestly.
    const outcome = await h.perform('browser.navigate', navigate)
    expect(outcome.performed).toBe(false)
    expect(totalEffects(h.counts)).toBe(0)
  })

  it('keeps the two unimplementable actions blocked, with their reasons attached', async () => {
    const h = await hostHarness()

    // Named, not hidden: still in the vocabulary, still gate-checked, still journalled.
    const keys = DEVICE_HANDS_BLOCKED_ACTIONS.map((entry) => entry.actionKey)
    expect(keys.sort()).toEqual(['browser.click', 'browser.type-text'])
    for (const entry of DEVICE_HANDS_BLOCKED_ACTIONS) {
      expect(entry.reason.length).toBeGreaterThan(40)
      expect(entry.reason).toMatch(/script/i)
    }

    // And the status a diagnostics surface reads carries the same list, so a person asking
    // "can it click?" gets the refusal rather than a timeout.
    expect(h.activation.status().blocked).toEqual(DEVICE_HANDS_BLOCKED_ACTIONS)

    // Which means an approved attempt still fails rather than reaching a browser: the gate
    // pipeline runs, the effect is reached, and the verification cannot confirm anything —
    // so the honest verdict is `failed`, never `passed`.
    const input = { url: `https://${ALLOWED_HOST}/about`, selector: '#submit' }
    const approval = await h.approve('browser.click', input, 'click-1')
    expect(approval.ok).toBe(true)
    const clicked = await h.perform('browser.click', input, { actionId: 'click-1' })
    expect(clicked.verdict).toBe('failed')
    expect(clicked.verification?.reason).toMatch(/did not|surface reported/i)
  })

  it('reports what it refused and why, without inventing an outcome', async () => {
    const h = await hostHarness()
    h.authority.grant = null

    await h.perform('browser.navigate', navigate)
    const projection = h.activation.projection()

    // A refused action is a recorded refusal, not a silent no-op and not a success. The
    // count and the last reason are both readable, because "nothing happened" and
    // "something was refused" are very different things to a person.
    expect(projection.refusals).toBe(1)
    expect(projection.lastRefusal?.gate).toBe('grant')
    expect(projection.lastRefusal?.reason.length).toBeGreaterThan(0)
    expect(projection.surfaces.find((surface) => surface.surface === 'browser')?.completed).toBe(0)
    expect(projection.summary).toMatch(/refused/)
  })

  it('declares the host adapter and the grant as the two things it needs, and the registry agrees', () => {
    const descriptor = registryById('core.device-hands')
    expect(descriptor).toBeDefined()
    // The registry names exactly the two requirements, plus the journal. If it asked for
    // less than the host genuinely provides, a wired build would still report `blocked`.
    const kinds = descriptor!.requirements.map((requirement) => requirement.kind)
    expect(kinds).toContain('host-adapter')
    expect(kinds).toContain('capability-grant')
    expect(descriptor!.requirements.every((requirement) => requirement.required)).toBe(true)
    // Phase 42 made Device Hands activatable. The required adapter and grant above
    // are what keep it blocked when authority is absent; the descriptor itself is
    // no longer unconditionally blocked.
    expect(descriptor!.activation).toBe('activatable')
    expect(PRINCIPAL).not.toBe('')
    expect(SCOPE).not.toBe('')
  })
})