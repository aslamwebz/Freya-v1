/**
 * TEST 10 — live native-browser acceptance.
 *
 * ## What this is, precisely
 *
 * A **real Electron integration acceptance harness**. It constructs the same real
 * components the app does — the public Freya Browser adapter, the Dual Browser
 * runtime, Device Hands, the Mind, the Guard and a live model provider — and runs a
 * real turn through them.
 *
 * It is *not* the full app host: `electron/coreHost.ts` and `electron/main.ts` are
 * not launched. So it exercises the real browser path end to end, but it is not a
 * claim that the shipped app composition was launched verbatim. It is narrower than
 * that on purpose, and this comment is where that narrower claim lives.
 *
 * ## Why a separate artifact
 *
 * A real browser needs `BrowserWindow`, so this cannot run under Vitest. It is
 * built by `build:chat-browser-acceptance` and run by `test:chat-browser`; it is
 * deliberately **not** part of `build:main`, so a production build never contains
 * a live-test-only binary.
 *
 * ## No extension, anywhere
 *
 * No extension host is constructed and `extension: undefined` is passed to the
 * activation. That is not a formality: it means there is no extension authority in
 * this process, so an authenticated page command could not be serviced even if the
 * router asked for one. The run refuses to start if an extension is paired, so a
 * machine with one installed cannot quietly turn this into a different test.
 *
 * The claim under test is therefore the strongest available form of "the extension
 * was not used": it was not used because it was not there.
 */

import { app } from 'electron'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'

import { createFreyaBrowserAdapter } from './browser/publicAdapter'
import { ElectronFreyaWindowFactory } from './browser/freyaWindow'
import { createDualBrowserActivation } from './browser/activation'
import { openDeviceHandsJournal } from './devicehands/journal'
import { createDeviceHandsActivation } from './devicehands/activation'
import { createDeviceHandsEffects } from './devicehands/effects'
import type { GrantFact } from '../core/devicehands'
import { normaliseSurfacePolicy } from '../core/devicehands/paths'

import { EventFabric } from '../core/events/fabric'
import type { EventStore } from '../core/events/store'
import type { AnyCoreEvent } from '../core/events/envelope'
import { MemoryConversationStore } from '../core/conversation/memory-store'
import { ModelGateway, type GatewayRecorder } from '../core/model/gateway'
import { NanoGptProvider } from '../core/model/nanogpt-provider'
import { MindService } from '../core/mind/mind'
import { createBrowserTaskTool } from '../core/mind/browser-tool'
import { createWebSearchTool, MindToolRegistry } from '../core/mind/tools'
import { SearxngSearchProvider } from '../core/research/providers/searxng'
import { Searcher } from '../core/research/searcher'
import { DefaultGuard } from '../core/security/guard'
import type { Capability } from '../core/protocol/core-protocol'
import { CognitionService } from '../core/cognition/service'
import { initialCoreState } from '../core/state'

/* --------------------------------------------------------------- reporting */

const failures: string[] = []
let passed = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1
    console.log(`  PASS  ${label}${detail === '' ? '' : ` — ${detail}`}`)
  } else {
    console.log(`  FAIL  ${label}${detail === '' ? '' : ` — ${detail}`}`)
    failures.push(label)
  }
}

function refuse(reason: string): never {
  console.error(`\n[TEST 10] REFUSED: ${reason}\n`)
  app.exit(1)
  throw new Error(reason)
}

/* ------------------------------------------------------------------ config */

function readLocalEnv(): Record<string, string> {
  const path = join(process.cwd(), '.env')
  if (!existsSync(path)) return {}
  const out: Record<string, string> = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const at = line.indexOf('=')
    if (at <= 0 || line.trimStart().startsWith('#')) continue
    out[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  return out
}

const env: Record<string, string> = { ...readLocalEnv(), ...(process.env as Record<string, string>) }

/** The owner principal and browser scope this run authorises, and nothing else. */
const PRINCIPAL = 'owner' as const
const GRANT_ID = 'test10-browser-grant'

/**
 * The identity the *browser* acts as, which is not the owner.
 *
 * Two principals are in play and conflating them is why an earlier version of this
 * harness reported `grant-missing` even after the scope matched:
 *
 *  - `owner` is the Core owner principal. The Mind's tool registry checks Guard
 *    against this one, so it is the identity the chat turn is authorised as.
 *  - `agent:freya` is the identity the Dual Browser runtime stamps on every action
 *    it performs (`core/browser/runtime.ts`, `options.principalId ?? 'agent:freya'`).
 *    Device Hands checks its grant against **this** one.
 *
 * A grant is therefore written for `agent:freya` even though the turn that triggers
 * it runs as `owner`. That is not a workaround; it is the two-check design working
 * as intended -- the registry answers "may this turn spend `browser.read`", Device
 * Hands answers "may this action, on this page, for this principal, right now".
 */
const BROWSER_PRINCIPAL = 'agent:freya'

/**
 * The one browser session this run authorises.
 *
 * Device Hands requires the grant Core reports to agree with the grant already
 * recorded in the journal on id, principal, scope, revocation, expiry, surfaces
 * and actions (`findRecordedGrant`, `core/devicehands/runtime.ts`). A mismatch is
 * `grant-missing`. So a grant cannot be registered against a placeholder scope and
 * then have its scope rewritten once the session exists -- that was the previous
 * harness's approach and it is exactly the mutation the rule exists to prevent.
 *
 * It does not need to be. The browser runtime mints session ids from a counter
 * (`core/browser/runtime.ts`: `freya-${sequence padded to 4}`), so in a runtime
 * that has not yet opened a session, the first id is exactly `freya-0001`. This
 * harness opens no session before the turn, so the grant is registered against the
 * real id, up front, through the ordinary activation path -- one principal, one
 * scope, the `browser` surface, and only the two actions the scenario performs.
 *
 * `page.click` and `page.type` are deliberately absent, so even inside Device
 * Hands there is no grant behind a click or a keystroke.
 */
const SESSION_SCOPE = 'freya-0001'

/**
 * The grant: two actions, one surface, one principal, one scope.
 *
 * Narrow on purpose. An earlier version answered `activeGrant` with a fabricated
 * always-valid fact cast through `as never`, which would have authorised any
 * principal on any surface — the opposite of what a browser-only acceptance run
 * needs to demonstrate. This one names only `browser.navigate` and
 * `browser.read-text`, so even inside Device Hands a click or a keystroke has no
 * grant behind it.
 */
function buildGrant(scope: string): GrantFact {
  // Short-lived, because the runtime caps a grant at fifteen minutes and refuses a
  // longer one rather than shortening it. A short life is also the right shape for
  // a test: this authority should not outlive the run that created it.
  const issuedAt = new Date()
  const expiresAt = new Date(issuedAt.getTime() + 10 * 60 * 1000)
  return {
    grantId: GRANT_ID,
    principalId: BROWSER_PRINCIPAL,
    scope,
    surfaces: ['browser'],
    actions: ['browser.navigate', 'browser.read-text'],
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    revokedAt: null,
  }
}

const GRANT: GrantFact = buildGrant(SESSION_SCOPE)

/**
 * The strict surface policy.
 *
 * Built through `normaliseSurfacePolicy` rather than hand-written, so it is the
 * same validation the app applies and an empty or malformed field is refused here
 * too. No `localUnrestricted`: this run must exercise the bounded public path.
 */
function buildPolicy(workspace: string) {
  const reading = normaliseSurfacePolicy({
    allowedRoots: [workspace],
    deniedRoots: [join(workspace, 'vault')],
    // Only the hosts the scenario legitimately needs. The web search itself runs
    // through the Searcher, not the browser, so the browser's host list is short
    // on purpose: a model that tries to wander somewhere else is refused.
    allowedHosts: ['laravel.com', 'www.laravel.com'],
    allowedCommands: ['echo'],
    allowedEnvNames: ['PATH'],
    maxTransferBytes: 1024,
  })
  if (!reading.ok) refuse(`the surface policy was refused: ${reading.reason}`)
  return reading.policy
}

/* --------------------------------------------------------------- the pieces */

function memoryEventStore(): EventStore {
  const events: AnyCoreEvent[] = []
  return {
    append: async (event) => { events.push(event) },
    readAll: async () => [...events],
    readAfter: async (after) => events.filter((e) => e.sequence > after),
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

async function main(): Promise<void> {
  /* --- preconditions, refused rather than worked around ---------------- */

  const apiKey = env.NANOGPT_API_KEY ?? ''
  if (apiKey === '') refuse('NANOGPT_API_KEY is not set')
  if (env.FREYA_ALLOW_LIVE_MODEL !== '1') {
    refuse('FREYA_ALLOW_LIVE_MODEL is not 1, so a live call would be refused by the provider anyway')
  }
  // An unrestricted run would prove nothing about the bounded path.
  if (env.FREYA_LOCAL_UNRESTRICTED === '1') {
    refuse('FREYA_LOCAL_UNRESTRICTED=1 would widen the browser policy and stop this being an acceptance run of the strict path')
  }
  const searxng = env.FREYA_SEARXNG_URL ?? ''
  if (searxng === '') {
    refuse('FREYA_SEARXNG_URL is not set; TEST 10 must search before it opens anything')
  }

  const workspace = mkdtempSync(join(tmpdir(), 'freya-test10-'))

  /* --- the browser ----------------------------------------------------- */

  const allowedHosts = ['laravel.com', 'www.laravel.com']
  const adapter = createFreyaBrowserAdapter({
    factory: new ElectronFreyaWindowFactory({
      allowedHosts,
      localUnrestricted: false,
      allowPrivateHosts: false,
      allowProtectedFields: false,
    }),
    publicAvailable: () => true,
    localUnrestricted: false,
  })

  /**
   * A **real** journal, on a real file, so `trustworthy()` is computed from a hash
   * chain rather than answering a constant. The previous version returned `true`
   * unconditionally and set `requireTrustworthyJournal: false` to suit — which
   * would have meant this run silently did not test journal integrity while
   * appearing to.
   */
  const journal = openDeviceHandsJournal(join(workspace, 'device-hands.jsonl'))

  /* --- Device Hands, with the real browser effect ---------------------- */

  const effects = createDeviceHandsEffects({
    browser: adapter.inPage,
    // Only the browser is live. Terminal, clipboard and transfer are refused, so
    // nothing but a page read can happen here even by accident -- and the grant
    // above does not name their actions either.
    clipboard: { readText: () => '', writeText: () => undefined, clear: () => undefined },
    terminal: {
      spawn: (() => { throw new Error('terminal is not part of TEST 10') }) as never,
      resolveExecutable: (() => { throw new Error('terminal is not part of TEST 10') }) as never,
    },
    transfer: {
      httpGet: (() => Promise.reject(new Error('transfers are not part of TEST 10'))) as never,
      httpPost: (() => Promise.reject(new Error('transfers are not part of TEST 10'))) as never,
      readFile: () => Promise.reject(new Error('transfers are not part of TEST 10')),
      writeFile: () => Promise.reject(new Error('transfers are not part of TEST 10')),
      statSize: () => Promise.reject(new Error('transfers are not part of TEST 10')),
    },
  })

  const hands = createDeviceHandsActivation({
    effects,
    journal,
    authority: {
      stopAllActive: () => false,
      enabled: () => true,
      /**
       * The narrow read. A grant is returned for the one principal and one scope
       * this run authorised, and `null` for anything else — so a request under a
       * different principal or scope is refused by the gate rather than quietly
       * served.
       */
      /**
       * The recorded grant, or nothing. It matches on the exact principal and the
       * exact session scope, and it is returned unchanged -- the same object that
       * was registered at activation -- so the journal and Core cannot disagree.
       */
      activeGrant: (principalId, scope) =>
        (principalId === BROWSER_PRINCIPAL && scope === SESSION_SCOPE ? GRANT : null),
      requestOwnerApproval: async (ask) => ({
        approvalId: ask.approvalId,
        granted: false,
        decidedBy: 'unknown',
        decidedAt: new Date().toISOString(),
        reason: 'The TEST 10 harness has no owner present to ask.',
      }),
      approvalStillValid: () => false,
    },
    now: () => new Date().toISOString(),
    newId: () => `dh-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
    localUnrestricted: false,
    // Integrity is genuinely checked, and the run depends on it.
    requireTrustworthyJournal: true,
  })
  await hands.open()
  const policy = buildPolicy(workspace)
  const handsOn = await hands.activate({ policy, grants: [GRANT] })
  if (!handsOn.ok) refuse(`Device Hands did not activate: ${handsOn.reason}`)
  console.log(`\n[TEST 10] Device Hands: ${handsOn.reason}`)

  const activation = createDualBrowserActivation({
    authority: {
      stopAllActive: () => false,
      perform: async (request) => {
        const outcome = await hands.runtime.perform({ ...request, claimsAction: null })
        return {
          performed: outcome.performed,
          verdict: outcome.verdict ?? 'failed',
          code: outcome.code,
          reason: outcome.reason,
        }
      },
    },
    journal,
    adapter,
    // **No extension.** See the file header.
    extension: undefined,
    allowedHosts,
    localUnrestricted: false,
    allowPrivateHosts: false,
    onLog: (line: string) => console.log(`  [browser] ${line}`),
  })

  const activated = await activation.activate()
  if (!activated.ok) refuse(`the Freya Browser did not activate: ${activated.reason}`)
  console.log(`[TEST 10] ${activated.reason}`)

  const status = activation.status()
  check('no Chrome extension is paired', !status.extensionPaired)
  check('no Chrome extension is live', !status.extensionLive)
  check('the public browser is available', status.publicAvailable)
  check('the journal chains and is trustworthy', status.journalTrustworthy)

  /* --- the turn: search, then open the official result, then read ------ */

  // Two tools, because the scenario has two kinds of work: a *search* over the
  // network and a *page read* in the browser. The prompt names no URL, so the
  // model has to find the official page itself rather than being handed it.
  const searcher = new Searcher({
    provider: new SearxngSearchProvider({
      env: { FREYA_SEARXNG_URL: searxng, FREYA_ALLOW_WEB_SEARCH: '1' },
    }),
  })
  const searched: string[] = []

  // Recorded from `BrowserResult` itself, which is the authoritative record of
  // which browser serviced each command. Reading it from the runtime rather than
  // from the model's prose is what makes this a proof rather than a claim.
  const visited: string[] = []
  const targets: string[] = []
  const sessionsUsed = new Set<string>()

  const provider = new NanoGptProvider({
    config: {
      apiKey,
      baseUrl: env.NANOGPT_BASE_URL ?? 'https://nano-gpt.com/api/v1',
      model: env.FREYA_ACCEPTANCE_MODEL ?? 'qwen/qwen3.8-27b-uncensored',
      liveEnabled: true,
    },
  })

  const fabric = await EventFabric.open({
    store: memoryEventStore(),
    now: () => new Date(),
    newId: (() => { let n = 0; return () => `evt-${(n += 1).toString().padStart(4, '0')}` })(),
  })
  const store = new MemoryConversationStore({ mode: 'memory' })
  await store.putConversation({
    conversationId: 'test10',
    title: 'TEST 10',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })

  const guard = new DefaultGuard()
  const registry = new MindToolRegistry({
    tools: [
      createWebSearchTool({
        now: () => new Date(),
        searchWeb: async (query, signal) => {
          searched.push(query)
          return searcher.searchWeb(query, { limit: 6, signal, vertical: 'web' })
        },
      }),
      createBrowserTaskTool({
        browser: {
          execute: async (request) => {
            if (typeof request.url === 'string' && request.url !== '') visited.push(request.url)
            const result = await activation.runtime.execute(request)
            targets.push(result.ok ? result.target : `refused:${result.code}`)
            if (!result.ok) {
              // Log the refusal in full: a bare code hides whether this was a grant
              // problem, a policy problem or a target problem, and those need
              // different fixes.
              console.log(`  [browser] REFUSED ${request.command}: ${result.code} — ${result.reason}`)
              console.log(`  [browser]   request: ${JSON.stringify({ sessionId: request.sessionId, url: request.url, ref: request.ref })}`)
            }
            // The session id is recorded, not granted: it proves the runtime opened
            // the one session the grant was registered against.
            if (typeof request.sessionId === 'string') sessionsUsed.add(request.sessionId)
            if (result.ok && request.command === 'session.open') {
              const opened = (result.data as Record<string, unknown> | undefined)?.['sessionId']
              if (typeof opened === 'string') sessionsUsed.add(opened)
            }
            return result
          },
        },
      }),
    ],
    guard,
    principal: {
      id: PRINCIPAL,
      capabilities: new Set<Capability>([
        'browser.read', 'search.web', 'cognition.request', 'cognition.grant.manage',
      ]),
      trusted: true,
    },
    stopped: () => false,
  })

  const gateway = new ModelGateway({ providers: [provider], recorder: silentRecorder, now: () => new Date() })
  const cognition = new CognitionService({ fabric, gateway, guard, now: () => new Date() }, initialCoreState())
  const mind = new MindService({
    fabric,
    store,
    authority: cognition.ownerAuthority(),
    gateway,
    now: () => new Date(),
    newId: (() => { let n = 0; return () => `id-${(n += 1).toString().padStart(4, '0')}` })(),
    tools: registry,
  })

  console.log('\n[TEST 10] asking — no extension in the process, no URL in the prompt:')
  const turn = await mind.runTurn({
    conversationId: 'test10',
    turnId: 'test10-turn',
    text: 'Use your browser yourself. Search the web for the official Laravel documentation about queues. '
      + 'Open the official result, navigate to the section about failed jobs, and tell me what command Laravel '
      + 'provides for retrying a failed job and what information the page gives about failed jobs.',
  })

  const record = await store.readConversation('test10')
  const answer = record?.messages.filter((m) => m.role === 'assistant').at(-1)?.content ?? ''

  console.log(`\n  outcome: ${turn.outcome}${turn.reason === null ? '' : ` (${turn.reason})`}`)
  console.log(`  searches: ${searched.length === 0 ? '(none)' : searched.join(' | ')}`)
  console.log(`  browser targets: ${targets.length === 0 ? '(none)' : [...new Set(targets)].join(', ')}`)
  console.log(`  visited: ${visited.length === 0 ? '(none)' : visited.join(' -> ')}`)
  console.log(`\n--- Freya's answer ---\n${answer}\n---------------------\n`)

  /* --- the assertions --------------------------------------------------- */

  // A live failure must be diagnosable from the log alone: an outcome with no
  // reason printed is a red herring waiting to happen.
  if (turn.outcome !== 'completed') {
    console.log(`
[TEST 10] the turn did not complete: outcome=${turn.outcome}`)
    console.log(`[TEST 10] reason: ${String(turn.reason)}`)
    console.log(`[TEST 10] providerContacted=${String(turn.providerContacted)} id=${String(turn.providerId)} model=${String(turn.model)}`)
  }
  check('the turn completed', turn.outcome === 'completed', `${turn.outcome}: ${String(turn.reason)}`)
  check('the model performed a real web search first', searched.length > 0, `queries=${searched.length}`)
  check('the browser opened at least one page', visited.length > 0, `visited=${visited.length}`)
  check('it opened the official Laravel docs', visited.some((url) => /(^|\.)laravel\.com/.test(new URL(url).hostname)),
    visited.join(' -> '))
  check('the answer is not empty', answer.trim().length > 0, `${answer.length} chars`)

  // THE claim. Every routed browser command landed on the public partition.
  // `authenticated` is the port the Chrome extension serves, so its absence here
  // -- read from the runtime, not asserted by the model -- is the proof.
  // The grant was registered against `freya-0001` before the turn. If the runtime
  // had opened a different session, that session would have had no grant and been
  // refused -- so this is the check that the exact-scope grant really was the one
  // that worked, rather than a wildcard quietly covering whatever appeared.
  check('the browser used exactly the session the grant was registered for',
    sessionsUsed.size === 1 && sessionsUsed.has(SESSION_SCOPE),
    `sessions=${[...sessionsUsed].join(',') || '(none)'} granted=${SESSION_SCOPE}`)

  check('every routed browser command landed on target "public"',
    targets.length > 0 && targets.every((target) => target === 'public'),
    `targets=${[...new Set(targets)].join(',') || '(none)'}`)
  check('the extension port ("authenticated") was never routed to',
    !targets.some((target) => target === 'authenticated'))
  check('no browser command was refused by the gate',
    targets.every((target) => target === 'public'),
    targets.filter((target) => target !== 'public').join(',') || '(none refused)')

  // The answer must be grounded in the page, not recalled. `queue:retry` is on the
  // page; it is also in many models' weights, so the load-bearing check is that the
  // page was read and that the transcript says so.
  check('the answer mentions the retry command', /queue:retry/.test(answer))
  check('the transcript names the browser that served it',
    answer.includes('native/public Freya browser'))
  check('the transcript never names the extension',
    !answer.includes('paired Chrome extension'))
  // The observation carries "Nothing was clicked, typed, submitted or logged
  // into, and none of those is claimed"; the answer is not obliged to repeat it.
  // What matters is that the answer does not *assert* a UI action it never made.
  check('it does not claim to have clicked or typed anything',
    !/(?:^|\W)(?:i|freya)\s+(?:clicked|typed|logged in to|signed in to|submitted the form)(?:$|\W)/i.test(answer))

  void activation.dispose()
  void hands.dispose()

  console.log(`\n[TEST 10] ${failures.length === 0 ? `all ${passed} checks passed` : `${failures.length} FAILED of ${passed + failures.length}: ${failures.join(', ')}`}`)
  app.exit(failures.length === 0 ? 0 : 1)
}

/**
 * Electron quits by default when its last window closes. The browser tool opens a
 * managed window, reads it and closes it again — so the first successful page read
 * was killing this process mid-assertion and the run exited 0 having proved
 * nothing. Suppressing the default is what lets the assertions after the turn run.
 */
app.on('window-all-closed', () => {
  /* intentional: main() decides when this process exits */
})

void app.whenReady().then(main).catch((error: unknown) => {
  console.error('[TEST 10] the runner threw', error)
  app.exit(1)
})
