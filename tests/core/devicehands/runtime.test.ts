// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  ALLOWED_HOST,
  ALLOWED_ROOT,
  T0,
  T_PLUS_5M,
  clipboardInput,
  defaultRequest,
  downloadInput,
  harness,
  policy,
  terminalInput,
  uploadInput,
} from './harness'

/**
 * The runtime, end to end.
 *
 * Every test here runs the real gate pipeline against a harness that cannot touch the
 * disk, a browser, a process or the real clipboard, and every one of them asserts on the
 * effect counters as well as the verdict — because a refusal that cannot be shown to
 * have reached nothing is not a refusal that has been shown.
 */
describe('device hands runtime', () => {
  it('runs an allowed navigation with no approval and verifies it from the observation', async () => {
    const h = harness()
    await h.ready()

    const { outcome } = await h.request({ actionKey: 'browser.navigate' })

    expect(outcome.performed).toBe(true)
    expect(outcome.verdict).toBe('passed')
    expect(outcome.refusedAt).toBeNull()
    expect(outcome.evaluated).toEqual([
      'journal-trustworthy',
      'stop-all',
      'enabled',
      'replay',
      'surface',
      'grant',
      'deadline',
      'budget',
      'policy',
      'approval',
    ])
    expect(h.calls('browser')).toBe(1)
    expect(h.calls('terminal')).toBe(0)
    expect(h.types()).toContain('hands.action.started')
    expect(h.types()).toContain('hands.verified')
  })

  it('treats a port that only *reports* success as unverified, never complete', async () => {
    const h = harness({ observes: false })
    await h.ready()

    const { outcome } = await h.request({ actionKey: 'browser.navigate' })

    expect(outcome.performed).toBe(true)
    expect(outcome.verdict).toBe('unverified')
    expect(outcome.code).toBe('claim-not-evidence')
    expect(h.runtime.snapshot().actions['act-1']?.outcome).toBe('unverified')
    // And crucially: the ledger did not move on a claim.
    expect(h.runtime.snapshot().bytesThisSession).toBe(0)
  })

  it('refuses an action the owner declined, and records which gate stopped it', async () => {
    const h = harness()
    await h.ready()

    const { outcome } = await h.request({ actionKey: 'terminal.run', input: terminalInput() })

    expect(outcome.performed).toBe(false)
    expect(outcome.refusedAt).toBe('approval')
    expect(outcome.code).toBe('approval-missing')
    expect(h.calls('terminal')).toBe(0)
    expect(h.refusals().at(-1)?.gate).toBe('approval')
  })

  it('runs a terminal command once the owner approved that exact body', async () => {
    const h = harness()
    await h.ready()
    const approved = await h.approve({
      actionId: 'act-term',
      actionKey: 'terminal.run',
      input: terminalInput(),
    })
    expect(approved.ok).toBe(true)

    const { outcome } = await h.request({
      actionId: 'act-term',
      actionKey: 'terminal.run',
      input: terminalInput(),
    })

    expect(outcome.performed).toBe(true)
    expect(outcome.verdict).toBe('passed')
    expect(h.calls('terminal')).toBe(1)
  })

  it('does not accept an approval for one command as permission for another', async () => {
    const h = harness()
    await h.ready()
    await h.approve({ actionId: 'act-term', actionKey: 'terminal.run', input: terminalInput() })

    // Same action name, same id, different working directory: a different body.
    const { outcome } = await h.request({
      actionId: 'act-term',
      actionKey: 'terminal.run',
      input: terminalInput({ workingDirectory: '/workspace/project/sub' }),
    })

    expect(outcome.performed).toBe(false)
    expect(outcome.code).toBe('approval-subject-mismatch')
    expect(h.calls('terminal')).toBe(0)
  })

  it('records a decision that did not come from the owner as a denial', async () => {
    const h = harness({ decidedBy: 'core' })
    await h.ready()

    const approved = await h.approve({
      actionId: 'act-term',
      actionKey: 'terminal.run',
      input: terminalInput(),
    })

    expect(approved.ok).toBe(false)
    expect(approved.reason).toContain('did not come from the owner')
    const { outcome } = await h.request({
      actionId: 'act-term',
      actionKey: 'terminal.run',
      input: terminalInput(),
    })
    expect(outcome.performed).toBe(false)
    expect(h.calls('terminal')).toBe(0)
  })

  it('refuses everything when STOP ALL is latched, and reaches nothing', async () => {
    const h = harness({ stopAll: true })
    await h.ready()

    const { outcome } = await h.request({ actionKey: 'browser.navigate' })

    expect(outcome.performed).toBe(false)
    expect(outcome.refusedAt).toBe('stop-all')
    expect(outcome.code).toBe('stop-all-latched')
    expect(h.calls('browser')).toBe(0)
  })

  it('refuses a replayed action id rather than running it twice', async () => {
    const h = harness()
    await h.ready()

    const first = await h.request({ actionId: 'act-once', actionKey: 'browser.navigate' })
    const second = await h.request({ actionId: 'act-once', actionKey: 'browser.navigate' })

    expect(first.outcome.verdict).toBe('passed')
    expect(second.outcome.performed).toBe(false)
    expect(second.outcome.refusedAt).toBe('replay')
    expect(second.outcome.code).toBe('replay-detected')
    expect(h.calls('browser')).toBe(1)
  })

  it('refuses an action whose deadline has passed, without reaching a port', async () => {
    const h = harness()
    await h.ready()

    const { outcome } = await h.request({
      actionId: 'act-late',
      actionKey: 'browser.navigate',
      deadlineAt: T0,
      at: T0,
    })

    expect(outcome.performed).toBe(false)
    expect(outcome.refusedAt).toBe('deadline')
    expect(h.calls('browser')).toBe(0)
  })

  it('refuses a deadline further out than the ceiling rather than shortening it', async () => {
    const h = harness()
    await h.ready()

    const { outcome } = await h.request({
      actionId: 'act-long',
      actionKey: 'browser.navigate',
      deadlineAt: T_PLUS_5M,
      at: T0,
    })

    expect(outcome.performed).toBe(false)
    expect(outcome.code).toBe('deadline-expired')
    expect(outcome.reason).toContain('at most 60 seconds')
    expect(h.calls('browser')).toBe(0)
  })

  it('reads the clipboard only with an approval, and journals no content', async () => {
    const h = harness({ clipboard: 'a shopping list' })
    await h.ready()

    // A refused request *consumes* its id, so the retry carries a new one. That is the
    // replay rule made concrete: an attempt that was refused cannot be re-presented under
    // the same id and be mistaken for a fresh one.
    const refused = await h.request({ actionId: 'act-clip-1', actionKey: 'clipboard.read' })
    expect(refused.outcome.code).toBe('approval-missing')
    expect(h.calls('clipboardRead')).toBe(0)

    await h.approve({ actionId: 'act-clip-2', actionKey: 'clipboard.read', input: {} })
    const read = await h.request({ actionId: 'act-clip-2', actionKey: 'clipboard.read' })

    expect(read.outcome.verdict).toBe('passed')
    expect(h.calls('clipboardRead')).toBe(1)
    const journalled = JSON.stringify(h.entries)
    expect(journalled).not.toContain('shopping list')
    expect(h.payloadsOf('hands.clipboard.read')[0]).toEqual({
      actionId: 'act-clip-2',
      bytes: 15,
      at: T0,
    })
  })

  it('refuses to return clipboard content that looks like a credential', async () => {
    const h = harness({ clipboard: '-----BEGIN RSA PRIVATE KEY-----\nMIIEow' })
    await h.ready()
    await h.approve({ actionId: 'act-clip', actionKey: 'clipboard.read', input: {} })

    const { outcome } = await h.request({ actionId: 'act-clip', actionKey: 'clipboard.read' })

    expect(outcome.code).toBe('clipboard-credential-content')
    expect(outcome.verdict).toBeNull()
    // The port *was* reached — the content has to be read to be judged — but nothing
    // about it survives, and the record says so without saying what.
    expect(h.calls('clipboardRead')).toBe(1)
    expect(h.types()).toContain('hands.clipboard.credential-detected')
    const journalled = JSON.stringify(h.entries)
    expect(journalled).not.toContain('PRIVATE KEY')
  })

  it('refuses to *write* a credential onto the clipboard, before any port is reached', async () => {
    const h = harness()
    await h.ready()

    // No approval is sought: the policy gate refuses the body itself, so asking the
    // owner about it would be the one thing the gate order exists to prevent.
    const { outcome } = await h.request({
      actionId: 'act-write',
      actionKey: 'clipboard.write',
      input: clipboardInput('GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz'),
    })

    expect(outcome.performed).toBe(false)
    expect(outcome.refusedAt).toBe('policy')
    expect(outcome.code).toBe('clipboard-credential-content')
    expect(h.calls('clipboardWrite')).toBe(0)
  })

  it('downloads with no approval, and moves the byte ledger only on a passed verdict', async () => {
    const h = harness()
    await h.ready()

    const { outcome } = await h.request({
      actionId: 'act-dl',
      actionKey: 'transfer.download',
      input: downloadInput(),
    })

    expect(outcome.performed).toBe(true)
    expect(outcome.verdict).toBe('passed')
    expect(outcome.bytes).toBe(2048)
    expect(h.calls('download')).toBe(1)
    expect(h.runtime.snapshot().bytesThisSession).toBe(2048)
    expect(h.runtime.snapshot().transferCountThisSession).toBe(1)
    expect(h.types()).toContain('hands.transfer.completed')
  })

  it('uploads only with an approval', async () => {
    const h = harness()
    await h.ready()

    const refused = await h.request({
      actionId: 'act-up-1',
      actionKey: 'transfer.upload',
      input: uploadInput(),
    })
    expect(refused.outcome.code).toBe('approval-missing')
    expect(h.calls('upload')).toBe(0)

    await h.approve({ actionId: 'act-up-2', actionKey: 'transfer.upload', input: uploadInput() })
    const sent = await h.request({
      actionId: 'act-up-2',
      actionKey: 'transfer.upload',
      input: uploadInput(),
    })
    expect(sent.outcome.verdict).toBe('passed')
    expect(h.calls('upload')).toBe(1)
  })

  it('cancels at settle rather than pretending to interrupt the surface', async () => {
    const h = harness()
    await h.ready()
    await h.approve({ actionId: 'act-cancel', actionKey: 'terminal.run', input: terminalInput() })

    // The terminal port is held open, so the cancellation genuinely arrives while the
    // action is in flight — which is the only way to observe the ordering this claim is
    // about.
    h.block()
    const inFlight = h.runtime.perform(
      defaultRequest({ actionId: 'act-cancel', actionKey: 'terminal.run', input: terminalInput() }),
    )
    await h.countsChange()
    const cancellation = h.runtime.cancel('act-cancel')
    h.release()
    const outcome = await inFlight

    expect(cancellation.accepted).toBe(true)
    expect(cancellation.reason).toContain('does not own the process')
    expect(outcome.code).toBe('action-cancelled')
    expect(outcome.verdict).toBeNull()
    expect(outcome.bytes).toBe(0)
    expect(h.types()).toContain('hands.action.cancelled')
    expect(h.types()).not.toContain('hands.verified')
  })

  it('refuses an action whose port settles after STOP ALL is thrown', async () => {
    const h = harness()
    await h.ready()
    await h.approve({ actionId: 'act-race', actionKey: 'terminal.run', input: terminalInput() })

    h.block()
    const inFlight = h.runtime.perform(
      defaultRequest({ actionId: 'act-race', actionKey: 'terminal.run', input: terminalInput() }),
    )
    await h.countsChange()
    // Thrown *after* the gate and *after* the action started: the latch is read again
    // before the verdict, so the action is recorded as not verified rather than as done.
    h.setStopAll(true)
    h.release()
    const outcome = await inFlight

    expect(outcome.performed).toBe(true)
    expect(outcome.verdict).toBe('unverified')
    expect(outcome.code).toBe('verification-missing')
    expect(outcome.reason).toContain('STOP ALL')
  })

  it('probes a surface, records the measurement, and grants nothing', async () => {
    const h = harness()
    await h.ready()

    const result = await h.runtime.probe('clipboard')

    expect(result.ok).toBe(true)
    expect(result.outcome?.available).toBe(true)
    expect(result.reason).toContain('not a permission')
    // The decisive part: the probe worked, and the caller still has no authority.
    expect(Object.keys(result.outcome ?? {}).sort()).toEqual([
      'available',
      'code',
      'probeId',
      'probedAt',
      'surface',
    ])
    expect(h.runtime.snapshot().grants[Object.keys(h.runtime.snapshot().grants)[0] ?? '']?.actions.length).toBe(10)
    expect(h.calls('probe')).toBe(1)
  })

  it('refuses a probe when STOP ALL is latched, and records no probe at all', async () => {
    const h = harness({ stopAll: true })
    await h.ready()

    const result = await h.runtime.probe('browser')

    expect(result.ok).toBe(false)
    expect(result.outcome).toBeNull()
    expect(h.calls('probe')).toBe(0)
    expect(h.types()).toContain('hands.probe.refused')
    expect(h.types()).not.toContain('hands.probe.performed')
  })

  it('refuses every action when no policy is loaded, and says so at the grant gate', async () => {
    const h = harness()
    await h.runtime.open()
    // `loadPolicy` refused, so `registerGrant` refuses too — and *that* is the honest
    // sequence: with no policy there is nothing for a grant to narrow, so the first
    // thing a caller meets is `grant-missing`, not a mysterious silence.
    const loaded = await h.runtime.loadPolicy({
      allowedRoots: [ALLOWED_ROOT],
      deniedRoots: [],
      allowedHosts: [ALLOWED_HOST],
      allowedCommands: ['git'],
      allowedEnvNames: ['CI'],
    })
    expect(loaded.ok).toBe(false)
    expect(loaded.code).toBe('policy-missing')

    const { outcome } = await h.request({ actionKey: 'browser.navigate' })

    expect(outcome.performed).toBe(false)
    expect(outcome.code).toBe('grant-missing')
    expect(h.calls('browser')).toBe(0)
  })

  it('refuses a grant the journal has never seen', async () => {
    const h = harness()
    await h.ready()
    // Core now reports a grant this phase has no record of.
    const fact = h.ports.activeGrant('owner-1', 'session-1')
    expect(fact).not.toBeNull()
    h.setGrant({ ...(fact ?? ({} as never)), grantId: 'grant-forged' } as never)

    const { outcome } = await h.request({ actionKey: 'browser.navigate' })

    expect(outcome.performed).toBe(false)
    expect(outcome.refusedAt).toBe('grant')
    expect(outcome.code).toBe('grant-missing')
    expect(h.calls('browser')).toBe(0)
  })

  it('refuses a grant whose contents Core and the journal disagree about', async () => {
    const h = harness()
    await h.ready()
    const fact = h.ports.activeGrant('owner-1', 'session-1')!
    h.setGrant({ ...fact, actions: [...fact.actions, 'transfer.download'] })

    const { outcome } = await h.request({ actionKey: 'browser.navigate' })

    expect(outcome.performed).toBe(false)
    expect(outcome.refusedAt).toBe('grant')
    expect(h.calls('browser')).toBe(0)
  })

  it('refuses a revoked grant, and refuses it again when Core disagrees with the journal', async () => {
    const h = harness()
    await h.ready()
    await h.runtime.revokeGrant('grant-1')

    // The journal says revoked; Core still reports the grant as live. Two records that
    // disagree means the gate believes neither, and `grant-missing` is the honest answer.
    const disagreed = await h.request({ actionKey: 'browser.navigate' })
    expect(disagreed.outcome.code).toBe('grant-missing')

    // Once Core agrees, the refusal names the real reason.
    const fact = h.ports.activeGrant('owner-1', 'session-1')
    expect(fact).not.toBeNull()
    h.setGrant({ ...(fact ?? ({} as never)), revokedAt: T0 } as never)
    const revoked = await h.request({ actionId: 'act-2', actionKey: 'browser.navigate' })
    expect(revoked.outcome.refusedAt).toBe('grant')
    expect(revoked.outcome.code).toBe('grant-revoked')
    expect(h.calls('browser')).toBe(0)

    const again = await h.runtime.revokeGrant('grant-1')
    expect(again.ok).toBe(false)
  })

  it('refuses a policy that has no denied root, and never falls back to defaults', async () => {
    const h = harness()
    await h.runtime.open()

    const loaded = await h.runtime.loadPolicy({
      allowedRoots: [ALLOWED_ROOT],
      deniedRoots: [],
      allowedHosts: [ALLOWED_HOST],
      allowedCommands: ['git'],
      allowedEnvNames: ['CI'],
    })

    expect(loaded.ok).toBe(false)
    expect(loaded.code).toBe('policy-missing')
    const { outcome } = await h.request({ actionKey: 'browser.navigate' })
    expect(outcome.code).toBe('grant-missing')
    expect(outcome.refusedAt).toBe('grant')
  })

  it('refuses to swap the policy underneath a journal that already recorded one', async () => {
    const h = harness()
    await h.ready()

    const swapped = await h.runtime.loadPolicy({
      allowedRoots: ['/workspace/other'],
      deniedRoots: ['/user-data/Freya/vault'],
      allowedHosts: [ALLOWED_HOST, 'other.test'],
      allowedCommands: ['git'],
      allowedEnvNames: ['CI'],
    })

    expect(swapped.ok).toBe(false)
    expect(swapped.code).toBe('policy-mismatch')
    expect(policy().allowedRoots).toEqual([ALLOWED_ROOT])
  })

  it('explains itself: what ran, what was refused, and what it is waiting for', async () => {
    const h = harness()
    await h.ready()
    await h.request({ actionId: 'act-1', actionKey: 'browser.navigate' })
    await h.request({ actionId: 'act-2', actionKey: 'terminal.run', input: terminalInput() })

    const projection = h.runtime.projection()

    expect(projection.actionsThisSession).toBe(2)
    expect(projection.refusals).toBe(1)
    expect(projection.lastRefusal?.gate).toBe('approval')
    expect(projection.surfaces.find((s) => s.surface === 'browser')?.completed).toBe(1)
    // There is no "next action" field at all: this phase schedules nothing, and a
    // projection with a next step would be a thing a renderer could poll to make Freya
    // look busy.
    expect(Object.keys(projection)).not.toContain('nextAction')
    expect(projection.summary).toContain('2 action(s)')
  })
})
