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
