// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { localUnrestrictedDecision, localUnrestrictedFromProcess } from '../../../electron/localUnrestricted'

/**
 * The unrestricted decision is the widest authority the desktop host has, so its
 * default is the property under test.
 *
 * The old expression was `... || !app.isPackaged`, which meant every unpackaged
 * build was unrestricted. `npm start` and `npm run electron:dev` — the two commands
 * the README tells a new developer to run — both produce unpackaged builds, so
 * the documented first run carried private-host browsing, protected-field access
 * and a self-issued owner approval with no opt-in anywhere. The same expression
 * also let `FREYA_LOCAL_UNRESTRICTED=1` re-open a **packaged** build, because the
 * `=== '1'` arm was evaluated before the packaging question was asked.
 *
 * The decision is pure, so it can be checked here without booting Electron. That
 * is the whole reason it was extracted: a security property that can only be
 * exercised by launching the app is a property nobody exercises.
 */

const DEV_PROFILE = { FREYA_DEV_USER_DATA: 'C:/temp/freya-scratch-profile' } as const
const PRODUCTION_PROFILE = 'C:/Users/Owner/AppData/Roaming/Freya'

/**
 * A dev-tagged launch against a separate profile: every prerequisite satisfied
 * unless the case under test overrides one.
 *
 * `'devUserData' in overrides` rather than `overrides.devUserData === undefined`,
 * because "no profile" is one of the cases under test and must be
 * indistinguishable from deliberately passing nothing.
 */
function prerequisitesSatisfied(overrides: {
  requested?: string
  isPackaged?: boolean
  devUserData?: string
  productionUserData?: string
  argv?: readonly string[]
} = {}) {
  return localUnrestrictedDecision({
    isPackaged: overrides.isPackaged ?? false,
    requested: overrides.requested ?? '1',
    devUserData: 'devUserData' in overrides ? overrides.devUserData : DEV_PROFILE.FREYA_DEV_USER_DATA,
    productionUserData: overrides.productionUserData ?? PRODUCTION_PROFILE,
    argv: overrides.argv ?? ['electron', '.', '--dev'],
  })
}

describe('an unpackaged build with no opt-in', () => {
  it('is strict, which is the defect this fixes', () => {
    // The exact shape of the documented first run: `npm start`, no environment set.
    // It used to be unrestricted. If this assertion ever fails again, the README's
    // first-run instructions are handing a developer every local authority.
    const decision = localUnrestrictedDecision({
      isPackaged: false,
      requested: undefined,
      devUserData: undefined,
      argv: ['electron', '.'],
    })
    expect(decision.mode).toBe(false)
    expect(decision.reason).toBe('not-requested')
  })

  it('is strict even when a profile is named and the run is dev-tagged', () => {
    // Proves the default is the switch and not the surroundings: a dev profile alone
    // does not turn anything on.
    expect(localUnrestrictedDecision({
      isPackaged: false,
      requested: undefined,
      devUserData: DEV_PROFILE.FREYA_DEV_USER_DATA,
      argv: ['electron', '.', '--dev'],
    }).mode).toBe(false)
  })
})

describe('a packaged build', () => {
  it('is strict with nothing set at all', () => {
    expect(localUnrestrictedDecision({
      isPackaged: true,
      requested: undefined,
      devUserData: undefined,
      argv: ['Freya'],
    }).mode).toBe(false)
  })

  it('stays strict when every other prerequisite is satisfied', () => {
    // The regression this guards is narrow and was a real hole: the old code's
    // `=== '1'` arm returned true for a packaged build without consulting
    // `isPackaged`, so the environment variable *was* a privilege escalation path
    // in a shipped product. Packaging is checked first and is not overridable.
    const decision = prerequisitesSatisfied({ isPackaged: true })
    expect(decision.mode).toBe(false)
    expect(decision.reason).toBe('packaged-build-always-strict')
  })

  it('is strict for the default production launch, which has no --dev and no profile', () => {
    expect(prerequisitesSatisfied({
      isPackaged: true,
      argv: ['Freya'],
      devUserData: undefined,
    }).mode).toBe(false)
  })
})

describe('the explicit opt-in', () => {
  it('is granted only when all three conditions hold', () => {
    expect(prerequisitesSatisfied()).toEqual({ mode: true, reason: 'granted' })
  })

  it.each(['0', 'true', 'yes', 'on', 'TRUE', '01', '', ' 1', '1 '])(
    'refuses the near-miss value %j rather than reading it as yes',
    (requested) => {
      // An exact `'1'` is the whole grammar. `'0'` matters most — it was the old
      // *opt-out*, so a machine that still had it exported was asking to be strict.
      const decision = prerequisitesSatisfied({ requested })
      expect(decision.mode).toBe(false)
      expect(decision.reason).toBe('not-requested')
    },
  )

  it('refuses when no separate profile is named', () => {
    // The profile requirement is what makes granting the flag defensible: the thing
    // being widened is a scratch directory that gets deleted, never the owner's own.
    expect(prerequisitesSatisfied({ devUserData: undefined })).toEqual({
      mode: false,
      reason: 'no-separate-profile',
    })
    expect(prerequisitesSatisfied({ devUserData: '' })).toEqual({
      mode: false,
      reason: 'no-separate-profile',
    })
  })

  it('refuses a dev profile equal to the real user profile', () => {
    expect(prerequisitesSatisfied({ devUserData: PRODUCTION_PROFILE })).toEqual({
      mode: false, reason: 'unsafe-dev-profile',
    })
  })

  it('refuses a dev profile nested inside the real user profile', () => {
    expect(prerequisitesSatisfied({ devUserData: PRODUCTION_PROFILE + '/test-profile' })).toEqual({
      mode: false, reason: 'unsafe-dev-profile',
    })
  })

  it('refuses a dev profile that contains the real user profile', () => {
    expect(prerequisitesSatisfied({ devUserData: 'C:/Users/Owner/AppData/Roaming' })).toEqual({
      mode: false, reason: 'unsafe-dev-profile',
    })
  })

  it('refuses unrestricted mode without a known production profile', () => {
    expect(localUnrestrictedDecision({
      isPackaged: false,
      requested: '1',
      devUserData: DEV_PROFILE.FREYA_DEV_USER_DATA,
      argv: ['electron', '--dev'],
    })).toEqual({ mode: false, reason: 'unsafe-dev-profile' })
  })

  it('refuses when the run is not dev-tagged', () => {
    // `FREYA_DEV_USER_DATA` is itself only honoured when `--dev` is present — see
    // `electron/main.ts`. Unrestricted mode requires the same tag, so the two can
    // never disagree about whether this is a real profile.
    expect(prerequisitesSatisfied({ argv: ['electron', '.'] })).toEqual({
      mode: false,
      reason: 'not-dev-tagged',
    })
  })
})

describe('the refusal reason', () => {
  it('names the packaging case before anything else is consulted', () => {
    // Ordering is load-bearing. A packaged build must not even look at the
    // environment, so the reason has to be the packaging one regardless of what
    // else was supplied.
    expect(localUnrestrictedDecision({
      isPackaged: true,
      requested: 'nonsense',
      devUserData: '',
      argv: [],
    }).reason).toBe('packaged-build-always-strict')
  })

  it('always produces one of the six closed reasons', () => {
    // Guards the startup warning against printing something unexpected. Nothing
    // here is an environment value, so the closed set is also what keeps a path or
    // a credential out of the log.
    const values = [undefined, '', '0', '1', 'true'] as const
    const reasons = new Set<string>()
    for (const requested of values) {
      for (const isPackaged of [true, false]) {
        for (const devUserData of [undefined, '', DEV_PROFILE.FREYA_DEV_USER_DATA]) {
          for (const argv of [[], ['--dev']]) {
            reasons.add(localUnrestrictedDecision({ isPackaged, requested, devUserData, argv, productionUserData: PRODUCTION_PROFILE }).reason)
          }
        }
      }
    }
    reasons.add(prerequisitesSatisfied({ devUserData: PRODUCTION_PROFILE }).reason)
    expect([...reasons].sort()).toEqual([
      'granted',
      'no-separate-profile',
      'not-dev-tagged',
      'not-requested',
      'packaged-build-always-strict',
      'unsafe-dev-profile',
    ])
  })
})

describe('reading the host process', () => {
  it('never grants a packaged host, whatever the environment says', () => {
    const hostile = {
      FREYA_LOCAL_UNRESTRICTED: '1',
      FREYA_DEV_USER_DATA: 'C:/temp/freya-scratch-profile',
    } as NodeJS.ProcessEnv
    expect(localUnrestrictedFromProcess(true, hostile, ['Freya', '--dev']).mode).toBe(false)
  })

  it('grants an unpackaged dev host that asked, on a separate profile', () => {
    const asking = {
      FREYA_LOCAL_UNRESTRICTED: '1',
      FREYA_DEV_USER_DATA: 'C:/temp/freya-scratch-profile',
    } as NodeJS.ProcessEnv
    expect(localUnrestrictedFromProcess(false, asking, ['electron', '.', '--dev'], PRODUCTION_PROFILE).mode).toBe(true)
  })

  it('defaults to the real environment and argv, which is how main.ts calls it', () => {
    // Guards the wiring: a host with neither switch set is strict. This reads the
    // actual `process.env`, so it is the assertion that would catch the decision
    // being evaluated against anything other than the live host.
    const previous = { ...process.env }
    try {
      delete process.env.FREYA_LOCAL_UNRESTRICTED
      delete process.env.FREYA_DEV_USER_DATA
      expect(localUnrestrictedFromProcess(false).mode).toBe(false)
      expect(localUnrestrictedFromProcess(true).mode).toBe(false)
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in previous)) delete process.env[key]
      }
      Object.assign(process.env, previous)
    }
  })
})