// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  DEVICE_HANDS_LIMITS,
  FORBIDDEN_DEVICE_HANDS_ACTIONS,
} from '../../../core/devicehands'
import {
  ALLOWED_HOST,
  ALLOWED_ROOT,
  POLICY_INPUT,
  T0,
  T_PLUS_1D,
  T_PLUS_30S,
  VAULT_ROOT,
  assertNoEffect,
  attacker,
  defaultGrant,
  terminalInput,
} from './harness'

/**
 * Red team: transfers, approvals, STOP ALL, and the attempt to widen authority.
 *
 * These are the four ways a phase like this could be talked into doing more than it says.
 * Each case ends on an effect counter that must not move, or on a record that must not
 * have changed.
 */
describe('device hands red team — transfers, approvals and authority', () => {
  describe('download and upload abuse', () => {
    it('refuses every image type, so a captured frame has no declared form', async () => {
      const a = attacker()
      await a.ready()
      for (const [fileName, mediaType] of [
        ['shot.png', 'image/png'],
        ['shot.jpg', 'image/jpeg'],
        ['shot.webp', 'image/webp'],
        ['screen.gif', 'image/gif'],
      ] as const) {
        const result = await a.attempt({
          actionId: `atk-img-${fileName}`,
          actionKey: 'transfer.download',
          input: {
            url: 'https://example.com/x',
            destinationPath: ALLOWED_ROOT,
            fileName,
            mediaType,
            bytes: 16,
          },
        })
        expect(result.effects, fileName).toBe(0)
        expect(result.code, fileName).toBe('media-type-not-allowed')
      }
    })

    it('refuses an executable however it is dressed', async () => {
      const a = attacker()
      await a.ready()
      for (const fileName of ['payload.exe', 'run.sh', 'start.bat', 'hook.js', 'lib.dll', 'x.ps1', 'y.jar', 'z.pem']) {
        const result = await a.attempt({
          actionId: `atk-exe-${fileName}`,
          actionKey: 'transfer.download',
          input: {
            url: 'https://example.com/x',
            destinationPath: ALLOWED_ROOT,
            fileName,
            mediaType: 'text/plain',
            bytes: 16,
          },
        })
        expect(result.effects, fileName).toBe(0)
        expect(result.code, fileName).toBe('media-type-not-allowed')
      }
    })

    it('refuses a name and a type that disagree, so an extension cannot lie', async () => {
      const a = attacker()
      await a.ready()
      const result = await a.attempt({
        actionId: 'atk-lie',
        actionKey: 'transfer.download',
        input: {
          url: 'https://example.com/x.txt',
          destinationPath: ALLOWED_ROOT,
          fileName: 'notes.txt',
          mediaType: 'application/pdf',
          bytes: 16,
        },
      })
      expect(result.effects).toBe(0)
      expect(result.code).toBe('media-type-mismatch')
    })

    it('refuses a transfer over the per-action ceiling, and never fetches it to find out', async () => {
      const a = attacker()
      await a.ready()
      const result = await a.attempt({
        actionId: 'atk-huge',
        actionKey: 'transfer.download',
        input: {
          url: 'https://example.com/huge.txt',
          destinationPath: ALLOWED_ROOT,
          fileName: 'huge.txt',
          mediaType: 'text/plain',
          bytes: DEVICE_HANDS_LIMITS.maxTransferBytesPerAction + 1,
        },
      })
      expect(result.effects).toBe(0)
      expect(result.code).toBe('file-too-large')
    })

    it('refuses to push the session past its cumulative byte ceiling', async () => {
      const a = attacker()
      await a.ready()
// 5 MiB of legal 64 KiB transfers would be 80 of them, but the session also caps the
      // *number* of transfers at 32, so that ceiling binds first. Both are real and
      // whichever answers first is the honest refusal; the byte ceiling specifically is
      // proved at the gate level in `tests/core/devicehands/gates.test.ts`.
      const ceiling = DEVICE_HANDS_LIMITS.maxTransferBytesPerSession
      const perTransfer = 64 * 1024
      let refusedAt: number | null = null
      for (let index = 0; index < 100 && refusedAt === null; index += 1) {
        const result = await a.attempt({
          actionId: `atk-sess-${String(index)}`,
          actionKey: 'transfer.download',
          input: {
            url: 'https://example.com/a.txt',
            destinationPath: ALLOWED_ROOT,
            fileName: `a${String(index)}.txt`,
            mediaType: 'text/plain',
            bytes: perTransfer,
          },
        })
        if (result.effects === 0 && result.code !== null) {
          refusedAt = index
          expect(['transfer-byte-ceiling', 'transfer-count-exceeded']).toContain(result.code)
        }
      }
      expect(refusedAt).toBe(DEVICE_HANDS_LIMITS.maxTransfersPerSession)
      expect(a.snapshot().bytesThisSession).toBeLessThanOrEqual(ceiling)
      expect(a.calls('download')).toBe(refusedAt)
    })

    it('refuses an upload whose source is the Vault, its keyring or a credential store', async () => {
      const a = attacker()
      await a.ready()
      for (const sourcePath of [VAULT_ROOT, '/user-data/Freya.keyring.json', '/home/freya/.ssh', ALLOWED_ROOT]) {
        await a.seekApproval({ actionId: `atk-up-${sourcePath}`, actionKey: 'transfer.upload', input: { url: 'https://example.com/in', sourcePath, fileName: 'r.csv', mediaType: 'text/csv', bytes: 8 } })
        const result = await a.attempt({
          actionId: `atk-up-${sourcePath}`,
          actionKey: 'transfer.upload',
          input: { url: 'https://example.com/in', sourcePath, fileName: 'r.csv', mediaType: 'text/csv', bytes: 8 },
        })
        if (sourcePath === ALLOWED_ROOT) {
          expect(result.effects).toBe(1)
        } else {
          expect(result.effects, sourcePath).toBe(0)
          assertNoEffect(result)
          expect(['vault-path-denied', 'credential-store-denied']).toContain(result.code)
        }
      }
    })

    it('refuses an upload to a host that is not on the allowlist, in either direction', async () => {
      const a = attacker()
      await a.ready()
      for (const url of ['https://evil.test/inbox', 'https://example.com@evil.test/', 'file:///tmp/x']) {
        await a.seekApproval({ actionId: `atk-uh-${url}`, actionKey: 'transfer.upload', input: { url, sourcePath: ALLOWED_ROOT, fileName: 'r.csv', mediaType: 'text/csv', bytes: 8 } })
        const result = await a.attempt({
          actionId: `atk-uh-${url}`,
          actionKey: 'transfer.upload',
          input: { url, sourcePath: ALLOWED_ROOT, fileName: 'r.csv', mediaType: 'text/csv', bytes: 8 },
        })
        expect(result.effects, url).toBe(0)
        expect(['url-host-not-allowed', 'url-carries-credential', 'url-scheme-not-allowed']).toContain(result.code)
      }
    })

    it('refuses an upload without an approval, however small it is', async () => {
      const a = attacker()
      await a.ready()
      const result = await a.attempt({
        actionId: 'atk-small',
        actionKey: 'transfer.upload',
        input: { url: 'https://example.com/in', sourcePath: ALLOWED_ROOT, fileName: 'r.csv', mediaType: 'text/csv', bytes: 1 },
      })
      expect(result.effects).toBe(0)
      expect(result.code).toBe('approval-missing')
    })

    it('refuses a reserved device name and a name with a separator', async () => {
      const a = attacker()
      await a.ready()
      for (const fileName of ['CON.txt', 'LPT1.txt', 'sub/a.txt', 'a\\b.txt', '..', '.']) {
        const result = await a.attempt({
          actionId: `atk-name-${fileName}`,
          actionKey: 'transfer.download',
          input: { url: 'https://example.com/a.txt', destinationPath: ALLOWED_ROOT, fileName, mediaType: 'text/plain', bytes: 1 },
        })
        expect(result.effects, fileName).toBe(0)
        expect(result.code, fileName).toBe('file-name-invalid')
      }
    })
  })

  describe('approval bypass', () => {
    it('refuses every approval-requiring action with no approval at all', async () => {
      const a = attacker()
      await a.ready()
      const bodies: readonly (readonly [string, Record<string, unknown>])[] = [
        ['terminal.run', terminalInput()],
        ['clipboard.read', {}],
        ['clipboard.write', { text: 'hello' }],
        ['clipboard.clear', {}],
        ['browser.click', { url: `https://${ALLOWED_HOST}/`, selector: '#a' }],
        ['browser.type-text', { url: `https://${ALLOWED_HOST}/`, selector: '#q', text: 'hi' }],
        ['transfer.upload', { url: 'https://example.com/in', sourcePath: ALLOWED_ROOT, fileName: 'r.csv', mediaType: 'text/csv', bytes: 8 }],
      ]
      for (const [actionKey, input] of bodies) {
        const result = await a.attempt({ actionId: `atk-noap-${actionKey}`, actionKey: actionKey as never, input })
        expect(result.effects, actionKey).toBe(0)
        assertNoEffect(result)
        expect(result.code, actionKey).toBe('approval-missing')
      }
    })

    it('refuses an approval that did not come from the owner', async () => {
      for (const decidedBy of ['core', 'surface', 'unknown'] as const) {
        const a = attacker({ decidedBy })
        await a.ready()
        const approval = await a.seekApproval({ actionId: 'atk-forged', actionKey: 'terminal.run' })

        expect(approval.ok).toBe(false)
        expect(approval.reason).toContain('did not come from the owner')

const result = await a.attempt({ actionId: 'atk-forged', actionKey: 'terminal.run', input: terminalInput() })
        expect(result.effects).toBe(0)
        // The decision was recorded as a denial, so the gate reports the denial rather
        // than "no approval exists" — which would hide that somebody had been asked.
        expect(result.code).toBe('approval-not-granted')
      }
    })

    it('refuses a denied approval', async () => {
      const a = attacker({ granted: false })
      await a.ready()
      const approval = await a.seekApproval({ actionId: 'atk-no', actionKey: 'terminal.run' })
      expect(approval.ok).toBe(false)
      const result = await a.attempt({ actionId: 'atk-no', actionKey: 'terminal.run', input: terminalInput() })
      expect(result.effects).toBe(0)
    })

    it('refuses an approval that was revoked the moment it was granted', async () => {
      const a = attacker({ approvalStillValid: false })
      await a.ready()
      const approval = await a.seekApproval({ actionId: 'atk-rev', actionKey: 'terminal.run' })
      expect(approval.ok).toBe(false)
      const result = await a.attempt({ actionId: 'atk-rev', actionKey: 'terminal.run', input: terminalInput() })
      expect(result.effects).toBe(0)
    })

    it('refuses to substitute a different command, directory or environment for the approved one', async () => {
      // A fresh attacker per substitution, because an id is consumed by the attempt that
      // presents it. Sharing one would test the replay rule instead of the digest.
      const substitutions: readonly Record<string, unknown>[] = [
        { args: ['status', '--porcelain'] },
        { workingDirectory: `${ALLOWED_ROOT}/sub` },
        { env: { CI: 'false' } },
        { args: ['clean', '-f'] },
      ]
      for (const override of substitutions) {
        const a = attacker()
        await a.ready()
        await a.seekApproval({ actionId: 'atk-sub', actionKey: 'terminal.run', input: terminalInput() })

        const result = await a.attempt({
          actionId: 'atk-sub',
          actionKey: 'terminal.run',
          input: terminalInput(override),
        })

        expect(result.effects, JSON.stringify(override)).toBe(0)
        expect(result.code, JSON.stringify(override)).toBe('approval-subject-mismatch')
        expect(a.calls('terminal')).toBe(0)
      }
    })

    it('refuses to reuse an approval for a different clipboard payload', async () => {
      const a = attacker()
      await a.ready()
      await a.seekApproval({ actionId: 'atk-clip', actionKey: 'clipboard.write', input: { text: 'meet at 3pm' } })
      await a.seekApproval({ actionId: 'atk-clip', actionKey: 'clipboard.write', input: { text: 'meet at 4pm' } })

      const result = await a.attempt({
        actionId: 'atk-clip',
        actionKey: 'clipboard.write',
        input: { text: 'meet at 4pm' },
      })
      expect(result.effects).toBe(0)
      expect(result.code).toBe('approval-subject-mismatch')
    })

    it('refuses an approval that expires between the request and the action', async () => {
      const a = attacker()
      await a.ready()
      const approval = await a.seekApproval({
        actionId: 'atk-exp',
        actionKey: 'terminal.run',
        input: terminalInput(),
        expiresAt: '2026-07-01T09:00:10.000Z',
      })
      expect(approval.ok).toBe(true)
      const result = await a.attempt({
        actionId: 'atk-exp',
        actionKey: 'terminal.run',
        input: terminalInput(),
        at: '2026-07-01T09:00:20.000Z',
      })
      expect(result.effects).toBe(0)
      expect(result.code).toBe('approval-expired')
    })

    it('refuses an approval window longer than the ceiling, rather than shortening it', async () => {
      const a = attacker()
      await a.ready()
      const approval = await a.seekApproval({
        actionId: 'atk-long',
        actionKey: 'terminal.run',
        input: terminalInput(),
        expiresAt: T_PLUS_1D,
      })
      expect(approval.ok).toBe(false)
      expect(approval.reason).toContain('within')
    })
  })

  describe('STOP ALL bypass', () => {
    it('refuses every surface with the latch thrown, and reaches nothing', async () => {
      const a = attacker({ stopAll: true })
      await a.ready()
      const bodies: readonly (readonly [string, Record<string, unknown>])[] = [
        ['browser.navigate', { url: `https://${ALLOWED_HOST}/` }],
        ['browser.read-text', { url: `https://${ALLOWED_HOST}/` }],
        ['transfer.download', { url: 'https://example.com/a.txt', destinationPath: ALLOWED_ROOT, fileName: 'a.txt', mediaType: 'text/plain', bytes: 4 }],
      ]
      for (const [actionKey, input] of bodies) {
        const result = await a.attempt({ actionId: `atk-stop-${actionKey}`, actionKey: actionKey as never, input })
        expect(result.effects, actionKey).toBe(0)
        assertNoEffect(result)
        expect(result.refusedAt, actionKey).toBe('stop-all')
      }
    })

    it('refuses even a probe, because a measurement is still an action', async () => {
      const a = attacker({ stopAll: true })
      await a.ready()
      const result = await a.probe('terminal')
      expect(result.ok).toBe(false)
      expect(a.calls('probe')).toBe(0)
    })

    it('refuses an action that was approved before the latch was thrown', async () => {
      const a = attacker()
      await a.ready()
      await a.seekApproval({ actionId: 'atk-race', actionKey: 'terminal.run', input: terminalInput() })
      a.setStopAll(true)

      const result = await a.attempt({ actionId: 'atk-race', actionKey: 'terminal.run', input: terminalInput() })

      expect(result.effects).toBe(0)
      expect(result.code).toBe('stop-all-latched')
    })

    it('records a refused action under STOP ALL as refused, and consumes its id', async () => {
      const a = attacker({ stopAll: true })
      await a.ready()
      await a.attempt({ actionId: 'atk-latch', actionKey: 'browser.navigate' })
      expect(a.snapshot().actions['atk-latch']?.outcome).toBe('refused')

      a.setStopAll(false)
      const again = await a.attempt({ actionId: 'atk-latch', actionKey: 'browser.navigate' })
      expect(again.code).toBe('replay-detected')
      expect(a.calls('browser')).toBe(0)
    })
  })

  describe('authority widening', () => {
    it('refuses every entry in the absolute deny list, with a code that says why', async () => {
      const a = attacker()
      await a.ready()
      for (const claim of FORBIDDEN_DEVICE_HANDS_ACTIONS) {
        const result = await a.attempt({ actionId: `atk-deny-${claim}`, claimsAction: claim })
        expect(result.effects, claim).toBe(0)
        assertNoEffect(result)
        expect(result.refusedAt, claim).toBe('surface')
      }
    })

    it('refuses a swap of the policy underneath a journal that already recorded one', async () => {
      const a = attacker()
      await a.ready()

      const wider = await a.swapPolicy({
        allowedRoots: ['/workspace', '/home'],
        deniedRoots: ['/user-data/Freya/vault'],
        allowedHosts: [ALLOWED_HOST, 'evil.test'],
        allowedCommands: ['git', 'rm'],
        allowedEnvNames: ['CI', 'PATH'],
      })

      expect(wider.ok).toBe(false)
      expect(wider.code).toBe('policy-mismatch')
      // And the refusal is not cosmetic: the narrow policy is still the one in force.
      const result = await a.attempt({
        actionId: 'atk-wide',
        actionKey: 'browser.navigate',
        input: { url: 'https://elsewhere.test/' },
      })
      expect(result.effects).toBe(0)
      expect(result.code).toBe('url-host-not-allowed')
    })

    it('refuses a policy with no denied root, because "nothing protected" is not a policy', async () => {
      const a = attacker()
      await a.ready()
      const result = await a.swapPolicy({ ...POLICY_INPUT, deniedRoots: [] })
      expect(result.ok).toBe(false)
      expect(result.code).toBe('policy-missing')
    })

    it('refuses a policy that widens the root, the host list or the command list', async () => {
      const a = attacker()
      await a.ready()
      for (const next of [
        { ...POLICY_INPUT, allowedRoots: ['/'] },
        { ...POLICY_INPUT, allowedHosts: [ALLOWED_HOST, 'evil.test'] },
        { ...POLICY_INPUT, allowedCommands: ['git', 'rm', 'curl'] },
        { ...POLICY_INPUT, allowedEnvNames: ['CI', 'AWS_SECRET_ACCESS_KEY'] },
        { ...POLICY_INPUT, maxTransferBytes: 10_000_000_000 },
      ]) {
        const result = await a.swapPolicy(next)
        expect(result.ok, JSON.stringify(next.allowedRoots)).toBe(false)
      }
    })

    it('refuses a grant with no policy to narrow', async () => {
      const a = attacker()
      await a.readyWithoutPolicy()
      const result = await a.grant({})
      expect(result.ok).toBe(false)
      expect(result.code).toBe('policy-missing')
    })

    it('refuses a grant naming an action this build does not route, including a wildcard', async () => {
      const a = attacker()
      await a.ready()
      for (const actions of [['*'], ['browser.*'], ['browser.screenshot'], ['all'], ['']]) {
        const result = await a.grant({ actions: actions as never })
        expect(result.ok, actions.join(',')).toBe(false)
        expect(result.code, actions.join(',')).toBe('grant-action-mismatch')
      }
    })

    it('refuses a grant whose window is longer than the ceiling', async () => {
      const a = attacker()
      await a.ready()
      const result = await a.grant({ issuedAt: T0, expiresAt: T_PLUS_1D })
      expect(result.ok).toBe(false)
      expect(result.code).toBe('grant-expired')
    })

    it('refuses a grant whose actions name a surface it does not list', async () => {
      const a = attacker()
      await a.ready()
      const result = await a.grant({ surfaces: ['browser'], actions: ['terminal.run'] })
      expect(result.ok).toBe(false)
      expect(result.code).toBe('grant-surface-mismatch')
    })

    it('refuses to act on a grant the journal has never seen', async () => {
      const a = attacker()
      await a.ready()
      a.reportGrant({ ...defaultGrant(), grantId: 'grant-forged' })

      const result = await a.attempt({ actionId: 'atk-fg', actionKey: 'browser.navigate' })

      expect(result.effects).toBe(0)
      expect(result.code).toBe('grant-missing')
    })

    it('refuses to act when Core and the journal disagree about the grant', async () => {
      const a = attacker()
      await a.ready()
      const fact = defaultGrant()
      a.reportGrant({ ...fact, actions: [...fact.actions, 'browser.screenshot' as never] })

      const result = await a.attempt({ actionId: 'atk-dis', actionKey: 'browser.navigate' })

      expect(result.effects).toBe(0)
      expect(result.code).toBe('grant-missing')
    })

    it('refuses to act as a principal the grant was not issued to', async () => {
      const a = attacker()
      await a.ready()
      for (const identity of [
        { principalId: 'someone-else', scope: 'session-1' },
        { principalId: 'owner-1', scope: 'another-session' },
      ]) {
        const result = await a.attempt({ actionId: `atk-who-${identity.principalId}-${identity.scope}`, ...identity })
        expect(result.effects).toBe(0)
        expect(result.code).toBe('grant-missing')
      }
    })

    it('gives a successful probe no authority whatsoever', async () => {
      const a = attacker()
      await a.readyWithoutGrant()

      const result = await a.probe('terminal')

      expect(result.ok).toBe(true)
      expect(result.available).toBe(true)
      // The probe worked. The caller still has nothing.
      expect(Object.keys(a.snapshot().grants)).toHaveLength(0)
      const afterwards = await a.attempt({ actionId: 'atk-after', actionKey: 'terminal.run', input: terminalInput() })
      expect(afterwards.effects).toBe(0)
      expect(afterwards.code).toBe('grant-missing')
    })

    it('leaves no method anywhere that could issue, widen or clear an authority', async () => {
      const a = attacker()
      await a.ready()
      // The runtime's public surface is enumerable, and none of these exist on it.
      const surface = Object.keys(a.runtime).sort()
      for (const forbidden of [
        'grant',
        'grantCapability',
        'widen',
        'widenPolicy',
        'widenBudget',
        'disableStopAll',
        'clearStopAll',
        'bypassGuard',
        'mintApproval',
        'selfApprove',
      ]) {
        expect(surface).not.toContain(forbidden)
      }
      expect(surface.sort()).toEqual([
        'approvals',
        'cancel',
        'loadPolicy',
        'open',
        'perform',
        'probe',
        'projection',
        'recovery',
        'refusals',
        'registerGrant',
        'requestApproval',
        'revokeGrant',
        'snapshot',
      ])
    })
  })

  describe('budget and time abuse', () => {
    it('refuses once the action ceiling is reached', async () => {
      const a = attacker()
      await a.ready()
      let refused: string | null = null
      for (let index = 0; index < DEVICE_HANDS_LIMITS.maxActionsPerSession + 2; index += 1) {
        const result = await a.attempt({
          actionId: `atk-cap-${String(index)}`,
          actionKey: 'browser.navigate',
          input: { url: `https://${ALLOWED_HOST}/p${String(index)}` },
        })
        if (result.code !== null && refused === null) refused = result.code
      }
      expect(refused).toBe('action-count-exceeded')
      expect(a.calls('browser')).toBe(DEVICE_HANDS_LIMITS.maxActionsPerSession)
    })

    it('refuses a deadline already passed, and one further out than the ceiling', async () => {
      const a = attacker()
      await a.ready()
      const past = await a.attempt({ actionId: 'atk-past', deadlineAt: T0, at: T0 })
      expect(past.effects).toBe(0)
      expect(past.code).toBe('deadline-expired')

      const tooLong = await a.attempt({ actionId: 'atk-long', deadlineAt: '2026-07-01T10:00:00.000Z' })
      expect(tooLong.effects).toBe(0)
      expect(tooLong.reason).toContain('at most 60 seconds')
    })

    it('refuses an action once the grant has expired', async () => {
      const a = attacker()
      await a.ready()
      const result = await a.attempt({
        actionId: 'atk-expg',
        actionKey: 'browser.navigate',
        at: '2026-07-01T09:06:00.000Z',
      })
      expect(result.effects).toBe(0)
      expect(result.code).toBe('grant-expired')
    })
  })

  describe('the probe and the audit trail', () => {
    it('journals no content of any kind', async () => {
      const a = attacker()
      await a.ready()
      await a.seekApproval({ actionId: 'atk-j', actionKey: 'clipboard.write', input: { text: 'meet at 3pm' } })
      await a.attempt({ actionId: 'atk-j', actionKey: 'clipboard.write', input: { text: 'meet at 3pm' } })
      await a.attempt({
        actionId: 'atk-dl',
        actionKey: 'transfer.download',
        input: { url: 'https://example.com/a.txt', destinationPath: ALLOWED_ROOT, fileName: 'a.txt', mediaType: 'text/plain', bytes: 8 },
      })

      const serialised = JSON.stringify(a.entries)
      expect(serialised).not.toContain('meet at 3pm')
      expect(serialised).not.toContain('approval-subject')
      expect(serialised).not.toContain('EXAMPLE')
    })

    it('records a refusal with the gate that produced it, every time', async () => {
      const a = attacker()
      await a.ready()
      await a.attempt({ actionId: 'atk-r1', actionKey: 'terminal.run', input: terminalInput() })
      const refusals = a.runtime.refusals()
      expect(refusals).toHaveLength(1)
      expect(refusals[0]?.gate).toBe('approval')
      expect(refusals[0]?.code).toBe('approval-missing')
      expect(refusals[0]?.reason.length).toBeGreaterThan(10)
    })

    it('never lets an unverified action be described as complete', async () => {
      const a = attacker({ observes: false })
      await a.ready()
      const result = await a.attempt({
        actionId: 'atk-unv',
        actionKey: 'transfer.download',
        input: { url: 'https://example.com/a.txt', destinationPath: ALLOWED_ROOT, fileName: 'a.txt', mediaType: 'text/plain', bytes: 64 },
      })
      expect(result.verdict).toBe('unverified')
      expect(result.bytes).toBe(0)
      expect(a.snapshot().actions['atk-unv']?.outcome).toBe('unverified')
      expect(a.snapshot().bytesThisSession).toBe(0)
      expect(a.journalTypes()).not.toContain('hands.transfer.completed')
    })

    it('records an action the process could not finish as unknown rather than as done', async () => {
      const a = attacker()
      await a.ready()
      a.seed({
        type: 'hands.action.started',
        recordedAt: T0,
        payload: {
          actionId: 'atk-lost',
          actionKey: 'browser.navigate',
          surface: 'browser',
          principalId: 'owner-1',
          grantId: 'grant-1',
          deadlineAt: T_PLUS_30S,
          at: T0,
        },
      })

      const restarted = await a.restart()

      expect(restarted.snapshot().actions['atk-lost']?.outcome).toBe('interrupted')
      expect(a.journalTypes()).toContain('hands.reconciled')
      const again = await restarted.perform({
        actionId: 'atk-lost',
        principalId: 'owner-1',
        scope: 'session-1',
        actionKey: 'browser.navigate',
        claimsAction: null,
        input: { url: `https://${ALLOWED_HOST}/about` },
        deadlineAt: T_PLUS_30S,
        at: T0,
      })
      expect(again.code).toBe('replay-detected')
      expect(a.calls('browser')).toBe(0)
    })
  })
})