import type { ReactNode } from 'react'
import { Card, Chip, Empty, Row } from '../cards/Card'
import type { ScreenSlots } from './Home'
import type { MindView, Resource, UiSnapshot } from '../../ui-v2/state/contract'
import { ready } from '../state/view'
import './mind.css'

/**
 * Mind — Freya's cognitive control room.
 *
 * ## What this screen is
 *
 * It is an operator-facing projection of what Core is currently doing, holding,
 * and unable to settle. It reads the `mind` resource the live adapter derives
 * from Core's own projections, and it renders nothing else.
 *
 * ## What it deliberately is not
 *
 * It is not a window into Freya's thoughts. There is no chain-of-thought, no
 * inner monologue, no prompt, no model response and no trait percentage
 * anywhere in this file — not because they are hidden but because nothing in
 * the Core this renders measures any of them. The previous content on this
 * screen was sample copy: a "Curious 82%" self row, a three-goal roadmap with
 * dates, an "Uncertain about" card of invented open questions, and a "You trust
 * me" card describing a person Core has never described. Every one of those was
 * a module constant, and each read exactly like a measurement.
 *
 * So every row below is one of three things: a closed word Core chose, a count
 * Core derived from already-authorized state, or a sentence Core itself wrote.
 * When a domain has not reported, the card says so with the reason Core gave,
 * rather than showing an empty list that would read as "nothing there".
 *
 * ## Provenance
 *
 * The strip at the top of the left column is the whole screen's status:
 * `live`, `stale`, `preview`, `loading` or `unavailable`, in the component's
 * `data-state` and in words. A design preview must never look live, and a stale
 * projection must never look current.
 */

/** A closed status word, rendered as a chip. Never invented. */
function Status({ word, tone }: { word: string; tone?: string }) {
  return <span className="m-status" data-tone={tone}>{word}</span>
}

/**
 * The one status strip.
 *
 * It is the first thing on the screen and it is machine-readable, so a test can
 * assert on it and a person can read it. `loading` is not `unavailable`: one is
 * a Core on its way, the other is a window with nothing behind it.
 */
function Provenance({ resource }: { resource: Resource<MindView> }) {
  const state = resource.status
  const word = state === 'ready' ? (resource.source === 'preview' ? 'design preview' : 'live') : state
  const sentence = state === 'ready'
    ? resource.source === 'preview'
      ? 'Design preview. No Core is projected in this window, so nothing here is live.'
      : 'Projected from Freya Core. Every row is a fact Core reported.'
    : state === 'loading'
      ? 'Waiting for Freya Core to report.'
      : state === 'stale'
        ? `Stale projection — ${resource.reason}`
        : resource.reason
  return (
    <p className="m-provenance" data-state={state} role="status">
      <span className="m-provenance-dot" aria-hidden="true" />
      <b>{word}</b>
      <span>{sentence}</span>
    </p>
  )
}

/**
 * A card body that is either the live content or an honest absence.
 *
 * One branch, used everywhere, so no card can render a partially-known
 * projection as a complete one. `stale` still renders the data — Core has told
 * us it is old, and the strip says so — but `loading`, `unavailable` and
 * `error` render the reason instead of an empty list.
 */
function Gate({ resource, title, detail, children }: {
  resource: Resource<unknown>
  title: string
  detail: string
  children: ReactNode
}) {
  if (resource.status === 'ready' || resource.status === 'stale') return <>{children}</>
  return (
    <Empty
      title={resource.status === 'loading' ? 'Waiting for Freya Core' : title}
      detail={resource.status === 'loading' ? 'Core has not reported this yet.' : detail}
    />
  )
}

/** A count that was never taken renders as an em dash, never as zero. */
function Count({ value, label }: { value: number | null; label: string }) {
  return (
    <div className="m-count">
      <b>{value === null ? '—' : value.toLocaleString('en-GB')}</b>
      <small>{label}</small>
    </div>
  )
}

/* ------------------------------------------------------------------ overview */

function OverviewCard({ resource }: { resource: Resource<MindView> }) {
  const view = ready(resource)
  const overview = view?.overview ?? null
  return (
    <Card
      title="Core & Mind"
      icon="mind"
      subtitle="What Freya is, right now"
      meta={overview ? <Status word={overview.mode} tone={overview.mode === 'stopped' || overview.mode === 'uncertain' ? 'attention' : overview.mode === 'working' ? 'positive' : undefined} /> : undefined}
    >
      <Provenance resource={resource} />
      <Gate resource={resource} title="Core is not reporting" detail="Core has not described its own state.">
        {overview ? (
          <>
            <p className="m-mode">{overview.modeDetail}</p>
            <div className="m-facts">
              <div className="m-fact"><small>Lifecycle</small><b>{overview.lifecycle}</b></div>
              <div className="m-fact"><small>Serving commands</small><b>{overview.operational ? 'yes' : 'no'}</b></div>
              <div className="m-fact"><small>STOP ALL</small><b>{overview.stopped ? 'latched' : 'clear'}</b></div>
              <div className="m-fact"><small>Governor</small><b>{overview.governorStatus}</b></div>
              <div className="m-fact"><small>Grants held</small><b>{overview.grantsActive}</b></div>
              <div className="m-fact"><small>Provider calls</small><b>{overview.activeProviderCalls}</b></div>
              <div className="m-fact"><small>Journal</small><b>{overview.journalIntegrity}</b></div>
              <div className="m-fact"><small>History</small><b>{overview.persistenceMode}</b></div>
              <div className="m-fact"><small>Event sequence</small><b>{overview.sequence}</b></div>
            </div>
            {overview.persistenceReason ? <p className="m-note">{overview.persistenceReason}</p> : null}
            {overview.faults.length > 0 ? (
              <div className="m-faults">
                <small>Recorded faults, in Core's words</small>
                {overview.faults.map((fault) => <Row key={fault} icon="bell" title={fault} tone="danger" />)}
              </div>
            ) : null}
            <div className="m-subhead">Cognition this session</div>
            <div className="m-counts">
              <Count value={overview.sessionCalls} label="provider calls" />
              <Count value={overview.sessionInputTokens} label="input tokens" />
              <Count value={overview.sessionOutputTokens} label="output tokens" />
              {/* A lower bound whenever this is above zero, and it says so. */}
              <Count value={overview.sessionUnknownUsageCalls} label="calls with no usage" />
            </div>
            {overview.sessionUnknownUsageCalls > 0 ? (
              <p className="m-note">Token totals are a lower bound: {overview.sessionUnknownUsageCalls} calls reported no usage.</p>
            ) : null}
            <div className="m-subhead">Providers</div>
            {overview.providers.length === 0 ? (
              <p className="m-note">Core reports no providers.</p>
            ) : (
              <div className="c-rows">{overview.providers.map((provider) => (
                <Row
                  key={provider.id}
                  icon="chip"
                  title={`${provider.id} · ${provider.kind}`}
                  detail={provider.detail}
                  end={<Status word={provider.liveEnabled ? 'live' : provider.status} />}
                />
              ))}</div>
            )}
            <p className="m-note">
              The model is not Freya. A provider is chosen and authorised inside Core; this window names no
              provider, no grant and no budget, and cannot.
            </p>
          </>
        ) : null}
      </Gate>
    </Card>
  )
}

/* ----------------------------------------------------------------- attention */

function AttentionCard({ resource }: { resource: Resource<MindView> }) {
  const view = ready(resource)
  const attention = view?.attention ?? null
  return (
    <Card
      title="Attention"
      icon="bell"
      subtitle="What Core is watching"
      meta={attention && attention.health === 'ready' ? <Status word={attention.focus} tone="accent" /> : undefined}
    >
      <Gate resource={resource} title="Attention is not reporting" detail="Nothing is being watched.">
        {attention ? (
          attention.health === 'ready' && attention.counts ? (
            <>
              {/* Core's own closed FocusState. There is no denominator for it
                  anywhere in this codebase, so there is no percentage. */}
              <p className="m-mode">Core reports <b>{attention.focus}</b>.</p>
              <div className="m-counts">
                <Count value={attention.counts.ingested} label="ingested" />
                <Count value={attention.counts.decisions} label="decided" />
                <Count value={attention.counts.cued} label="cued" />
                <Count value={attention.counts.spoke} label="spoke" />
                <Count value={attention.counts.interrupted} label="interrupted" />
                <Count value={attention.counts.doNothing} label="do-nothing" />
                <Count value={attention.counts.remembered} label="remembered" />
                <Count value={attention.counts.budgetExceeded} label="over budget" />
              </div>
              <p className="m-note">
                {attention.inboxCount === 1 ? '1 retained event' : `${attention.inboxCount} retained events`} — metadata only.
                An event's text stays in Core and is readable one item at a time, never as a feed.
              </p>
              {attention.lastDecision ? (
                <>
                  <div className="m-subhead">Last decision</div>
                  <div className="c-rows">
                    <Row icon="activity" title={`${attention.lastDecision.source} · ${attention.lastDecision.kind}`}
                      detail={`${attention.lastDecision.outcome} · ${attention.lastDecision.importance} / ${attention.lastDecision.urgency}`}
                      end={<Status word={attention.lastDecision.reason} />} />
                  </div>
                  <p className="m-note">{new Date(attention.lastDecision.decidedAt).toLocaleString('en-GB')}</p>
                </>
              ) : (
                <p className="m-note">Core has recorded no decision yet.</p>
              )}
            </>
          ) : (
            /* 'unavailable' is not 'ready' with zeroes: nobody is watching, which
               is a different fact from "nothing needs attention". */
            <Empty title="No Attention domain is reporting" detail={attention.reason ?? 'Core has not reported an Attention domain.'} />
          )
        ) : null}
      </Gate>
    </Card>
  )
}

/* ----------------------------------------------------------------- threads */

const THREAD_WORDS: Record<string, string> = {
  run: 'Work run',
  mission: 'Mission',
  worker: 'Worker',
  approval: 'Approval',
}

function ThreadsCard({ resource }: { resource: Resource<MindView> }) {
  const view = ready(resource)
  const threads = view?.threads ?? []
  return (
    <Card
      title="Active threads"
      icon="workforce"
      subtitle="What is running now"
      meta={threads.length > 0 ? <Chip>{threads.length}</Chip> : undefined}
    >
      <Gate resource={resource} title="Work is not reporting" detail="Core has not described what it is doing.">
        {threads.length === 0 ? (
          <Empty title="Nothing is in progress" detail="No run, Mission, worker or approval is open right now." />
        ) : (
          <div className="c-rows">{threads.map((thread) => (
            <Row
              key={`${thread.kind}-${thread.id}`}
              icon="activity"
              title={`${THREAD_WORDS[thread.kind] ?? thread.kind} · ${thread.id}`}
              detail={thread.detail ?? undefined}
              end={thread.live ? <Status word={`live · ${thread.status}`} tone="positive" /> : <Status word={thread.status} />}
            />
          ))}</div>
        )}
        {view && view.waiting.pendingApprovals > 0 ? (
          <p className="m-note">
            {view.waiting.pendingApprovals === 1 ? '1 approval' : `${view.waiting.pendingApprovals} approvals`} waiting on a person.
            Deciding one is an owner act on the Work surface, not here.
          </p>
        ) : null}
      </Gate>
    </Card>
  )
}

/* --------------------------------------------------------------------- self */

function SelfCard({ resource }: { resource: Resource<MindView> }) {
  const view = ready(resource)
  const self = view?.self ?? null
  return (
    <Card
      title="Self model"
      icon="core"
      subtitle="Who Freya is, in Core's words"
      meta={self && self.complete ? <Status word="seeded" /> : self ? <Status word="partial" tone="attention" /> : undefined}
    >
      <Gate resource={resource} title="The Brain is not reporting" detail="Core has not described itself.">
        {self ? (
          <>
            {self.name || self.role || self.purpose ? (
              <>
                <h3 className="m-lead">{self.name ?? 'Unnamed'}</h3>
                {self.role ? <p className="m-sub">{self.role}</p> : null}
                {self.purpose ? <blockquote className="m-quote">{self.purpose}</blockquote> : null}
              </>
            ) : (
              <Empty title="No identity is projected" detail={self.reason ?? 'Core has not reported an identity root.'} />
            )}
            <div className="m-facts">
              <div className="m-fact"><small>Root claims</small><b>{self.claimCount}</b></div>
              <div className="m-fact"><small>Self-definition</small><b>{self.complete ? 'complete' : 'incomplete'}</b></div>
              <div className="m-fact"><small>Survives a restart</small><b>{self.durable ? 'yes' : 'no'}</b></div>
            </div>
            {/* No trait meters. Nothing in Phases 0–18 measures a temperament
                percentage, and a meter that rendered an invented one would be
                the exact lie this screen replaced. */}
            {self.claims.length > 0 ? (
              <>
                <div className="m-subhead">Root claims</div>
                <div className="c-rows">{self.claims.map((claim) => (
                  <Row key={claim.claimId} icon="core" title={claim.statement} />
                ))}</div>
              </>
            ) : null}
            {self.capabilities.length > 0 ? (
              <>
                <div className="m-subhead">Seeded capabilities</div>
                <div className="c-rows">{self.capabilities.map((capability) => (
                  <Row key={capability.capability} icon="chip" title={capability.capability}
                    detail={capability.cannot.length > 0 ? `cannot: ${capability.cannot.join(', ')}` : undefined}
                    end={<Status word={capability.state} />} />
                ))}</div>
              </>
            ) : null}
            {self.limitations.length > 0 ? (
              <>
                <div className="m-subhead">Stated limitations</div>
                <div className="c-rows">{self.limitations.map((limitation) => (
                  <Row key={limitation.limitationId} icon="bell" title={limitation.statement} tone="attention" />
                ))}</div>
              </>
            ) : null}
            {self.world ? (
              <>
                <div className="m-subhead">World model</div>
                {self.world.health === 'ready' ? (
                  <div className="m-counts">
                    <Count value={self.world.entities} label="entities" />
                    <Count value={self.world.edges} label="edges" />
                    <Count value={self.world.evidenceRecords} label="evidence" />
                    <Count value={self.world.beliefs} label="beliefs" />
                    <Count value={self.world.conflicts} label="conflicts" />
                    <Count value={self.world.uncertainties} label="uncertainties" />
                    <Count value={self.world.withdrawn} label="withdrawn" />
                    {/* Counted because it is real, and shown because hiding it
                        would claim Freya holds nothing private. */}
                    <Count value={self.world.withheld} label="withheld" />
                  </div>
                ) : (
                  <Empty title="No world model is reporting" detail={self.world.reason ?? 'Core has not reported a world model.'} />
                )}
                <p className="m-note">
                  Counts only. Core projects no entity names here, and nothing a window can do writes one.
                </p>
              </>
            ) : null}
            <div className="m-subhead">Compartments read from Core</div>
            {self.worldSelf ? (
              <>
                <p className="m-note">
                  {self.worldSelf.readAt === null
                    ? 'Read via self.status.read. Core builds this fresh each time and streams nothing.'
                    : `Read ${new Date(self.worldSelf.readAt).toLocaleTimeString('en-GB')} via self.status.read. Core builds this fresh each time and streams nothing, so the reading is that old.`}
                </p>
                <div className="m-rows">
                  <div className="m-mini"><small>Source</small><b>{self.worldSelf.source}</b></div>
                  <div className="m-mini"><small>Capabilities Guard assigned</small><b>{self.worldSelf.assignedCapabilities.filter((row) => row.held).length} held / {self.worldSelf.assignedCapabilities.length} asked</b></div>
                  <div className="m-mini"><small>Known skills</small><b>{self.worldSelf.knownSkills.length}</b></div>
                  <div className="m-mini"><small>Providers that would answer</small><b>{self.worldSelf.models.length}</b></div>
                  <div className="m-mini"><small>Worker claims on record</small><b>{self.worldSelf.workerClaims.length}</b></div>
                </div>
                {self.worldSelf.assignedCapabilities.length > 0 ? (
                  <div className="c-chips">{self.worldSelf.assignedCapabilities.map((row) => (
                    <Chip key={row.capability} tone={row.held ? 'accent' : 'quiet'}>{row.capability}</Chip>
                  ))}</div>
                ) : (
                  <p className="m-note">Guard has assigned no capabilities in this read.</p>
                )}
                {self.worldSelf.workerClaims.length > 0 ? (
                  <>
                    <div className="m-subhead">Worker claims — data, never authority</div>
                    <div className="c-rows">{self.worldSelf.workerClaims.map((claim) => (
                      <Row key={`${claim.workerId}-${claim.claimKind}`} icon="workforce"
                        title={`${claim.workerId} claims ${claim.claimKind}`} end={<Status word={claim.decision} tone="attention" />} />
                    ))}</div>
                  </>
                ) : null}
                <div className="m-subhead">The separations Core states about itself</div>
                <div className="m-rows">
                  {Object.entries(self.worldSelf.separation).map(([key, value]) => (
                    <div key={key} className="m-mini"><small>{key}</small><b>{typeof value === 'boolean' ? (value ? 'true' : 'false') : value}</b></div>
                  ))}
                </div>
              </>
            ) : (
              <Empty
                title="The compartment read has not happened"
                detail="Core builds the seven-compartment self model fresh on request and streams nothing, and this window has not asked for it yet."
              />
            )}
          </>
        ) : null}
      </Gate>
    </Card>
  )
}

/* ------------------------------------------------------------------ missions */

function MissionsCard({ resource }: { resource: Resource<MindView> }) {
  const view = ready(resource)
  const missions = view?.missions ?? []
  return (
    <Card
      title="Goals"
      icon="mission"
      subtitle="What Freya is working toward"
      meta={view && view.missionsTotal > 0 ? <Chip>{view.missionsTotal}</Chip> : undefined}
    >
      <Gate resource={resource} title="Missions are not reporting" detail="Core has not reported any Missions.">
        {missions.length === 0 ? (
          <Empty title="No Missions yet" detail="A Mission records what the owner asked Freya to accomplish. None exists." />
        ) : (
          <>
            <div className="c-rows">{missions.map((mission) => (
              <Row
                key={mission.id}
                icon="mission"
                title={mission.awaitingOwner ? `${mission.id} · waiting on the owner` : mission.id}
                detail={[
                  mission.nextDecision ? `next: ${mission.nextDecision}` : null,
                  mission.nextReason ?? null,
                  mission.verifiedRuns > 0 ? `${mission.verifiedRuns}/${mission.totalRuns} runs verified` : null,
                ].filter(Boolean).join(' · ') || undefined}
                end={<>
                  {mission.needsAttention ? <Status word="needs attention" tone="attention" /> : null}
                  <Status word={mission.priority} />
                  <Status word={mission.status} />
                </>}
              />
            ))}</div>
            {/* Titles and intents live in the encrypted Mission store and the
                bridge exposes no read for them. Saying so is the honest
                alternative to an invented roadmap. */}
            <p className="m-note">
              Mission titles and intents are not projected to this window, and no roadmap date exists anywhere in Core.
              What crosses is status, counts, blockers and the last continuation decision.
            </p>
            {view && view.missionsHidden > 0 ? (
              <p className="m-note">{view.missionsHidden} not listed — the projection bounds its own listing rather than hiding them silently.</p>
            ) : null}
            {view && view.nextActions.length > 0 ? (
              <>
                <div className="m-subhead">Actions Core has advertised</div>
                <div className="c-rows">{view.nextActions.map((action) => (
                  <Row key={`${action.scope}-${action.subjectId}-${action.action}`} icon="arrow"
                    title={action.action} detail={`${action.scope} · ${action.subjectId}`} />
                ))}</div>
              </>
            ) : (
              <p className="m-note">Core has advertised no next action.</p>
            )}
          </>
        )}
      </Gate>
    </Card>
  )
}

/* ------------------------------------------------------- waiting & uncertainty */

function UncertaintyCard({ resource }: { resource: Resource<MindView> }) {
  const view = ready(resource)
  const waiting = view?.waiting ?? null
  const uncertainties = view?.uncertainties ?? []
  return (
    <Card
      title="Waiting & uncertainty"
      icon="bell"
      subtitle="What is open, and what Core cannot settle"
      meta={uncertainties.length > 0 ? <Chip tone="accent">{uncertainties.length}</Chip> : undefined}
    >
      <Gate resource={resource} title="Nothing is projected" detail="Core has not reported what it is holding.">
        {waiting ? (
          <>
            {waiting.pendingApprovals === 0 && waiting.waitingRuns.length === 0
              && waiting.blockedAgents.length === 0 && waiting.unfulfilledPresenceRequests === 0 ? (
              <p className="m-mode">Nothing is waiting.</p>
            ) : (
              <div className="m-counts">
                <Count value={waiting.pendingApprovals} label="approvals pending" />
                <Count value={waiting.waitingRuns.length} label="runs waiting" />
                <Count value={waiting.blockedAgents.length} label="agents blocked" />
                <Count value={waiting.unfulfilledPresenceRequests} label="presence unfulfilled" />
              </div>
            )}
            {waiting.waitingRuns.length > 0 ? (
              <div className="c-rows">{waiting.waitingRuns.map((run) => (
                <Row key={run.runId} icon="activity" title={run.runId} detail={`waiting · ${run.status}`}
                  end={run.waitingSince ? new Date(run.waitingSince).toLocaleString('en-GB') : undefined} />
              ))}</div>
            ) : null}
            <div className="m-subhead">Open questions</div>
            {uncertainties.length === 0 ? (
              <p className="m-note">
                {view && view.absentSections.includes('uncertainty')
                  ? 'Core does not project an uncertainty section in this build.'
                  : 'Core reports nothing it could not settle.'}
              </p>
            ) : (
              <div className="c-rows">{uncertainties.map((item) => (
                <Row key={`${item.code}-${item.subjectId ?? item.subjectKind}`} icon="bell" tone="attention"
                  title={item.code} detail={item.subjectId ? `${item.subjectKind} · ${item.subjectId}` : item.subjectKind}
                  end={item.since ? new Date(item.since).toLocaleString('en-GB') : undefined} />
              ))}</div>
            )}
            {view && view.uncertaintiesOmitted > 0 ? (
              <p className="m-note">{view.uncertaintiesOmitted} more not listed — the projection bounds its own listing.</p>
            ) : null}
            <p className="m-note">
              A code and a subject, never a sentence. Nothing here is a thought, a worry or an inner monologue:
              it is Core naming a fact it could not establish.
            </p>
          </>
        ) : null}
      </Gate>
    </Card>
  )
}

/* --------------------------------------------------------------------- owner */

function OwnerCard({ resource }: { resource: Resource<MindView> }) {
  const view = ready(resource)
  const owner = view?.owner ?? null
  return (
    <Card title="Owner context" icon="people" subtitle="Only what Core is allowed to say">
      <Gate resource={resource} title="Nothing is projected" detail="Core has not reported owner context.">
        {owner ? (
          <>
            <div className="m-subhead">Relationship</div>
            {owner.personalityHealth === 'ready' ? (
              <>
                <div className="m-rows">
                  <div className="m-mini"><small>Continuity</small><b>{owner.continuity ?? 'not interpreted'}</b></div>
                  <div className="m-mini"><small>Formality</small><b>{owner.formality ?? 'not interpreted'}</b></div>
                  <div className="m-mini"><small>Records held</small><b>{owner.relationshipItems}</b></div>
                  <div className="m-mini"><small>Admitted</small><b>{owner.admittedItems}</b></div>
                  <div className="m-mini"><small>Cues admitted</small><b>{owner.cuesAdmitted}</b></div>
                  <div className="m-mini"><small>Survives a restart</small><b>{owner.relationshipDurable === null ? '—' : owner.relationshipDurable ? 'yes' : 'no'}</b></div>
                </div>
                {owner.temperament.length > 0 ? (
                  <div className="c-chips">{owner.temperament.map((row) => (
                    <Chip key={row.dimension}>{row.dimension}: {row.level}</Chip>
                  ))}</div>
                ) : (
                  <p className="m-note">Core has not projected a standing temperament.</p>
                )}
              </>
            ) : (
              <Empty title="No Personality domain is reporting" detail={owner.personalityReason ?? 'Core has not reported a Personality projection.'} />
            )}
            <p className="m-note">
              No preference wording, habit, inside joke or relationship text crosses this boundary. What a person
              told Freya stays in Core's encrypted store; the projection carries health, closed labels and counts.
            </p>
            <div className="m-subhead">Context</div>
            {owner.contextHealth === 'ready' ? (
              <div className="m-rows">
                <div className="m-mini"><small>Items held</small><b>{owner.contextItems}</b></div>
                <div className="m-mini"><small>Current</small><b>{owner.contextCurrent}</b></div>
                <div className="m-mini"><small>Scopes</small><b>{owner.contextScopes.length === 0 ? '—' : owner.contextScopes.join(', ')}</b></div>
                <div className="m-mini"><small>Unresolved references</small><b>{owner.contextUnresolvedReferences}</b></div>
                <div className="m-mini"><small>Survives a restart</small><b>{owner.contextDurable === null ? '—' : owner.contextDurable ? 'yes' : 'no'}</b></div>
              </div>
            ) : (
              <Empty title="No Context domain is reporting" detail={owner.contextReason ?? 'Core has not reported a Context projection.'} />
            )}
          </>
        ) : null}
      </Gate>
    </Card>
  )
}

/* ----------------------------------------------------------------- provenance */

function ProvenanceCard({ resource }: { resource: Resource<MindView> }) {
  const view = ready(resource)
  const provenance = view?.provenance ?? null
  const changes = view?.recentChanges ?? []
  return (
    <Card
      title="Provenance"
      icon="activity"
      subtitle="Who said what, and how stale it is"
      meta={view ? <Status word={view.consciousHealth} tone={view.consciousHealth === 'ready' ? 'positive' : 'attention'} /> : undefined}
    >
      <Gate resource={resource} title="No conscious context" detail="Core has not reported a conscious context.">
        {view ? (
          <>
            <p className="m-mode">
              {view.consciousHealth === 'ready'
                ? 'Every contributing subsystem could be read.'
                : view.consciousReason ?? 'Some contributing subsystems could not be read.'}
            </p>
            {view.absentSections.length > 0 ? (
              <>
                <div className="m-subhead">Not in this build</div>
                <div className="c-chips">{view.absentSections.map((section) => <Chip key={section}>{section}</Chip>)}</div>
                <p className="m-note">Stated rather than drawn as empty lists: "not built yet" and "nothing there" are different claims.</p>
              </>
            ) : (
              <p className="m-note">Core reports no absent section.</p>
            )}
            {provenance ? (
              <>
                <div className="m-subhead">Contributors</div>
                <div className="m-rows">
                  {provenance.sources.map((source) => (
                    <div key={source.domain} className="m-mini">
                      <small>{source.domain}</small>
                      <b>{source.basis} · {source.freshness}</b>
                      {source.durable === null ? null : <small>{source.durable ? 'durable' : 'not durable'}</small>}
                      {source.note ? <small>{source.note}</small> : null}
                    </div>
                  ))}
                </div>
                <p className="m-note">Snapshot as of {new Date(provenance.asOf).toLocaleString('en-GB')}, {provenance.basis} · {provenance.freshness}.</p>
              </>
            ) : null}
            <div className="m-subhead">Recent durable changes</div>
            {changes.length === 0 ? (
              <p className="m-note">Nothing has been recorded since this Core started.</p>
            ) : (
              <div className="c-rows">{changes.slice(0, 6).map((change) => (
                <Row key={change.id} icon="activity" title={change.kind}
                  detail={`sequence ${change.sequence}`} end={new Date(change.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} />
              ))}</div>
            )}
            <p className="m-note">
              A closed kind, a sequence and an instant. An event's own sentence is Core's account of it and is not
              repeated here, and nothing on this screen is a chain-of-thought.
            </p>
          </>
        ) : null}
      </Gate>
    </Card>
  )
}

/* -------------------------------------------------------------------- screen */

export function Mind({ snapshot }: { snapshot: UiSnapshot }): ScreenSlots {
  const resource = snapshot.mind
  return {
    left: (
      <>
        <OverviewCard resource={resource} />
        <AttentionCard resource={resource} />
      </>
    ),
    right: (
      <>
        <ThreadsCard resource={resource} />
        <SelfCard resource={resource} />
      </>
    ),
    bottom: (
      <>
        <MissionsCard resource={resource} />
        <UncertaintyCard resource={resource} />
        <OwnerCard resource={resource} />
        <ProvenanceCard resource={resource} />
      </>
    ),
  }
}
