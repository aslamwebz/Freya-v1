// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EventFabric } from '../../../core/events/fabric'
import type { EventStore } from '../../../core/events/store'
import type { AnyCoreEvent } from '../../../core/events/envelope'
import { MemoryConversationStore } from '../../../core/conversation/memory-store'
import { ModelGateway, type GatewayRecorder } from '../../../core/model/gateway'
import type { ModelProvider, ModelRequest, ModelResult } from '../../../core/model/provider'
import { MindService } from '../../../core/mind/mind'
import {
  BROWSER_PORT_NAMES,
  BROWSER_TASK_CAPABILITY,
  BROWSER_TASK_LIMITS,
  createBrowserTaskTool,
  type BrowserTaskPort,
} from '../../../core/mind/browser-tool'
import {
  EXTRACT_CUT_MARKER,
  MIND_TOOL_LIMITS,
  MindToolRegistry,
  createWebSearchTool,
  renderObservation,
  renderToolFooter,
  type MindTool,
  type ToolObservation,
} from '../../../core/mind/tools'
import { DefaultGuard } from '../../../core/security/guard'
import type { Guard, Principal } from '../../../core/security/guard'
import type { OwnerAuthority } from '../../../core/authority'
import { CognitionService } from '../../../core/cognition/service'
import { initialCoreState } from '../../../core/state'
import { CONVERSATION_LIMITS } from '../../../core/conversation/types'
import type { Capability } from '../../../core/protocol/core-protocol'
import type { BrowserRequest, BrowserResult } from '../../../core/browser'
import { harness as dualBrowser } from '../browser/harness'

/**
 * The Mind's browser task tool.
 *
 * Every test here names one property, and the properties are the ones the spec makes
 * non-negotiable:
 *
 *   - the body runs **only** after a Guard evaluation, and only for `browser.read`;
 *   - a denial reaches nothing;
 *   - the observation names **which browser answered**, so a test can prove the answer was
 *     serviced by the native/public Freya Browser and not by the paired Chrome extension;
 *   - a step that read text is reported as a read, never as a click;
 *   - cancellation and the stop latch both bite **between** commands, and the window is
 *     closed either way;
 *   - everything that comes back is bounded, provenance-bearing and quotable.
 *
 * ## How the backend-identity claim is actually proved
 *
 * Two directions, because one alone would prove nothing:
 *
 *   1. **Against the real runtime.** `tests/core/browser/harness.ts` builds the actual
 *      `createDualBrowserRuntime` over the actual `createFreyaBrowserAdapter`, so the tool
 *      drives real routing, the real URL policy and the real Device Hands gate calls. The
 *      assertion is on what came back — and it holds with the extension paired, live and
 *      `autoEscalate` switched on, which is the configuration in which a silent fallback
 *      would show up if one existed.
 *   2. **Against a port that genuinely answers `authenticated`.** Without this, the first
 *      test cannot tell "the runtime said public" from "the tool printed public". Here the
 *      observation says the extension served it, so the field is a reading and not a label.
 */

const T0 = new Date('2026-07-01T09:00:00.000Z')
const CONVERSATION_ID = 'c1'
const PAGE = 'https://example.org/article'

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-mind-browser-tool-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/* ------------------------------------------------------------------- plumbing */

function ownerHolding(...capabilities: Capability[]): Principal {
  return { id: 'owner', capabilities: new Set(capabilities), trusted: true }
}

interface RegistryOptions {
  readonly tool: MindTool
  readonly holding?: readonly Capability[]
  readonly guard?: Guard
  readonly stopped?: () => boolean
}

/**
 * A registry around one tool, which is the only place a Guard verdict is ever made.
 *
 * Deliberately smaller than the full Mind harness: most of what these tests are about
 * happens at `MindToolRegistry.invoke`, and going through a real turn to prove that a
 * denial stops a body would only add a provider to the assertion. The whole-turn cases at
 * the bottom of this file use the real Mind.
 */
function registry(options: RegistryOptions) {
  const calls: { principal: Principal['id']; capability: Capability }[] = []
  const policy = options.guard ?? new DefaultGuard()
  const guard: Guard = {
    evaluate(principal, capability) {
      calls.push({ principal: principal.id, capability })
      return policy.evaluate(principal, capability)
    },
    holds(principal, capability) {
      return policy.holds(principal, capability)
    },
  }
  return {
    calls,
    registry: new MindToolRegistry({
      tools: [options.tool],
      guard,
      principal: ownerHolding(...(options.holding ?? [options.tool.capability])),
      stopped: options.stopped ?? (() => false),
    }),
  }
}

const DESCRIBED = {
  pageId: 'page-freya-0001',
  revision: 1,
  url: PAGE,
  title: 'The official page',
  truncated: false,
  elements: [
    { ref: 'r1-a', kind: 'heading', label: 'The official page', selector: 'h1', protected: false, disabled: false },
    { ref: 'r1-b', kind: 'text', label: 'It says the thing the owner asked about.', selector: '#main', protected: false, disabled: false },
    { ref: 'r1-c', kind: 'field', label: 'Search', selector: '#q', protected: false, disabled: false },
  ],
}

/** A port that answers with a scripted result per command, and records what it was asked. */
function scriptedPort(
  answers: Partial<Record<string, BrowserResult>> = {},
  onExecute: (request: BrowserRequest, issued: number) => void = () => {},
): BrowserTaskPort & { readonly requests: BrowserRequest[] } {
  const requests: BrowserRequest[] = []
  return {
    requests,
    async execute(request) {
      requests.push(request)
      onExecute(request, requests.length)
      const scripted = answers[request.command]
      if (scripted !== undefined) return scripted
      if (request.command === 'session.open') {
        return { ok: true, command: 'session.open', target: 'public', escalation: null, data: { sessionId: 'freya-0001' } }
      }
      if (request.command === 'page.navigate') {
        return {
          ok: true,
          command: 'page.navigate',
          target: 'public',
          escalation: null,
          data: { url: request.url ?? '', revision: 1, title: null },
        }
      }
      if (request.command === 'page.describe') {
        return { ok: true, command: 'page.describe', target: 'public', escalation: null, data: DESCRIBED }
      }
      if (request.command === 'session.close') {
        return { ok: true, command: 'session.close', target: 'public', escalation: null, data: { sessionId: 'freya-0001', alreadyClosed: false } }
      }
      return {
        ok: false,
        command: request.command,
        target: 'public',
        code: 'request-malformed',
        reason: `no scripted answer for ${request.command}`,
        escalation: null,
      }
    },
  }
}

function browserTool(port: BrowserTaskPort, over: { maxCommands?: number } = {}): MindTool {
  return createBrowserTaskTool({ browser: port, now: () => T0, ...over })
}

const toolCall = (name: string, args: Record<string, string>): string =>
  `FREYA_TOOL_CALL\n${JSON.stringify({ tool: name, ...args })}\nFREYA_TOOL_CALL_END`

function okOf(invocation: { observation: ToolObservation }): Extract<ToolObservation, { kind: 'ok' }> {
  if (invocation.observation.kind !== 'ok') {
    throw new Error(`expected an ok observation, got ${invocation.observation.kind}: ${invocation.observation.reason}`)
  }
  return invocation.observation
}

function refusedWith(observation: ToolObservation): string {
  if (observation.kind === 'ok') throw new Error('expected a refusal, got ok')
  return observation.reason
}

/* ------------------------------------------------------------- the capability */

describe('the capability the browser task tool names', () => {
  it('is browser.read, and nothing else', () => {
    expect(BROWSER_TASK_CAPABILITY).toBe('browser.read')
    expect(browserTool(scriptedPort()).capability).toBe('browser.read')
  })

  it('declares no parameter that could name a click, a keystroke or a search', () => {
    // Structural rather than instructional: `page.click` is `browser.click`, an `act`
    // command needing a different capability, so the only way this tool could ever click
    // is if somebody added a parameter for it. There isn't one.
    const tool = browserTool(scriptedPort())
    expect(tool.parameters.map((parameter) => parameter.name)).toEqual(['url', 'section'])
    for (const parameter of tool.parameters) {
      expect(parameter.name).not.toMatch(/click|type|press|submit|login|signin|search|query/i)
    }
  })
})

/* ------------------------------------------------------------------- the gate */

describe('a browser task under the registry Gate', () => {
  it('evaluates browser.read against the owner before the body runs', async () => {
    const port = scriptedPort()
    const { registry: reg, calls } = registry({ tool: browserTool(port) })

    const invocation = await reg.invoke({ name: 'browser_read', arguments: { url: PAGE } })

    expect(calls).toEqual([{ principal: 'owner', capability: 'browser.read' }])
    expect(okOf(invocation).capability).toBe('browser.read')
    expect(port.requests.length).toBeGreaterThan(0)
  })

  it('never reaches the browser when Guard denies browser.read', async () => {
    const port = scriptedPort()
    const { registry: reg, calls } = registry({ tool: browserTool(port), holding: ['search.web'] })

    const invocation = await reg.invoke({ name: 'browser_read', arguments: { url: PAGE } })

    expect(calls).toEqual([{ principal: 'owner', capability: 'browser.read' }])
    expect(invocation.executed).toBe(false)
    expect(invocation.observation.kind).toBe('denied')
    if (invocation.observation.kind === 'denied') {
      expect(invocation.observation.capability).toBe('browser.read')
    }
    // The assertion that matters: not one command reached the runtime.
    expect(port.requests).toEqual([])
  })

  it('is refused when the principal is untrusted, whatever it claims to hold', async () => {
    const port = scriptedPort()
    const reg = new MindToolRegistry({
      tools: [browserTool(port)],
      guard: new DefaultGuard(),
      // The literal the guard module's own comment describes: trusted is a property of the
      // principal, not of the capability set somebody wrote down.
      principal: { id: 'owner', capabilities: new Set<Capability>(['browser.read']), trusted: false },
      stopped: () => false,
    })

    const invocation = await reg.invoke({ name: 'browser_read', arguments: { url: PAGE } })

    expect(invocation.observation.kind).toBe('denied')
    expect(port.requests).toEqual([])
  })
})

/* ------------------------------------------------------- which backend answered */

describe('which browser actually answered', () => {
  it('names the native/public Freya browser when the public port served it', async () => {
    const { registry: reg } = registry({ tool: browserTool(scriptedPort()) })

    const observation = okOf(await reg.invoke({ name: 'browser_read', arguments: { url: PAGE } }))

    expect(observation.provenance?.actor).toBe('native/public Freya browser')
    expect(observation.provenance?.actor).toBe(BROWSER_PORT_NAMES.public)
    expect(renderObservation(observation).content).toContain('native/public Freya browser')
    // A person reading the transcript learns it too.
    expect(
      renderToolFooter(
        [{ index: 1, tool: 'browser_read', capability: 'browser.read', outcome: 'ok', executed: true, sourceCount: 1 }],
        [observation],
      ),
    ).toContain('native/public Freya browser')
  })

  it('reports the paired Chrome extension when that is genuinely what answered', async () => {
    // The mirror image, and the reason the first test is worth anything: the actor is a
    // reading of the runtime's answer, not a constant this module prints. Every command
    // here answers `authenticated`, so nothing public leaks into the report.
    const onExtension = { ok: true, target: 'authenticated', escalation: null } as const
    const port = scriptedPort({
      'session.open': { ...onExtension, command: 'session.open', data: { sessionId: 'ext-0001' } },
      'session.close': { ...onExtension, command: 'session.close', data: { sessionId: 'ext-0001', alreadyClosed: false } },
      'page.navigate': { ...onExtension, command: 'page.navigate', data: { url: PAGE, revision: 1, title: null } },
      'page.describe': {
        ...onExtension,
        command: 'page.describe',
        data: { ...DESCRIBED, elements: [] },
      },
    })
    const { registry: reg } = registry({ tool: browserTool(port) })

    const observation = okOf(await reg.invoke({ name: 'browser_read', arguments: { url: PAGE } }))

    expect(observation.provenance?.actor).toBe('paired Chrome extension')
    expect(JSON.stringify(observation)).not.toContain('native/public Freya browser')
  })

  it('reports no actor at all when no command was permitted to run', async () => {
    const port = scriptedPort({
      'page.navigate': {
        ok: false,
        command: 'page.navigate',
        target: null,
        code: 'stop-all-latched',
        reason: 'STOP ALL is latched, so no page was opened, read, clicked or handed off.',
        escalation: null,
      },
    })
    const { registry: reg } = registry({ tool: browserTool(port) })

    const invocation = await reg.invoke({ name: 'browser_read', arguments: { url: PAGE } })

    // A refusal has no actor, because nothing acted.
    expect(invocation.observation.kind).toBe('failed')
    expect(JSON.stringify(invocation.observation)).not.toContain('paired Chrome extension')
  })

  it('drives the real dual-browser runtime and is serviced by the native/public port', async () => {
    // The acceptance test. Real `createDualBrowserRuntime`, real
    // `createFreyaBrowserAdapter`, real `routeBrowserIntent`, real Device Hands gate
    // calls — nothing here mocks the layer under test.
    const instance = dualBrowser({ autoEscalate: true })
    await instance.open()
    const { registry: reg } = registry({ tool: browserTool(instance.runtime) })

    const observation = okOf(await reg.invoke({ name: 'browser_read', arguments: { url: PAGE } }))

    expect(observation.provenance?.actor).toBe('native/public Freya browser')
    expect(JSON.stringify(observation)).not.toContain('paired Chrome extension')

    // Independently: the runtime's own route record says the same thing, and every route
    // it decided was `public`.
    const routes = instance.journal.entries.filter((entry) => entry.type === 'browser.dual.route.decided')
    expect(routes.length).toBeGreaterThan(0)
    expect([...new Set(routes.map((entry) => String(entry.payload.target)))]).toEqual(['public'])

    // And the page that served it is a Freya Browser partition, not somebody's tab.
    const [partition] = [...instance.partitions.values()]
    expect(partition?.startsWith('freya-public-')).toBe(true)
    expect(instance.extension.opened).toEqual([])
  })

  it('does not reach the extension even when it is paired, live and escalation is on', async () => {
    // The forbidden backend, in the one configuration where a fallback would be permitted
    // to happen. `autoEscalate` lets the router *propose* the authenticated target; it does
    // not apply it, and this tool never asks it to.
    const instance = dualBrowser({ autoEscalate: true })
    await instance.open()
    instance.extension.paired = true
    instance.extension.live = true
    instance.extension.sharedTabId = 7
    const { registry: reg } = registry({ tool: browserTool(instance.runtime) })

    const observation = okOf(await reg.invoke({ name: 'browser_read', arguments: { url: PAGE } }))

    expect(observation.provenance?.actor).toBe('native/public Freya browser')
    expect(instance.extension.opened).toEqual([])
  })

  it('is refused by the runtime itself when Device Hands will not perform the read', async () => {
    // The second of the two authority checks, exercised end to end: the registry allowed
    // `browser.read`, and the runtime still refused because the gate chain said no. Both
    // checks are real, and both are kept.
    const instance = dualBrowser({ authority: { allow: [] } })
    await instance.open()
    const { registry: reg } = registry({ tool: browserTool(instance.runtime) })

    const invocation = await reg.invoke({ name: 'browser_read', arguments: { url: PAGE } })

    expect(invocation.observation.kind).toBe('failed')
    expect(refusedWith(invocation.observation)).toContain('authority-refused')
    // The session opened, then the very first gated action was refused and never reached
    // the page.
    expect(instance.authority.actionKeys).toEqual(['browser.navigate'])
    expect(instance.page().calls.filter((call) => call.startsWith('navigate:'))).toEqual([])
  })

  it('routes both a navigation and a read through the same browser.read-text gate', async () => {
    const instance = dualBrowser()
    await instance.open()
    const { registry: reg } = registry({ tool: browserTool(instance.runtime) })

    await reg.invoke({ name: 'browser_read', arguments: { url: PAGE } })

    // `BROWSER_COMMAND_ACTION`: page.navigate → browser.navigate, page.describe →
    // browser.read-text. The same gates the extension uses, on the public port.
    expect(instance.authority.actionKeys).toEqual(['browser.navigate', 'browser.read-text'])
  })
})

/* ------------------------------------------------------------ fetched vs drove */

describe('reporting what was done rather than what was intended', () => {
  it('reports a page that was read and not driven as a read', async () => {
    const { registry: reg } = registry({ tool: browserTool(scriptedPort()) })

    const observation = okOf(await reg.invoke({ name: 'browser_read', arguments: { url: PAGE } }))
    const report = renderObservation(observation).content

    // The read is described as a read, in the words the spec asks for.
    expect(observation.summary).toContain('read the page as it rendered')
    expect(observation.summary).toContain('Nothing was clicked, typed, submitted or logged into')

    // And nowhere does the report claim a click, a keystroke or a submission.
    for (const line of observation.provenance?.steps ?? []) {
      expect(line).not.toMatch(/click|typed|submitted|logged in/i)
    }
    expect(report).not.toMatch(/it clicked|clicked the|pressed|submitted the form/i)
    // The commands that were issued are named exactly, so the claim is checkable.
    const steps = observation.provenance?.steps ?? []
    expect(steps.some((line) => line.includes('page.navigate — navigated'))).toBe(true)
    expect(steps.some((line) => line.includes('page.describe — read-text'))).toBe(true)
  })

  it('distinguishes a real navigation from the read that followed it', async () => {
    const { registry: reg } = registry({ tool: browserTool(scriptedPort()) })

    const observation = okOf(await reg.invoke({ name: 'browser_read', arguments: { url: PAGE } }))

    expect(observation.provenance?.steps).toEqual([
      '1. session.open — session-opened — served by native/public Freya browser',
      '2. page.navigate — navigated — served by native/public Freya browser',
      '3. page.describe — read-text — served by native/public Freya browser',
      'session.close — closed — served by native/public Freya browser',
    ])
    expect(observation.summary).toContain('performed 1 real navigation(s)')
  })

  it('counts a second navigation when it follows a section', async () => {
    const { registry: reg } = registry({ tool: browserTool(scriptedPort()) })

    const observation = okOf(await reg.invoke({ name: 'browser_read', arguments: { url: PAGE, section: '#pricing' } }))

    expect(observation.summary).toContain('performed 2 real navigation(s)')
    // A section is a navigation to an anchor, not a click on a heading.
    const steps = observation.provenance?.steps ?? []
    expect(steps.filter((line) => line.includes(' — navigated — '))).toHaveLength(2)
    expect(steps.some((line) => /click/i.test(line))).toBe(false)
  })

  it('reports a refused command as nothing done, rather than as the effect it would have had', async () => {
    const port = scriptedPort({
      'page.describe': {
        ok: false,
        command: 'page.describe',
        target: 'public',
        code: 'authority-refused',
        reason: 'Device Hands refused this action (grant-missing): No grant covers that action.',
        escalation: null,
      },
    })
    const { registry: reg } = registry({ tool: browserTool(port) })

    const invocation = await reg.invoke({ name: 'browser_read', arguments: { url: PAGE } })

    expect(invocation.observation.kind).toBe('failed')
    // A read that did not happen is not reported as a read, and nothing is cited.
    const reason = refusedWith(invocation.observation)
    expect(reason).toContain('authority-refused')
    expect(reason).not.toContain('read-text')
    const rendered = renderObservation(invocation.observation).content
    expect(rendered).toContain('Status: FAILED')
    expect(rendered).not.toContain('page.describe — read-text')
  })

  it('refuses an address that is not http or https before the browser is asked', async () => {
    const port = scriptedPort()
    const { registry: reg } = registry({ tool: browserTool(port) })

    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'chrome://settings', 'ftp://example.org/x']) {
      expect((await reg.invoke({ name: 'browser_read', arguments: { url } })).observation.kind).toBe('failed')
    }
    expect(port.requests).toEqual([])
  })

  it('refuses a section that is really a second address', async () => {
    const port = scriptedPort()
    const { registry: reg } = registry({ tool: browserTool(port) })

    const invocation = await reg.invoke({
      name: 'browser_read',
      arguments: { url: PAGE, section: 'https://elsewhere.example/x' },
    })

    expect(invocation.observation.kind).toBe('failed')
    expect(port.requests).toEqual([])
  })

  it('lets the runtime refuse a URL the shared page policy refuses', async () => {
    // The tool checks the scheme, because it is cheap and because a scheme is not a policy.
    // Everything else — private hosts, ports, userinfo, the host allowlist — belongs to
    // `assertPublicBrowserUrl` inside the runtime, and the tool does not second-guess it.
    const instance = dualBrowser()
    await instance.open()
    const { registry: reg } = registry({ tool: browserTool(instance.runtime) })

    const invocation = await reg.invoke({ name: 'browser_read', arguments: { url: 'http://127.0.0.1:8080/' } })

    expect(invocation.observation.kind).toBe('failed')
    expect(refusedWith(invocation.observation)).toContain('url-refused')
    expect(instance.authority.actionKeys).toEqual([])
  })
})

/* ---------------------------------------------------------------- provenance */

describe('the evidence a turn can cite', () => {
  it('carries the URL actually read, the title and the domain', async () => {
    const { registry: reg } = registry({ tool: browserTool(scriptedPort()) })

    const observation = okOf(await reg.invoke({ name: 'browser_read', arguments: { url: PAGE } }))

    expect(observation.sources).toHaveLength(1)
    expect(observation.sources[0]?.url).toBe(PAGE)
    expect(observation.sources[0]?.title).toBe('The official page')
    expect(observation.sources[0]?.sourceDomain).toBe('example.org')
    expect(observation.sources[0]?.retrievedAt).toBe(T0.toISOString())
  })

  it('quotes bounded page text, and skips fields and protected elements', async () => {
    const port = scriptedPort({
      'page.describe': {
        ok: true,
        command: 'page.describe',
        target: 'public',
        escalation: null,
        data: {
          url: PAGE,
          title: 't',
          truncated: true,
          elements: [
            { ref: 'r1-a', kind: 'heading', label: 'Pricing', selector: 'h1' },
            { ref: 'r1-b', kind: 'text', label: 'The thing you asked about.', selector: '#main' },
            { ref: 'r1-c', kind: 'field', label: 'Email', selector: '#email' },
            { ref: 'r1-d', kind: 'field', label: 'Password', selector: '#pw', protected: true },
            { ref: 'r1-e', kind: 'link', label: '', selector: '#x' },
          ],
        },
      },
    })
    const { registry: reg } = registry({ tool: browserTool(port) })

    const observation = okOf(await reg.invoke({ name: 'browser_read', arguments: { url: PAGE } }))

    expect(observation.provenance?.extract).toEqual(['Pricing', 'The thing you asked about.'])
    // Nothing about a field reaches the model, protected or not.
    expect(JSON.stringify(observation)).not.toContain('Password')
    expect(JSON.stringify(observation)).not.toContain('Email')
  })

  it('bounds the extract on lines and on characters', async () => {
    const port = scriptedPort({
      'page.describe': {
        ok: true,
        command: 'page.describe',
        target: 'public',
        escalation: null,
        data: {
          url: PAGE,
          title: 't',
          truncated: true,
          elements: Array.from({ length: 400 }, (_unused, index) => ({
            ref: `r1-${String(index)}`,
            kind: 'text',
            label: `line ${String(index)} ${'x'.repeat(500)}`,
            selector: `#s${String(index)}`,
          })),
        },
      },
    })
    const { registry: reg } = registry({ tool: browserTool(port) })

    const observation = okOf(await reg.invoke({ name: 'browser_read', arguments: { url: PAGE } }))
    const extract = observation.provenance?.extract ?? []

    // The marker is a line, so the bound is on the quoted lines plus it.
    expect(extract.length).toBeLessThanOrEqual(BROWSER_TASK_LIMITS.maxExtractLines + 1)
    expect(extract.join('').length).toBeLessThanOrEqual(BROWSER_TASK_LIMITS.maxExtractChars + EXTRACT_CUT_MARKER.length)
    expect(extract.at(-1)).toBe(EXTRACT_CUT_MARKER)
  })

  it('bounds the whole observation, and says the extract was cut', async () => {
    const port = scriptedPort({
      'page.describe': {
        ok: true,
        command: 'page.describe',
        target: 'public',
        escalation: null,
        data: {
          url: PAGE,
          title: 't'.repeat(4_000),
          truncated: true,
          elements: Array.from({ length: 400 }, (_unused, index) => ({
            ref: `r1-${String(index)}`,
            kind: 'text',
            label: `line ${String(index)} ${'y'.repeat(500)}`,
            selector: `#s${String(index)}`,
          })),
        },
      },
    })
    const { registry: reg } = registry({ tool: browserTool(port) })

    const observation = okOf(await reg.invoke({ name: 'browser_read', arguments: { url: PAGE } }))
    const report = renderObservation(observation)

    expect(report.role).toBe('user')
    expect(report.content.length).toBeLessThanOrEqual(MIND_TOOL_LIMITS.maxObservationChars)
    // The cut is stated rather than silent: a truncated quote must never read as a whole one.
    expect(observation.provenance?.extract?.at(-1)).toBe(EXTRACT_CUT_MARKER)
  })

  it('bounds the number of browser commands one execution may issue', async () => {
    const port = scriptedPort()
    const { registry: reg } = registry({ tool: browserTool(port, { maxCommands: 2 }) })

    const invocation = await reg.invoke({ name: 'browser_read', arguments: { url: PAGE, section: '#pricing' } })

    // Two commands allowed: open and navigate. The anchor navigation is refused as a bound,
    // not silently dropped, and the refusal says so.
    expect(invocation.observation.kind).toBe('failed')
    expect(refusedWith(invocation.observation)).toContain('bound of 2 browser commands')
    expect(port.requests.filter((request) => request.command === 'page.navigate')).toHaveLength(1)
  })

  it('visits at most two pages, because a section is an anchor and not an address', async () => {
    const port = scriptedPort()
    const { registry: reg } = registry({ tool: browserTool(port) })

    await reg.invoke({ name: 'browser_read', arguments: { url: PAGE, section: '#pricing' } })

    const navigated = port.requests.filter((request) => request.command === 'page.navigate')
    expect(navigated.map((request) => request.url)).toEqual([PAGE, `${PAGE}#pricing`])
    for (const request of navigated) {
      expect(String(request.url).startsWith(PAGE)).toBe(true)
    }
    expect(BROWSER_TASK_LIMITS.maxPages).toBe(2)
  })
})

/* --------------------------------------------------------------- cancellation */

describe('cancellation and the stop latch, between commands', () => {
  it('stops issuing commands once the turn is cancelled, and says why', async () => {
    const controller = new AbortController()
    const port = scriptedPort({}, (_request, issued) => {
      // The owner stops the turn while the first navigation is in flight.
      if (issued === 2) controller.abort()
    })
    const { registry: reg } = registry({ tool: browserTool(port) })

    const invocation = await reg.invoke({
      name: 'browser_read',
      arguments: { url: PAGE },
      signal: controller.signal,
    })

    expect(invocation.observation.kind).toBe('failed')
    expect(refusedWith(invocation.observation)).toContain('cancelled between browser steps')
    // The describe never happened, and nothing is cited.
    expect(port.requests.some((request) => request.command === 'page.describe')).toBe(false)
  })

  it('is refused by the registry before the body runs when the turn is already cancelled', async () => {
    const port = scriptedPort()
    const { registry: reg } = registry({ tool: browserTool(port) })

    const invocation = await reg.invoke({
      name: 'browser_read',
      arguments: { url: PAGE },
      signal: AbortSignal.abort(),
    })

    expect(invocation.executed).toBe(false)
    expect(invocation.observation.kind).toBe('failed')
    expect(port.requests).toEqual([])
  })

  it('is refused by the registry when STOP ALL is latched', async () => {
    const port = scriptedPort()
    const { registry: reg } = registry({ tool: browserTool(port), stopped: () => true })

    const invocation = await reg.invoke({ name: 'browser_read', arguments: { url: PAGE } })

    expect(invocation.executed).toBe(false)
    expect(invocation.observation.kind).toBe('failed')
    expect(port.requests).toEqual([])
  })

  it('is refused by the runtime when its own STOP ALL latch is set mid-task', async () => {
    const instance = dualBrowser()
    await instance.open()
    // The latch lands as the first gated action is asked for. That navigation was already
    // authorised and already in flight, so the runtime lets it finish and refuses the next
    // command — which is the honest shape of a stop: it cannot un-navigate a page, but it
    // can refuse to read it.
    const original = instance.authority.perform.bind(instance.authority)
    instance.authority.perform = async (request) => {
      instance.authority.stopAll = true
      return original(request)
    }
    const { registry: reg } = registry({ tool: browserTool(instance.runtime) })

    const invocation = await reg.invoke({ name: 'browser_read', arguments: { url: PAGE } })

    expect(invocation.observation.kind).toBe('failed')
    expect(refusedWith(invocation.observation)).toContain('stop-all-latched')
    // The navigation that was in flight completed; the read never started. Asserted on the
    // read rather than on a navigation count, because one authorised navigation reaches the
    // page through the adapter's navigate *and* its read-back — see `openInPage` in
    // `electron/browser/publicAdapter.ts`.
    expect(instance.page().calls).not.toContain('describe')
    expect(instance.page().calls).not.toContain('read')
    expect(instance.page().calls.filter((call) => call.startsWith('navigate:')).length).toBeGreaterThan(0)
  })

  it('closes its window on the cancellation path, because a cancelled turn is not a reason to leave one open', async () => {
    const controller = new AbortController()
    const port = scriptedPort({}, (_request, issued) => {
      if (issued === 2) controller.abort()
    })
    const { registry: reg } = registry({ tool: browserTool(port) })

    await reg.invoke({ name: 'browser_read', arguments: { url: PAGE }, signal: controller.signal })

    expect(port.requests.at(-1)?.command).toBe('session.close')
  })

  it('closes the real Freya Browser session it opened', async () => {
    const instance = dualBrowser()
    await instance.open()
    const { registry: reg } = registry({ tool: browserTool(instance.runtime) })

    await reg.invoke({ name: 'browser_read', arguments: { url: PAGE } })

    expect(instance.page().closed).toBe(true)
    expect(instance.journal.types).toContain('browser.dual.session.closed')
  })
})

/* ------------------------------------------------ the composed, whole turn */

/* ------------------------------------------------------------------- harness */

function memoryEventStore(): EventStore {
  const events: AnyCoreEvent[] = []
  return {
    append: async (event: AnyCoreEvent) => {
      events.push(event)
    },
    readAll: async () => [...events],
    readAfter: async (afterSequence: number) => events.filter((e) => e.sequence > afterSequence),
    lastSequence: async () => events[events.length - 1]?.sequence ?? 0,
    describe: () => 'memory',
    close: async () => undefined,
  }
}

const silentRecorder: GatewayRecorder = {
  started: async () => undefined,
  completed: async () => undefined,
  failed: async () => undefined,
  cancelled: async () => undefined,
}

/** A provider that replays a fixed script of answers, one per call. */
class ScriptedProvider implements ModelProvider {
  readonly id = 'scripted'
  readonly kind = 'fake' as const
  readonly live = false
  calls = 0
  readonly requests: ModelRequest[] = []

  constructor(readonly script: readonly string[]) {}

  status() {
    return {
      id: this.id,
      kind: 'fake' as const,
      status: 'configured' as const,
      model: 'scripted-1',
      detail: 'A scripted provider for the Mind browser-task tests.',
      liveEnabled: false,
    }
  }

  async complete(request: ModelRequest, options: { signal: AbortSignal }): Promise<ModelResult> {
    if (options.signal.aborted) throw new Error('aborted before the provider was contacted')
    this.calls += 1
    this.requests.push(request)
    const text = this.script[Math.min(this.calls - 1, this.script.length - 1)] ?? ''
    return {
      requestId: request.requestId,
      providerId: this.id,
      model: 'scripted-1',
      text,
      inputTokens: 10,
      outputTokens: 10,
    }
  }
}

interface TurnHarnessOptions {
  readonly script: readonly string[]
  readonly browser?: BrowserTaskPort
  readonly rows?: readonly unknown[]
  readonly tools?: readonly MindTool[]
  readonly holding?: readonly Capability[]
}

/** A real Mind over a real Cognition Service, a real grant store and a scripted provider. */
async function turnHarness(options: TurnHarnessOptions) {
  const provider = new ScriptedProvider(options.script)
  const fabric = await EventFabric.open({
    store: memoryEventStore(),
    now: () => T0,
    newId: (() => {
      let n = 0
      return () => `evt-${(n += 1).toString().padStart(4, '0')}`
    })(),
  })
  const store = new MemoryConversationStore({ mode: 'memory' })
  await store.putConversation({
    conversationId: CONVERSATION_ID,
    title: 'a conversation',
    createdAt: T0.toISOString(),
    updatedAt: T0.toISOString(),
  })

  const tools: MindTool[] = [
    ...(options.tools ?? [
      createWebSearchTool({ searchWeb: async () => options.rows ?? [], now: () => T0 }),
      browserTool(options.browser ?? scriptedPort()),
    ]),
  ]
  const guard = new DefaultGuard()
  const reg = new MindToolRegistry({
    tools,
    guard,
    principal: ownerHolding(...(options.holding ?? tools.map((tool) => tool.capability))),
    stopped: () => false,
  })

  const gateway = new ModelGateway({ providers: [provider], recorder: silentRecorder, now: () => T0 })
  const cognition = new CognitionService({ fabric, gateway, guard, now: () => T0 }, initialCoreState())
  const authority: OwnerAuthority = cognition.ownerAuthority()

  const mind = new MindService({
    fabric,
    store,
    authority,
    gateway,
    now: () => T0,
    newId: (() => {
      let n = 0
      return () => `id-${(n += 1).toString().padStart(4, '0')}`
    })(),
    tools: reg,
  })

  return { mind, store, provider, grants: () => authority.grants() }
}

describe('the turn the spec describes: search, open the official result, say what it says', () => {
  it('answers a search-then-read turn inside the turn ceiling', async () => {
    // Two separately-gated capabilities rather than one tool spending twice, and a turn
    // that needs a search and a page read now has room for both plus a follow-up: the
    // ceiling is ten calls, and this uses three. The bound that matters is the money,
    // asserted below — the sum of what the calls reserved cannot exceed the ceiling.
    const h = await turnHarness({
      script: [
        toolCall('web_search', { query: 'the official page' }),
        toolCall('browser_read', { url: PAGE }),
        'The official page says the thing you asked about [1].',
      ],
      rows: [{ title: 'Official', url: PAGE, snippet: 'the thing', sourceDomain: 'example.org' }],
    })

    const outcome = await h.mind.runTurn({
      conversationId: CONVERSATION_ID,
      turnId: 't1',
      text: 'what does the official page say?',
    })

    expect(outcome.outcome).toBe('completed')
    // Search, read, answer — and then it *stopped*, which is the part worth asserting.
    // The old ceiling made this look like it had run out of room; it had simply finished.
    expect(h.provider.calls).toBe(3)
    expect(MIND_TOOL_LIMITS.maxProviderCalls).toBeGreaterThan(3)
    expect(h.grants()[0]?.maxCalls).toBe(MIND_TOOL_LIMITS.maxProviderCalls)

    // The grant's whole output allowance is the turn's ceiling, and what the three calls
    // actually reserved fits inside it. This is the invariant that a larger ceiling must
    // not quietly break: more calls, not more money.
    expect(h.grants()[0]?.maxOutputTokens).toBe(CONVERSATION_LIMITS.maxOutputTokensPerTurn)
    expect(h.grants()[0]?.usage.outputTokenBudgetReserved)
      .toBeLessThanOrEqual(CONVERSATION_LIMITS.maxOutputTokensPerTurn)

    const answer = outcome.assistantMessage?.content ?? ''
    expect(answer).toContain(PAGE)
    // The footer is the part no model can edit away: it names the tool, the source and the
    // browser that served it.
    expect(answer).toContain('Used the "browser_read" lookup')
    expect(answer).toContain('That was read through native/public Freya browser')
    expect(answer).toContain('Used the "web_search" lookup')
  })

  it('tells the model which browser served it, and what it actually did', async () => {
    const h = await turnHarness({ script: [toolCall('browser_read', { url: PAGE }), 'It says the thing [1].'] })

    await h.mind.runTurn({ conversationId: CONVERSATION_ID, turnId: 't1', text: 'open the official page' })

    const report = h.provider.requests[1]?.messages.at(-1)?.content ?? ''
    expect(report).toContain('Which browser served this: native/public Freya browser.')
    expect(report).toContain('What was actually done, in order:')
    expect(report).toContain('page.navigate — navigated')
    expect(report).toContain('page.describe — read-text')
    expect(report).toContain('Text read off that page, quoted:')
    // Labelled as untrusted data, exactly like a search report.
    expect(report).toContain('UNTRUSTED REFERENCE DATA')
    expect(h.provider.requests[1]?.messages.at(-1)?.role).toBe('user')
  })

  it('says plainly that nothing was looked up when the browser read was not permitted', async () => {
    const port = scriptedPort()
    const h = await turnHarness({
      script: [toolCall('browser_read', { url: PAGE }), 'I could not check that.'],
      tools: [browserTool(port)],
      // The owner holds `search.web` and nothing else.
      holding: ['search.web'],
    })

    const outcome = await h.mind.runTurn({
      conversationId: CONVERSATION_ID,
      turnId: 't1',
      text: 'open the official page',
    })

    expect(outcome.outcome).toBe('completed')
    expect(port.requests).toEqual([])
    const answer = outcome.assistantMessage?.content ?? ''
    expect(answer).toContain('NOT PERMITTED')
    expect(answer).toContain('Nothing in the answer above came from a search')
  })

  it('runs two lookups and then answers, rather than opening a third', async () => {
    const port = scriptedPort()
    const h = await turnHarness({
      script: [
        toolCall('browser_read', { url: PAGE }),
        toolCall('browser_read', { url: 'https://example.org/other' }),
        'Both pages opened.',
      ],
      browser: port,
    })

    const outcome = await h.mind.runTurn({ conversationId: CONVERSATION_ID, turnId: 't1', text: 'open both pages' })

    expect(outcome.outcome).toBe('completed')
    // Both executions ran and the third call produced the answer. With room left in the
    // ceiling, the reason the loop stopped is that the model answered — which is the
    // behaviour that matters, and the reason the ceiling can be raised safely.
    expect(h.provider.calls).toBe(3)
    expect(port.requests.filter((request) => request.command === 'session.open')).toHaveLength(2)
  })

  it('still stops a model that will not stop asking', async () => {
    // The other half of raising the ceiling: a bigger allowance must not mean an
    // unbounded turn. A script that only ever asks for a tool has to end, truthfully.
    const port = scriptedPort()
    const h = await turnHarness({
      script: [toolCall('browser_read', { url: PAGE })],
      browser: port,
    })

    const outcome = await h.mind.runTurn({ conversationId: CONVERSATION_ID, turnId: 't1', text: 'keep reading' })

    expect(outcome.outcome).toBe('failed')
    expect(outcome.reason).toMatch(/allowed for one turn/i)
    // Exactly the ceiling, never one more.
    expect(h.provider.calls).toBe(MIND_TOOL_LIMITS.maxProviderCalls)
  })

  it('reports honestly when a browser read is requested but the owner has no such tool', async () => {
    const h = await turnHarness({ script: ['just an answer'], tools: [] })

    const outcome = await h.mind.runTurn({ conversationId: CONVERSATION_ID, turnId: 't1', text: 'hello' })

    expect(outcome.outcome).toBe('completed')
    // No tool was offered, so no tool was named, so the loop stayed on its single call.
    expect(h.provider.calls).toBe(1)
  })
})
