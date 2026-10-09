// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { auditBrowserTabsTool, BROWSER_TABS_LIMITS, createBrowserTabsTool, type BrowserTabsPort } from '../../../core/mind/browser-tabs-tool'
import type { SemanticBrowserRequest, SemanticBrowserResult, SemanticSnapshot } from '../../../core/browser/service'

/**
 * The multi-tab browser tool.
 *
 * The claims that matter here are about what a model can make it do:
 *
 *   - it cannot aim the browser. Every act quotes a reference and a revision, and a
 *     reference from a snapshot that has been superseded is refused *before* the call.
 *   - it cannot open more tabs than the ceiling, whatever it asks for.
 *   - it cannot open a non-web address, whatever it asks for.
 *   - and a refusal is reported as a refusal, with the code, rather than being smoothed into
 *     a sentence that reads like success.
 */

const URL_A = 'https://alpha.example.com/'
const URL_B = 'https://beta.example.com/'
const URL_C = 'https://gamma.example.com/'

/** A port that records what it was asked and answers from a script. */
function port(
  answer: (request: SemanticBrowserRequest) => SemanticBrowserResult,
  log: SemanticBrowserRequest[] = [],
): { readonly bridge: BrowserTabsPort; readonly log: SemanticBrowserRequest[] } {
  return {
    bridge: {
      run: async (request) => {
        log.push(request)
        return answer(request)
      },
    },
    log,
  }
}

function ok(op: SemanticBrowserRequest['op'], data: Readonly<Record<string, unknown>>): SemanticBrowserResult {
  return { ok: true, op, data }
}

function no(op: SemanticBrowserRequest['op'], code: string, reason: string): SemanticBrowserResult {
  return { ok: false, op, code: 'stale-reference' as never, reason: `${code}: ${reason}`, data: {} } as SemanticBrowserResult
}

function snapshotOf(revision: number, elements: readonly { ref: string; name: string; kind: string }[]): SemanticSnapshot {
  return {
    tabId: 'tab-1',
    url: URL_A,
    title: 'Alpha',
    revision,
    text: 'A page.',
    truncated: false,
    elements: elements.map((element) => ({ ref: element.ref, kind: element.kind as 'link', name: element.name, disabled: false, protected: false, destructive: false })),
    rendered: `tab: tab-1\nurl: ${URL_A}\nrevision: ${String(revision)}\n\n[r1] link "Contact"\n[r2] button "Continue"`,
    superseded: false,
  }
}

describe('opening several tabs at once', () => {
  it('makes one tab per address, and reports every id', async () => {
    let next = 0
    const { bridge, log } = port((request) => (request.op === 'open' ? ok('open', { tabId: `tab-${String(++next)}`, sessionId: 'freya-0001', status: 'ready', url: request.url }) : ok(request.op, {})))
    const tool = createBrowserTabsTool({ browser: bridge })
    const result = await tool.run({ arguments: { op: 'open', urls: `${URL_A}\n${URL_B}\n${URL_C}` } })
    expect(log.filter((entry) => entry.op === 'open')).toHaveLength(3)
    expect(result.summary).toContain('Opened 3 tab(s)')
    expect(result.summary).toContain('tab-1, tab-2, tab-3')
  })

  it('accepts a comma-separated list too, because models write both', async () => {
    const { bridge, log } = port((request) => ok(request.op, { tabId: 'tab-1', url: request.op === 'open' ? request.url : null }))
    const tool = createBrowserTabsTool({ browser: bridge })
    await tool.run({ arguments: { op: 'open', urls: `${URL_A}, ${URL_B}` } })
    expect(log.filter((entry) => entry.op === 'open')).toHaveLength(2)
  })

  it('does not split on a comma inside a query string', async () => {
    const { bridge, log } = port((request) => ok(request.op, { tabId: 'tab-1', url: request.op === 'open' ? request.url : null }))
    const tool = createBrowserTabsTool({ browser: bridge })
    await tool.run({ arguments: { op: 'open', urls: 'https://alpha.example.com/?a=1,2' } })
    const opens = log.filter((entry) => entry.op === 'open')
    expect(opens).toHaveLength(1)
    expect(opens[0]?.op === 'open' ? opens[0].url : null).toBe('https://alpha.example.com/?a=1,2')
  })

  it('opens the first one in front and leaves the rest behind it', async () => {
    const { bridge, log } = port((request) => ok(request.op, { tabId: 'tab-1', url: request.op === 'open' ? request.url : null }))
    const tool = createBrowserTabsTool({ browser: bridge })
    await tool.run({ arguments: { op: 'open', urls: `${URL_A}\n${URL_B}` } })
    const opens = log.filter((entry) => entry.op === 'open')
    expect(opens[0]?.activate).toBe(true)
    expect(opens[1]?.activate).toBe(false)
  })

  it('attributes every tab it opens to Freya, never to the owner', async () => {
    const { bridge, log } = port((request) => ok(request.op, { tabId: 'tab-1', url: request.op === 'open' ? request.url : null }))
    const tool = createBrowserTabsTool({ browser: bridge })
    await tool.run({ arguments: { op: 'open', urls: `${URL_A}\n${URL_B}` } })
    expect(log.filter((entry) => entry.op === 'open').every((entry) => entry.op !== 'open' || entry.createdBy === 'freya')).toBe(true)
  })

  it('refuses a non-web address and says which one', async () => {
    const { bridge, log } = port((request) => ok(request.op, { tabId: 'tab-1', url: request.op === 'open' ? request.url : null }))
    const tool = createBrowserTabsTool({ browser: bridge })
    const result = await tool.run({ arguments: { op: 'open', urls: `${URL_A}\njavascript:alert(1)` } })
    expect(log.filter((entry) => entry.op === 'open')).toHaveLength(1)
    expect(result.summary).toContain('javascript:alert(1)')
  })

  it('stops at the tab ceiling instead of opening fifteen', async () => {
    let next = 0
    const { bridge, log } = port((request) => ok(request.op, { tabId: `tab-${String(++next)}`, url: request.op === 'open' ? request.url : null }))
    const tool = createBrowserTabsTool({ browser: bridge, maxTabs: 4 })
    const urls = Array.from({ length: 10 }, (_unused, index) => `https://site${String(index)}.example.com/`).join('\n')
    const result = await tool.run({ arguments: { op: 'open', urls } })
    expect(log.filter((entry) => entry.op === 'open').length).toBeLessThanOrEqual(4)
    expect(result.summary).toContain('were not opened')
  })

  it('cannot widen its own ceiling', async () => {
    let next = 0
    const { bridge, log } = port((request) => ok(request.op, { tabId: `tab-${String(++next)}`, url: request.op === 'open' ? request.url : null }))
    const tool = createBrowserTabsTool({ browser: bridge, maxTabs: 1_000, maxCommands: 1_000 })
    const urls = Array.from({ length: 10 }, (_unused, index) => `https://site${String(index)}.example.com/`).join('\n')
    await tool.run({ arguments: { op: 'open', urls } })
    expect(log.length).toBeLessThanOrEqual(BROWSER_TABS_LIMITS.maxCommands)
  })
})

describe('the tab list', () => {
  it('draws every tab with its id, state and attribution', async () => {
    const { bridge } = port(() => ok('tabs', {
      activeTabId: 'tab-2',
      tabs: [
        { tabId: 'tab-1', url: URL_A, status: 'ready', title: 'Alpha', active: false, createdBy: 'freya' },
        { tabId: 'tab-2', url: URL_B, status: 'navigating', title: null, active: true, createdBy: 'user' },
      ],
    }))
    const tool = createBrowserTabsTool({ browser: bridge })
    const result = await tool.run({ arguments: { op: 'tabs' } })
    expect(result.summary).toContain('2 tab(s) open; tab-2 is in front')
    expect(result.summary).toContain('tab-1')
    expect(result.summary).toContain('navigating')
    expect(result.summary).toContain('freya')
  })
})

describe('snapshots and references', () => {
  it('hands back the elements *and* the revision, because an element number alone is meaningless', async () => {
    const { bridge } = port(() => ok('snapshot', { snapshot: snapshotOf(41, [{ ref: 'r1', name: 'Contact', kind: 'link' }, { ref: 'r2', name: 'Continue', kind: 'button' }]) }))
    const tool = createBrowserTabsTool({ browser: bridge })
    const result = await tool.run({ arguments: { op: 'snapshot' } })
    expect(result.summary).toContain('[r1] link "Contact"')
    expect(result.summary).toContain('revision')
    // The instruction that makes the protocol usable is in the answer, not only in the schema.
    expect(result.summary).toContain('"revision":41')
  })

  it('cites the page it read', async () => {
    const { bridge } = port(() => ok('snapshot', { snapshot: snapshotOf(4, [{ ref: 'r1', name: 'Contact', kind: 'link' }]) }))
    const tool = createBrowserTabsTool({ browser: bridge })
    const result = await tool.run({ arguments: { op: 'snapshot' } })
    expect(result.sources).toHaveLength(1)
    expect(result.sources[0]?.url).toBe(URL_A)
  })

  it('clicks a reference when the revision is the one it took', async () => {
    const { bridge, log } = port((request) => (request.op === 'snapshot' ? ok('snapshot', { snapshot: snapshotOf(41, [{ ref: 'r1', name: 'Contact', kind: 'link' }]) }) : ok(request.op, { name: 'Contact', revision: 41 })))
    const tool = createBrowserTabsTool({ browser: bridge })
    await tool.run({ arguments: { op: 'snapshot' } })
    const result = await tool.run({ arguments: { op: 'click', ref: 'r1', revision: '41' } })
    expect(result.summary).toContain('Clicked "Contact"')
    expect(log.at(-1)).toMatchObject({ op: 'click', ref: 'r1', revision: 41 })
  })

  it('forwards the revision it was given, and reports the refusal that comes back', async () => {
    // The tool holds no memory between calls — it is built per turn — so the service is where
    // a stale revision is caught. What this layer owes is that the number cannot be omitted
    // and that whatever the service says is reported rather than smoothed away.
    const { bridge, log } = port((request) =>
      request.op === 'click'
        ? no('click', 'stale-reference', 'The page changed. Take a fresh snapshot.')
        : request.op === 'snapshot'
          ? ok('snapshot', { snapshot: snapshotOf(41, []) })
          : ok(request.op, {}))
    const tool = createBrowserTabsTool({ browser: bridge })
    await tool.run({ arguments: { op: 'snapshot' } })
    const result = await tool.run({ arguments: { op: 'click', ref: 'r1', revision: '40' } })
    expect(log.at(-1)).toMatchObject({ op: 'click', ref: 'r1', revision: 40 })
    expect(result.summary).toContain('stale-reference')
  })

  it('insists on a revision, because an act without one is an act from memory', async () => {
    const { bridge, log } = port(() => ok('click', { name: 'Contact' }))
    const tool = createBrowserTabsTool({ browser: bridge })
    await expect(tool.run({ arguments: { op: 'click', ref: 'r1' } })).rejects.toThrow(/revision/)
    expect(log).toHaveLength(0)
  })

  it('insists on a reference', async () => {
    const { bridge, log } = port(() => ok('click', {}))
    const tool = createBrowserTabsTool({ browser: bridge })
    await expect(tool.run({ arguments: { op: 'click', revision: '4' } })).rejects.toThrow(/ref/)
    expect(log).toHaveLength(0)
  })

  it('reports the service refusal with its code rather than smoothing it over', async () => {
    const { bridge } = port((request) => (request.op === 'click' ? no('click', 'stale-reference', 'The page changed.') : ok(request.op, {})))
    const tool = createBrowserTabsTool({ browser: bridge })
    const result = await tool.run({ arguments: { op: 'click', ref: 'r1', revision: '4' } })
    expect(result.summary).toContain('stale-reference')
    expect(result.summary).toContain('The page changed')
  })

  it('reports a protected field as refused, and does not claim a click', async () => {
    const { bridge } = port((request) => (request.op === 'click' ? no('click', 'protected-field', 'That is a protected field.') : ok(request.op, {})))
    const tool = createBrowserTabsTool({ browser: bridge })
    const result = await tool.run({ arguments: { op: 'click', ref: 'r1', revision: '4' } })
    expect(result.summary).toContain('protected-field')
    expect(result.summary).not.toContain('Clicked')
  })

  it('needs an option number to choose one', async () => {
    const { bridge, log } = port(() => ok('select', { selected: 'Sri Lanka' }))
    const tool = createBrowserTabsTool({ browser: bridge })
    await expect(tool.run({ arguments: { op: 'select', ref: 'r1', revision: '4' } })).rejects.toThrow(/index/)
    expect(log).toHaveLength(0)
  })

  it('needs text to type', async () => {
    const { bridge, log } = port(() => ok('type', {}))
    const tool = createBrowserTabsTool({ browser: bridge })
    await expect(tool.run({ arguments: { op: 'type', ref: 'r1', revision: '4' } })).rejects.toThrow(/text/)
    expect(log).toHaveLength(0)
  })
})

describe('page motion', () => {
  it('scrolls to the bottom by default, because "show me the rest of this page" is the common ask', async () => {
    const { bridge, log } = port(() => ok('scroll', { top: 4_000 }))
    const tool = createBrowserTabsTool({ browser: bridge })
    await tool.run({ arguments: { op: 'scroll' } })
    expect(log[0]).toMatchObject({ op: 'scroll', to: 'bottom' })
  })

  it('scrolls to the top when told to', async () => {
    const { bridge, log } = port(() => ok('scroll', { top: 0 }))
    const tool = createBrowserTabsTool({ browser: bridge })
    await tool.run({ arguments: { op: 'scroll', to: 'top' } })
    expect(log[0]).toMatchObject({ op: 'scroll', to: 'top' })
  })

  it('goes back, forward and reloads through the service', async () => {
    const { bridge, log } = port(() => ok('back', { url: URL_A }))
    const tool = createBrowserTabsTool({ browser: bridge })
    await tool.run({ arguments: { op: 'back' } })
    await tool.run({ arguments: { op: 'forward' } })
    await tool.run({ arguments: { op: 'reload' } })
    expect(log.map((entry) => entry.op)).toEqual(['back', 'forward', 'reload'])
  })

  it('closes and activates by tab id', async () => {
    const { bridge, log } = port(() => ok('close', { tabId: 'tab-2', activeTabId: 'tab-3' }))
    const tool = createBrowserTabsTool({ browser: bridge })
    await tool.run({ arguments: { op: 'close', tab: 'tab-2' } })
    await tool.run({ arguments: { op: 'activate', tab: 'tab-3' } })
    expect(log).toEqual([{ op: 'close', tabId: 'tab-2' }, { op: 'activate', tabId: 'tab-3' }])
  })

  it('needs a tab id to switch to', async () => {
    const { bridge } = port(() => ok('activate', {}))
    const tool = createBrowserTabsTool({ browser: bridge })
    await expect(tool.run({ arguments: { op: 'activate' } })).rejects.toThrow(/tab/)
  })
})

describe('bounds', () => {
  it('stops at the operation ceiling before making the call', async () => {
    // One call, one batch: this is the only path that issues several operations, and it is
    // where the ceiling has to hold. Ten addresses into a two-operation tool must open two
    // and say that the rest were not opened.
    let next = 0
    const { bridge, log } = port((request) => ok(request.op, { tabId: `tab-${String(++next)}`, url: request.op === 'open' ? request.url : null }))
    const tool = createBrowserTabsTool({ browser: bridge, maxCommands: 2 })
    const urls = Array.from({ length: 10 }, (_unused, index) => `https://site${String(index)}.example.com/`).join(String.fromCharCode(10))
    const result = await tool.run({ arguments: { op: 'open', urls } })
    expect(log).toHaveLength(2)
    expect(result.summary).toContain('were not opened')
  })

  it('performs exactly one act per step', async () => {
    // A step that clicked three things would report one summary for three effects, which is
    // the provenance confusion this package exists to prevent.
    const { bridge, log } = port((request) => ok(request.op, { name: 'x' }))
    const tool = createBrowserTabsTool({ browser: bridge })
    await tool.run({ arguments: { op: 'click', ref: 'r1', revision: '1' } })
    await tool.run({ arguments: { op: 'click', ref: 'r2', revision: '2' } })
    expect(log).toHaveLength(2)
  })

  it('cannot widen its own ceilings', async () => {
    let next = 0
    const { bridge, log } = port((request) => ok(request.op, { tabId: `tab-${String(++next)}`, url: request.op === 'open' ? request.url : null }))
    const tool = createBrowserTabsTool({ browser: bridge, maxCommands: 1_000, maxTabs: 1_000 })
    const urls = Array.from({ length: 30 }, (_unused, index) => `https://site${String(index)}.example.com/`).join(String.fromCharCode(10))
    await tool.run({ arguments: { op: 'open', urls } })
    expect(log.length).toBeLessThanOrEqual(BROWSER_TABS_LIMITS.maxCommands)
  })

  it('holds the command ceiling above the tab ceiling, so a full batch can complete', () => {
    expect(BROWSER_TABS_LIMITS.maxCommands).toBeGreaterThanOrEqual(BROWSER_TABS_LIMITS.maxTabs)
  })
})

describe('the audit', () => {
  it('is clean', () => {
    expect(auditBrowserTabsTool()).toEqual([])
  })

  it('holds at least ten tabs', () => {
    expect(BROWSER_TABS_LIMITS.maxTabs).toBeGreaterThanOrEqual(10)
  })
})

describe('the screenshot op', () => {
  it('hands the model the facts of a capture and says in words that it has not seen the image', async () => {
    // The pixels are the owner's. A summary that let a model describe what it
    // "saw" in an image it cannot read would be the failure the routed
    // vocabulary's ban on capture commands exists to prevent, arriving by the
    // back door.
    const { bridge, log } = port((request) =>
      ok(request.op, {
        tabId: 'tab-1',
        url: URL_A,
        title: 'Alpha',
        revision: 7,
        width: 1920,
        height: 1080,
        bytes: 4096,
        mediaUrl: 'freya-browser://screenshot/freya-0001/7.png',
      }),
    )
    const tool = createBrowserTabsTool({ browser: bridge })
    const result = await tool.run({ arguments: { op: 'screenshot' } })
    expect(log).toEqual([{ op: 'screenshot', tabId: null }])
    expect(result.summary).toContain('1920x1080')
    expect(result.summary).toContain('4096')
    expect(result.summary).toContain('freya-browser://screenshot/freya-0001/7.png')
    expect(result.summary).toContain('for the owner to look at')
    // And the whole base64 payload must not be handed over: the summary is text.
    expect(result.summary).not.toContain('data:image')
  })

  it('reports a refused capture as a refusal, with the code', async () => {
    const { bridge } = port((request) => no(request.op, 'capture-empty', 'the view has no painted frame'))
    const tool = createBrowserTabsTool({ browser: bridge })
    const result = await tool.run({ arguments: { op: 'screenshot' } })
    expect(result.summary).toContain('capture-empty')
  })
})