import { useEffect, useState } from 'react'
import type { ResearchCommandOutcome } from '../../../core/protocol/core-protocol'
import { researchMirror } from '../../platform/researchClient'

/**
 * The Research surface.
 *
 * Bounded, cited deep research. The interesting part is not that it can start a
 * research job but that it is honest about one:
 *
 *   - **Progress is real.** The stage comes from Core, not from a spinner this window
 *     invented, and the counters are the ones Core actually counted.
 *   - **Partial means partial.** A research job that gathered three of five sources
 *     says so, and names the failures, rather than presenting what it managed to read
 *     as though it were the whole answer.
 *   - **Nothing is called verified.** Research is retrieval. The sources are pages
 *     somebody wrote, and the answer is a model summarising pages somebody wrote;
 *     Phase 4 already established that a stored claim is not proof, and this window
 *     must not quietly reverse that.
 *
 * All remote and model text renders as React children. There is no
 * `dangerouslySetInnerHTML` in this file, and that is the whole security property of
 * the surface: a page or an answer can contain `<script>`, and React renders it as
 * the characters `<` and `>`.
 */

type Phase =
  | { kind: 'idle' }
  | { kind: 'running'; question: string }
  | { kind: 'done'; outcome: ResearchCommandOutcome['result'] }
  | { kind: 'failed'; reason: string }

export function ResearchSurface() {
  const mirror = researchMirror()
  const [question, setQuestion] = useState('')
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [status, setStatus] = useState(mirror.status)

  useEffect(() => mirror.subscribe(setStatus), [mirror])

  // Asked once, on attach. Never on a timer and never on a poll loop: the surface
  // opens to nothing happening, which is the honest state for a window that has not
  // been asked to do anything.
  useEffect(() => {
    void mirror.refresh()
    return () => {}
  }, [mirror])

  const start = async () => {
    const value = question.trim()
    if (value.length === 0) return
    setPhase({ kind: 'running', question: value })
    const outcome = await mirror.research(value)
    if (outcome.result) setPhase({ kind: 'done', outcome: outcome.result })
    else setPhase({ kind: 'failed', reason: outcome.reason ?? 'Freya could not start that research.' })
  }

  const cancel = async () => {
    const id = status.operationId
    if (id === null) return
    await mirror.cancel(id)
    // The running promise still settles; this only stops claiming to be busy.
    setPhase({ kind: 'idle' })
  }

  const running = phase.kind === 'running'

  return (
    <div className="research-surface">
      <p className="research-boundary">
        Research reads public web pages and summarises them. A page somebody wrote is not a fact,
        and an answer is not verified. Every finding names the sources it came from so you can check
        it yourself.
      </p>

      <section className="research-section">
        <h3>What should Freya find out?</h3>
        <label className="research-field">
          <span>Research question</span>
          <textarea
            aria-label="Research question"
            value={question}
            rows={3}
            maxLength={4096}
            placeholder="e.g. how does Freya keep what it learns between restarts?"
            onChange={(event) => setQuestion(event.target.value)}
          />
        </label>
        <div className="research-actions">
          <button
            type="button"
            className="research-button"
            disabled={running || question.trim().length === 0}
            onClick={() => void start()}
          >
            {running ? 'Researching…' : 'Start research'}
          </button>
          {running ? (
            <button type="button" className="research-cancel" onClick={() => void cancel()}>
              Cancel
            </button>
          ) : null}
        </div>
        {running ? <p className="research-stage">{describeStage(status.stage)}</p> : null}
      </section>

      {/* The ceilings are shown before anything is asked for, not after. A person
          deciding whether to spend a research run is entitled to know what it costs. */}
      <section className="research-section">
        <h3>Limits</h3>
        <p className="research-limits">
          Core owns these. They cannot be raised from this window, and a page or a model cannot raise
          them either.
        </p>
        <ul className="research-limit-list">
          <li>5 model turns</li>
          <li>6 pages read</li>
          <li>4 web queries</li>
          <li>2 rounds of follow-up</li>
          <li>120 seconds</li>
        </ul>
        <p className="research-limits-note">{describeAvailability(status.availability, status.reason)}</p>
      </section>

      {phase.kind === 'failed' ? (
        <p className="research-failure" role="alert">
          {phase.reason}
        </p>
      ) : null}

      {phase.kind === 'done' && phase.outcome ? <Findings result={phase.outcome} /> : null}
    </div>
  )
}

/**
 * Findings, conflicts and sources.
 *
 * Every finding carries its source ids and the sources are listed below, so a claim
 * and its basis are always on the same screen. A citation that cannot be followed
 * would be decoration.
 */
function Findings({ result }: { result: NonNullable<ResearchCommandOutcome['result']> }) {
  const byId = new Map(result.sources.map((source) => [source.sourceId, source]))
  return (
    <section className="research-section">
      <h3>
        {result.state === 'completed'
          ? 'Findings'
          : result.state === 'partial'
            ? 'Findings (partial)'
            : result.state === 'cancelled'
              ? 'Findings (cancelled)'
              : 'Findings (none)'}
      </h3>

      {result.state !== 'completed' ? (
        <p className="research-partial">
          This research is <b>{result.state}</b>. What follows is everything gathered before the
          research stopped — not a complete answer.
        </p>
      ) : null}

      {result.failures.length > 0 ? (
        <ul className="research-failures">
          {result.failures.map((failure, index) => (
            <li key={`${failure.stage}-${index}`}>
              {failure.stage}: <code>{failure.code}</code>
            </li>
          ))}
        </ul>
      ) : null}

      {result.findings.length === 0 ? (
        <p className="research-none">No findings. Nothing readable was gathered.</p>
      ) : (
        <ul className="research-findings">
          {result.findings.map((finding, index) => (
            <li key={index}>
              <p>{finding.text}</p>
              <span className="research-citations">
                from{' '}
                {finding.sourceIds.map((id) => byId.get(id)?.domain ?? id).join(', ')}
              </span>
            </li>
          ))}
        </ul>
      )}

      {result.conflicts.length > 0 ? (
        <>
          <h4>Where the sources disagree</h4>
          <ul className="research-conflicts">
            {result.conflicts.map((conflict, index) => (
              <li key={index}>
                <p>{conflict.text}</p>
                <span className="research-citations">
                  between {conflict.sourceIds.map((id) => byId.get(id)?.domain ?? id).join(' and ')}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {result.uncertainties.length > 0 ? (
        <>
          <h4>What Freya does not know</h4>
          <ul className="research-uncertainties">
            {result.uncertainties.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </>
      ) : null}

      <h4>Sources</h4>
      <ul className="research-sources">
        {result.sources.map((source) => (
          <li key={source.sourceId}>
            <a href={source.url} target="_blank" rel="noreferrer noopener">
              {source.title || source.url}
            </a>
            <span className="research-source-url">{source.url}</span>
            <p>{source.excerpt}</p>
          </li>
        ))}
      </ul>

      <p className="research-usage">
        {result.usage.modelTurns ?? 0} model turns · {result.usage.queries ?? 0} queries ·{' '}
        {result.usage.pages ?? 0} pages read
      </p>
    </section>
  )
}

function describeStage(stage: string | null): string {
  switch (stage) {
    case 'authorizing':
      return 'Checking whether Freya is allowed to do this…'
    case 'planning':
      return 'Deciding what to look for…'
    case 'searching':
      return 'Searching the web…'
    case 'reading':
      return 'Reading sources…'
    case 'gap':
      return 'Looking for something still missing…'
    case 'synthesizing':
      return 'Writing the answer from what it read…'
    default:
      return 'Working…'
  }
}

function describeAvailability(availability: string, reason: string | null): string {
  if (reason !== null && (availability === 'unconfigured' || availability === 'disabled')) return reason
  switch (availability) {
    case 'ready':
      return 'Web search is configured and enabled.'
    case 'disabled':
      return 'Web search is present but disabled. Set FREYA_ALLOW_WEB_SEARCH=1 to enable it.'
    case 'unconfigured':
      return 'Web search is not configured on this machine.'
    default:
      return 'Web search status is not known yet.'
  }
}