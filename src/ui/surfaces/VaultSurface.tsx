import { useEffect, useState } from 'react'
import type { BrainCommandOutcome } from '../../../core/protocol/core-protocol'
import type { BrainProjection } from '../../../core/brain/brain'
import { brainMirror } from '../../platform/brainClient'
import { useBrain } from '../../core/useBrain'

/**
 * The Vault surface: what Freya remembers, and what she believes about herself.
 *
 * ## The three things this window is for
 *
 * A memory system with no surface is a memory system nobody can check. So this
 * window exists to answer three questions a person is entitled to ask, and it is
 * built around exactly those:
 *
 *   1. **Will she remember?** Durability is stated before anything else, and before
 *      anything is typed into it. Somebody deciding whether to tell Freya something
 *      needs to know whether it will survive a restart *first* — finding out after
 *      the conversation that none of it was saved is the failure this ordering
 *      exists to prevent.
 *   2. **What does she think she knows?** Every memory is shown with its source
 *      class and confidence, because a note from a web page and a note from the
 *      owner are different claims and a list that flattened them would be lying by
 *      omission.
 *   3. **Where does she disagree with herself?** Contradictions are shown rather
 *      than hidden. A Brain that resolved them silently by recency would look more
 *      coherent and be less true.
 *
 * ## What it deliberately does not do
 *
 * There is no "edit" and there is no "delete". Withdrawing a memory is archive: the
 * record stays, its status changes, and it stops being recalled. That is what makes
 * the hash chain meaningful — deletion and tampering must not look alike.
 *
 * There is also no trust control. A window that could label its own memories
 * `owner-assertion` could launder anything into something the owner said, so the
 * surface says *you* said it and lets Core decide what that is worth.
 */

/** Refusal and result messages are ours, and are bounded like everything else. */
const MAX_COMPOSED_CHARS = 16_000

export function VaultSurface() {
  const projection = useBrain()
  const mirror = brainMirror()

  const [draft, setDraft] = useState('')
  const [subject, setSubject] = useState('')
  const [busy, setBusy] = useState(false)
  const [reply, setReply] = useState<string | null>(null)
  const [tone, setTone] = useState<'ok' | 'refused'>('ok')
  const [query, setQuery] = useState('')
  const [pack, setPack] = useState<BrainCommandOutcome['recall'] | null>(null)

  useEffect(() => {
    void mirror.attach()
  }, [mirror])

  // A refusal is shown as a refusal, with Core's own words. Swallowing the reason
  // would leave a person unable to find out why Freya declined to remember
  // something, which is exactly when they most need to know.
  const report = (outcome: BrainCommandOutcome): boolean => {
    if (outcome.operation === 'memory-written' || outcome.operation === 'memory-archived') {
      setTone('ok')
      setReply(outcome.reason ?? 'Stored.')
      return true
    }
    if (outcome.operation === 'memory-refused') {
      setTone('refused')
      setReply(outcome.reason ?? 'Freya did not keep that.')
      return false
    }
    setTone('ok')
    setReply(outcome.reason ?? null)
    return false
  }

  const remember = async () => {
    const content = draft.trim()
    if (content.length === 0) return
    setBusy(true)
    setReply(null)
    try {
      const outcome = await mirror.write({
        content: content.slice(0, MAX_COMPOSED_CHARS),
        ...(subject.trim().length > 0 ? { subject: subject.trim() } : {}),
      })
      if (report(outcome)) {
        setDraft('')
        setSubject('')
      }
    } finally {
      setBusy(false)
    }
  }

  const withdraw = async (memoryId: string) => {
    setBusy(true)
    setReply(null)
    try {
      report(await mirror.archive(memoryId, 'withdrawn from the Vault surface'))
    } finally {
      setBusy(false)
    }
  }

  const ask = async () => {
    setBusy(true)
    try {
      const outcome = await mirror.recall(query.trim())
      setPack(outcome.recall ?? null)
      if (outcome.operation !== 'recall') report(outcome)
    } finally {
      setBusy(false)
    }
  }

  if (projection === null) {
    return (
      <div className="vault-surface">
        <p className="vault-absent">Waiting for Freya Core to report what she knows.</p>
      </div>
    )
  }

  return (
    <div className="vault-surface" data-health={projection.health} data-durable={projection.durable}>
      {/* Durability first. Everything else on this window is worthless to somebody
          deciding what to type if they do not know whether it will be kept. */}
      <section className="vault-durability" data-tone={projection.durable ? 'durable' : 'ephemeral'}>
        <b>{projection.durable ? 'REMEMBERS ACROSS RESTARTS' : 'FORGETS ON QUIT'}</b>
        <span>
          {projection.durable
            ? 'What Freya learns is written encrypted to this machine, chained so a deleted record can be detected.'
            : (projection.reason ??
              'No secure key is available, so this session only. Nothing you tell her will survive a restart.')}
        </span>
      </section>

      {projection.health !== 'healthy' ? (
        <p className="vault-warning" role="alert">
          Freya's memory is {projection.health}
          {projection.reason ? ` — ${projection.reason}` : ''}. She is still answering; she just may
          not be able to read everything she has been told.
        </p>
      ) : null}

      <section className="vault-section">
        <h3>Remember something</h3>
        <p className="vault-note">
          This is you telling Freya directly, so it is recorded as your assertion — the strongest
          source she has. It is still a statement, not a verified fact: she cannot check it, so it
          will not claim to be verified.
        </p>
        <label className="vault-field">
          <span>About</span>
          <input
            type="text"
            value={subject}
            maxLength={500}
            placeholder="optional — who or what this is about"
            onChange={(event) => setSubject(event.target.value)}
          />
        </label>
        <label className="vault-field">
          <span>What Freya should remember</span>
          <textarea
            value={draft}
            maxLength={MAX_COMPOSED_CHARS}
            rows={4}
            placeholder="Something you want her to know next time."
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="vault-button"
          disabled={busy || draft.trim().length === 0}
          onClick={() => void remember()}
        >
          {busy ? 'Remembering…' : 'Remember this'}
        </button>
        {reply ? (
          <p className="vault-reply" data-tone={tone} role={tone === 'refused' ? 'alert' : 'status'}>
            {reply}
          </p>
        ) : null}
      </section>

      <section className="vault-section">
        <h3>What she has remembered</h3>
        <dl className="vault-facts">
          <div>
            <dt>Memories</dt>
            <dd>
              {projection.counts.admitted} admitted
              {projection.counts.conflicted > 0 ? ` · ${projection.counts.conflicted} in conflict` : ''}
              {projection.counts.rejected > 0 ? ` · ${projection.counts.rejected} refused` : ''}
            </dd>
          </div>
          {/* Withdrawn memories are not in the listing, and saying so is the point:
              a person who withdrew something is entitled to know it went somewhere
              rather than nowhere. */}
          {projection.counts.withdrawn > 0 ? (
            <div>
              <dt>Withdrawn</dt>
              <dd>
                {projection.counts.withdrawn} kept on disk, no longer recalled. Freya never deletes a
                memory — forgetting and tampering must not look alike.
              </dd>
            </div>
          ) : null}
          <div>
            <dt>World</dt>
            <dd>
              {projection.counts.entities} entities · {projection.counts.relations} facts ·{' '}
              {projection.counts.observations} things said
            </dd>
          </div>
          <div>
            <dt>Experience</dt>
            <dd>{projection.counts.experiences} attempts recorded</dd>
          </div>
        </dl>

        {projection.conflicts.length > 0 ? (
          <ul className="vault-conflicts">
            {projection.conflicts.map((conflict) => (
              <li key={`${conflict.memoryId}-${conflict.conflictsWith.join(',')}`}>
                {conflict.detail}
              </li>
            ))}
          </ul>
        ) : null}

        {projection.recentAdmissions.length === 0 ? (
          <p className="vault-none">She has not been told anything yet.</p>
        ) : (
          <ul className="vault-memories">
            {projection.recentAdmissions.map((memory) => (
              <li key={memory.memoryId} data-status={memory.status}>
                <b>{memory.subject}</b>
                <span>
                  {memory.kind} · from {memory.source} · {memory.confidence} confidence
                </span>
                <em>{memory.admittedAt}</em>
                <button
                  type="button"
                  className="vault-withdraw"
                  disabled={busy}
                  onClick={() => void withdraw(memory.memoryId)}
                >
                  Withdraw
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="vault-section">
        <h3>Ask what she would recall</h3>
        <p className="vault-note">
          Retrieval is deterministic and offline — no model is called to search. Every item shows
          where it came from, and anything left out is counted rather than hidden.
        </p>
        <label className="vault-field">
          <span>Question</span>
          <input
            type="text"
            value={query}
            maxLength={2000}
            placeholder="what should she bring to mind?"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="vault-button vault-recall"
          disabled={busy}
          onClick={() => void ask()}
        >
          Recall
        </button>
        {pack ? <RecallPack pack={pack} /> : null}
      </section>

      <SelfPanel projection={projection} />
    </div>
  )
}

/**
 * The recall result, shown with its own accounting.
 *
 * `considered`, `included` and `omitted` are all displayed. A pack that silently
 * dropped three memories would look identical to one that found three, and the whole
 * value of a deterministic retriever is that its omissions are knowable.
 */
function RecallPack({ pack }: { pack: NonNullable<BrainCommandOutcome['recall']> }) {
  if (pack.empty) {
    return (
      <p className="vault-none">
        Nothing matched{pack.query ? ` "${pack.query}"` : ''}. She searched{' '}
        {pack.candidatesConsidered} memories and recalled none.
      </p>
    )
  }

  return (
    <div className="vault-pack">
      <p className="vault-pack-counts">
        {pack.items.length} recalled from {pack.candidatesConsidered} considered
        {pack.omittedCount > 0 ? `, ${pack.omittedCount} left out for space` : ''} · about{' '}
        {pack.estimatedTokens} tokens
      </p>
      <ul className="vault-pack-items">
        {pack.items.map((item) => (
          <li key={item.memoryId} data-status={item.status}>
            <b>{item.subject}</b>
            <p>{item.content}</p>
            <span>
              {item.source} · {item.confidence} · score {item.score}
              {item.status === 'conflicted' ? ' · contradicted' : ''}
            </span>
          </li>
        ))}
      </ul>
      {pack.conflicts.length > 0 ? (
        <ul className="vault-conflicts">
          {pack.conflicts.map((conflict) => (
            <li key={`${conflict.memoryId}-${conflict.conflictsWith.join(',')}`}>
              {conflict.detail}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/**
 * Who Freya believes she is.
 *
 * The `cannot` lists are shown, not just the capabilities, because a capability
 * described only by what it does is a claim and one that also says what it cannot do
 * is something a person can rely on. Nothing here is writable — these claims have no
 * write path at all, which is the property rather than a missing feature.
 */
function SelfPanel({ projection }: { projection: BrainProjection }) {
  return (
    <section className="vault-section vault-self">
      <h3>What she knows about herself</h3>
      {projection.identity ? (
        <div className="vault-identity">
          <b>{projection.identity.name}</b>
          <p>{projection.identity.role}</p>
          <p>{projection.identity.purpose}</p>
          <ul>
            {projection.identity.claims.map((claim) => (
              <li key={claim.claimId}>{claim.statement}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="vault-none">Her identity has not been written yet.</p>
      )}

      {projection.self ? (
        <div className="vault-capabilities">
          <h4>What she cannot do</h4>
          <ul>
            {projection.self.capabilities.flatMap((capability) =>
              capability.cannot.map((limit) => (
                <li key={`${capability.capability}-${limit}`}>
                  <b>{capability.capability}</b>: {limit}
                </li>
              )),
            )}
            {projection.self.limitations.map((limitation) => (
              <li key={limitation.limitationId}>
                <b>{limitation.statement}</b>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}