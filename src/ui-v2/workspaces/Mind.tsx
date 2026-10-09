import type { ReactNode } from 'react'
import { Badge, EmptyState, Panel } from '../primitives/Controls'
import { ListRow, type WorkspaceProps } from './shared'
import type { MindAttentionView, MindSelfView, MindThreadView, MindView } from '../state/contract'

/**
 * Mind — the control room, rendered from the projection and nothing else.
 *
 * This workspace used to be two things: a pending card in a live window and a
 * finished concept design in a preview one — "Curious · Always learning", a
 * three-goal roadmap with month dates, "72% complete" rows. Every one of this
 * screen's old values was a module constant, and each read exactly like a
 * measurement. None of them was.
 *
 * It is now one renderer for both windows, because the projection is the whole
 * content in both. The preview fixture is built out of Core's own *absent*
 * projections rather than invented ones (see `state/preview.ts`), so a browser
 * sees the same honest "not projected" states a live window shows when a
 * domain has not reported — which is the state a real window spends most of
 * its life in. The shell still announces `ui-mode="preview"` for it.
 *
 * Three rules, the same three the adapter is written around:
 *
 * 1. **Report only what the projection carries.** Every word, count and code
 *    below is copied out of `MindView`. Nothing is inferred, smoothed or
 *    back-filled. A number Core never took renders as an em dash, never as a
 *    zero, because a zero is a claim.
 * 2. **Absence is a state, not a gap.** A domain that has not reported renders
 *    its own reason; a section Core said is not in this build is named as
 *    absent rather than drawn as an empty list that reads as "nothing there".
 * 3. **No hidden reasoning crosses.** There is no thought, monologue, prompt or
 *    model output here, and no trait percentage: nothing in Core measures one.
 *
 * The workspace is read-only by construction. It submits no command, holds no
 * write verb, and renders no control that could mint authority: Governor
 * posture and grant *counts* are facts Core reports, and the grant objects
 * themselves never leave Core.
 */

/** A count that was never taken renders as an em dash, never as zero. */
function count(value: number | null): string {
  return value === null ? '—' : value.toLocaleString('en-GB')
}

const modeTone: Readonly<Record<MindView['overview']['mode'], 'neutral' | 'positive' | 'attention' | 'danger'>> = {
  stopped: 'danger',
  unavailable: 'attention',
  uncertain: 'attention',
  working: 'positive',
  idle: 'neutral',
}

const threadIcons: Readonly<Record<MindThreadView['kind'], string>> = {
  run: 'activity',
  mission: 'mission',
  worker: 'workforce',
  approval: 'bell',
}

/** One labelled fact. The label is the field's name; the value is Core's. */
function Fact({ label, value }: { label: string; value: string }) {
  return <div className="f-summary-line"><span className="f-muted">{label}</span><span>{value}</span></div>
}

/** A block that is either the projected content or an honest absence. */
function Section({ health, reason, title, missing, children }: {
  health: 'ready' | 'unavailable'
  reason: string | null
  title: string
  missing: string
  children?: ReactNode
}) {
  if (health !== 'ready') {
    return <Panel title={title}><EmptyState title={missing} detail={reason ?? 'Core has not reported this domain.'} /></Panel>
  }
  return <Panel title={title}>{children}</Panel>
}

function PosturePanel({ view }: { view: MindView }) {
  const overview = view.overview
  return <Panel title="Posture · what Freya is doing" meta={<Badge tone={modeTone[overview.mode]}>{overview.mode}</Badge>}>
    <p className="f-muted">{overview.modeDetail}</p>
    <Fact label="Lifecycle" value={overview.lifecycle} />
    <Fact label="Serving commands" value={overview.operational ? 'yes' : 'no'} />
    <Fact label="STOP ALL" value={overview.stopped ? 'latched' : 'clear'} />
    {/* The Governor's own posture. `unknown` is not `deny_all`: a Core that has
        not finished booting has no answer, and this row reports the word it
        gave rather than claiming a stop latch that may not be set. */}
    <Fact label="Governor" value={overview.governorStatus} />
    <Fact label="Grants held" value={count(overview.grantsActive)} />
    <Fact label="Provider calls" value={count(overview.activeProviderCalls)} />
    <Fact label="Journal" value={overview.journalIntegrity} />
    <Fact label="History" value={overview.persistenceMode} />
    <Fact label="Event sequence" value={count(overview.sequence)} />
    {overview.persistenceReason === null ? null : <p className="f-muted">{overview.persistenceReason}</p>}
    {overview.faults.length === 0 ? null : <div className="f-tags">
      <span className="f-eyebrow">Recorded faults, in Core's words</span>
      {overview.faults.map((fault) => <Badge key={fault} tone="danger">{fault}</Badge>)}
    </div>}
    <div className="f-eyebrow">Cognition this session</div>
    <Fact label="Session calls" value={count(overview.sessionCalls)} />
    <Fact label="Input tokens" value={count(overview.sessionInputTokens)} />
    <Fact label="Output tokens" value={count(overview.sessionOutputTokens)} />
    <Fact label="Calls with no usage" value={count(overview.sessionUnknownUsageCalls)} />
    {overview.sessionUnknownUsageCalls === 0 ? null :
      <p className="f-muted">Token totals are a lower bound: {count(overview.sessionUnknownUsageCalls)} calls reported no usage.</p>}
    <div className="f-eyebrow">Providers Core would answer with</div>
    {overview.providers.length === 0
      ? <p className="f-muted">Core reports no providers.</p>
      : overview.providers.map((provider) => <ListRow key={provider.id} icon="chip"
          title={`${provider.id} · ${provider.kind}`}
          detail={provider.model === null ? provider.detail : `${provider.model} · ${provider.detail}`}
          end={<Badge tone={provider.liveEnabled ? 'positive' : 'neutral'}>{provider.liveEnabled ? 'live' : provider.status}</Badge>} />)}
    {/* The model is not Freya. A provider is chosen and authorised inside Core;
        this window names no grant and no budget, and cannot. */}
    <p className="f-muted">A provider is chosen and authorised inside Core. This window reports what Core named, and nothing it can change.</p>
  </Panel>
}

function AttentionPanel({ attention }: { attention: MindAttentionView }) {
  if (attention.health !== 'ready' || attention.counts === null) {
    return <Section health="unavailable" reason={attention.reason} title="Attention · what Core is watching"
      missing="No Attention domain is reporting" />
  }
  const counts = attention.counts
  return <Panel title="Attention · what Core is watching" meta={<Badge tone="cognition">{attention.focus}</Badge>}>
    {/* Core's own closed FocusState — focused / available / away / unknown.
        There is no denominator for a percentage anywhere in the codebase, so
        there is no percentage. */}
    <p className="f-muted">Core reports <b>{attention.focus}</b>.</p>
    <Fact label="Ingested" value={count(counts.ingested)} />
    <Fact label="Decided" value={count(counts.decisions)} />
    <Fact label="Cued" value={count(counts.cued)} />
    <Fact label="Spoke" value={count(counts.spoke)} />
    <Fact label="Interrupted" value={count(counts.interrupted)} />
    <Fact label="Do-nothing" value={count(counts.doNothing)} />
    <Fact label="Remembered" value={count(counts.remembered)} />
    <Fact label="Over budget" value={count(counts.budgetExceeded)} />
    <p className="f-muted">{count(attention.inboxCount)} retained events — metadata only. An event's text stays in Core.</p>
    {attention.lastDecision === null
      ? <p className="f-muted">Core has recorded no decision yet.</p>
      : <>
        <div className="f-eyebrow">Last decision</div>
        <ListRow icon="activity" title={`${attention.lastDecision.source} · ${attention.lastDecision.kind}`}
          detail={`${attention.lastDecision.outcome} · ${attention.lastDecision.importance} / ${attention.lastDecision.urgency} · ${attention.lastDecision.decidedAt}`}
          end={<Badge>{attention.lastDecision.reason}</Badge>} />
      </>}
  </Panel>
}

function ThreadsPanel({ view }: { view: MindView }) {
  return <Panel title="Active threads · what is open now"
    meta={view.threads.length === 0 ? undefined : <Badge tone="cognition">{view.threads.length}</Badge>}>
    {view.threads.length === 0
      ? <EmptyState title="Nothing is in progress" detail="No run, Mission, worker or approval is open right now." />
      : view.threads.map((thread) => <ListRow key={`${thread.kind}-${thread.id}`} icon={threadIcons[thread.kind]}
          title={`${thread.kind} · ${thread.id}`}
          detail={thread.detail ?? 'no further detail projected'}
          end={thread.live
            ? <Badge tone="positive">live · {thread.status}</Badge>
            : <Badge>{thread.status}</Badge>} />)}
    {view.waiting.pendingApprovals === 0 ? null :
      <p className="f-muted">{count(view.waiting.pendingApprovals)} approvals waiting on a person. Deciding one is an owner act, not a control on this surface.</p>}
  </Panel>
}

function SelfPanel({ self }: { self: MindSelfView }) {
  return <Panel title="Self · who Freya is, in Core's words"
    meta={self.complete ? <Badge tone="positive">complete</Badge> : <Badge tone="attention">partial</Badge>}>
    {self.name === null && self.role === null && self.purpose === null
      ? <EmptyState title="No identity is projected" detail={self.reason ?? 'Core has not reported an identity root.'} />
      : <>
        <h3 className="f-narrative">{self.name ?? 'Unnamed'}</h3>
        {self.role === null ? null : <p className="f-muted">{self.role}</p>}
        {self.purpose === null ? null : <blockquote className="f-muted">{self.purpose}</blockquote>}
      </>}
    <Fact label="Root claims" value={count(self.claimCount)} />
    <Fact label="Self-definition" value={self.complete ? 'complete' : 'incomplete'} />
    <Fact label="Survives a restart" value={self.durable ? 'yes' : 'no'} />
    {/* No trait meters. Nothing in Core measures a temperament percentage, and
        a meter that rendered one would be printing fiction. */}
    {self.claims.length === 0 ? null : <>
      <div className="f-eyebrow">Root claims</div>
      {self.claims.map((claim) => <ListRow key={claim.claimId} icon="core" title={claim.statement} detail={claim.claimId} />)}
    </>}
    {self.capabilities.length === 0 ? null : <>
      <div className="f-eyebrow">Seeded capabilities</div>
      {self.capabilities.map((capability) => <ListRow key={capability.capability} icon="chip" title={capability.capability}
        detail={capability.cannot.length === 0 ? 'no stated exclusions' : `cannot: ${capability.cannot.join(', ')}`}
        end={<Badge>{capability.state}</Badge>} />)}
    </>}
    {self.limitations.length === 0 ? null : <>
      <div className="f-eyebrow">Stated limitations</div>
      {self.limitations.map((limitation) => <ListRow key={limitation.limitationId} icon="bell"
        title={limitation.statement} detail={limitation.limitationId} end={<Badge tone="attention">limitation</Badge>} />)}
    </>}
    {self.world === null ? null : self.world.health !== 'ready'
      ? <EmptyState title="No world model is reporting" detail={self.world.reason ?? 'Core has not reported a world model.'} />
      : <>
        <div className="f-eyebrow">World model — counts only</div>
        <Fact label="Entities" value={count(self.world.entities)} />
        <Fact label="Edges" value={count(self.world.edges)} />
        <Fact label="Evidence records" value={count(self.world.evidenceRecords)} />
        <Fact label="Beliefs" value={count(self.world.beliefs)} />
        <Fact label="Conflicts" value={count(self.world.conflicts)} />
        <Fact label="Uncertainties" value={count(self.world.uncertainties)} />
        <Fact label="Withdrawn" value={count(self.world.withdrawn)} />
        {/* Withheld is counted because it is real and shown because hiding it
            would claim Freya holds nothing private. */}
        <Fact label="Withheld" value={count(self.world.withheld)} />
        <Fact label="Survives a restart" value={self.world.durable ? 'yes' : 'no'} />
        <p className="f-muted">Core projects no entity names here, and nothing a window can do writes one.</p>
      </>}
    <div className="f-eyebrow">Compartments read from Core</div>
    {self.worldSelf === null
      ? <p className="f-muted">Core builds the seven-compartment self model fresh on request and streams nothing, and this window has not read it yet.</p>
      : <>
        <p className="f-muted">
          Read {self.worldSelf.readAt === null ? 'just now' : self.worldSelf.readAt} via {self.worldSelf.source}.
          Core builds this fresh each time and streams nothing, so the reading is that old.
        </p>
        <Fact label="Guard capabilities held" value={`${count(self.worldSelf.assignedCapabilities.filter((row) => row.held).length)} of ${count(self.worldSelf.assignedCapabilities.length)} asked`} />
        <Fact label="Known skills" value={count(self.worldSelf.knownSkills.length)} />
        <Fact label="Providers that would answer" value={count(self.worldSelf.models.length)} />
        <Fact label="Worker claims on record" value={count(self.worldSelf.workerClaims.length)} />
        <div className="f-eyebrow">The separations Core states about itself</div>
        {Object.entries(self.worldSelf.separation).map(([rule, value]) =>
          <Fact key={rule} label={rule} value={typeof value === 'boolean' ? String(value) : value} />)}
      </>}
  </Panel>
}

function MissionsPanel({ view }: { view: MindView }) {
  return <Panel title="Goals · what Freya is working toward"
    meta={view.missionsTotal === 0 ? undefined : <Badge tone="cognition">{count(view.missionsTotal)}</Badge>}>
    {view.missions.length === 0
      ? <EmptyState title="No Missions yet" detail="A Mission records what the owner asked Freya to accomplish. None is projected." />
      : view.missions.map((mission) => <ListRow key={mission.id} icon="mission"
          title={mission.awaitingOwner ? `${mission.id} · waiting on the owner` : mission.id}
          detail={[
            mission.nextDecision === null ? null : `next: ${mission.nextDecision}`,
            mission.nextReason,
            mission.verifiedRuns === 0 ? null : `${count(mission.verifiedRuns)}/${count(mission.totalRuns)} runs verified`,
            mission.blockers.length === 0 ? null : `blocked by: ${mission.blockers.join(', ')}`,
          ].filter((part): part is string => part !== null).join(' · ') || 'no further detail projected'}
          end={<>
            {mission.needsAttention ? <Badge tone="attention">needs attention</Badge> : null}
            <Badge>{mission.priority}</Badge>
            <Badge>{mission.status}</Badge>
          </>} />)}
    {/* Titles and intents live in the encrypted Mission store and the bridge
        exposes no read for them. Saying so is the honest alternative to an
        invented roadmap — and no roadmap date exists anywhere in Core. */}
    <p className="f-muted">Mission titles, intents and dates are not projected to this window. What crosses is status, counts, blockers and the last continuation decision.</p>
    {view.missionsHidden === 0 ? null :
      <p className="f-muted">{count(view.missionsHidden)} not listed — the projection bounds its own listing rather than hiding them silently.</p>}
    <div className="f-eyebrow">Actions Core has advertised</div>
    {view.nextActions.length === 0
      ? <p className="f-muted">Core has advertised no next action.</p>
      : view.nextActions.map((action) => <ListRow key={`${action.scope}-${action.subjectId}-${action.action}`}
          icon="arrow" title={action.action} detail={`${action.scope} · ${action.subjectId}`} />)}
  </Panel>
}

function OwnerPanel({ view }: { view: MindView }) {
  const owner = view.owner
  return <Panel title="Owner · only what Core is allowed to say">
    <div className="f-eyebrow">Relationship</div>
    {owner.personalityHealth === 'ready'
      ? <>
        <Fact label="Continuity" value={owner.continuity ?? 'not interpreted'} />
        <Fact label="Formality" value={owner.formality ?? 'not interpreted'} />
        <Fact label="Records held" value={count(owner.relationshipItems)} />
        <Fact label="Admitted" value={count(owner.admittedItems)} />
        <Fact label="Cues admitted" value={count(owner.cuesAdmitted)} />
        <Fact label="Survives a restart" value={owner.relationshipDurable === null ? '—' : owner.relationshipDurable ? 'yes' : 'no'} />
        {owner.temperament.length === 0
          ? <p className="f-muted">Core has not projected a standing temperament.</p>
          : <div className="f-tags">{owner.temperament.map((row) =>
            <Badge key={row.dimension}>{row.dimension}: {row.level}</Badge>)}</div>}
      </>
      : <EmptyState title="No Personality domain is reporting"
          detail={owner.personalityReason ?? 'Core has not reported a Personality projection.'} />}
    {/* No preference wording, habit, inside joke or relationship text crosses
        this boundary; the projection carries health, closed labels and counts. */}
    <p className="f-muted">What a person told Freya stays in Core's encrypted store. This window receives health, closed labels and counts, and nothing it can do writes one.</p>
    <div className="f-eyebrow">Context</div>
    {owner.contextHealth === 'ready'
      ? <>
        <Fact label="Items held" value={count(owner.contextItems)} />
        <Fact label="Current" value={count(owner.contextCurrent)} />
        <Fact label="Scopes" value={owner.contextScopes.length === 0 ? '—' : owner.contextScopes.join(', ')} />
        <Fact label="Unresolved references" value={count(owner.contextUnresolvedReferences)} />
        <Fact label="Survives a restart" value={owner.contextDurable === null ? '—' : owner.contextDurable ? 'yes' : 'no'} />
      </>
      : <EmptyState title="No Context domain is reporting"
          detail={owner.contextReason ?? 'Core has not reported a Context projection.'} />}
  </Panel>
}

function WaitingPanel({ view }: { view: MindView }) {
  const waiting = view.waiting
  const open = waiting.pendingApprovals > 0 || waiting.waitingRuns.length > 0
    || waiting.blockedAgents.length > 0 || waiting.unfulfilledPresenceRequests > 0
  return <Panel title="Waiting & uncertainty · what is open">
    {open
      ? <>
        <Fact label="Approvals pending" value={count(waiting.pendingApprovals)} />
        <Fact label="Runs waiting" value={count(waiting.waitingRuns.length)} />
        <Fact label="Agents blocked" value={count(waiting.blockedAgents.length)} />
        <Fact label="Presence unfulfilled" value={count(waiting.unfulfilledPresenceRequests)} />
        {waiting.waitingRuns.map((run) => <ListRow key={run.runId} icon="activity" title={run.runId}
          detail={`waiting · ${run.status}${run.waitingSince === null ? '' : ` · since ${run.waitingSince}`}`} />)}
        {waiting.blockedAgents.map((agent) => <ListRow key={agent.workerId} icon="workforce" title={agent.workerId}
          detail={`blocked · ${agent.status}`} end={<Badge tone="attention">blocked</Badge>} />)}
      </>
      : <p className="f-muted">Nothing is waiting.</p>}
    <div className="f-eyebrow">Open questions</div>
    {view.uncertainties.length === 0
      ? <p className="f-muted">{view.absentSections.includes('uncertainty')
          ? 'Core does not project an uncertainty section in this build.'
          : 'Core reports nothing it could not settle.'}</p>
      : view.uncertainties.map((item) => <ListRow key={`${item.code}-${item.subjectId ?? item.subjectKind}`}
          icon="bell" title={item.code}
          detail={item.subjectId === null ? item.subjectKind : `${item.subjectKind} · ${item.subjectId}${item.since === null ? '' : ` · since ${item.since}`}`}
          end={<Badge tone="attention">unsettled</Badge>} />)}
    {view.uncertaintiesOmitted === 0 ? null :
      <p className="f-muted">{count(view.uncertaintiesOmitted)} more not listed — the projection bounds its own listing.</p>}
    {/* A code and a subject, never a sentence. Nothing here is a thought, a
        worry or an inner monologue: it is Core naming a fact it could not
        establish. */}
    <p className="f-muted">A closed code and a subject, never a sentence about what Freya is thinking.</p>
  </Panel>
}

function ProvenancePanel({ view }: { view: MindView }) {
  return <Panel title="Provenance · who said what, and how fresh"
    meta={<Badge tone={view.consciousHealth === 'ready' ? 'positive' : 'attention'}>{view.consciousHealth}</Badge>}>
    <p className="f-muted">{view.consciousHealth === 'ready'
      ? 'Every contributing subsystem of the conscious context could be read.'
      : view.consciousReason ?? 'Some contributing subsystems could not be read.'}</p>
    {view.absentSections.length === 0
      ? <p className="f-muted">Core reports no absent section.</p>
      : <>
        <div className="f-tags">
          <span className="f-eyebrow">Not in this build</span>
          {view.absentSections.map((section) => <Badge key={section}>{section}</Badge>)}
        </div>
        {/* Stated rather than drawn as empty lists: "not built yet" and
            "nothing there" are different claims. */}
        <p className="f-muted">Named as absent rather than drawn as empty lists, because "not built yet" and "nothing there" are different claims.</p>
      </>}
    {view.provenance === null
      ? <p className="f-muted">No contributor snapshot has been projected.</p>
      : <>
        <div className="f-eyebrow">Contributors</div>
        {view.provenance.sources.map((source) => <ListRow key={source.domain} icon="core" title={source.domain}
          detail={[source.basis, source.freshness, source.durable === null ? null : source.durable ? 'durable' : 'not durable', source.note]
            .filter((part): part is string => part !== null).join(' · ')} />)}
        <p className="f-muted">Snapshot as of {view.provenance.asOf} · {view.provenance.basis} · {view.provenance.freshness}.</p>
      </>}
    <div className="f-eyebrow">Recent durable changes</div>
    {view.recentChanges.length === 0
      ? <p className="f-muted">Nothing has been recorded since this Core started.</p>
      : view.recentChanges.slice(0, 6).map((change) => <ListRow key={change.id} icon="activity" title={change.kind}
          detail={`sequence ${change.sequence} · ${new Date(change.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`}
          end={<Badge tone={change.tone === 'good' ? 'positive' : change.tone === 'bad' ? 'danger' : 'neutral'}>{change.tone}</Badge>} />)}
    {/* An event's own sentence is Core's account of it and is not repeated
        here, and nothing on this surface is a chain-of-thought. */}
    <p className="f-muted">A closed kind, a sequence and an instant. An event's own text stays in Core.</p>
  </Panel>
}

export function Mind({ snapshot }: WorkspaceProps) {
  const resource = snapshot.mind
  if (resource.status === 'loading') {
    return <div className="f-workspace"><EmptyState title="Waiting for Freya Core" detail="Core has not reported its Mind projection yet." /></div>
  }
  if (resource.status === 'unavailable' || resource.status === 'error') {
    return <div className="f-workspace"><EmptyState title="Mind is not reporting" detail={resource.reason} /></div>
  }
  const view = resource.data
  const stale = resource.status === 'stale'
  return <div className="f-workspace">
    {/* The one provenance read for the whole surface. A stale projection must
        never look current, and a design preview never looks live: the shell
        labels the window, and this line labels the projection. */}
    <div className="f-summary-line">
      <span>{stale
        ? `Stale projection — ${resource.reason}`
        : resource.source === 'preview'
          ? 'Design preview. No Core is projected in this window, so nothing here is live.'
          : 'Projected from Freya Core. Every row is a fact Core reported.'}</span>
      <span>{view.overview.mode} · {view.consciousHealth}</span>
    </div>
    <div className="f-card-grid">
      <PosturePanel view={view} />
      <AttentionPanel attention={view.attention} />
      <ThreadsPanel view={view} />
      <SelfPanel self={view.self} />
      <MissionsPanel view={view} />
      <OwnerPanel view={view} />
      <WaitingPanel view={view} />
      <ProvenancePanel view={view} />
    </div>
  </div>
}
