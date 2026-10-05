import { describe, expect, it } from 'vitest'
import {
  auditHandoffLedger,
  createHandoffEnvelope,
  foldHandoffs,
  settleUnfinished,
  verifyHandoffEnvelope,
  type HandoffContext,
  type HandoffEnvelope,
  type HandoffTransition,
} from '../../../core/browser'

const OFFERED_AT = '2026-01-01T00:00:00.000Z'
const NOW = Date.parse(OFFERED_AT)

function offer(overrides: Partial<Parameters<typeof createHandoffEnvelope>[0]> = {}) {
  return createHandoffEnvelope({
    handoffId: 'handoff-0001',
    from: 'public',
    to: 'authenticated',
    url: 'https://example.com/invoices/42',
    reason: 'this page is a sign-in wall',
    offeredAt: OFFERED_AT,
    ...overrides,
  })
}

function envelopeOf(reading: ReturnType<typeof offer>): HandoffEnvelope {
  if (!reading.ok) throw new Error(`setup failed: ${reading.reason}`)
  return reading.envelope
}

describe('the handoff envelope', () => {
  it('passes its own audit', () => {
    expect(auditHandoffLedger()).toEqual([])
  })

  it('carries a URL, a reason, a title and a note — and nothing else', () => {
    const envelope = envelopeOf(offer({ context: { title: 'Invoices', note: 'needs a login' } }))
    expect(envelope.url).toBe('https://example.com/invoices/42')
    expect(envelope.context.title).toBe('Invoices')
    expect(envelope.context.note).toBe('needs a login')
    expect(Object.keys(envelope.context).sort()).toEqual(['note', 'title'])
  })

  it('drops a context field that is not on the closed list, rather than carrying it quietly', () => {
    const envelope = envelopeOf(
      offer({ context: { title: 'Invoices', referrer: 'https://x/', depth: 3 } as unknown as HandoffContext }),
    )
    expect(Object.keys(envelope.context)).toEqual(['title'])
  })

  it('refuses the whole envelope when an off-list field names a credential, rather than dropping it', () => {
    const reading = offer({ context: { title: 'Invoices', cookies: 'sid=abc' } as unknown as HandoffContext })
    expect(reading.ok).toBe(false)
    if (!reading.ok) expect(reading.code).toBe('credential-carry-refused')
  })

  it('refuses to carry a credential under any key, or behind an innocent one', () => {
    for (const context of [
      { cookies: 'sid=abc' },
      { note: 'Authorization: Bearer abcdefghijklmnop' },
      { title: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefgh' },
      { note: 'sid=abc; csrftoken=def' },
      { localStorage: 'x' },
    ]) {
      const reading = offer({ context: context as HandoffContext })
      expect(reading.ok, JSON.stringify(Object.keys(context)[0])).toBe(false)
      if (!reading.ok) expect(reading.code).toBe('credential-carry-refused')
    }
  })

  it('still allows a note that merely mentions a URL with a query string', () => {
    const reading = offer({ context: { note: 'see https://example.com/a?x=1&y=2 for detail' } })
    expect(reading.ok).toBe(true)
  })

  it('refuses an offer from a browser to itself, and a malformed id', () => {
    const same = offer({ to: 'public' })
    expect(same.ok).toBe(false)
    if (!same.ok) expect(same.code).toBe('handoff-target-mismatch')
    for (const handoffId of ['', 'short', 'HAS-CAPS', 'has spaces', 'x'.repeat(80)]) {
      const reading = offer({ handoffId })
      expect(reading.ok, handoffId).toBe(false)
    }
  })

  it('refuses a ttl wider than this build will act on', () => {
    const wide = offer({ ttlMs: 24 * 60 * 60_000 })
    expect(wide.ok).toBe(false)
    const narrow = offer({ ttlMs: 60_000 })
    expect(narrow.ok).toBe(true)
    if (narrow.ok) expect(narrow.envelope.expiresAt).toBe(NOW + 60_000)
  })

  it('verifies only for the browser it was offered to, and only while fresh', () => {
    const envelope = envelopeOf(offer())
    expect(verifyHandoffEnvelope(envelope, { to: 'authenticated', now: NOW + 1, state: 'open' }).ok).toBe(true)
    const wrongTarget = verifyHandoffEnvelope(envelope, { to: 'public', now: NOW + 1, state: 'open' })
    expect(wrongTarget.ok).toBe(false)
    if (!wrongTarget.ok) expect(wrongTarget.code).toBe('handoff-target-mismatch')
    const late = verifyHandoffEnvelope(envelope, { to: 'authenticated', now: envelope.expiresAt + 1, state: 'open' })
    expect(late.ok).toBe(false)
    if (!late.ok) expect(late.code).toBe('handoff-expired')
  })

  it('fails verification when any field was changed after the offer', () => {
    const envelope = envelopeOf(offer())
    for (const tampered of [
      { ...envelope, url: 'https://attacker.example/' },
      { ...envelope, to: 'public' as const },
      { ...envelope, reason: 'something else entirely' },
      { ...envelope, context: { title: 'Invoices', note: 'and a secret' } },
    ]) {
      const reading = verifyHandoffEnvelope(tampered, { to: 'authenticated', now: NOW + 1, state: 'open' })
      expect(reading.ok).toBe(false)
    }
  })

  it('will not verify an envelope whose outcome is uncertain or already settled', () => {
    const envelope = envelopeOf(offer())
    const expected = {
      uncertain: 'handoff-uncertain',
      consumed: 'handoff-already-settled',
      cancelled: 'handoff-already-settled',
      expired: 'handoff-already-settled',
    } as const
    for (const [state, code] of Object.entries(expected)) {
      const reading = verifyHandoffEnvelope(envelope, {
        to: 'authenticated',
        now: NOW + 1,
        state: state as 'uncertain' | 'consumed' | 'cancelled' | 'expired',
      })
      expect(reading.ok, state).toBe(false)
      if (!reading.ok) expect(reading.code, state).toBe(code)
    }
  })
})

describe('the handoff ledger', () => {
  const offered: HandoffTransition = {
    type: 'browser.dual.handoff.offered',
    payload: {
      handoffId: 'handoff-0001',
      from: 'public',
      to: 'authenticated',
      url: 'https://example.com/',
      digest: 'digest-1',
      at: OFFERED_AT,
    },
  }

  it('folds an offer, a consume and a settle', () => {
    const open = foldHandoffs([offered])
    expect(open.handoffs.get('handoff-0001')?.state).toBe('open')

    const consumed = foldHandoffs([offered, { type: 'browser.dual.handoff.consumed', payload: { handoffId: 'handoff-0001', at: OFFERED_AT } }])
    expect(consumed.handoffs.get('handoff-0001')?.state).toBe('consumed')

    const cancelled = foldHandoffs([offered, { type: 'browser.dual.handoff.settled', payload: { handoffId: 'handoff-0001', state: 'cancelled', at: OFFERED_AT } }])
    expect(cancelled.handoffs.get('handoff-0001')?.state).toBe('cancelled')
  })

  it('leaves an offer open within the run that made it, and only turns it uncertain when the record ends', () => {
    const state = foldHandoffs([offered])
    expect(state.handoffs.get('handoff-0001')?.state).toBe('open')
    const ended = settleUnfinished(state)
    expect(ended.handoffs.get('handoff-0001')?.state).toBe('uncertain')
    expect(ended.uncertain).toEqual(['handoff-0001'])
  })

  it('never lets a consume entry revive an uncertain handoff on replay', () => {
    const ended = settleUnfinished(foldHandoffs([offered]))
    const revived = foldHandoffs(
      [{ type: 'browser.dual.handoff.consumed', payload: { handoffId: 'handoff-0001', at: OFFERED_AT } }],
      ended,
    )
    expect(revived.handoffs.get('handoff-0001')?.state).toBe('uncertain')
  })

  it('does not let a re-offer un-consume a settled handoff', () => {
    const consumed = foldHandoffs([offered, { type: 'browser.dual.handoff.consumed', payload: { handoffId: 'handoff-0001', at: OFFERED_AT } }])
    expect(consumed.handoffs.get('handoff-0001')?.state).toBe('consumed')
    const reOffered = foldHandoffs([offered], consumed)
    expect(reOffered.handoffs.get('handoff-0001')?.state).toBe('consumed')
  })

  it('ignores entries it does not recognise and entries about handoffs it never saw offered', () => {
    const state = foldHandoffs([
      { type: 'hands.browser.performed', payload: { actionId: 'a1' } },
      { type: 'browser.dual.page.described', payload: { sessionId: 'freya-0001' } },
      { type: 'browser.dual.handoff.consumed', handoffId: 'handoff-9999', at: OFFERED_AT },
      null,
      'not an entry',
    ])
    expect(state.handoffs.size).toBe(0)
    expect(state.uncertain).toEqual([])
  })
})