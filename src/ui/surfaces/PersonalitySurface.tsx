import { useEffect, useState } from 'react'
import type {
  PersonalityProjection,
  PersonalityReadOutcome,
  PersonalityRelationshipItemView,
} from '../../../core/protocol/personality'
import { NO_PERSONALITY_DOMAIN_REASON } from '../../../core/protocol/personality'
import { personalityMirror } from '../../platform/personalityClient'
import { usePersonality } from '../../core/usePersonality'
import { expressionCueLine } from '../../presence/expressionCue'

/**
 * THE PERSONALITY VIEW.
 *
 * This window answers two questions: *who is Freya as a temperament*, and
 * *what has she actually recorded about you*. Everything on screen arrived in a
 * `PersonalityProjection` that Core built. There is no local record, no
 * optimistic row and no simulated relationship — including when there is
 * nothing to show, in which case the window says plainly that this build has no
 * Personality domain rather than rendering an empty intimacy as though the two
 * of you had simply drifted apart.
 *
 * ## What it deliberately does not do
 *
 * There is not one control in this file, and there is not one command submitted
 * from it. Core's vocabulary carries no `personality.*` name the bridge
 * whitelists, so the one pull this surface makes on mount exists so that a
 * refusal lands as a sentence on screen rather than as a view that quietly
 * stopped being current — and a pull carries no fields by construction, so
 * there is nothing here that could smuggle a preference, a habit, an inside
 * joke, a confidence or a cue toward Core even by accident.
 *
 * ## Records are drawn as metadata, never as content
 *
 * Each record prints its key, kind, status, source class, confidence and
 * admitted instant — Core's words, verbatim. The recorded `text` never crosses
 * the bridge and therefore cannot appear here, which is the point: a window
 * that displayed what was said about a person would be a window holding the
 * private half of a relationship wherever its cache happens to live. A
 * `candidate` row is shown as a candidate and a `superseded` row as
 * superseded, because a projection that tidied away the records Freya has not
 * decided about would be reporting a relationship more settled than it is.
 *
 * ## Style is subordinate, and this window says so out loud
 *
 * The temperament strip carries the subordination claim as Core sent it —
 * Constitution first, identity supersedes temperament, and the list of things
 * style may never weaken — because that claim is a fact about the artefact a
 * person is reading, not a promise buried in a comment.
 */

/** Refusal text is ours and bounded, like everything else here. */
const MAX_REASON_CHARS = 220

function bounded(text: string): string {
  return text.length > MAX_REASON_CHARS ? `${text.slice(0, MAX_REASON_CHARS - 1)}…` : text
}

/** Counts in words, from Core's own numbers. */
function describeCounts(projection: PersonalityProjection): string {
  const c = projection.counts
  if (c.items === 0) return 'no records'
  const parts: string[] = [`${c.items} ${c.items === 1 ? 'record' : 'records'}`]
  if (c.admitted > 0) parts.push(`${c.admitted} admitted`)
  if (c.candidate > 0) parts.push(`${c.candidate} candidate`)
  if (c.rejected > 0) parts.push(`${c.rejected} rejected`)
  if (c.superseded > 0) parts.push(`${c.superseded} superseded`)
  if (c.dropped > 0) parts.push(`${c.dropped} not projected`)
  if (c.cuesAdmitted > 0) parts.push(`${c.cuesAdmitted} with a cue`)
  return parts.join(' · ')
}

/**
 * One record, as metadata.
 *
 * Every field is a word or a slug Core supplied. Nothing here is re-spelled,
 * recoloured by status or shortened into something friendlier: `superseded`
 * reads as superseded.
 */
function recordLine(item: PersonalityRelationshipItemView): string {
  const cue = item.cueKind === null ? '' : ` · cue: ${item.cueKind}`
  const admitted = item.admittedAt === null ? ' · not admitted' : ` · admitted ${item.admittedAt}`
  return `${item.key} (${item.kind}) · ${item.status} · ${item.sourceType} · ${item.confidence}${cue}${admitted}`
}

export function PersonalitySurface() {
  const projection = usePersonality()
  const [outcome, setOutcome] = useState<PersonalityReadOutcome | null>(null)

  /**
   * The single pull this surface makes, once per mount — argument-free, so its
   * only job is turning "Core could not be reached" into something visible.
   */
  useEffect(() => {
    let alive = true
    void personalityMirror().read().then((answer) => {
      if (alive) setOutcome(answer)
    })
    return () => {
      alive = false
    }
  }, [])

  const notice =
    outcome !== null && !outcome.ok ? (
      <p className="personality-read-notice" role="status">
        Core could not answer the personality read: {bounded(outcome.reason ?? 'no reason given')}
      </p>
    ) : null

  if (projection === null) {
    return (
      <div className="personality-surface" data-health="absent">
        <p className="personality-absent">
          Personality is not available. Core has not reported a projection, and this window
          will not guess at one.
        </p>
        {notice}
      </div>
    )
  }

  if (projection.health !== 'ready') {
    // Two different absences, kept apart: Core has said *no Personality domain
    // exists* (what a build with no relationship record reports), or Core has
    // simply not been reached yet (a window that opened early). Quoting Core's
    // own sentence is what keeps the headline honest without this window
    // claiming more than Core did.
    const noDomain = projection.reason === NO_PERSONALITY_DOMAIN_REASON
    return (
      <div className="personality-surface" data-health="unavailable">
        <div
          className="personality-posture"
          data-ready="false"
          data-domain={noDomain ? 'absent' : 'unknown'}
        >
          <b>{noDomain ? 'NO PERSONALITY DOMAIN' : 'PERSONALITY UNAVAILABLE'}</b>
          <span>
            {bounded(
              projection.reason ??
                'Core reports no Personality domain, so there is nothing to show.',
            )}
          </span>
          <span>
            Nothing on this screen is simulated. When a relationship record exists, its
            metadata appears here exactly as Core reports it — never the recorded text.
          </span>
        </div>
        {notice}
      </div>
    )
  }

  const cue = expressionCueLine(projection.presenceCue)

  return (
    <div className="personality-surface" data-health="ready">
      <div className="personality-posture" data-ready="true">
        <b>PERSONALITY</b>
        <span>{describeCounts(projection)}</span>
        <span>
          Read-only. Every level, key, status and confidence below is Core's own; this window
          cannot record, admit, forget or choose anything.
        </span>
      </div>

      {notice}

      {projection.temperament === null ? (
        <p className="personality-none">Core reports no temperament table.</p>
      ) : (
        <section className="personality-section" aria-label="Temperament">
          <h2>Temperament</h2>
          <div className="personality-temperament">
            {projection.temperament.dimensions.map((row) => (
              <span key={row.dimension} className="personality-dimension" data-level={row.level}>
                {row.dimension}: {row.level}
              </span>
            ))}
          </div>
          <p className="personality-subordination">
            Constitution first · identity supersedes temperament · style may never weaken{' '}
            {projection.temperament.cannotWeaken.join(', ')}.
          </p>
        </section>
      )}

      <section className="personality-section" aria-label="Relationship record">
        <h2>Relationship record</h2>
        {projection.items.length === 0 ? (
          <p className="personality-none">
            Core reports no records. That is a fact about the record, not a paused view — and
            it is not read as one about the relationship.
          </p>
        ) : (
          <ul className="personality-records" aria-label="Recorded items">
            {projection.items.map((item) => (
              <li key={item.itemId} className="personality-record" data-status={item.status}>
                {recordLine(item)}
              </li>
            ))}
          </ul>
        )}
        <p className="personality-note">
          Metadata only. The recorded text, its tags and the reason it was admitted stay in
          Core; nothing here can show them, and nothing here was written by this window.
        </p>
      </section>

      {projection.interpretation === null ? null : (
        <section className="personality-section" aria-label="Interpretation">
          <h2>This moment</h2>
          <p className="personality-interpretation">
            {projection.interpretation.continuity} · {projection.interpretation.formality} formality
            · greeting {projection.interpretation.greetingEligible ? 'eligible' : 'not eligible'} ·{' '}
            {projection.interpretation.preferenceHits} preference hits ·{' '}
            {projection.interpretation.factsConsidered} facts considered
          </p>
          <p className="personality-note">
            Computed by Core from records and observed events only. It reports what can be
            checked; it says nothing about how anyone feels.
          </p>
        </section>
      )}

      {projection.expression === null ? null : (
        <section className="personality-section" aria-label="Expression">
          <h2>Expression</h2>
          <p className="personality-expression">
            {projection.expression.cuesOffered} offered · {projection.expression.cuesHeld} held ·{' '}
            {projection.expression.suppressedCueCount} suppressed by anti-repetition ·{' '}
            {projection.expression.estimatedTokens} estimated tokens
          </p>
          <p className="personality-note">
            Counts, not the guidance: the style lines are addressed to the model and never
            cross this bridge. Style may never weaken {projection.expression.cannotWeaken.join(', ')}.
          </p>
        </section>
      )}

      <p className="personality-cue" data-cue={cue === null ? 'none' : 'offered'}>
        {cue ?? 'No expression cue offered this turn.'}
      </p>

      {projection.repetition === null ? null : (
        <p className="personality-note">
          Anti-repetition ledger: {projection.repetition.entries} of{' '}
          {projection.repetition.maxEntries} metadata entries. Hashes and instants only — never
          what was said.
        </p>
      )}
    </div>
  )
}
