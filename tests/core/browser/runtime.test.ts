import { describe, expect, it } from 'vitest'
import { harness, ScriptedJournal, ScriptedPage } from './harness'

const URL = 'https://example.com/article'

async function withSession(options: Parameters<typeof harness>[0] = {}) {
  const instance = harness(options)
  await instance.open()
  const opened = await instance.ok({ command: 'session.open', target: 'public' })
  const sessionId = String(opened.data.sessionId)
  return { ...instance, sessionId }
}

describe('opening a Freya Browser session', () => {
  it('opens an in-memory partition and names a page id', async () => {
    const instance = await withSession()
    const opened = await instance.ok({ command: 'session.open', target: 'public' })
    expect(String(opened.data.partition)).toBe('freya-public-freya-0002')
    expect(String(opened.data.partition).startsWith('persist:')).toBe(false)
    expect(String(opened.data.pageId)).toBe('page-freya-0002')
    expect(instance.journal.types).toContain('browser.dual.session.opened')
  })

  it('refuses to open when the Freya Browser is not activated', async () => {
    const instance = harness({ publicAvailable: false })
    await instance.open()
    await instance.refused({ command: 'session.open', target: 'public' }, 'target-unavailable')
    expect(instance.pages.size).toBe(0)
  })

  it('holds only as many sessions as this build will hold', async () => {
    const instance = await withSession({ maxSessions: 1 })
    await instance.refused({ command: 'session.open', target: 'public' }, 'budget-exceeded')
    expect(instance.pages.size).toBe(1)
  })

  it('reports nothing observed about a session that has opened no page', async () => {
    const instance = await withSession()
    const state = await instance.ok({ command: 'session.state', target: 'public', sessionId: instance.sessionId })
    expect(state.data).toMatchObject({ session: 'open', page: 'absent', revision: 0, url: null, observed: false })
  })
})

describe('navigating, reading and describing', () => {
  it('navigates through Device Hands and reports where it landed', async () => {
    const instance = await withSession()
    const result = await instance.ok({ command: 'page.navigate', target: 'public', sessionId: instance.sessionId, url: URL })
    expect(result.data.url).toBe(URL)
    expect(instance.authority.actionKeys).toEqual(['browser.navigate'])
    expect(instance.authority.calls[0]?.input).toEqual({ url: URL })
    expect(instance.page().calls).toContain(`navigate:${URL}`)
  })

  it('refuses a URL the shared page policy refuses, before any gate is asked', async () => {
    const instance = await withSession()
    for (const url of ['file:///etc/passwd', 'http://127.0.0.1:8080/', 'https://user:pw@example.com/', 'chrome://settings']) {
      await instance.refused({ command: 'page.navigate', target: 'public', sessionId: instance.sessionId, url }, 'url-refused')
    }
    expect(instance.authority.calls).toHaveLength(0)
    expect(instance.page().calls).toHaveLength(0)
  })

  it('applies the owner host allowlist', async () => {
    const instance = await withSession({ allowedHosts: ['example.com'] })
    await instance.refused(
      { command: 'page.navigate', target: 'public', sessionId: instance.sessionId, url: 'https://other.com/' },
      'url-refused',
    )
    await instance.ok({ command: 'page.navigate', target: 'public', sessionId: instance.sessionId, url: URL })
  })

  it('reports a navigation as not done when the window does not say where it landed', async () => {
    const instance = await withSession()
    const page = instance.page()
    page.navigate = async () => ({ ok: true, finalUrl: null, code: 'navigated' })
    await instance.refused({ command: 'page.navigate', target: 'public', sessionId: instance.sessionId, url: URL }, 'adapter-failed')
    expect(instance.authority.calls).toHaveLength(1)
  })

  it('refuses a read when nothing is loaded, rather than reading nothing successfully', async () => {
    const instance = await withSession()
    await instance.refused({ command: 'page.read', target: 'public', sessionId: instance.sessionId }, 'page-stale')
    expect(instance.authority.calls).toHaveLength(0)
  })

  it('reads a page and reports a byte count rather than the content', async () => {
    const instance = await withSession()
    await instance.ok({ command: 'page.navigate', target: 'public', sessionId: instance.sessionId, url: URL })
    const read = await instance.ok({ command: 'page.read', target: 'public', sessionId: instance.sessionId })
    expect(Number(read.data.bytes)).toBeGreaterThan(0)
    expect(Object.keys(read.data)).not.toContain('text')
    expect(instance.authority.actionKeys).toEqual(['browser.navigate', 'browser.read-text'])
  })

  it('describes a page and hands out references bound to its revision', async () => {
    const instance = await withSession()
    await instance.ok({ command: 'page.navigate', target: 'public', sessionId: instance.sessionId, url: URL })
    const described = await instance.ok({ command: 'page.describe', target: 'public', sessionId: instance.sessionId })
    const elements = described.data.elements as { ref: string; label: string }[]
    expect(elements.length).toBeGreaterThan(0)
    expect(elements.every((element) => element.ref.startsWith('r1-'))).toBe(true)
    expect(Number(described.data.revision)).toBeGreaterThanOrEqual(1)
    expect(instance.journal.types).toContain('browser.dual.page.described')
  })

  it('reports how many elements it described, and that nothing was dropped, without claiming a count it does not have', async () => {
    const instance = await withSession({ page: new ScriptedPage('x', { elements: [{ kind: 'link', label: 'a', selector: '#a' }] }) })
    await instance.ok({ command: 'page.navigate', target: 'public', sessionId: instance.sessionId, url: URL })
    const described = await instance.ok({ command: 'page.describe', target: 'public', sessionId: instance.sessionId })
    expect((described.data.elements as unknown[]).length).toBe(1)
    expect(described.data.truncated).toBe(false)
  })
})

describe('acting on a page', () => {
  async function described(options: Parameters<typeof harness>[0] = {}) {
    const instance = await withSession(options)
    await instance.ok({ command: 'page.navigate', target: 'public', sessionId: instance.sessionId, url: URL })
    const described = await instance.ok({ command: 'page.describe', target: 'public', sessionId: instance.sessionId })
    const elements = described.data.elements as { ref: string; selector: string }[]
    const button = elements.find((element) => element.selector === '#continue')
    if (button === undefined) throw new Error('setup failed: no button described')
    return { ...instance, ref: button.ref }
  }

  it('clicks a reference, through the browser.click gate', async () => {
    const instance = await described()
    const result = await instance.ok({ command: 'page.click', target: 'public', sessionId: instance.sessionId, ref: instance.ref })
    expect(result.data.clicked).toBe(true)
    expect(instance.authority.actionKeys).toEqual(['browser.navigate', 'browser.read-text', 'browser.click'])
    expect(instance.authority.calls[2]?.input).toEqual({ url: URL, selector: '#continue' })
  })

it('refuses a reference from an older page rather than clicking whatever is there now', async () => {
    const instance = await described()
    // The page goes somewhere else *through Freya*, which is what retires the references the
    // description handed out.
    await instance.ok({
      command: 'page.navigate',
      target: 'public',
      sessionId: instance.sessionId,
      url: 'https://example.com/other',
    })
    const refused = await instance.refused(
      { command: 'page.click', target: 'public', sessionId: instance.sessionId, ref: instance.ref },
      'page-stale',
    )
    expect(refused.ok).toBe(false)
    expect(instance.page().calls.some((call) => call.startsWith('click:'))).toBe(false)
  })

  it('refuses a click when the window has moved off the page that was authorised', async () => {
    const instance = await described()
    // The page navigated itself, behind Freya's back. The revision is unchanged, so the
    // reference still resolves — and the click is still refused, because the window is no
    // longer on the URL the authority checked.
    instance.page().url = 'https://example.com/somewhere-else'
    await instance.refused(
      { command: 'page.click', target: 'public', sessionId: instance.sessionId, ref: instance.ref },
      'adapter-failed',
    )
    expect(instance.page().calls.some((call) => call.startsWith('click:'))).toBe(false)
  })

  it('refuses a reference nobody was given', async () => {
    const instance = await described()
    await instance.refused(
      { command: 'page.click', target: 'public', sessionId: instance.sessionId, ref: 'r1-0000000000000000' },
      'ref-unknown',
    )
    expect(instance.page().calls.some((call) => call.startsWith('click:'))).toBe(false)
  })

  it('refuses to type into a protected field, and does not reach the page', async () => {
    const instance = await withSession({
      page: new ScriptedPage('x', {
        elements: [{ kind: 'field', label: 'Password', selector: '#password', protected: true }],
        protectedSelectors: ['#password'],
      }),
    })
    await instance.ok({ command: 'page.navigate', target: 'public', sessionId: instance.sessionId, url: URL })
    const described = await instance.ok({ command: 'page.describe', target: 'public', sessionId: instance.sessionId })
    const [field] = described.data.elements as { ref: string }[]
    await instance.refused(
      { command: 'page.type', target: 'public', sessionId: instance.sessionId, ref: field?.ref, text: 'hunter2' },
      'protected-field',
    )
    expect(instance.page().calls.some((call) => call.startsWith('type:'))).toBe(false)
    expect(instance.authority.calls.some((call) => call.actionKey === 'browser.type-text')).toBe(false)
  })

  it('reports a click the page did not react to as not done', async () => {
    const instance = await described({ page: new ScriptedPage('x', { clickChanges: false }) })
    await instance.refused({ command: 'page.click', target: 'public', sessionId: instance.sessionId, ref: instance.ref }, 'adapter-failed')
  })

  it('reports a keystroke the field did not read back as not done', async () => {
    const instance = await withSession({
      page: new ScriptedPage('x', { typeEcho: 'mismatch' }),
    })
    await instance.ok({ command: 'page.navigate', target: 'public', sessionId: instance.sessionId, url: URL })
    const described = await instance.ok({ command: 'page.describe', target: 'public', sessionId: instance.sessionId })
    const field = (described.data.elements as { ref: string }[]).find((element) => element.ref !== undefined)
    await instance.refused(
      { command: 'page.type', target: 'public', sessionId: instance.sessionId, ref: field?.ref, text: 'hello' },
      'adapter-failed',
    )
  })

  it('types into an ordinary field and confirms the value read back', async () => {
    const instance = await withSession({
      page: new ScriptedPage('x', {
        elements: [{ kind: 'field', label: 'Search', selector: '#search' }],
      }),
    })
    await instance.ok({ command: 'page.navigate', target: 'public', sessionId: instance.sessionId, url: URL })
    const described = await instance.ok({ command: 'page.describe', target: 'public', sessionId: instance.sessionId })
    const [field] = described.data.elements as { ref: string }[]
    const result = await instance.ok({
      command: 'page.type',
      target: 'public',
      sessionId: instance.sessionId,
      ref: field?.ref,
      text: 'encryption',
    })
    expect(result.data.typed).toBe(true)
    expect(instance.page().calls).toContain('type:#search')
  })

  it('needs text before it will ask for a keystroke', async () => {
    const instance = await described()
    await instance.refused({ command: 'page.type', target: 'public', sessionId: instance.sessionId, ref: instance.ref }, 'request-malformed')
  })
})

describe('authority is the gate', () => {
  it('never reaches the browser when Device Hands refuses', async () => {
    const instance = await withSession({ authority: { allow: [] } })
    await instance.refused({ command: 'page.navigate', target: 'public', sessionId: instance.sessionId, url: URL }, 'authority-refused')
    expect(instance.page().calls).toHaveLength(0)
    expect(instance.journal.types).toContain('browser.dual.refused')
  })

  it('does not read an observation the action did not authorise', async () => {
    const instance = await withSession({ authority: { allow: [], verdict: 'failed', code: 'stop-all-latched' } })
    await instance.refused({ command: 'page.navigate', target: 'public', sessionId: instance.sessionId, url: URL }, 'authority-refused')
  })

  it('reports `passed` with nothing observed as a contradiction, not a success', async () => {
    const instance = await withSession({ authority: { allow: ['browser.navigate'], silent: true } })
    await instance.refused({ command: 'page.navigate', target: 'public', sessionId: instance.sessionId, url: URL }, 'adapter-failed')
  })

  it('uses the same four Device Hands keys the extension bridge uses, and no others', async () => {
    const instance = await withSession()
    await instance.ok({ command: 'page.navigate', target: 'public', sessionId: instance.sessionId, url: URL })
    for (const key of instance.authority.actionKeys) {
      expect(['browser.navigate', 'browser.read-text', 'browser.click', 'browser.type-text']).toContain(key)
    }
  })
})

describe('STOP ALL wins', () => {
  it('refuses everything once latched, including a state read', async () => {
    const instance = await withSession()
    await instance.ok({ command: 'page.navigate', target: 'public', sessionId: instance.sessionId, url: URL })
    instance.authority.stopAll = true
    for (const request of [
      { command: 'session.open' as const, target: 'public' as const },
      { command: 'session.state' as const, target: 'public' as const, sessionId: instance.sessionId },
      { command: 'page.navigate' as const, target: 'public' as const, sessionId: instance.sessionId, url: URL },
      { command: 'page.read' as const, target: 'public' as const, sessionId: instance.sessionId },
      { command: 'handoff.list' as const, target: 'public' as const },
    ]) {
      const result = await instance.runtime.execute(request)
      expect(result.ok, JSON.stringify(request.command)).toBe(false)
      if (!result.ok) expect(result.code).toBe('stop-all-latched')
    }
    expect(instance.authority.calls).toHaveLength(1)
  })

  it('tears every window down when the owner latches it through the runtime', async () => {
    const instance = await withSession()
    const page = instance.page()
    await instance.ok({ command: 'page.navigate', target: 'public', sessionId: instance.sessionId, url: URL })
    instance.runtime.stopAll('the owner pressed STOP ALL')
    expect(page.closed).toBe(true)
    await instance.refused({ command: 'page.read', target: 'public', sessionId: instance.sessionId }, 'stop-all-latched')
  })
})

describe('media', () => {
  it('describes an observed download and says plainly that it was not written', async () => {
    const instance = await withSession()
    await instance.ok({ command: 'page.navigate', target: 'public', sessionId: instance.sessionId, url: URL })
    const recorded = await instance.runtime.observeMedia(instance.sessionId, {
      mediaId: 'media-0001',
      url: 'https://example.com/invoice.pdf',
      fileName: 'invoice.pdf',
      mediaType: 'application/pdf',
      bytes: 12_000,
    })
    expect(recorded.ok).toBe(true)
    if (recorded.ok) {
      expect(recorded.data.written).toBe(false)
      expect(recorded.data.code).toBe('media-write-refused')
      expect(recorded.data.transferable).toBe(true)
    }

    const described = await instance.ok({
      command: 'media.describe',
      target: 'public',
      sessionId: instance.sessionId,
      mediaId: 'media-0001',
    })
    expect(described.data.fileName).toBe('invoice.pdf')
  })

  it('refuses to describe a download that was never observed', async () => {
    const instance = await withSession()
    await instance.refused(
      { command: 'media.describe', target: 'public', sessionId: instance.sessionId, mediaId: 'media-9999' },
      'media-not-observed',
    )
  })

  it('refuses a media observation for a session that does not exist', async () => {
    const instance = await withSession()
    const result = await instance.runtime.observeMedia('freya-9999', { mediaId: 'media-0001', url: 'https://example.com/a', fileName: 'a' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('session-unknown')
  })
})

describe('handoff', () => {
  it('carries only a URL and a reason, and continues in the shared Chrome tab', async () => {
    const instance = await withSession()
    instance.extension.paired = true
    instance.extension.live = true
    instance.extension.sharedTabId = 9
    await instance.ok({ command: 'page.navigate', target: 'public', sessionId: instance.sessionId, url: URL })

    const offered = await instance.ok({
      command: 'handoff.offer',
      target: 'public',
      sessionId: instance.sessionId,
      reason: 'this page needs a login',
      context: { title: 'Article', note: 'finish it in Chrome' },
    })
    expect(offered.data.to).toBe('authenticated')
    expect(offered.data.url).toBe(URL)
    expect(Object.keys(offered.data.context as object).sort()).toEqual(['note', 'title'])

    const accepted = await instance.ok({
      command: 'handoff.accept',
      target: 'authenticated',
      handoffId: String(offered.data.handoffId),
    })
    expect(accepted.data.tabId).toBe(9)
    expect(instance.extension.opened).toHaveLength(1)
    expect(instance.extension.opened[0]?.url).toBe(URL)
  })

  it('refuses to offer a handoff that would carry a credential', async () => {
    const instance = await withSession()
    await instance.refused(
      {
        command: 'handoff.offer',
        target: 'public',
        sessionId: instance.sessionId,
        url: URL,
        reason: 'carry this',
        context: { cookies: 'sid=abc' } as unknown as Record<string, string>,
      },
      'credential-carry-refused',
    )
  })

  it('refuses to accept a handoff that does not exist, or one offered to the other browser', async () => {
    const instance = await withSession()
    instance.extension.paired = true
    instance.extension.live = true
    instance.extension.sharedTabId = 9
    const offered = await instance.ok({ command: 'handoff.offer', target: 'public', sessionId: instance.sessionId, url: URL })
    await instance.refused({ command: 'handoff.accept', target: 'authenticated', handoffId: 'handoff-9999' }, 'handoff-unknown')
    await instance.refused({ command: 'handoff.accept', target: 'public', handoffId: String(offered.data.handoffId) }, 'handoff-target-mismatch')
    expect(instance.extension.opened).toHaveLength(0)
  })

  it('never acts on a handoff twice', async () => {
    const instance = await withSession()
    instance.extension.paired = true
    instance.extension.live = true
    instance.extension.sharedTabId = 9
    const offered = await instance.ok({ command: 'handoff.offer', target: 'public', sessionId: instance.sessionId, url: URL })
    await instance.ok({ command: 'handoff.accept', target: 'authenticated', handoffId: String(offered.data.handoffId) })
    await instance.refused({ command: 'handoff.accept', target: 'authenticated', handoffId: String(offered.data.handoffId) }, 'handoff-unknown')
    expect(instance.extension.opened).toHaveLength(1)
  })

  it('settles a handoff as cancelled when the extension will not open it', async () => {
    const instance = await withSession()
    instance.extension.paired = true
    instance.extension.live = true
    instance.extension.sharedTabId = 9
    instance.extension.failNext = true
    const offered = await instance.ok({ command: 'handoff.offer', target: 'public', sessionId: instance.sessionId, url: URL })
    await instance.refused({ command: 'handoff.accept', target: 'authenticated', handoffId: String(offered.data.handoffId) }, 'adapter-failed')
    const list = await instance.ok({ command: 'handoff.list', target: 'public' })
    const handoffs = list.data.handoffs as { handoffId: string; state: string }[]
    expect(handoffs.find((entry) => entry.handoffId === offered.data.handoffId)?.state).toBe('cancelled')
  })

  it('will not accept a handoff that has expired', async () => {
    const instance = await withSession({ handoffTtlMs: 1_000 })
    instance.extension.paired = true
    instance.extension.live = true
    instance.extension.sharedTabId = 9
    const offered = await instance.ok({ command: 'handoff.offer', target: 'public', sessionId: instance.sessionId, url: URL })
    // The clock never moves in the harness, so the expiry is driven by the ledger instead:
    // a cancel settles the offer, and a settled offer is refused.
    await instance.ok({ command: 'handoff.cancel', target: 'public', handoffId: String(offered.data.handoffId) })
    await instance.refused({ command: 'handoff.accept', target: 'authenticated', handoffId: String(offered.data.handoffId) }, 'handoff-unknown')
  })

  it('reports an unsettled handoff as uncertain after a restart, and never replays it', async () => {
    const journal = new ScriptedJournal()
    const first = await withSession({ journal })
    first.extension.paired = true
    first.extension.live = true
    first.extension.sharedTabId = 9
    await first.ok({ command: 'page.navigate', target: 'public', sessionId: first.sessionId, url: URL })
    const offered = await first.ok({ command: 'handoff.offer', target: 'public', sessionId: first.sessionId, url: URL })
    await first.runtime.dispose()

    const second = harness({ journal })
    second.extension.paired = true
    second.extension.live = true
    second.extension.sharedTabId = 9
    const recovery = await second.runtime.open()
    expect(recovery.handoffsUncertain).toContain(String(offered.data.handoffId))
    expect(recovery.summary).toContain('None of them were replayed')
    expect(second.extension.opened).toHaveLength(0)

    // And the offer is gone: it cannot be accepted after the restart that found it uncertain.
    await second.refused({ command: 'handoff.accept', target: 'authenticated', handoffId: String(offered.data.handoffId) }, 'handoff-unknown')
  })

  it('reports a session left open by a restart as uncertain rather than reopening it', async () => {
    const journal = new ScriptedJournal()
    const first = await withSession({ journal })
    await first.ok({ command: 'page.navigate', target: 'public', sessionId: first.sessionId, url: URL })
    const second = harness({ journal })
    const recovery = await second.runtime.open()
    expect(recovery.sessionsLost).toEqual([{ sessionId: first.sessionId, url: URL }])
    expect(recoveryNeedsAttention(recovery)).toBe(true)
    expect(second.pages.size).toBe(0)
  })
})

describe('the lifecycle', () => {
  it('refuses to act before open, and to act after a dispose', async () => {
    const instance = harness()
    await instance.refused({ command: 'session.state', target: 'public' }, 'subsystem-disabled')
    await instance.open()
    expect((await instance.runtime.execute({ command: 'session.state', target: 'public' })).ok).toBe(true)
    await instance.runtime.dispose()
    await instance.refused({ command: 'session.state', target: 'public' }, 'subsystem-disabled')
  })

  it('closes the window and records the close when a session is closed', async () => {
    const instance = await withSession()
    const page = instance.page()
    await instance.ok({ command: 'page.navigate', target: 'public', sessionId: instance.sessionId, url: URL })
    await instance.ok({ command: 'session.close', target: 'public', sessionId: instance.sessionId })
    expect(page.closed).toBe(true)
    expect(instance.journal.types).toContain('browser.dual.session.closed')
    await instance.refused({ command: 'page.read', target: 'public', sessionId: instance.sessionId }, 'session-closed')
  })

  it('closes every window on dispose', async () => {
    const instance = await withSession()
    const page = instance.page()
    await instance.ok({ command: 'page.navigate', target: 'public', sessionId: instance.sessionId, url: URL })
    await instance.runtime.dispose()
    expect(page.closed).toBe(true)
  })

  it('never journals a payload the code-owned tables forbid', async () => {
    const instance = await withSession()
    await instance.ok({ command: 'page.navigate', target: 'public', sessionId: instance.sessionId, url: URL })
    await instance.ok({ command: 'page.describe', target: 'public', sessionId: instance.sessionId })
    await instance.refused({ command: 'page.click', target: 'public', sessionId: instance.sessionId, ref: 'r1-0000000000000000' }, 'ref-unknown')
    expect(instance.journal.illegal).toEqual([])
    expect(instance.journal.entries.length).toBeGreaterThan(4)
  })

it('keeps working when the record refuses a write, rather than failing an action that happened', async () => {
    const instance = await withSession()
    const before = instance.journal.entries.length
    instance.journal.appendFails = true
    const result = await instance.runtime.execute({
      command: 'page.navigate',
      target: 'public',
      sessionId: instance.sessionId,
      url: URL,
    })
    expect(result.ok).toBe(true)
    expect(instance.journal.entries).toHaveLength(before)
  })

  it('counts the routes it decided, for the owner view', async () => {
    const instance = await withSession()
    await instance.ok({ command: 'page.navigate', target: 'public', sessionId: instance.sessionId, url: URL })
    await instance.ok({ command: 'page.navigate', target: 'public', sessionId: instance.sessionId, url: URL })
    expect(instance.runtime.routes().get('page.navigate')).toBe(2)
    expect(instance.runtime.routes().get('session.open')).toBe(1)
  })
})

function recoveryNeedsAttention(report: { uncertain: readonly unknown[] }): boolean {
  return report.uncertain.length > 0
}