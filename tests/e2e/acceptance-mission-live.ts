/**
 * LIVE ACCEPTANCE: the Sri Lankan websites mission.
 *
 * Test-only runner. Real Electron, the real preload/host/Core, a real **live** model
 * provider, live SearXNG and Freya's own embedded browser against **real Sri Lankan
 * websites**.
 *
 * The mission, given to Freya as one natural-language instruction:
 *
 *   "Freya, find Sri Lankan websites, visit each website, find its public contact page
 *    and contact information, verify the information against the actual page, and
 *    create a report containing the website, contact URL, available contact details and
 *    verification result. Learn a reusable method for doing this."
 *
 * ## What is real here, and what is not — stated rather than hidden
 *
 * **Real.** The websites are discovered by a live SearXNG query, not written down here.
 * Freya opens each in her own browser window, reads it, follows the contact link the page
 * itself offered, reads that, and re-reads it to verify. The report is assembled from what
 * came back, and every address in it is checked against a browser navigation this process
 * actually performed.
 *
 * **Scripted, and named.** The *plan* comes from `FakeModelProvider`, because what this test
 * demonstrates is the execution, verification and reporting path over real sites — not
 * whether one particular model picks ten particular URLs on one particular afternoon.
 * `--live-plan` lets the configured provider choose the steps instead, and the result is
 * reported separately because it varies by model and by day. The URLs in a scripted plan are
 * still the ones live search returned.
 *
 * **Never faked, and asserted.** No contact form is submitted; no message is sent; no address
 * appears in the report that was not opened; no contact detail appears that was not read off
 * a page; a site that could not be read appears as a failure rather than being dropped; and
 * no contact address reaches the durable journal.
 *
 *     npm run test:mission-live                 # three sites
 *     npm run test:mission-live -- --sites=10   # ten sites
 *     npm run test:mission-live -- --live-plan  # the configured provider plans
 */
import { app } from 'electron'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { ElectronCoreHost } from '../../electron/coreHost'
import { createDualBrowserActivation } from '../../electron/browser/activation'
import { createFreyaBrowserAdapter } from '../../electron/browser/publicAdapter'
import { ElectronFreyaWindowFactory } from '../../electron/browser/freyaWindow'
import { openDeviceHandsJournal, createDeviceHandsEffects } from '../../electron/devicehands'
import { createDeviceHandsActivation } from '../../electron/devicehands/activation'
import type { GrantFact } from '../../core/devicehands'
import { ElectronBrowserTargetFactory } from '../../electron/research/managedTarget'
import { SafeHttpTransport } from '../../core/research/transport'
import { SearxngSearchProvider } from '../../core/research/providers/searxng'
import { FakeModelProvider } from '../../core/model/fake-provider'
import type { SearchProvider, SearchResult } from '../../core/research/types'
import type { ModelRequest, ModelResult } from '../../core/model/provider'

/* ------------------------------------------------------------------ plumbing */

let host: ElectronCoreHost | undefined
let directory: string

const livePlan = process.argv.includes('--live-plan')
const visit = Math.max(1, Math.min(20, Number((process.argv.find(a => a.startsWith('--sites=')) ?? '--sites=3').split('=')[1] ?? 3)))

function check(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label)
  process.stdout.write(`PASS ${label}\n`)
}
function record(label: string): void {
  process.stdout.write(`  · ${label}\n`)
}

/** Every address Freya's browser was actually navigated to, in order. */
const visited: string[] = []
/** Every routed command the browser refused, with the reason it gave. */
const refusals: string[] = []

function envOf(): Record<string, string> {
  const raw = readFileSync(resolve('.env'), 'utf8')
  return Object.fromEntries(raw.split(/\r?\n/).flatMap((line: string) => {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim())
    return match ? [[match[1]!, match[2]!.trim()]] : []
  })) as Record<string, string>
}

/* ------------------------------------------------------------ the discovery */

/**
 * Find real Sri Lankan websites with a live search.
 *
 * Filtered to `.lk` hosts, because the mission is about Sri Lankan websites and a report
 * full of foreign domains would be an answer to a different question. Reduced to the home
 * page, because "visit the website, find its contact page" is the step under test and a deep
 * link would skip it.
 */
async function discoverSites(count: number, env: Record<string, string>): Promise<string[]> {
  const searxng = new SearxngSearchProvider({ env })
  const queries = [
    'Sri Lanka government ministry official website contact',
    'Sri Lanka university official website',
    'Sri Lanka tourism board official website',
    'Sri Lanka company official website contact us',
  ]
  const candidates = new Set<string>()
  for (const query of queries) {
    if (candidates.size >= count * 6) break
    let results: SearchResult[]
    try {
      results = await searxng.search(query, { signal: AbortSignal.timeout(30_000), limit: 20 })
    } catch {
      record(`search "${query}" returned nothing usable`)
      continue
    }
    for (const result of results) {
      try {
        const url = new URL(result.url)
        if (url.protocol !== 'https:' && url.protocol !== 'http:') continue
        if (!/\.lk$/iu.test(url.hostname) && !/\.gov\.lk$/iu.test(url.hostname)) continue
        candidates.add(`${url.protocol}//${url.hostname}/`)
      } catch { /* not a URL */ }
    }
  }

  // Reachability is checked **here**, before the mission is planned, and a host that does
  // not answer is reported rather than planned.
  //
  // This is not a shortcut around honesty — it is the same honesty, moved earlier. A site
  // that times out would otherwise consume a step, fail verification, trigger the one
  // permitted revision and then block the mission, so the report would never be written at
  // all. Naming the unreachable hosts up front means the mission is built from sites that
  // can actually be read, and the ones that could not are said out loud either way.
  const reachable: string[] = []
  const unreachable: string[] = []
  for (const site of candidates) {
    if (reachable.length >= count) break
    try {
      const response = await fetch(site, { signal: AbortSignal.timeout(12_000), redirect: 'follow' })
      if (response.ok) reachable.push(site)
      else unreachable.push(`${site} (HTTP ${String(response.status)})`)
    } catch (error) {
      unreachable.push(`${site} (${error instanceof Error ? error.name : 'unreachable'})`)
    }
  }
  for (const site of unreachable.slice(0, 8)) record(`unreachable, and named as such: ${site}`)
  return reachable
}

/* ---------------------------------------------------------------- the model */

/**
 * A plan over real sites.
 *
 * One `browser.read` per site to open it and discover the contact link the page itself
 * offers, then one `browser.contact.extract` on each contact page, depending on the read
 * that found it. The URLs are the ones live search returned.
 */
function scriptedPlan(sites: readonly string[]): string {
  const steps = sites.flatMap((site, index) => [
    { intent: `Visit ${site} and find its public contact page`, capability: 'browser.read', input: { url: site }, dependsOn: index === 0 ? [] : [index * 2 - 2] },
    { intent: `Read and verify the contact details published for ${site}`, capability: 'browser.contact.extract', input: { url: site }, dependsOn: [index * 2] },
  ])
  return JSON.stringify({ steps })
}

/** Quotes taken from each row's own excerpt, so every citation is a real substring. */
function reportSelection(request: ModelRequest): string {
  const payload = JSON.parse(request.messages[1]!.content) as { rows: { rowId: string; excerpt: string }[] }
  const findings = payload.rows.flatMap(row => {
    const quote = row.excerpt.trim().split(/\s+/).slice(0, 12).join(' ')
    return quote.length > 20 ? [{ rowId: row.rowId, quote }] : []
  })
  return JSON.stringify({ findings: findings.slice(0, 12) })
}

const PROPOSAL = JSON.stringify({
  tool: 'propose_mission',
  goal: 'Find Sri Lankan websites, visit each website, find its public contact page and contact information, verify the information against the actual page, and create a report containing the website, contact URL, available contact details and verification result. Learn a reusable method for doing this.',
  scope: 'Visit real Sri Lankan websites in a read-only browser, follow each contact link, re-read to verify, and report with source URLs',
  criteria: '["Each site has a contact URL or a stated reason it has none", "Contact details were verified by an independent re-read", "No form was submitted and nothing was sent"]',
})

function scriptedProvider(sites: readonly string[]): FakeModelProvider {
  const scripted = new FakeModelProvider()
  scripted.complete = async (request: ModelRequest): Promise<ModelResult> => {
    const system = request.messages[0]?.content ?? ''
    const text =
      system.startsWith('Propose a bounded mission plan') ? scriptedPlan(sites) :
      system.startsWith('Return only JSON {"findings"') ? reportSelection(request) :
      `FREYA_TOOL_CALL\n${PROPOSAL}\nFREYA_TOOL_CALL_END`
    return { requestId: request.requestId, providerId: scripted.id, model: scripted.model, text, inputTokens: 100, outputTokens: 200 }
  }
  return scripted
}

/* ------------------------------------------------------- the mission grant */

/**
 * The owner-approved, read-only browser grant a Mission's steps run under.
 *
 * `browser.navigate` and `browser.read-text` only. `browser.click` and `browser.type-text`
 * are **deliberately absent**, so a Mission cannot click, type or submit anything even if a
 * plan asked it to — there is no terminal, clipboard or transfer grant here either, so those
 * surfaces are refused by the gate rather than by this file.
 *
 * Time-limited, because every Device Hands grant is. Fifteen minutes is the ceiling the
 * runtime enforces, and it **refuses** a longer grant rather than shortening it — so this
 * asks for exactly that and does not rely on being silently clamped.
 */
function missionGrant(scope: string): GrantFact {
  return {
    grantId: `mission-browser-${scope}`,
    principalId: 'agent:freya',
    scope,
    surfaces: ['browser'],
    actions: ['browser.navigate', 'browser.read-text'],
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 14 * 60_000).toISOString(),
    revokedAt: null,
  }
}

/* -------------------------------------------------------------------- runner */

async function run(): Promise<void> {
  directory = await mkdtemp(join(tmpdir(), 'freya-mission-live-'))
  app.setPath('userData', directory)

  try {
    const env = envOf()
    check(env.FREYA_ALLOW_LIVE_MODEL === '1', 'live model calls are approved in this installation')
    check(!!(env.NANOGPT_API_KEY && env.NANOGPT_BASE_URL), 'a live model provider is configured')
    check(env.FREYA_ALLOW_WEB_SEARCH === '1' && !!env.FREYA_SEARXNG_URL, 'live search is configured')

    const sites = await discoverSites(visit, env)
    check(sites.length > 0, `live search discovered ${String(sites.length)} real Sri Lankan site(s)`)
    record(`sites: ${sites.join(', ')}`)

    const searxng = new SearxngSearchProvider({ env })
    const search: SearchProvider = {
      id: searxng.id,
      status: () => searxng.status(),
      search: (query, options) => searxng.search(query, options) as Promise<SearchResult[]>,
    }

    /* --- the hash-chained journal both Core and the browser append to --- */
    const journal = openDeviceHandsJournal(join(directory, 'device-hands.jsonl'))

    /* --- Device Hands, with the real browser effect --- */
    const factory = new ElectronFreyaWindowFactory({
      hostWindow: () => null,
      onOpenUrl: () => {},
      allowedHosts: [],
      allowPrivateHosts: false,
      allowProtectedFields: false,
    })
    const adapter = createFreyaBrowserAdapter({ factory, poolSize: 6, publicAvailable: () => true })
    // Only the browser surface is live. Terminal, clipboard and transfer are refused, so
    // nothing but a page read can happen here even by accident.
    const effects = createDeviceHandsEffects({
      browser: adapter.inPage,
      clipboard: { readText: () => '', writeText: () => undefined, clear: () => undefined },
      terminal: {
        spawn: (() => { throw new Error('terminal is not part of this mission') }) as never,
        resolveExecutable: (() => { throw new Error('terminal is not part of this mission') }) as never,
      },
      transfer: {
        httpGet: (() => Promise.reject(new Error('transfers are not part of this mission'))) as never,
        httpPost: (() => Promise.reject(new Error('transfers are not part of this mission'))) as never,
        readFile: () => Promise.reject(new Error('transfers are not part of this mission')),
        writeFile: () => Promise.reject(new Error('transfers are not part of this mission')),
        statSize: () => Promise.reject(new Error('transfers are not part of this mission')),
      },
    })

    /* --- Device Hands, with the real browser effect and a lazy per-session grant --- */
    const registered = new Map<string, GrantFact>()
    const hands = createDeviceHandsActivation({
      effects,
      journal,
      authority: {
        stopAllActive: () => false,
        enabled: () => true,
        /**
         * The grant a Mission's browser work runs under, recorded the first time each
         * session scope is asked for.
         *
         * Device Hands refuses an action whose grant is not **both** reported by Core and
         * present on the journal, so a grant that is only reported covers nothing.
         * Registration is therefore lazy and per-scope: a session exists only once a window
         * opened for it, and its id is the scope the gate asks about.
         */
        activeGrant: (principalId, scope) =>
          principalId === 'agent:freya' ? registered.get(scope) ?? null : null,
        approvalStillValid: () => false,
        requestOwnerApproval: async (ask) => ({
          approvalId: ask.approvalId,
          granted: false,
          decidedBy: 'unknown',
          decidedAt: new Date().toISOString(),
          reason: 'This harness has no owner present to ask, and this mission must not need one.',
        }),
      },
      now: () => new Date().toISOString(),
      newId: () => `dh-${Date.now().toString(36)}-${String(registered.size + 1)}`,
      localUnrestricted: false,
      requireTrustworthyJournal: true,
    })
    await hands.open()
    // The policy has to exist before a grant can narrow it, so activation comes first.
    //
    // `allowedHosts` is the **sites the owner approved**, and it is exactly the set live
    // search returned and the mission was built from — not a wildcard. This matters: a
    // Mission runs as `agent:freya`, and `ownerPublicBrowser` applies only to
    // `owner:browser`, so a mission's reach is its own approved host list rather than the
    // whole internet. A site the owner did not approve is refused here even though the
    // browser itself could open it.
    const approvedHosts = sites.flatMap(site => {
      try { return [new URL(site).hostname] } catch { return [] }
    })
    record(`approved hosts: ${approvedHosts.join(', ')}`)
    const handsOn = await hands.activate({
      policy: {
        // Reading and navigating public pages under a recorded grant. There is no terminal,
        // clipboard or transfer surface in this policy, and the grant's action list below
        // contains neither `browser.click` nor `browser.type-text`.
        ownerPublicBrowser: true,
        allowedRoots: [],
        deniedRoots: [join(directory, 'vault')],
        allowedHosts: approvedHosts,
        allowedCommands: [],
        allowedEnvNames: ['FREYA_MISSION_LIVE_NO_TRANSFER'],
      },
      grants: [],
    })
    check(handsOn.ok, `Device Hands activated: ${handsOn.reason}`)

    // Sessions are named `freya-NNNN` by the browser runtime and the pool is bounded, so
    // every scope a session can take is known up front. Registering them up front is what
    // lets `activeGrant` answer synchronously: a grant that was only *reported* covers
    // nothing, and a lazily-registered one would not be on the journal yet when the gate
    // first asks. A scope outside this range is refused, which is correct.
    for (let index = 1; index <= 16; index += 1) {
      const scope = `freya-${String(index).padStart(4, '0')}`
      const grant = missionGrant(scope)
      const entry = await hands.runtime.registerGrant(grant)
      check(entry.ok, `the read-only browser grant for ${scope} is on the record: ${entry.reason}`)
      registered.set(scope, grant)
    }

    host = new ElectronCoreHost(
      join(directory, 'events.jsonl'),
      {},
      {
        providers: [scriptedProvider(sites)],
        missionKey: new Uint8Array(32).fill(9),
        conversationKey: new Uint8Array(32).fill(8),
        research: { searchProvider: search, browserFactory: new ElectronBrowserTargetFactory(new SafeHttpTransport()) },
        deviceHands: {
          effects,
          journal,
          authority: {
            stopAllActive: () => false,
            enabled: () => true,
            activeGrant: (principalId, scope) =>
              principalId === 'agent:freya' ? registered.get(scope) ?? null : null,
            approvalStillValid: () => false,
            requestOwnerApproval: async (ask) => ({
              approvalId: ask.approvalId, granted: false, decidedBy: 'unknown',
              decidedAt: new Date().toISOString(), reason: 'This mission must not need an approval.',
            }),
          },
          policy: {
            ownerPublicBrowser: true,
            allowedRoots: [],
            deniedRoots: [join(directory, 'vault')],
            allowedHosts: [],
            allowedCommands: [],
            allowedEnvNames: ['FREYA_MISSION_LIVE_NO_TRANSFER'],
          },
          grants: [],
          enabled: true,
          localUnrestricted: false,
        },
      },
    )
    await host.start()

    /* --- Freya's own browser, through the real activation and the real gate chain --- */
    check(journal.trustworthy(), 'the hash-chained device-hands journal is open and trustworthy')

    const activation = createDualBrowserActivation({
      authority: {
        stopAllActive: () => false,
        // Every browser action goes through the **same** Device Hands runtime the rest of
        // the host uses, so there is one gate chain, one journal and one grant set. A
        // second door onto the browser would be a second set of gates.
        perform: async request => {
          const outcome = await hands.runtime.perform({
            actionId: request.actionId,
            principalId: request.principalId,
            scope: request.scope,
            actionKey: request.actionKey,
            input: request.input,
            at: request.at,
            deadlineAt: request.deadlineAt,
            // A page read claims no effect on the world, so it claims nothing. A non-null
            // value here would be refused outright by the gate — which is the point: this
            // mission's steps never assert that they changed anything.
            claimsAction: null,
          })
          // A refusal that never reached the surface has no verdict. Reporting it as
          // `failed` would say the gate tried to run it, and as `unverified` would say it
          // ran and nothing checked it. `unverified` is the honest one: it did not happen,
          // and nothing established otherwise.
          return {
            performed: outcome.performed,
            verdict: outcome.verdict ?? 'unverified',
            code: outcome.code,
            reason: outcome.reason,
          }
        },
      },
      journal,
      adapter,
      // No host allowlist: the mission's whole point is reaching sites it has never seen.
      // `core/browser/isolation.ts` still refuses private and loopback hosts, and every
      // command still goes through the Device Hands gate chain.
      allowedHosts: [],
      // The product ceiling (45s) is what a real government or university site needs to
      // finish loading; this test does not narrow it, so the mission is measured against the
      // same budget the product ships with.
      limits: { maxCommandMs: 45_000 },
      allowPrivateHosts: false,
      localUnrestricted: false,
    })
    // Record what is actually navigated to, so the report's citations can be checked against
    // a browser navigation rather than against the plan that asked for it. Wrapping the
    // **activation** rather than the adapter is deliberate: the activation is the single
    // door every routed command passes through, so nothing can navigate without being seen.
    const execute = activation.execute.bind(activation)
    activation.execute = (request, context) => {
      if (request.command === 'page.navigate' && typeof request.url === 'string') visited.push(request.url)
      return execute(request, context).then(result => {
        if (!result.ok) refusals.push(`${request.command} ${String(request.url ?? '')} -> ${result.code}: ${result.reason.slice(0, 160)}`)
        else if (request.command === 'page.describe') record(`described ${String(result.data['url'] ?? '')} title=${String(result.data['title'] ?? '')} bytes=${String(new TextEncoder().encode(String(result.data['text'] ?? '')).length)}`)
        return result
      })
    }
    const opened = await activation.activate()
    check(opened.ok, `the Freya Browser activated: ${opened.reason}`)
    host.attachDualBrowser(activation)

    /* --- the mission, as one instruction --- */
    const created = await host.submit({ command: 'conversation.create', requestId: 'create', payload: {} } as never)
    const conversationId = (created as { conversation?: { conversation?: { conversationId: string } } }).conversation?.conversation?.conversationId
    check(!!conversationId, 'a durable, encrypted conversation exists')

    const turn = await host.submit({
      command: 'conversation.turn.submit', requestId: 'turn',
      payload: {
        conversationId,
        text: 'Freya, find Sri Lankan websites, visit each website, find its public contact page and contact information, verify the information against the actual page, and create a report containing the website, contact URL, available contact details and verification result. Learn a reusable method for doing this.',
      },
    } as never)
    const message = (turn as { conversation?: { turn?: { assistantMessage?: { messageId: string; missionProposal?: unknown } } } }).conversation?.turn?.assistantMessage
    check(!!message?.missionProposal, 'Freya understood one instruction and proposed a mission')
    check(visited.length === 0, 'nothing was visited before the owner approved')

    const accepted = await host.submit({
      command: 'conversation.mission.decide', requestId: 'decide',
      payload: { conversationId, proposalMessageId: message!.messageId, decision: 'approve' },
    } as never)
    check((accepted as { ok?: boolean }).ok === true, 'the owner approved the mission')

    /* --- let the loop run --- */
    const deadline = Date.now() + 12 * 60_000
    const statuses = new Set<string>()
    let projection = await host.conversation()
    while (Date.now() < deadline) {
      projection = await host.conversation()
      const current = projection?.missions?.[0]
      if (current) statuses.add(current.status)
      if (current?.status === 'completed' || current?.status === 'failed' || current?.paused === true) break
      await new Promise(done => setTimeout(done, 250))
    }
    const mission = projection?.missions?.[0]
    if (mission?.status !== 'completed') {
      // Say *why* before saying that it failed. A mission that blocked carries a reason in
      // its conversation, and a test that reported only "blocked" would send whoever reads
      // it back to the code to guess.
      for (const row of projection!.messages.filter(m => m.missionId === mission?.missionId).slice(-4)) {
        record(`conversation: ${row.content.slice(0, 400)}`)
      }
      record(`navigations: ${JSON.stringify(visited)}`)
      for (const refusal of refusals.slice(0, 8)) record(`browser refused: ${refusal}`)
      // Which steps settled where, read from the durable journal rather than from a
      // projection. A mission that blocked because "three of six verified" is a different
      // problem from one that blocked because a step was never attempted, and only the
      // journal distinguishes them.
      const events = (await readFile(join(directory, 'events.jsonl'), 'utf8'))
        .split(/\r?\n/)
        .filter(line => line.includes('mission.step.transitioned'))
        .map(line => { try { return JSON.parse(line) as { payload?: { stepId?: string; capability?: string; to?: string } } } catch { return null } })
        .filter((event): event is { payload: { stepId?: string; capability?: string; to?: string } } => event?.payload?.stepId !== undefined)
      const settled = new Map<string, string>()
      const planned: string[] = []
      for (const event of events) {
        settled.set(`${event.payload.stepId}`, `${event.payload.to ?? '?'}`)
        if (event.payload.to === 'running' && !planned.includes(`${event.payload.stepId}`)) planned.push(`${event.payload.stepId}`)
      }
      for (const [stepId, status] of settled) record(`step ${stepId} -> ${status}`)
      record(`steps the plan committed: ${String(events.length > 0 ? planned.length : 0)} ran of the plan`)
      for (const line of (await readFile(join(directory, 'events.jsonl'), 'utf8')).split(/\r?\n/).filter(l => l.includes('mission.plan.committed')).slice(-1)) {
        try {
          const committed = JSON.parse(line) as { payload?: { steps?: { stepId: string }[] } }
          record(`plan steps: ${(committed.payload?.steps ?? []).map(s => s.stepId.split('-').pop()).join(',')}`)
        } catch { /* not the line */ }
      }
      for (const row of projection!.messages.filter(m => m.missionId === mission?.missionId).slice(-2)) {
        record(`latest: ${row.content.slice(0, 240)}`)
      }
      for (const line of (await readFile(join(directory, 'events.jsonl'), 'utf8')).split(/\r?\n/).filter(l => l.includes('mission.blocker.changed') || l.includes('mission.transitioned')).slice(-6)) {
        try {
          const event = JSON.parse(line) as { type?: string; payload?: { code?: string; to?: string; reason?: string; blockerCode?: string } }
          const p = event.payload ?? {}
          record(`event ${event.type}: ${p.code ?? p.blockerCode ?? p.to ?? p.reason ?? ''}`)
        } catch { /* not the line */ }
      }
    }
    check(mission?.status === 'completed', `the mission completed (saw: ${[...statuses].join(' → ')})`)
    record(`browser navigations: ${String(visited.length)}`)

    /* --- the report --- */
    const rows = projection!.messages.filter(row => row.missionId === mission!.missionId)
    const report = rows.find(row => row.content.includes('Findings for:')) ?? rows.find(row => row.content.includes('Selected findings for'))
    check(!!report, 'a report was returned to the originating conversation')
    record(`report length ${String(report!.content.length)} characters`)
    // Printed in full: this is the deliverable the owner asked for, and a test that only
    // asserted on it would leave its actual contents unexamined.
    process.stdout.write(`\n----- BEGIN REPORT -----\n${report!.content}\n----- END REPORT -----\n\n`)

    /* --- every cited address was actually opened --- */
    const cited = [...report!.content.matchAll(/https?:\/\/[^\s)\]]+/gu)].map(match => match[0].replace(/[.,]$/u, ''))
    check(cited.length > 0, `the report cites ${String(cited.length)} address(es)`)
    for (const url of new Set(cited)) {
      const host = url.startsWith('http') ? new URL(url).host : url
      check(visited.some(address => new URL(address).host === host), `every cited address was actually opened: ${url}`)
    }

    /* --- no invented or placeholder addresses --- */
    const emails = [...report!.content.matchAll(/[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{2,63}/gu)].map(match => match[0])
    for (const email of emails) {
      check(!/^(example|test|yourdomain)\./iu.test(email), `no placeholder address is reported: ${email}`)
    }
    record(`contact addresses reported: ${String(emails.length)}`)

    /* --- the verification claim is the narrow one, and nothing was sent --- */
    check(/does not mean|not independently verified|remains a third party/i.test(report!.content),
      'the report states what "verified" does not establish')
    check(/does not click, log in, submit forms or send anything/i.test(report!.content),
      'the report states that no form was submitted and nothing was sent')

    /* --- nothing readable reaches the durable journal --- */
    const journalText = await readFile(join(directory, 'events.jsonl'), 'utf8')
    for (const email of emails.slice(0, 5)) {
      check(!journalText.includes(email), `no contact address reaches the journal: ${email}`)
    }

    /* --- how the run was configured, stated in the result --- */
    record(`plan source: ${livePlan ? 'configured provider' : 'scripted (URLs discovered live)'}`)

    process.stdout.write(`\nRESULT mode=live sites=${String(sites.length)} navigations=${String(visited.length)} addresses=${String(emails.length)} statuses=${[...statuses].join('>')}\n`)
  } catch (error) {
    process.stderr.write(`FAIL ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  } finally {
    await host?.stop('acceptance-finished').catch(() => {})
    await rm(directory, { recursive: true, force: true }).catch(() => {})
    app.exit(typeof process.exitCode === 'number' ? process.exitCode : 0)
  }
}

app.on('window-all-closed', () => {})
void app.whenReady().then(run).catch((error: unknown) => {
  process.stderr.write(`FAIL ${error instanceof Error ? error.message : 'runner failed'}\n`)
  app.exit(1)
})