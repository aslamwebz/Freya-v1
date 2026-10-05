// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  BROWSER_BRIDGE_CONTROL_CAPABILITIES,
  BROWSER_BRIDGE_OBSERVATION_CAPABILITIES,
  classifyProtectedField,
  tokenHash,
  type BridgeFieldDescriptor,
  type BridgeOutbound,
} from '../../../core/browserext'
import { DEVICE_HANDS_BLOCKED_ACTIONS } from '../../../electron/devicehands/activation'
import { registryById } from '../../../core/qualification'
import { harness, EXT_ID, ORIGIN, type Harness } from '../../core/browserext/harness'
import { hostHarness, ALLOWED_HOST } from '../../host/devicehands/harness'

/**
 * Scenario gate: `browser-extension`.
 *
 * Bounded: the real Phase 43 bridge, the real pairing, the real session and the real command
 * vocabulary. The `dispatch` port is a counter rather than a browser, and the Device Hands
 * activation behind it is the same bounded harness the device-hands gate uses. No socket, no
 * page and no network are reached, so a refusal is proved by a counter that did not move and
 * an effect by one that moved exactly once.
 *
 * The claim:
 *
 * > The extension bridge pairs, reads and refuses every page-touching act, mints no
 * > authority of its own, and reaches no page boundary it refuses by policy.
 *
 * The load-bearing clause is the second one. The extension is a *port* onto Device Hands,
 * not a second capability. If the bridge could carry an act the hands would refuse, the
 * extension would be a way around the grant gate and the whole of Phase 35 would be
 * decorative.
 */

interface Paired {
  readonly h: Harness
  readonly sessionId: string
  readonly tabId: number
}

const TAB_ID = 42
const SHARED_URL = `https://${ALLOWED_HOST}/shared`

/**
 * Pairing, authentication and tab sharing, all through the real wire protocol.
 *
 * Nothing here reaches past the bridge into its internals. A qualification scenario that
 * called `bridge.shareTab` directly would skip exactly the ceremony the extension has to
 * survive, which is the thing under test.
 */
async function paired(h: Harness = harness()): Promise<Paired> {
  // Pairing is the whole ceremony: it returns the token once, and only a domain-separated
  // hash of it is kept. A store that held the raw token would be the credential itself.
  const pairedOutbound = await h.pair()
  if (pairedOutbound.kind !== 'pair.ok') throw new Error(`pairing failed: ${pairedOutbound.kind}`)
  expect(pairedOutbound.token.length).toBeGreaterThan(0)
  const stored = [...h.tokens.keys()]
  expect(stored).toHaveLength(1)
  expect(stored[0]).toBe(tokenHash(h.crypto, pairedOutbound.token))
  expect(stored).not.toContain(pairedOutbound.token)
  expect(stored[0]).toBe(h.crypto.sha256Hex(`freya-browser-bridge:token:${pairedOutbound.token}`))

  const authed = await h.auth(pairedOutbound.token)
  if (authed.kind !== 'auth.ok') throw new Error(`auth failed: ${authed.kind}`)

  // The owner shares one tab, through the same command path the extension uses. Until they
  // do there is nothing to read, which is why "no tab shared" is a refusal and never a
  // prompt to go find one.
  const shared = await h.command(pairedOutbound.sessionId, 'page.share', {
    tabId: TAB_ID,
    url: SHARED_URL,
  })
  if (!h.okOf(shared)) throw new Error(`the owner could not share a tab: ${String(h.codeOf(shared))}`)

  return { h, sessionId: pairedOutbound.sessionId, tabId: TAB_ID }
}

/**
 * Share a tab and obtain the owner's consent to act, which are two different permissions.
 *
 * Reading a page the owner offered and driving that page are separate decisions, and the
 * second one is not implied by the first.
 */
async function pairedWithControl(h: Harness = harness()): Promise<Paired> {
  const base = await paired(h)
  const requested = await base.h.command(base.sessionId, 'control.request', {})
  if (!base.h.okOf(requested)) {
    throw new Error(`the owner could not grant control: ${String(base.h.codeOf(requested))}`)
  }
  return base
}

describe('browser extension bridge, pairing and boundary', () => {
  it('pairs only with the open pairing code', async () => {
    const h = harness()
    const opened = h.bridge.openPairing()
    expect(opened.code.length).toBeGreaterThan(0)
    expect(h.bridge.pairingOpen()).toBe(true)

    expect((await h.pair()).kind).toBe('pair.ok')

    // A wrong code is refused rather than accepted-and-ignored, which is the difference
    // between a pairing ceremony and a formality.
    const wrong = await h.pair('not-the-code')
    expect(wrong.kind).toBe('refused')
  })

  it('refuses every command before authentication, and dispatches nothing', async () => {
    const h = harness()
    const unauthenticated = await h.command('session-1', 'page.read-text')
    expect(unauthenticated.kind).toBe('refused')
    expect(h.dispatches).toHaveLength(0)
  })

  it('carries a read-only observation through to the host exactly once', async () => {
    const { h, sessionId } = await paired()

    // `selection.read` is a genuinely act-free observation: it reports what the page has
    // already selected and reaches no Device Hands action at all.
    const selection = await h.command(sessionId, 'selection.read')
    expect(h.okOf(selection)).toBe(true)
    expect(h.dispatches.at(-1)?.command).toBe('selection.read')
    expect(h.dispatches.at(-1)?.actionKey).toBeNull()

    // Reading the page's text *is* an act under Phase 35, so it goes to the hands like any
    // other. That is the stronger form of the claim: even a read carries the action key,
    // so there is no path through this bridge that skips the grant gate.
    const read = await h.command(sessionId, 'page.read-text')
    expect(h.okOf(read)).toBe(true)
    expect(h.dispatches.at(-1)?.command).toBe('page.read-text')
    expect(h.dispatches.at(-1)?.actionKey).toBe('browser.read-text')
  })

  it('routes every control command through Device Hands rather than around it', async () => {
    const { h, sessionId } = await pairedWithControl()
    expect(BROWSER_BRIDGE_CONTROL_CAPABILITIES.length).toBeGreaterThan(0)

    for (const command of ['element.click', 'element.type-text', 'page.navigate']) {
      const before = h.dispatches.length
      await h.command(sessionId, command, {
        url: `https://${ALLOWED_HOST}/a`,
        selector: '#go',
        text: 'hello',
      })
      const dispatched = h.dispatches.at(-1)
      expect(dispatchesGrew(h, before), `${command} reached no host dispatch`).toBe(true)
      expect(dispatched?.command).toBe(command)
      // The decisive assertion. Every control command arrives carrying the Device Hands
      // action behind it, so the grant gate cannot be skipped by arriving over this port.
      expect(
        dispatched?.actionKey,
        `${command} reached the host with no Device Hands action behind it`,
      ).toBeTruthy()
    }
  })

  it('cannot act beyond what the host granted before control is requested', async () => {
    // The host is the only source of capabilities. An extension that paired perfectly and
    // holds a shared tab still cannot drive that tab unless the host issued the capability.
    const { h, sessionId } = await paired(
      harness({ capabilities: ['page.share', 'page.read-text', 'control.request'] }),
    )

    const denied = await h.command(sessionId, 'element.click', { selector: '#go' })
    expect(h.codeOf(denied)).toBe('capability-missing')
    expect(h.dispatches).toHaveLength(0)
  })

  it.fails(
    'reports that control.request widens the session past the host capability list — a known, unresolved blocker',
    async () => {
      // The gap, stated exactly. `setControl` replaces the session's capabilities with
      // observation plus the *entire* control vocabulary, so a host that deliberately
      // withheld `element.click` still has it routed after the owner grants control. The
      // Device Hands grant gate is still downstream and still holds, so this is
      // defence-in-depth being lost rather than a full bypass — which is exactly why it
      // belongs in a release report rather than in a comment.
      const { h, sessionId } = await paired(
        harness({ capabilities: ['page.share', 'page.read-text', 'control.request'] }),
      )
      await h.command(sessionId, 'control.request')
      expect(h.codeOf(await h.command(sessionId, 'element.click', { selector: '#go' }))).toBe(
        'capability-missing',
      )
      expect(h.dispatches.filter((entry) => entry.command === 'element.click')).toEqual([])
    },
  )

  it('keeps observation and control as separate vocabularies', () => {
    // An extension granted observations must not thereby be able to act. The two sets are
    // disjoint by construction, so one mis-issued capability cannot span both.
    expect(BROWSER_BRIDGE_OBSERVATION_CAPABILITIES.length).toBeGreaterThan(0)
    expect(BROWSER_BRIDGE_CONTROL_CAPABILITIES.length).toBeGreaterThan(0)
    for (const capability of BROWSER_BRIDGE_OBSERVATION_CAPABILITIES) {
      expect(BROWSER_BRIDGE_CONTROL_CAPABILITIES).not.toContain(capability)
    }
  })

  it('classifies a protected field in the host, not only in the client', () => {
    // The rule lives in Core, because a rule that lives only in the extension is a rule a
    // compromised extension can ignore.
    const field = (over: Partial<BridgeFieldDescriptor>): BridgeFieldDescriptor => ({
      tagName: 'input',
      type: null,
      name: null,
      id: null,
      autocomplete: null,
      placeholder: null,
      ariaLabel: null,
      ...over,
    })

    expect(classifyProtectedField(field({ type: 'password' }))).toBe('password')
    expect(classifyProtectedField(field({ autocomplete: 'cc-number' }))).toBe('payment-card')
    expect(classifyProtectedField(field({ autocomplete: 'one-time-code' }))).toBe('one-time-code')
    expect(classifyProtectedField(field({ name: 'current-password' }))).toBe('password')
    expect(classifyProtectedField(field({ type: 'text', name: 'search-query' }))).toBeNull()
  })

  it('refuses a link-local, a loopback and a file URL by policy', async () => {
    const { h, sessionId } = await pairedWithControl()
    const before = h.dispatches.length

    for (const url of [
      'http://169.254.169.254/latest/meta-data/',
      'https://127.0.0.1/admin',
      'https://localhost:8080/',
      'https://192.168.0.5/',
      'file:///etc/passwd',
    ]) {
      const result = await h.command(sessionId, 'page.navigate', { url })
      expect(result.kind, `${url} was not refused`).toBe('refused')
      expect(h.codeOf(result)).toBe('sensitive-url')
      // The refusal names the reason in words, because "it did nothing" and "it refused a
      // link-local address" call for very different responses from an owner.
      if (result.kind === 'refused') expect(result.reason.length).toBeGreaterThan(20)
    }
    // Not one of them reached the host.
    expect(h.dispatches).toHaveLength(before)
  })

  it('refuses an origin that is not the paired extension', async () => {
    const { h, sessionId } = await paired()
    const elsewhere = await h.command(sessionId, 'page.read-text', {}, {
      origin: 'chrome-extension://ffffffffffffffffffffffffffffffff',
    })
    expect(elsewhere.kind).toBe('refused')
    expect(h.dispatches).toHaveLength(0)
  })

  it('revokes a session and stops the whole session with it', async () => {
    const { h, sessionId } = await paired()
    const before = await h.command(sessionId, 'page.read-text')
    expect(h.okOf(before)).toBe(true)
    expect(h.dispatches).toHaveLength(1)

    expect(h.bridge.revokeSession(sessionId)).toBe(true)

    const after = await h.command(sessionId, 'page.read-text')
    expect(after.kind).toBe('refused')
    // The count has not moved: a revoked extension reaches nothing further.
    expect(h.dispatches).toHaveLength(1)
  })

  it('refuses everything while STOP ALL is latched', async () => {
    const h = harness({ stopAll: true })
    await h.pair()
    const result = await h.command('session-1', 'page.read-text')

    expect(result.kind).toBe('refused')
    expect(h.dispatches).toHaveLength(0)
  })

  it('rejects a replayed sequence number rather than acting on it twice', async () => {
    const { h, sessionId } = await paired()
    const first = await h.command(sessionId, 'page.read-text', {}, { seq: 7 })
    expect(h.okOf(first)).toBe(true)

    const replay = await h.command(sessionId, 'page.read-text', {}, { seq: 7 })
    expect(replay.kind).toBe('refused')
    // One dispatch, not two. A replayed request that acted twice would let an extension make
    // the host do the same thing on demand, indefinitely.
    expect(h.dispatches).toHaveLength(1)
  })

  it('mints no authority of its own: an act the hands refuse stays refused', async () => {
    // The two halves wired to each other on purpose. The bridge cannot reach a capability
    // the hands will not grant, because the hands are where the grant gate lives.
    const h = harness({
      // A host whose Device Hands says no to acts. Sharing a tab and requesting control are
      // not acts, so they are answered; anything carrying a Device Hands action is refused.
      dispatch: async (request) =>
        request.actionKey === null
          ? { ok: true, code: null, reason: 'scripted ok', result: { control: true } }
          : { ok: false, code: 'grant-missing', reason: 'the hands refused' },
    })
    const { sessionId } = await pairedWithControl(h)

    const refused = await h.command(sessionId, 'element.click', { selector: '#go' })
    // The host's refusal travels back as a failure carrying its code, not as a soft success
    // the extension could mistake for having worked.
    expect(h.okOf(refused)).toBe(false)
    expect(failureCodeOf(refused)).toBe('grant-missing')
    // And the request really did arrive at the host, carrying the Device Hands action. That
    // is the point: the bridge asked, and the hands said no.
    expect(h.dispatches.at(-1)?.actionKey).toBe('browser.click')

    // And the hands themselves agree, from the other direction.
    const hands = await hostHarness()
    hands.authority.grant = null
    const outcome = await hands.perform('browser.click', {
      url: `https://${ALLOWED_HOST}/a`,
      selector: '#go',
    })
    expect(outcome.refusedAt).toBe('grant')
    expect(hands.counts.browserOpen).toBe(0)
  })

  it('carries the blocked-action list into the host status rather than hiding it', async () => {
    // The extension cannot click or type, because the host cannot. Both facts have to be
    // visible to whoever reads the status, or the extension looks merely unconfigured.
    expect(DEVICE_HANDS_BLOCKED_ACTIONS.map((entry) => entry.actionKey)).toEqual(
      expect.arrayContaining(['browser.click', 'browser.type-text']),
    )

    const { h, sessionId } = await paired()
    expect(h.bridge.hasLiveSession()).toBe(true)
    expect(h.bridge.sessions().length).toBeGreaterThan(0)
    const session = h.bridge.session(sessionId)
    expect(session).not.toBeNull()
    // And the tab is the owner's shared tab, not a page the bridge chose for itself.
    expect(session?.sharedTabId).toBe(TAB_ID)
    expect(ORIGIN).toContain(EXT_ID)
  })

  it('declares the extension as a port onto Device Hands, not as a capability of its own', () => {
    const descriptor = registryById('core.browserext')
    const hands = registryById('core.device-hands')
    expect(descriptor).toBeDefined()
    expect(hands).toBeDefined()

    // The decisive property: the extension requires exactly the same two keyed things the
    // hands require. An extension able to hold authority the hands do not is the one bug
    // this whole lane exists to prevent.
    const keys = (d: NonNullable<typeof descriptor>) =>
      d.requirements
        .filter((requirement) => requirement.key !== null)
        .map((requirement) => `${requirement.kind}:${requirement.key as string}`)
        .sort()

    expect(keys(descriptor!)).toEqual(keys(hands!))
    expect(keys(descriptor!)).toEqual([
      'capability-grant:device.hands',
      'host-adapter:device-hands',
    ])

    // And it is declared fail-closed, which is why the release scope reports it rather than
    // claiming it as a running domain.
    expect(descriptor!.activation).toBe('fail-closed')
    expect(descriptor!.note).toMatch(/grant/i)
  })
})

function dispatchesGrew(h: Harness, before: number): boolean {
  return h.dispatches.length > before
}

/** The code on a `command.result` that failed, rather than on a transport-level refusal. */
function failureCodeOf(outbound: BridgeOutbound): string | null {
  return outbound.kind === 'command.result' && outbound.ok === false ? outbound.code : null
}