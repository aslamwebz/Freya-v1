// @vitest-environment node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  DEVICE_HANDS_BANNED_ACTION_WORDS,
  DEVICE_HANDS_LIMITS,
  DEVICE_HANDS_PROBE_OUTCOME_KEYS,
  DEVICE_HANDS_SURFACE_ACTIONS,
  DEVICE_HANDS_SURFACES,
  FORBIDDEN_DEVICE_HANDS_ACTIONS,
  analyseJournal,
  auditDeviceHandsTables,
  auditGateTables,
  auditImpurityInSource,
  auditProbeOutcome,
  deviceHandsApprovalRequired,
  findAuthorityShapedKeys,
  findForbiddenVocabularyInSource,
  findTimerUsageInSource,
  auditUnboundedLoopInSource,
  stripComments,
} from '../../../core/devicehands'
import { harness } from './harness'

/**
 * The structural audits.
 *
 * Everything else in this suite proves a *behaviour*. This file proves the *shape* of
 * the code, which is what makes those behaviours hard to undo by accident: a pure policy
 * module that grew a clock, a port that grew a capture method, a routed action that grew
 * the word "screenshot", a probe result that grew a field called `granted`.
 *
 * It reads the source files rather than trusting a comment, so a reviewer does not have
 * to be the one who notices.
 */

const CORE = fileURLToPath(new URL('../../../core/devicehands/', import.meta.url))

function source(name: string): string {
  return readFileSync(`${CORE}${name}`, 'utf8')
}

/** The pure decision modules: no clock, no ports, no I/O. */
const PURE_MODULES = [
  'types.ts',
  'digest.ts',
  'paths.ts',
  'commands.ts',
  'clipboard.ts',
  'transfer.ts',
  'approvals.ts',
  'verification.ts',
  'gates.ts',
  'machine.ts',
  'state.ts',
  'recovery.ts',
  'projection.ts',
  'probe.ts',
] as const

/** The modules that must contain no timer and no capture vocabulary. */
const NO_TIMER_MODULES = [
  'types.ts',
  'digest.ts',
  'paths.ts',
  'commands.ts',
  'clipboard.ts',
  'transfer.ts',
  'approvals.ts',
  'verification.ts',
  'gates.ts',
  'machine.ts',
  'state.ts',
  'recovery.ts',
  'projection.ts',
  'probe.ts',
  'runtime.ts',
  'ports.ts',
] as const

/** The modules that must contain no capture, credential or authority minter. */
const NO_FORBIDDEN_VOCABULARY = [
  'types.ts',
  'paths.ts',
  'commands.ts',
  'clipboard.ts',
  'transfer.ts',
  'approvals.ts',
  'verification.ts',
  'gates.ts',
  'machine.ts',
  'state.ts',
  'recovery.ts',
  'projection.ts',
  'runtime.ts',
  'ports.ts',
] as const

describe('device hands structure', () => {
  it('passes every table and policy audit', () => {
    expect(auditDeviceHandsTables()).toEqual([])
  })

  it('passes the gate-order audit', () => {
    expect(auditGateTables()).toEqual([])
  })

  it('passes the probe audit', () => {
    expect(auditProbeOutcome()).toEqual([])
  })

  describe('the pure modules cannot read the world', () => {
    it.each(PURE_MODULES)('%s has no clock, no randomness, no network and no port access', (name) => {
      expect(auditImpurityInSource(source(name))).toEqual([])
    })

    it.each(PURE_MODULES)('%s has no self-scheduling', (name) => {
      expect(findTimerUsageInSource(source(name))).toEqual([])
    })
  })

  describe('nothing in this phase schedules itself', () => {
    it.each(NO_TIMER_MODULES)('%s contains no timer and no self-wake', (name) => {
      expect(findTimerUsageInSource(source(name))).toEqual([])
      expect(auditUnboundedLoopInSource(source(name))).toEqual([])
    })

    it('a phase that can drive a browser and a terminal still cannot act on its own', () => {
      // The strongest single claim in this phase: nothing here arms a timer, so nothing
      // here can act when nobody is watching.
      for (const name of NO_TIMER_MODULES) {
        const text = source(name)
        expect(text).not.toMatch(/\bsetTimeout\s*\(|\bsetInterval\s*\(|\bqueueMicrotask\s*\(/)
      }
    })
  })

  describe('nothing in this phase can capture or mint authority', () => {
    it.each(NO_FORBIDDEN_VOCABULARY)(
      '%s contains no capture, credential-read or authority-minter identifier',
      (name) => {
        expect(findForbiddenVocabularyInSource(source(name))).toEqual([])
      },
    )

    it('the port surface has no method that could carry an image', () => {
      // Comments are stripped first: this file's own prose *names* the things it refuses,
      // and a check that fires on its own documentation is a check people switch off.
      const ports = stripComments(source('ports.ts'))
      for (const name of [
        'captureScreen',
        'screenshot',
        'getScreenshot',
        'captureWindow',
        'getDisplayMedia',
        'getUserMedia',
        'canvas',
        'toDataURL',
        'renderPdf',
      ]) {
        expect(new RegExp(`\\b${name}\\b`, 'i').test(ports)).toBe(false)
      }
      // And the type surface is equally clear: no port request or outcome has a field
      // whose name could be a frame.
      expect(ports).not.toMatch(/\b(image|screenshot|pixels|frame|bitmap|dataUrl)\s*:/i)
    })

    it('the port surface has no authority method either', () => {
      const ports = stripComments(source('ports.ts'))
      for (const name of [
        'checkCapability',
        'grantCapability',
        'createGrant',
        'widenLimit',
        'disableStopAll',
        'mintApproval',
      ]) {
        expect(new RegExp(`\\b${name}\\b`, 'i').test(ports)).toBe(false)
      }
      // The one grant-shaped method is a *read*, and its result carries no authority.
      expect(ports).toContain('activeGrant')
      expect(ports).not.toMatch(/^\s*(issue|create|register|write|set)Grant\s*\(/m)
    })

    it('the runtime schedules nothing', () => {
      expect(findTimerUsageInSource(source('runtime.ts'))).toEqual([])
    })

    it('the projection has no next-action field for a renderer to poll', () => {
      const projection = stripComments(source('projection.ts'))
      expect(projection).not.toMatch(/nextBoundedAction|nextAction|schedule/i)
    })
  })

  describe('the routed vocabulary cannot describe a capture', () => {
    it('has exactly four surfaces', () => {
      expect([...DEVICE_HANDS_SURFACES]).toEqual(['browser', 'terminal', 'clipboard', 'transfer'])
    })

    it('names no physical-world or credential surface', () => {
      for (const surface of DEVICE_HANDS_SURFACES) {
        const lower = surface.toLowerCase()
        for (const banned of ['camera', 'mic', 'sensor', 'location', 'screen', 'display', 'robot', 'iot', 'vault', 'keyring']) {
          expect(lower).not.toContain(banned)
        }
      }
    })

    it.each(DEVICE_HANDS_SURFACES.flatMap((s) =>
      DEVICE_HANDS_SURFACE_ACTIONS[s].map((a) => `${s}.${a}` as const),
    ))('%s contains no banned word', (key) => {
      const lower = key.slice(key.indexOf('.') + 1).toLowerCase()
      for (const word of DEVICE_HANDS_BANNED_ACTION_WORDS) {
        expect(lower).not.toContain(word)
      }
    })

    it('the browser has no capture action at all, and the audit would notice one', () => {
      expect(DEVICE_HANDS_SURFACE_ACTIONS.browser).toEqual([
        'navigate',
        'read-text',
        'click',
        'type-text',
      ])
      // The audit is what makes that a property rather than a comment: if somebody adds
      // `capture-frame`, `auditAuthorityTables` reports it.
      const mutated = new Map(Object.entries(DEVICE_HANDS_SURFACE_ACTIONS))
      expect(mutated.get('browser')).not.toContain('capture-frame')
    })

    it('every action that executes needs an approval, and only two do not', () => {
      const exempt: string[] = []
      for (const surface of DEVICE_HANDS_SURFACES) {
        for (const action of DEVICE_HANDS_SURFACE_ACTIONS[surface]) {
          if (!deviceHandsApprovalRequired(`${surface}.${action}` as never)) exempt.push(`${surface}.${action}`)
        }
      }
      expect(exempt.sort()).toEqual(['browser.navigate', 'browser.read-text', 'transfer.download'])
    })
  })

  describe('the deny list', () => {
    it('cannot be emptied', () => {
      expect(FORBIDDEN_DEVICE_HANDS_ACTIONS.length).toBeGreaterThan(30)
      expect(auditDeviceHandsTables()).toEqual([])
    })

    it('covers credentials, capture, the physical world and authority minting', () => {
      for (const required of [
        'read-vault',
        'read-keyring',
        'read-credential-store',
        'screenshot',
        'capture-screen',
        'render-pdf',
        'read-camera',
        'control-iot-device',
        'grant-authority',
        'widen-capability',
        'disable-stop-all',
        'bypass-guard',
        'self-approve',
      ]) {
        expect(FORBIDDEN_DEVICE_HANDS_ACTIONS).toContain(required)
      }
    })

    it('names no screenshot and no capture word as a *routable* action anywhere', () => {
      for (const action of FORBIDDEN_DEVICE_HANDS_ACTIONS) {
        expect(DEVICE_HANDS_SURFACE_ACTIONS.browser).not.toContain(action)
      }
    })
  })

  describe('the ceilings are frozen facts about this build', () => {
    it('are positive and finite', () => {
      for (const [name, value] of Object.entries(DEVICE_HANDS_LIMITS)) {
        expect(typeof value, name).toBe('number')
        expect(Number.isFinite(value), name).toBe(true)
        expect(value, name).toBeGreaterThan(0)
      }
    })

    it('bind the surfaces tightly enough that a mistake is small', () => {
      expect(DEVICE_HANDS_LIMITS.maxTransferBytesPerAction).toBeLessThanOrEqual(2 * 1024 * 1024)
      expect(DEVICE_HANDS_LIMITS.maxClipboardBytes).toBeLessThanOrEqual(64 * 1024)
      expect(DEVICE_HANDS_LIMITS.maxCommandArgs).toBeLessThanOrEqual(16)
      expect(DEVICE_HANDS_LIMITS.maxActionTimeoutMs).toBeLessThanOrEqual(5 * 60_000)
      expect(DEVICE_HANDS_LIMITS.maxGrantTtlMs).toBeLessThanOrEqual(60 * 60_000)
    })

    it('has no widening function anywhere in the phase', () => {
      for (const name of NO_FORBIDDEN_VOCABULARY) {
        expect(findForbiddenVocabularyInSource(source(name))).toEqual([])
      }
    })
  })

  describe('a probe result cannot be read as a permission', () => {
    it('carries no authority-shaped key', () => {
      expect(findAuthorityShapedKeys(Object.fromEntries(DEVICE_HANDS_PROBE_OUTCOME_KEYS.map((k) => [k, 'x'])))).toEqual([])
    })

    it('says nothing about scope or expiry, because both are permission shapes', () => {
      expect(DEVICE_HANDS_PROBE_OUTCOME_KEYS).not.toContain('scope')
      expect(DEVICE_HANDS_PROBE_OUTCOME_KEYS).not.toContain('expiresAt')
      expect(DEVICE_HANDS_PROBE_OUTCOME_KEYS).not.toContain('actions')
    })

    it('and the runtime hands out exactly those keys', async () => {
      const h = harness()
      await h.ready()
      const result = await h.runtime.probe('browser')
      expect(result.ok).toBe(true)
      expect(Object.keys(result.outcome ?? {}).sort()).toEqual([...DEVICE_HANDS_PROBE_OUTCOME_KEYS].sort())
      expect(findAuthorityShapedKeys(result.outcome ?? {})).toEqual([])
    })
  })

  describe('the journal audit finds what it is looking for', () => {
    it('finds an effect with no start', () => {
      const analysis = analyseJournal([
        { type: 'hands.terminal.performed', payload: { actionId: 'ghost', command: 'git' } },
      ])
      expect(analysis.violations.map((v) => v.code)).toContain('effect-without-start')
    })

    it('finds a refusal that names no gate', () => {
      const analysis = analyseJournal([
        { type: 'hands.action.refused', payload: { actionId: 'a', actionKey: 'browser.navigate', code: 'x' } },
      ])
      expect(analysis.violations.map((v) => v.code)).toContain('refusal-without-gate')
    })

    it('finds a transfer whose byte ledger moved without a passed verdict', () => {
      const analysis = analyseJournal([
        { type: 'hands.action.started', payload: { actionId: 'a' } },
        {
          type: 'hands.transfer.completed',
          payload: { actionId: 'a', verificationId: 'v', bytes: 10 },
        },
        { type: 'hands.verified', payload: { actionId: 'a', verificationId: 'v', result: 'reported' } },
      ])
      expect(analysis.violations.map((v) => v.code)).toContain('ledger-moved-without-passed-verdict')
    })

    it('finds a probe record carrying an authority-shaped key', () => {
      const analysis = analyseJournal([
        { type: 'hands.probe.performed', payload: { probeId: 'p', surface: 'browser', available: true, granted: true } },
      ])
      expect(analysis.violations.map((v) => v.code)).toContain('probe-recorded-as-authority')
    })

    it('finds the same action id started twice', () => {
      const analysis = analyseJournal([
        { type: 'hands.action.started', payload: { actionId: 'a' } },
        { type: 'hands.action.started', payload: { actionId: 'a' } },
      ])
      expect(analysis.violations.map((v) => v.code)).toContain('duplicate-action-id')
    })

    it('finds nothing in a journal the runtime actually wrote', async () => {
      const h = harness()
      await h.ready()
      await h.request({ actionId: 'act-1', actionKey: 'browser.navigate' })
      await h.request({ actionId: 'act-2', actionKey: 'transfer.download', input: { url: 'https://example.com/a.txt', destinationPath: '/workspace/project', fileName: 'a.txt', mediaType: 'text/plain', bytes: 16 } })
      await h.runtime.probe('terminal')

      const analysis = analyseJournal(h.entries)
      expect(analysis.violations).toEqual([])
      expect(analysis.effects).toBeGreaterThan(0)
    })
  })

  describe('the source audits are not vacuous', () => {
    it('finds a timer when one is added', () => {
      const findings = findTimerUsageInSource('setTimeout(() => {}, 10)')
      expect(findings).toContain('setTimeout')
      expect(findTimerUsageInSource('setTimeout(() => {}, 10)')).toContain('setTimeout')
    })

    it('finds an impurity when one is added', () => {
      expect(auditImpurityInSource('const t = Date.now()')).toContain('Date.now')
      expect(auditImpurityInSource('const u = process.env.SECRET')).toContain('process.env')
      expect(auditImpurityInSource('const c = process.cwd()')).toContain('process.cwd')
      expect(auditImpurityInSource('const r = resolve("x")')).toContain('path.resolve')
      expect(auditImpurityInSource('ports.now()')).toContain('ports-call')
    })

    it('finds a forbidden identifier when one is added', () => {
      expect(findForbiddenVocabularyInSource('await captureScreen()')).toContain('captureScreen')
      expect(findForbiddenVocabularyInSource('await readKeyring()')).toContain('readKeyring')
      expect(findForbiddenVocabularyInSource('grantCapability(x)')).toContain('grantCapability')
    })

    it('is not fooled by the words appearing in a comment or a string', () => {
      expect(findForbiddenVocabularyInSource('// we do not call captureScreen here')).toEqual([])
      expect(findForbiddenVocabularyInSource('const reason = "screenshot is refused"')).toEqual([])
      expect(auditImpurityInSource('// Date.now is deliberately absent')).toEqual([])
    })
  })
})
