import { describe, expect, it, beforeAll } from 'vitest'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The live App Mode must not assert operational facts it cannot evidence.
 *
 * ## Why this is a source scan and not a render test
 *
 * Eight of the twelve App Mode screens take **no props**. `Focus()`, `World()`,
 * `Workforce()`, `Life()`, `Memory()`, `People()`, `Foundry()` and `Relay()` are
 * pure functions of a module-level constant table, so there is no snapshot for
 * them to be truthful *about*. A render assertion cannot fix that — there is
 * nothing to pass in and nothing to vary.
 *
 * That is the actual defect, and it is why the previous test in this directory
 * asserted only `textContent.length > 0`. It passed for a screen that printed
 * `1,842 Nodes · 6,391 Relationships · Live Sync`, because the string it printed was
 * long. A test that a lie can satisfy is not a test.
 *
 * So the property is checked where the lie lives: in the source. Two properties are
 * enforced, and together they mean a sample screen can exist without lying:
 *
 *   1. it carries no fabricated **operational claim** — a count, a percentage, a
 *      status, or a future event that describes Freya's actual condition; and
 *   2. it **declares** that what it is showing is sample data, in the DOM, where a
 *      person scrolling the screen will see it.
 *
 * (2) is what makes (1) workable. Without it the only options would be to wire all
 * eight screens to real projections at once or to delete them; with it, a screen can
 * honestly say "sample" until its projection is bound. The marker is asserted here, so
 * it cannot be quietly dropped.
 *
 * ## What is deliberately *not* forbidden
 *
 *   - Layout and design constants (`3px`, `0.5rem`, `translateX(-50%)`).
 *   - Design labels in copy (`'FREYA'`, `'Key People'`, `'Sample timeline'`).
 *   - Real values that arrive as props — Home, Settings and Mind take a snapshot, and
 *     their numbers are rendered from it.
 *   - The dressing store, which is presentation state and says so.
 *
 * The rule is: a number or status word describing Freya's *operational condition*
 * must not be a module-level constant in a screen that cannot read one.
 */

async function codeOnly(path: string): Promise<string> {
  const source = await readFile(path, 'utf8')
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1 ')
}

/**
 * Screens that take no props, and therefore cannot read a projection.
 *
 * Enumerated from the actual signatures and checked against them below, so a screen
 * that gains snapshot access is expected to move out of this list rather than being
 * silently scanned as if it still were sample data.
 */
const SAMPLE_SCREENS = [
  'Focus.tsx',
  'Foundry.tsx',
  'Life.tsx',
  'Memory.tsx',
  'People.tsx',
  'Relay.tsx',
  'Workforce.tsx',
  'World.tsx',
] as const

interface Rule {
  readonly name: string
  readonly pattern: RegExp
  readonly why: string
}

/**
 * Each rule is anchored to the *shape of the claim*, not to one exact string, so a
 * different invented number is caught too.
 */
const RULES: readonly Rule[] = [
  {
    name: 'a graph size claim',
    pattern: /<b>[\d.,]+<\/b>\s*(?:Nodes|Relationships|Entities|Edges)\b/i,
    why: 'a world-model size must come from the World projection, not a constant',
  },
  {
    name: 'a live-sync status badge',
    pattern: /['"`]?\bLive\s*Sync\b/i,
    why: 'no projection reports a sync state; claiming one invents a capability',
  },
  {
    name: 'an uptime or availability percentage',
    // `<b>98%</b> Uptime` — the closing tag is allowed because that is the real markup,
    // and a pattern expecting the number to touch the word silently never matches.
    pattern: /\d+(?:\.\d+)?%[\s\S]{0,12}?(?:Uptime|uptime)\b/,
    why: 'nothing measures uptime; a percentage here is invented',
  },
  {
    name: 'a connector reported connected',
    pattern: /['"`][^'"`]*Connected['"`]\s*(?:\)|,|\]|;)/,
    why: 'Relay connectors are never supplied by the host and report unavailable',
  },
  {
    name: 'a connector service count',
    pattern: /<b>\d+<\/b>\s*(?:Connected services|connected services)/i,
    why: 'no connector is connected; a count here is invented',
  },
  {
    name: 'an active-agent count',
    pattern: /\b\d+\s+Active Agents\b/,
    why: 'agent counts must come from the Workforce projection',
  },
  {
    name: 'a recorded-entry count in a glance ring',
    pattern: /<b>[\d.,]+<\/b>\s*(?:Entries|entries)\b/,
    why: 'memory and life entry counts must come from the Brain and Life projections',
  },
  {
    name: 'an absolute guarantee about storage',
    pattern: /['"`][^'"`]*\b(?:Journal Encrypted|Memory Durable)\b[^'"`]*['"`]/i,
    why: 'encryption and durability are per-domain and each may be absent',
  },
  {
    name: 'a consent claim about window observation',
    pattern: /['"`][^'"`]*Window observation['"`]\s*[:,]\s*['"`][^'"`]*Ask each time/i,
    why: 'window observation is a launch-time variable, never a consent flow',
  },
  {
    name: 'a future-dated life event',
    pattern: /when:\s*['"`](?:Tomorrow|Further ahead|Later|Next week)['"`]/i,
    why: 'an autobiography cannot contain an event that has not happened',
  },
  {
    name: 'a build version literal',
    pattern: /Build\s+\d+\.\d+\.\d+/,
    why: 'the build version is reported by the host, not written into a screen',
  },
]

const screenSource: Record<string, string> = {}

beforeAll(async () => {
  const dir = join(process.cwd(), 'src', 'app', 'screens')
  for (const file of await readdir(dir)) {
    if (!file.endsWith('.tsx')) continue
    screenSource[file] = await codeOnly(join(dir, file))
  }
})

describe('the live App Mode asserts no operational fact it cannot evidence', () => {
  it('found the screens it expected to scan', () => {
    // A scan that silently matched nothing would pass every rule below.
    expect(Object.keys(screenSource).length).toBeGreaterThan(8)
    for (const file of SAMPLE_SCREENS) {
      expect(screenSource[file], `${file} is missing from src/app/screens`).toBeTypeOf('string')
    }
  })

  it('the screens it scans really do take no snapshot', () => {
    // If one of these gained props it is no longer sample data, and the rules below
    // would be wrong about it. That is a prompt to move it out of SAMPLE_SCREENS.
    for (const file of SAMPLE_SCREENS) {
      const signature = screenSource[file]?.match(/export function \w+\(([^)]*)\)/)?.[1] ?? ''
      expect(signature, `${file} now takes arguments and should leave SAMPLE_SCREENS`)
        .not.toMatch(/snapshot/i)
    }
  })

  for (const rule of RULES) {
    it(`carries no ${rule.name}`, () => {
      const found: string[] = []
      for (const file of SAMPLE_SCREENS) {
        const source = screenSource[file]
        if (source === undefined) continue
        // `matchAll` requires a global regex and throws without one. Built here rather
        // than stored on the rule, so no rule can be added with the flag already wrong.
        // Getting this wrong made every rule fail with a TypeError instead of a
        // finding — a gate that is red for a reason unrelated to the screens, and
        // therefore a gate that gets deleted.
        const global = new RegExp(rule.pattern.source, `${rule.pattern.flags.replace('g', '')}g`)
        for (const match of source.matchAll(global)) {
          found.push(`${file}: ${match[0].trim().slice(0, 90)}`)
        }
      }
      // Named in the failure, because "a fabricated claim" with no location is not
      // something anybody can act on.
      expect(found, `${rule.why}\n  ${found.join('\n  ')}`).toEqual([])
    })
  }
})

describe('every screen still showing sample data declares it', () => {
  /**
   * The companion rule, and the one that makes the rules above workable.
   *
   * A screen that cannot read a projection is allowed to show invented content —
   * that is what a design preview is — but it is not allowed to do so *silently*.
   * The marker is asserted here, so removing it without binding a real projection
   * fails a test rather than quietly reintroducing the problem.
   *
   * `data-sample` is checked rather than a class name, because it is a statement in
   * the markup that a test can read and a stylesheet cannot accidentally satisfy.
   */
  for (const file of SAMPLE_SCREENS) {
    it(`${file} labels its content as sample`, () => {
      const source = screenSource[file] ?? ''
      // The declaration is on the typed slot contract, so it is one line per screen and
      // the shell renders the single visible note. `data-sample` and `c-sample-note` are
      // also accepted so a screen that needs the marker inline is not forced through
      // the contract.
const declares = /sample: \s*'/.test(source) || /data-sample=/.test(source)
      const visible = /c-sample-note/.test(source)
      expect(declares || visible,
        `${file} still renders invented content but never says so. Add data-sample to the ` +
        'element wrapping it, or bind the screen to its projection.').toBe(true)
    })
  }
})

describe('screens that do read a projection are not caught by the sample rules', () => {
  it('Home, Settings and Mind take a snapshot, so they are not sample screens', () => {
    // If this ever fails, the sample-screen rules no longer describe the codebase and
    // the honest response is to move the screen, not to widen the patterns.
    expect(SAMPLE_SCREENS).not.toContain('Home.tsx')
    expect(SAMPLE_SCREENS).not.toContain('Settings.tsx')
    expect(SAMPLE_SCREENS).not.toContain('Mind.tsx')
    expect(screenSource['Home.tsx']).toMatch(/snapshot/)
    expect(screenSource['Settings.tsx']).toMatch(/snapshot/)
    expect(screenSource['Mind.tsx']).toMatch(/snapshot/)
  })
})
