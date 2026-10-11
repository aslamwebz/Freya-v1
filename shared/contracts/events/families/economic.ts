export const ECONOMIC_EVENT_TYPES = [
// Economic Intelligence (Phase 32) — metadata only, and the family whose *absence* of
  // a field is the guarantee.
  //
  // Nineteen events describing bounded economic work: an experiment's lifecycle, the
  // evidence gathered about it, a simulation run, a **simulated** order, a metric, a gate
  // decision, a refusal, and the wake that occasioned any of it. None carries a price
  // series, a simulation metric, a research answer, a prompt or a provider identity.
  //
  // None carries a venue, a broker, an account, a wallet, a custody relationship, a
  // withdrawal, a deposit or an amount of anything either, and that absence is enforced
  // three ways over: the payload shapes below have no field for one, the journal
  // validator refuses the forbidden keys outright, and `core/economic/assertions.ts`
  // reports their appearance as a `noRealMoneyAction` violation. Three mechanisms for one
  // promise is not redundancy — it is the difference between a policy and a type.
  //
  // The two that come closest to authority are `economic.gate.decided` and
  // `economic.unstopped`, and neither mints anything: the first *records* which gates
  // Core already cleared, and the second records the owner's own act of clearing a latch,
  // which the fold refuses unless a `security.stop_all.cleared` stands behind it.
  'economic.experiment.created',
'economic.experiment.state-changed',
'economic.experiment.completed',
'economic.experiment.failed',
'economic.experiment.cancelled',
'economic.evidence.gathered',
'economic.simulation.started',
'economic.simulation.completed',
'economic.paper-order.placed',
'economic.paper-order.filled',
'economic.metric.computed',
'economic.continuation.decided',
'economic.gate.decided',
'economic.refusal.recorded',
'economic.wake.received',
'economic.wake.denied',
'economic.reconciled',
'economic.stopped',
'economic.unstopped',
] as const
export interface EconomicEventPayloads {
/* ------------------------------------------------------ economic intelligence */

  /**
   * An experiment was defined.
   *
   * `criteria` is the one field in this whole family wide enough to be worth explaining:
   * a bounded, ` | `-joined list of slugs, capped by `ECONIC_LIMITS`, which is what lets
   * a completion criterion be a *claim key* rather than a sentence. Nothing else in
   * Phase 32 is allowed to be prose, and this is a list of keys.
   */
  'economic.experiment.created': {
    experimentId: string
    kind: string
    state: string
    title: string
    question: string
    criteria: string
    criteriaCount: number
    progress: number
    deadlineAt: string
    createdAt: string
    updatedAt: string
  }

/**
   * The experiment moved one bounded stage.
   *
   * `from` and `to` are both recorded **and** both checked by the fold against the state
   * machine's own answer, so an entry claiming an impossible move is refused rather than
   * believed. Recording them anyway is what makes that check possible — and it means the
   * journal cannot rewind a stage by asserting it used to be elsewhere.
   */
  'economic.experiment.state-changed': {
    experimentId: string
    from: string
    to: string
    signal: string
    progress: number
    reasoning: string
    updatedAt: string
  }

/** Terminal success. Carries no conclusion — the criteria are re-derived from evidence. */
  'economic.experiment.completed': {
    experimentId: string
    from: string
    progress: number
    criteriaMet: number
    completedAt: string
  }

/**
   * Terminal failure, with a closed code.
   *
   * Also the event a **cancellation** is journalled as, because the stage machine tracks
   * progress and a cancelled experiment has none. The distinction the owner cares about —
   * finished, failed, or stopped looking — lives in the experiment's lifecycle state,
   * which has three separate terminal values.
   */
  'economic.experiment.failed': {
    experimentId: string
    from: string
    code: string
    updatedAt: string
  }

'economic.experiment.cancelled': {
    experimentId: string
    from: string
    reason: string
    updatedAt: string
  }

/**
   * One piece of evidence about one claim.
   *
   * `state` and `confidence` are recorded but **not trusted**: the fold re-derives both
   * from `observedAt` and the set of source references on every read, because freshness
   * is a function of the clock and a journalled "fresh" would stop being fresh.
   */
  'economic.evidence.gathered': {
    evidenceId: string
    experimentId: string
    source: string
    sourceRef: string
    citation: string
    claim: string
    observedAt: string
    state: string
    confidence: string
  }

/** A scenario started. Counts, never parameters or a series. */
  'economic.simulation.started': {
    scenarioId: string
    experimentId: string
    strategy: string
    parameterCount: number
    assumptionCount: number
    observationCount: number
    startedAt: string
  }

/**
   * A scenario finished.
   *
   * **No metrics.** A metric carries a name, a value, a denominator and a unit, and
   * letting the journal hold them would make it the place a simulation's numbers live —
   * which is exactly the thing a reader would then have to trust. What is durable here is
   * that a run happened, over how many observations, and the numbers are recomputed from
   * the series on demand. `failed` says whether there was a result at all.
   */
  'economic.simulation.completed': {
    scenarioId: string
    experimentId: string
    resultId: string
    strategy: string
    metricCount: number
    observationCount: number
    completedAt: string
    failed: boolean
  }

/**
   * A **simulated** order was placed.
   *
   * There is no venue field, no account field and no broker field, and there is nothing
   * in this shape for one to go in. `reasoning` is a single closed code rather than a
   * list, because a durable payload is scalars and a list would be the first open-ended
   * structure in a file whose whole value is that it cannot hold one.
   */
  'economic.paper-order.placed': {
    orderId: string
    experimentId: string
    symbol: string
    side: string
    quantity: number
    price: number
    placedAt: string
    reasoning: string
  }

/**
   * A simulated order was filled against the simulated portfolio.
   *
   * `realizedPnl` is recorded but **recomputed** by the fold from the position
   * arithmetic, and a mismatch is an anomaly. A journal that could assert a profit the
   * arithmetic does not support would be the one place in Phase 32 where a number could
   * be made up.
   */
  'economic.paper-order.filled': {
    orderId: string
    experimentId: string
    positionId: string
    symbol: string
    side: string
    quantity: number
    price: number
    realizedPnl: number
  }

/**
   * One metric. `denominator` and `unit` are **not optional**, and a metric whose
   * denominator would be zero is never emitted at all rather than reported as `0/0`.
   */
  'economic.metric.computed': {
    metricId: string
    experimentId: string
    name: string
    value: number
    denominator: number
    unit: string
    computedAt: string
  }

/**
   * What the continuation decided, before it moved.
   *
   * Journalled separately from the move that follows, so a reader sees what was concluded
   * before seeing where it went — and so a decision to stop is recorded even if the
   * process died between deciding and moving. `reasoning` is one closed code and `blocker`
   * is one closed code or empty, because this is the entry that answers "why did Freya do
   * nothing here?", and an answer with a free-text field in it is not one.
   */
  'economic.continuation.decided': {
    experimentId: string
    wakeId: string
    decision: string
    stage: string
    reasoning: string
    blocker: string
    evidenceCount: number
    scenarioCount: number
    orderCount: number
    attempt: number
  }

/**
   * Which gates cleared, and which one refused.
   *
   * `checked` is the ordered prefix that passed, ` | `-joined, so a denial reads as
   * "three cleared and then the budget ran out" rather than as a bare no. Journalled on
   * the allowed path too: the record that a thing *was* permitted is worth as much to an
   * auditor as the record that it was not. `remainingUnits` is a count of bounded work,
   * never an amount of anything.
   */
  'economic.gate.decided': {
    wakeId: string
    experimentId: string
    outcome: string
    code: string
    checked: string
    remainingUnits: number
    at: string
  }

/**
   * A request was refused.
   *
   * `code` is closed and `subject` is a closed kind, so a caller's own text can never
   * reach the journal through a refusal — which is the oldest mistake in this trade and
   * the reason the shape is two codes rather than one string.
   */
  'economic.refusal.recorded': {
    refusalId: string
    code: string
    subject: string
    experimentId: string
    wakeId: string
    at: string
  }

/** Metadata only, and the wake the whole family hangs off. */
  'economic.wake.received': {
    wakeId: string
    source: string
    kind: string
    wakeKey: string
    experimentId: string
    goalRef: string
    sourceRef: string
    occurredAt: string
    observedAt: string
  }

/**
   * The registry refused a wake. Bookkeeping, not a move: a wake that never entered the
   * continuation leaves the subsystem exactly where it was, and this is the only trace it
   * leaves. The dedupe key is deliberately not consumed, so a wake that was never
   * processed may legitimately arrive again.
   */
  'economic.wake.denied': {
    wakeId: string
    source: string
    kind: string
    code: string
    experimentId: string
  }

/**
   * A restart or an owner pre-emption reconciled the position to what the journal proves.
   *
   * Not a continuation step, and deliberately not in the state machine's ordinary table:
   * a process that died mid-stage cannot be resumed, so the experiment is *recorded as
   * interrupted* and left where it was. Putting a fake signal in the table would make
   * every entry in it less trustworthy.
   */
  'economic.reconciled': {
    code: string
    from: string
    experimentId: string
    atStage: string
  }

/**
   * STOP ALL reached the subsystem.
   *
   * The one event that may override terminality, and it can only ever *set* the latch.
   * Re-asserting a clearable stop is legitimate — a subsystem that closed out cleanly
   * sits latched with a clearable code, and the owner pressing the button in the same turn
   * has to leave a latch behind. The upgrade is one-directional, so accepting it cannot
   * release anything.
   */
  'economic.stopped': {
    experimentId: string
    stage: string
    code: string
  }

/**
   * The owner cleared the latch. One key, deliberately.
   *
   * This is the owner's act and nothing in Phase 32 may write it; the fold refuses an
   * entry that arrives without a `security.stop_all.cleared` behind it, which is what
   * stops one line in a text file from un-pressing a panic button.
   */
  'economic.unstopped': {
    code: string
  }
}