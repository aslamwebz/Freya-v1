import { useEffect, useState } from 'react'
import type {
  ContextProjection,
  ContextReadOutcome,
} from '../../../core/protocol/context'
import { NO_CONTEXT_DOMAIN_REASON } from '../../../core/protocol/context'
import { contextMirror } from '../../platform/contextClient'
import { useContext } from '../../core/useContext'

/**
 * THE CONTEXT VIEW.
 *
 * This window answers one question: *what does Core say is around the current
 * question, and what does it say about where that came from?* Everything on
 * screen arrived in a `ContextProjection` carrying Core's own report of what is
 * held. There is no local
 * awareness, no optimistic item, and no simulated context — including when
 * there is nothing to show, in which case the window says plainly that no
 * Context domain is reporting rather than rendering an empty frame as though
 * Freya were quietly looking at something.
 *
 * ## What it deliberately does not do
 *
 * There is not one control in this file, and there is not one command submitted
 * from it. Core's vocabulary carries context commands, and this window reaches
 * none of them: the bridge whitelists no `context.*` name, so the one pull this
 * surface makes on mount exists so that a refusal to answer lands as a sentence
 * on screen rather than as a view that has quietly stopped being current — and
 * a pull carries no fields by construction, so there is nothing here that could
 * smuggle a provenance, a scope, a TTL or an authority toward Core even by
 * accident. Nothing captured, nothing selected, nothing revoked, nothing
 * resolved.
 *
 * ## Provenance, scope and TTL are Core's facts, shown as Core's words
 *
 * Each item line prints the kind, state, source class, scope and expiry the
 * projection carried, verbatim — including states this lane has never heard of.
 * An `expired` or `revoked` item is shown *as* expired or revoked, not hidden
 * and not redrawn as current, because a surface that tidied away the withdrawn
 * items of a quiet awareness would be a surface rendering context as trust when
 * it is only report. A reference with more than one candidate shows every
 * candidate: an ambiguous "this" is displayed as ambiguity, and this window
 * does not get to pick.
 */

/** Refusal and reason text is ours and bounded, like everything else here. */
const MAX_REASON_CHARS = 220

function bounded(text: string): string {
  return text.length > MAX_REASON_CHARS ? `${text.slice(0, MAX_REASON_CHARS - 1)}…` : text
}

/**
 * Counts in words, from Core's own numbers.
 *
 * Only the ones that say something: zeroes under an absent domain mean
 * "nobody counted", and the posture strip above already said so before this
 * line is ever drawn.
 */
function describeCounts(projection: ContextProjection): string {
  const c = projection.counts
  if (c.items === 0 && c.references === 0) return 'no context items, no open references'
  const parts: string[] = []
  if (c.items > 0) {
    parts.push(`${c.items} ${c.items === 1 ? 'item' : 'items'}`)
    if (c.current > 0) parts.push(`${c.current} current`)
    if (c.expired > 0) parts.push(`${c.expired} expired`)
    if (c.revoked > 0) parts.push(`${c.revoked} revoked`)
  } else {
    parts.push('no items')
  }
  if (c.references > 0) {
    parts.push(`${c.references} ${c.references === 1 ? 'reference' : 'references'}`)
    if (c.unresolvedReferences > 0) {
      parts.push(`${c.unresolvedReferences} unresolved`)
    }
  }
  return parts.join(' · ')
}

/** The TTL line, from Core's expiry facts only — never a locally-ticked clock. */
function ttlLine(item: ContextProjection['items'][number]): string {
  if (item.expiresAt === null && item.ttlSeconds === null) {
    return 'No expiry reported by Core.'
  }
  const expiry = item.expiresAt ?? 'expiry not reported'
  const ttl = item.ttlSeconds !== null ? ` · ${item.ttlSeconds}s granted` : ''
  return `Expires: ${expiry}${ttl}`
}

export function ContextSurface() {
  const projection = useContext()
  const [outcome, setOutcome] = useState<ContextReadOutcome | null>(null)

  /**
   * The single pull this surface makes, once per mount.
   *
   * It is a read of Core's projection with no arguments and no payload, and its
   * only job is to turn "Core could not be reached" into something a person can
   * see instead of something only a console sees.
   */
  useEffect(() => {
    let alive = true
    void contextMirror().read().then((answer) => {
      if (alive) setOutcome(answer)
    })
    return () => {
      alive = false
    }
  }, [])

  const notice =
    outcome !== null && !outcome.ok ? (
      <p className="context-read-notice" role="status">
        Core could not answer the context read: {bounded(outcome.reason ?? 'no reason given')}
      </p>
    ) : null

  if (projection === null) {
    return (
      <div className="context-surface" data-health="absent">
        <p className="context-absent">
          Context is not available. Core has not reported a Context projection, and this
          window will not guess at one.
        </p>
        {notice}
      </div>
    )
  }

  if (projection.health !== 'ready') {
    // Two different absences, and they must not read as each other: Core has
    // said *no Context domain exists* (what a Core without one reports), or
    // Core is simply not reporting context yet (a window that opened early,
    // or a Core that has not started). Matching the sentence Core exported is
    // what keeps the headline honest without this window paraphrasing it into
    // something stronger than Core claimed.
    const noDomain = projection.reason === NO_CONTEXT_DOMAIN_REASON
    return (
      <div className="context-surface" data-health="unavailable">
        <div
          className="context-posture"
          data-ready="false"
          data-domain={noDomain ? 'absent' : 'unknown'}
        >
          <b>{noDomain ? 'NO CONTEXT DOMAIN' : 'CONTEXT UNAVAILABLE'}</b>
          <span>
            {bounded(projection.reason ?? 'Core reports no Context, so there is nothing to show.')}
          </span>
          <span>
            Nothing on this screen is simulated and nothing here is captured by this
            window. When Core reports context, items arrive with the provenance, scope
            and expiry Core assigned them, exactly as Core said them.
          </span>
        </div>
        {notice}
      </div>
    )
  }

  return (
    <div className="context-surface" data-health="ready">
      <div className="context-posture" data-ready="true">
        <b>CONTEXT</b>
        <span>{describeCounts(projection)}</span>
        <span>
          Read-only. Provenance, scope, expiry and every state below are Core&apos;s own
          report; this window asserts none of them, resolves nothing, and captures nothing.
        </span>
      </div>

      {notice}

      {projection.items.length === 0 && projection.references.length === 0 ? (
        <p className="context-none">
          Core reports no context items and no open references. The Context domain is
          reporting and it is empty — which is a fact about the projection, not a paused
          view.
        </p>
      ) : null}

      {projection.items.length > 0 ? (
        <section className="context-section" aria-label="Context items">
          <h2>Items</h2>
          <div className="context-list">
            {projection.items.map((item) => (
              <article
                key={item.itemId}
                className="context-item"
                data-item-id={item.itemId}
                data-kind={item.kind}
                data-state={item.state}
              >
                <header>
                  <h3>{item.label ?? item.kind}</h3>
                  <code>{item.itemId}</code>
                  <span className="context-state">{item.state}</span>
                </header>

                <p className="context-kind">Kind: {item.kind} — Core&apos;s word.</p>

                <p className="context-provenance">
                  {item.provenance === null
                    ? 'Provenance: Core does not report one.'
                    : `Provenance: ${item.provenance.sourceClass}` +
                      (item.provenance.detail ? ` (${item.provenance.detail})` : '') +
                      (item.provenance.admittedAt ? ` · admitted ${item.provenance.admittedAt}` : '')}
                </p>

                <p className="context-scope">
                  {item.scope === null
                    ? 'Scope: Core does not report one.'
                    : `Scope: ${item.scope.label}` +
                      (item.scope.detail ? ` (${item.scope.detail})` : '')}
                </p>

                <p className="context-ttl">{ttlLine(item)}</p>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {projection.references.length > 0 ? (
        <section className="context-section" aria-label="References">
          <h2>References</h2>
          <div className="context-list">
            {projection.references.map((reference, index) => (
              <article
                key={`${reference.reference}:${index}`}
                className="context-reference"
                data-reference={reference.reference}
                data-status={reference.status}
              >
                <header>
                  <h3>“{reference.reference}”</h3>
                  <span className="context-state">{reference.status}</span>
                </header>
                <p className="context-resolves">
                  {reference.itemIds.length === 0
                    ? reference.reason ?? 'Core reports no resolution and gives no reason.'
                    : `${reference.itemIds.length === 1 ? 'Resolves to' : 'All candidates — Core left this open'}: ${reference.itemIds.join(', ')}` +
                      (reference.reason ? ` — ${reference.reason}` : '')}
                </p>
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  )
}
