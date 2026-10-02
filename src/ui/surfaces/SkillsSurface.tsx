import { useEffect, useState } from 'react'
import type {
  SkillCommandOutcome,
  SkillDetailView,
  SkillProjection,
  SkillSelectionReport,
} from '../../../core/protocol/skills'
import { NO_SKILL_DOMAIN_REASON } from '../../../core/protocol/skills'
import {
  SKILL_KINDS,
  SKILL_RETIREMENT_REASONS,
  SKILL_STATUSES,
  type SkillKind,
} from '../../../core/skills/types'
import { skillsMirror } from '../../platform/skillsClient'
import { useSkills } from '../../core/useSkills'

/**
 * THE SKILLS VIEW.
 *
 * This window answers three questions: *what procedures does Freya have*, *what
 * evidence stands behind each one*, and *what has she decided to do with them*.
 * Everything on screen arrived in a `SkillProjection` Core built. There is no local
 * status, no local verdict, no local threshold and no local sort — including when there
 * is nothing to show, in which case the window says plainly that this build has no
 * Skill domain rather than rendering "Freya has learned nothing" as though she had been
 * offered the chance.
 *
 * ## What it deliberately does not do
 *
 * It cannot invent a verdict, a status or an evidence item. Those are Core's own closed
 * labels, printed verbatim, and a refusal is rendered with its **code** so "this may
 * never be true" and "this is not true yet" cannot be confused. Model commentary
 * appears as a **character count next to the verdict**, which is the whole point: a
 * reader can see that four thousand characters of opinion moved nothing.
 *
 * A procedure's summary and contract descriptions are **not** in the projection. The
 * one way to read them back is the explicit, per-skill read below — which asks Core for
 * exactly one procedure rather than holding a standing feed of every one of them.
 *
 * ## What it can do, and only what Core permits
 *
 * Admit a procedure, revise one, report an observation about one, ask Core to move a
 * status, retire one, propose an improvement, and ask for a deterministic selection.
 * None of those carries a trust class, a verification state, a verification record, a
 * threshold or a version. There is no control here that promotes an artifact into
 * Freya's running code, because that operation does not exist in this build and the
 * window has nothing to call.
 */

const MAX_REASON_CHARS = 240

function bounded(text: string): string {
  return text.length > MAX_REASON_CHARS ? `${text.slice(0, MAX_REASON_CHARS - 1)}…` : text
}

function describeCounts(projection: SkillProjection): string {
  const c = projection.counts
  if (c.retained === 0) return 'no procedures recorded'
  const parts: string[] = [`${c.retained} recorded`]
  if (c.promoted > 0) parts.push(`${c.promoted} promoted`)
  parts.push(`${c.executable} executable`)
  parts.push(`${c.established} established evaluation(s)`)
  if (c.contradicted > 0) parts.push(`${c.contradicted} contradicted`)
  if (c.inconclusive > 0) parts.push(`${c.inconclusive} inconclusive`)
  if (c.retirements > 0) parts.push(`${c.retirements} retired`)
  return parts.join(' · ')
}

/** The one thing worth saying about model commentary, in one line. */
function describeCommentary(skill: SkillProjection['skills'][number]): string | null {
  const last = skill.lastEvaluation
  if (last === null || last.commentaryChars === 0) return null
  return `${last.commentaryChars} characters of model commentary, which changed no verdict`
}

/** A plain procedure draft, so the surface is usable without a form library. */
function draft(): {
  name: string
  kind: SkillKind
  summary: string
  tags: string
  capability: string
  verifier: string
} {
  return {
    name: '',
    kind: 'procedure',
    summary: '',
    tags: 'research',
    capability: '',
    verifier: '',
  }
}

function toPayload(input: ReturnType<typeof draft>, name: string) {
  return {
    name: input.name.trim().length > 0 ? input.name.trim() : name,
    kind: input.kind,
    summary: input.summary.trim(),
    contract: {
      inputs: [{ name: 'subject', description: 'What this procedure is asked to act on.' }],
      outputs: [{ name: 'result', description: 'What this procedure produces, once verified.' }],
      preconditions: [],
      postconditions: [
        { name: 'verified', description: 'The producing step closed on its registered verifier.' },
      ],
    },
    applicability: input.tags
      .split(/[\s,]+/)
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0),
    requiredCapabilities: [input.capability.trim()],
    steps: [{ key: 'step-1', capability: input.capability.trim(), verifier: input.verifier.trim() }],
  }
}

export function SkillsSurface() {
  const projection = useSkills()
  const [outcome, setOutcome] = useState<SkillCommandOutcome | null>(null)
  const [form, setForm] = useState(draft())
  const [detail, setDetail] = useState<SkillDetailView | null>(null)
  const [selection, setSelection] = useState<SkillSelectionReport | null>(null)

  useEffect(() => {
    let alive = true
    void skillsMirror()
      .read()
      .then(() => {
        if (!alive) return
      })
    return () => {
      alive = false
    }
  }, [])

  const admit = async (): Promise<void> => {
    const answer = await skillsMirror().admit(toPayload(form, 'new-procedure'))
    setOutcome(answer)
    if (answer.ok) setForm(draft())
  }

  const askSelection = async (): Promise<void> => {
    const report = await skillsMirror().select({
      applicability: form.tags.split(/[\s,]+/).filter((tag) => tag.trim().length > 0),
      includeTrial: true,
    })
    setSelection(report)
    setOutcome({
      operation: 'selected',
      ok: report !== null,
      ...(report === null ? { reason: 'Core did not answer the selection' } : {}),
    })
  }

  if (projection === null) {
    return (
      <div className="skills-surface" data-health="absent">
        <p className="skills-absent">
          Skills are not available. Core has not reported a projection, and this window will not guess
          at one.
        </p>
      </div>
    )
  }

  if (projection.health !== 'ready') {
    const noDomain = projection.reason === NO_SKILL_DOMAIN_REASON
    return (
      <div className="skills-surface" data-health="unavailable">
        <div className="skills-posture" data-ready="false" data-domain={noDomain ? 'absent' : 'unknown'}>
          <b>{noDomain ? 'NO SKILL DOMAIN' : 'SKILLS UNAVAILABLE'}</b>
          <span>
            {bounded(projection.reason ?? 'Core reports no Skill domain, so there is nothing to show.')}
          </span>
          <span>
            Nothing on this screen is simulated. “No procedures” is a Core fact; it is never this
            window’s guess.
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="skills-surface" data-health="ready">
      <div className="skills-posture" data-ready="true" data-durable={String(projection.persistence.durable)}>
        <b>SKILLS</b>
        <span>{describeCounts(projection)}</span>
        <span>
          Bodies are {projection.persistence.mode} at rest. Every status, verdict and reason below is
          Core’s own; this window cannot invent one, submit a verification record, or move a
          threshold.
        </span>
        {projection.persistence.reason === null ? null : (
          <span>{bounded(projection.persistence.reason)}</span>
        )}
      </div>

      {outcome !== null && !outcome.ok ? (
        <p className="skills-notice" role="status" data-code={outcome.code ?? 'none'}>
          Core refused that ({outcome.code ?? 'no code'}): {bounded(outcome.reason ?? 'no reason given')}
        </p>
      ) : null}

      <section className="skills-section" aria-label="Procedures">
        <h2>Procedures</h2>
        {projection.skills.length === 0 ? (
          <p className="skills-none">
            Core holds no procedures. That is a fact about this install, not a placeholder.
          </p>
        ) : (
          <ul className="skills-list">
            {projection.skills.map((skill) => (
              <li
                key={skill.skillId}
                data-status={skill.status}
                data-verification={skill.verification}
                data-trust={skill.trustClass}
              >
                <span className="skills-name">{skill.name}</span>{' '}
                <span className="skills-state">
                  v{skill.version} · {skill.status} · {skill.verification} · {skill.kind} ·{' '}
                  {skill.trustClass} trust
                </span>
                <span className="skills-tags">
                  applies to {skill.applicability.join(', ')} · {skill.stepCount} step(s) ·{' '}
                  {skill.inputCount}/{skill.outputCount} input/output ·{' '}
                  {skill.summaryLength} characters of summary
                </span>
                {skill.lastEvaluation === null ? (
                  <span className="skills-evidence">no evaluation yet</span>
                ) : (
                  <span className="skills-evidence" data-verdict={skill.lastEvaluation.verdict}>
                    last: {skill.lastEvaluation.verdict} ({skill.lastEvaluation.reason}) from{' '}
                    {skill.lastEvaluation.deterministicCount} deterministic item(s)
                    {describeCommentary(skill) === null ? null : ` — ${describeCommentary(skill)}`}
                  </span>
                )}
                {skill.retirementReason === null ? null : (
                  <span className="skills-retired">retired: {skill.retirementReason}</span>
                )}
                <span className="skills-actions">
                  {skill.status === 'candidate' ? (
                    <button
                      type="button"
                      onClick={() =>
                        void skillsMirror().transition(skill.skillId, 'draft').then(setOutcome)
                      }
                    >
                      Mark reviewed
                    </button>
                  ) : null}
                  {skill.status === 'trial' || skill.status === 'verified' ? (
                    <button
                      type="button"
                      onClick={() =>
                        void skillsMirror().transition(skill.skillId, 'promoted').then(setOutcome)
                      }
                    >
                      Ask Core to promote
                    </button>
                  ) : null}
                  {skill.status === 'promoted' || skill.status === 'trial' ? (
                    <button
                      type="button"
                      onClick={() =>
                        void skillsMirror().transition(skill.skillId, 'draft').then(setOutcome)
                      }
                    >
                      Withdraw from use
                    </button>
                  ) : null}
                  {skill.status === 'retired' || skill.status === 'blocked' ? null : (
                    <button
                      type="button"
                      onClick={() =>
                        void skillsMirror()
                          .retire(skill.skillId, 'owner-request')
                          .then(setOutcome)
                      }
                    >
                      Retire
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      void skillsMirror()
                        .readDetail(skill.skillId)
                        .then((read) => setDetail(read))
                    }
                  >
                    Read
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
        {detail === null ? null : (
          <div className="skills-detail" data-skill={detail.skillId}>
            <p className="skills-detail-summary">{bounded(detail.summary)}</p>
            <ul className="skills-detail-contract">
              {[...detail.contract.inputs, ...detail.contract.outputs, ...detail.contract.preconditions, ...detail.contract.postconditions].map(
                (entry) => (
                  <li key={`${entry.name}`} data-entry={entry.name}>
                    {entry.name}: {bounded(entry.description)}
                  </li>
                ),
              )}
            </ul>
            <p className="skills-detail-provenance">
              v{detail.version} · {detail.provenance.source} · {detail.provenance.trustClass} · admitted by{' '}
              {detail.provenance.admittedBy}
              {detail.provenance.parentVersion === null
                ? ''
                : ` · revised from v${detail.provenance.parentVersion}`}
            </p>
            <p className="skills-detail-note">
              This is the owner’s own procedure text. It came back from one explicit read; it is not
              a standing feed and it is not in the projection.
            </p>
          </div>
        )}
      </section>

      <section className="skills-section" aria-label="Record a procedure">
        <h2>Record a procedure</h2>
        <label>
          Name
          <input
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            maxLength={64}
          />
        </label>
        <label>
          Kind
          <select
            value={form.kind}
            onChange={(event) => setForm({ ...form, kind: event.target.value as SkillKind })}
          >
            {SKILL_KINDS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label>
          What it is for
          <input
            value={form.summary}
            onChange={(event) => setForm({ ...form, summary: event.target.value })}
            maxLength={400}
          />
        </label>
        <label>
          Applies to
          <input
            value={form.tags}
            onChange={(event) => setForm({ ...form, tags: event.target.value })}
            maxLength={200}
          />
        </label>
        <label>
          Capability it needs
          <input
            value={form.capability}
            onChange={(event) => setForm({ ...form, capability: event.target.value })}
            maxLength={128}
          />
        </label>
        <label>
          Verifier that closes its step
          <input
            value={form.verifier}
            onChange={(event) => setForm({ ...form, verifier: event.target.value })}
            maxLength={128}
          />
        </label>
        <button type="button" onClick={() => void admit()}>
          Record as a candidate
        </button>
        <button type="button" onClick={() => void askSelection()}>
          Ask Core which procedures apply
        </button>
        <p className="skills-note">
          A recorded procedure is a <b>candidate</b>: nothing is executable, verified or promoted
          until recorded evaluations say so. This form cannot name a trust class, a status or a
          threshold — Core assigns all three.
        </p>
      </section>

      {selection === null ? null : (
        <section className="skills-section" aria-label="Core's selection">
          <h2>Core’s selection</h2>
          {selection.emptyReason === null ? null : (
            <p className="skills-none">{selection.emptyReason.replace(/-/g, ' ')}</p>
          )}
          <ol className="skills-selection">
            {selection.candidates.map((candidate) => (
              <li key={candidate.skillId} data-status={candidate.status}>
                {candidate.name} · v{candidate.version} · {candidate.status} ·{' '}
                {candidate.establishedCount} established · matched{' '}
                {candidate.matchedTags.join(', ') || 'no tags'}
              </li>
            ))}
          </ol>
          <p className="skills-note">
            This is Core’s order and Core’s evidence. The window does not re-sort it, because a
            window that chose which procedure to prefer would be choosing what Freya is allowed to do.
          </p>
        </section>
      )}

      <section className="skills-section" aria-label="Improvement">
        <h2>Improvement</h2>
        {projection.proposals.length === 0 ? (
          <p className="skills-none">Core holds no open improvement proposal.</p>
        ) : (
          <ul className="skills-proposals">
            {projection.proposals.map((proposal) => (
              <li key={proposal.proposalId} data-target={proposal.target}>
                {proposal.target} · {proposal.targetRef} · resting on {proposal.basisCount} recorded
                evaluation(s) · proposed by {proposal.proposedBy}
                <button
                  type="button"
                  onClick={() =>
                    void skillsMirror()
                      .settleProposal(proposal.proposalId, 'refused', 'revision-limit')
                      .then(setOutcome)
                  }
                >
                  Refuse
                </button>
              </li>
            ))}
          </ul>
        )}
        {projection.runtimePromotionRefusals.length === 0 ? null : (
          <p className="skills-note">
            {projection.runtimePromotionRefusals.length} request(s) to put an artifact into Freya’s
            running code were refused. This build has no workflow that could allow one.
          </p>
        )}
        <p className="skills-limits">
          Thresholds Core will not bend: {projection.thresholds.minEstablishedForPromoted} established
          evaluation(s) across {projection.thresholds.minDistinctSubjectsForPromoted} subjects, at most{' '}
          {projection.thresholds.maxContradictedForPromoted} contradicted, and{' '}
          {projection.thresholds.maxRevisionsPerSkill} revisions per procedure so an improvement loop
          has to converge.
        </p>
        <p className="skills-limits">
          Retirement reasons Core records: {SKILL_RETIREMENT_REASONS.join(', ')}. Statuses Core knows:{' '}
          {SKILL_STATUSES.join(', ')}.
        </p>
      </section>
    </div>
  )
}