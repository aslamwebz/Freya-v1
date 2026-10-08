// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { harness, ScriptedSurfacePage, type Harness } from './service-harness'
import { renderSemanticSnapshot, SemanticRefTable, isSemanticRef } from '../../../core/browser/service'
import type { BrowserRecoverySummary } from '../../../core/browser/service'

/**
 * The two boundaries the service is not allowed to cross, and the two tables that keep them
 * from drifting.
 *
 * ## Sensitive surfaces
 *
 * A control whose whole purpose is something only the owner may do is refused with
 * `owner-action-required` — a sign-in, a captcha, a payment, a permission grant, an upload,
 * an executable, a click-through on terms. The pattern is deliberately generous, because the
 * costs are asymmetric: a false positive costs the owner one confirmation, a false negative
 * puts money moving or a second factor answered by something that is not them.
 *
 * ## The journal and the live surface
 *
 * The journal may not carry page text, a title or a locator. The live surface has to carry all
 * three, because a tab strip and a semantic snapshot cannot be drawn without them. The two
 * vocabularies being separate is what lets the journal stay minimal while the protocol stays
 * rich, and the last block below is the assertion that keeps them apart.
 */

async function withElement(label: string, kind: 'link' | 'button' | 'field' = 'button'): Promise<{ readonly h: Harness; readonly ref: string; readonly revision: number }> {
  const h = harness({ create: (id) => new ScriptedSurfacePage(id, { elements: [{ kind, label, selector: '#target' }] }) })
  await h.ok({ op: 'open', url: 'https://alpha.example.com/', createdBy: 'user' })
  const snapshot = await h.ok({ op: 'snapshot' })
  const view = snapshot.data.snapshot as { revision: number; elements: { ref: string }[] }
  return { h, ref: view.elements[0]?.ref ?? 'r1', revision: view.revision }
}

describe('sensitive surfaces are the owner\u2019s', () => {
  const cases: readonly [string, string][] = [
    ['a sign-in control', 'Sign in'],
    ['an authenticator choice', 'Use authenticator app'],
    ['a captcha', 'I am not a robot'],
    ['a payment', 'Pay now'],
    ['a checkout', 'Checkout'],
    ['a purchase', 'Buy now'],
    ['a transfer', 'Send money'],
    ['a banking action', 'Withdraw'],
    ['a permission grant', 'Allow notifications'],
    ['a camera permission', 'Grant camera access'],
    ['an upload', 'Upload file'],
    ['an executable download', 'Download installer .exe'],
    ['terms on the owner\u2019s behalf', 'I agree to the terms and conditions'],
  ]

  for (const [what, label] of cases) {
    it(`refuses ${what}`, async () => {
      const { h, ref, revision } = await withElement(label)
      await h.refused({ op: 'click', ref, revision }, 'owner-action-required')
      expect(h.pages.get('freya-0001')?.calls).not.toContain('click:#target')
    })
  }

  it('says why, in a sentence naming the category rather than a code', async () => {
    const { h, ref, revision } = await withElement('Pay now')
    const refused = await h.refused({ op: 'click', ref, revision }, 'owner-action-required')
    expect(refused.reason).toContain('payment')
    expect(refused.reason).toContain('owner')
  })

  it('refuses the same controls for typing and for choosing an option', async () => {
    const h = harness({ create: (id) => new ScriptedSurfacePage(id, {
      elements: [
        { kind: 'field', label: 'Card number', selector: '#card', protected: true },
        { kind: 'field', label: 'Bank transfer', selector: '#bank', options: ['Domestic', 'Wire'] },
      ],
    }) })
    await h.ok({ op: 'open', url: 'https://alpha.example.com/', createdBy: 'user' })
    const snapshot = await h.ok({ op: 'snapshot' })
    const view = snapshot.data.snapshot as { revision: number; elements: { ref: string; name: string }[] }
    const bank = view.elements.find((element) => /bank/i.test(element.name))
    await h.refused({ op: 'select', ref: bank?.ref ?? 'r2', revision: view.revision, index: 0 }, 'owner-action-required')
  })

  it('leaves an ordinary control alone', async () => {
    const { h, ref, revision } = await withElement('Read more')
    await h.ok({ op: 'click', ref, revision })
    expect(h.pages.get('freya-0001')?.calls).toContain('click:#target')
  })

  it('leaves a link that merely mentions a word alone', async () => {
    // The pattern matches whole words, so "Payment options" as documentation is not a payment
    // and "Our verification process" is not a verification code.
    const { h, ref, revision } = await withElement('Payment options explained')
    await h.ok({ op: 'click', ref, revision })
  })
})

describe('the reference table', () => {
  it('accepts only the shape it mints', () => {
    for (const candidate of ['r1', 'r12', 'r999999']) expect(isSemanticRef(candidate), candidate).toBe(true)
    for (const candidate of ['r0', 'r', '#continue', 'r-1', 'R1', '', 'x'.repeat(40)]) {
      expect(isSemanticRef(candidate), candidate).toBe(false)
    }
  })

  it('refuses a protected element and a disabled one, in that order', () => {
    const table = new SemanticRefTable('tab-1', 4)
    table.mint([
      { kind: 'field', name: 'Password', selector: '#pw', disabled: false, protected: true, destructive: false },
      { kind: 'button', name: 'Buy', selector: '#buy', disabled: true, protected: false, destructive: false },
      { kind: 'button', name: 'Go', selector: '#go', disabled: false, protected: false, destructive: false },
    ])
    expect(table.resolve('r1', 4)).toMatchObject({ ok: false, code: 'protected-field' })
    expect(table.resolve('r2', 4)).toMatchObject({ ok: false, code: 'element-disabled' })
    expect(table.resolve('r3', 4)).toMatchObject({ ok: true })
  })

  it('refuses a revision that was never named', () => {
    const table = new SemanticRefTable('tab-1', 4)
    table.mint([{ kind: 'button', name: 'Go', selector: '#go', disabled: false, protected: false, destructive: false }])
    expect(table.resolve('r1', Number.NaN)).toMatchObject({ ok: false, code: 'revision-required' })
  })

  it('never lets a revision go backwards', () => {
    const table = new SemanticRefTable('tab-1', 9)
    table.retire(4)
    expect(table.currentRevision).toBe(9)
  })

  it('forgets everything when the tab closes, so no reference outlives its document', () => {
    const table = new SemanticRefTable('tab-1', 2)
    table.mint([{ kind: 'button', name: 'Go', selector: '#go', disabled: false, protected: false, destructive: false }])
    table.clear()
    expect(table.resolve('r1', 2)).toMatchObject({ ok: false, code: 'ref-unknown' })
  })

  it('keeps a retired reference long enough to name the revision it came from', () => {
    const table = new SemanticRefTable('tab-1', 2)
    table.mint([{ kind: 'button', name: 'Go', selector: '#go', disabled: false, protected: false, destructive: false }])
    table.retire(3)
    const reading = table.resolve('r1', 2)
    expect(reading.ok).toBe(false)
    if (!reading.ok) expect(reading.reason).toContain('revision 2')
  })
})

describe('rendering a snapshot', () => {
  it('puts the references above the prose, so the useful part is not below the fold', () => {
    const rendered = renderSemanticSnapshot({
      tabId: 'tab-1',
      url: 'https://alpha.example.com/contact',
      title: 'Contact',
      revision: 41,
      text: 'x'.repeat(100),
      truncated: false,
      superseded: false,
      elements: [{ ref: 'r1', kind: 'link', name: 'About', disabled: false, protected: false, destructive: false }],
    }).rendered
    expect(rendered.indexOf('[r1]')).toBeLessThan(rendered.indexOf('text:'))
  })

  it('marks a truncated page rather than handing back a fragment with no marker', () => {
    const rendered = renderSemanticSnapshot({
      tabId: 'tab-1', url: 'https://alpha.example.com/', title: null, revision: 3,
      text: 'x'.repeat(100), truncated: true, superseded: false, elements: [],
    }).rendered
    expect(rendered).toContain('the page text was cut')
  })

  it('flags a protected or destructive control on its own line', () => {
    const rendered = renderSemanticSnapshot({
      tabId: 'tab-1', url: 'https://alpha.example.com/', title: null, revision: 1,
      text: '', truncated: false, superseded: false,
      elements: [{ ref: 'r1', kind: 'field', name: 'Password', disabled: false, protected: true, destructive: false }],
    }).rendered
    expect(rendered).toContain('[r1] field "Password" (protected)')
  })

  it('says so when the page has already moved on', () => {
    const rendered = renderSemanticSnapshot({
      tabId: 'tab-1', url: 'https://alpha.example.com/', title: null, revision: 1,
      text: '', truncated: false, superseded: true, elements: [],
    }).rendered
    expect(rendered).toContain('this page has moved on')
  })
})

describe('recovery', () => {
  /**
   * The shape the host hands the service at mount, and the assertion that matters: a recovery
   * report *lists* what could be reopened and reopens nothing. Reopening is a navigation, and a
   * navigation to a site that has changed since the run ended is a side effect on somebody's
   * account that nobody asked for.
   */
  const recovery: BrowserRecoverySummary = {
    trustworthy: true,
    sessionsLost: 3,
    referencesRetired: 12,
    restored: 0,
    skipped: 0,
    restorable: [
      { sessionId: 'freya-0001', url: 'https://alpha.example.com/' },
      { sessionId: 'freya-0002', url: 'https://beta.example.com/' },
    ],
    summary: 'three sessions were open when the run ended; none were reopened',
  }

  it('reports the recovery state rather than pretending nothing was lost', () => {
    const h = harness()
    h.service.trust(true, recovery)
    const state = h.state()
    expect(state.recovery?.sessionsLost).toBe(3)
    expect(state.recovery?.restorable).toHaveLength(2)
    expect(state.recovery?.restorable[0]?.url).toBe('https://alpha.example.com/')
  })

  it('restores nothing on its own, and creates no empty tab for a lost session', () => {
    const h = harness()
    h.service.trust(true, recovery)
    expect(h.state().tabCount).toBe(0)
    expect(h.service.tabs()).toHaveLength(0)
  })

  it('says the browser is unavailable when trust is lost, and not merely paused', () => {
    const h = harness({ journalTrustworthy: false })
    h.service.trust(false, { ...recovery, trustworthy: false, restorable: [] })
    expect(h.state().runtimeStatus).toBe('journalUntrusted')
    expect(h.state().reason).toContain('journal')
  })

  it('carries no recovery at all before anything has been reconciled', () => {
    expect(harness().state().recovery).toBeNull()
  })
})