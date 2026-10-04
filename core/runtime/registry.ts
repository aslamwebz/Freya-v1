import { optional, require } from './dependencies'
import type { RuntimeDomainDescriptor } from './types'

/**
 * The canonical runtime inventory.
 *
 * Every entry names a module that actually exists in this tree. Nothing here is
 * invented: the `module` path is where the implementation lives, and the
 * requirements are read from what that implementation's own ports and options
 * ask for. A domain whose dependencies are not satisfied is reported blocked or
 * degraded by the controller rather than quietly assumed to be running.
 *
 * Order is activation order (low first) and shutdown order (high first). The
 * security spine comes first so STOP ALL is always the last thing released, and
 * the fail-closed domains come last so they can never be reached by a bug in an
 * earlier start.
 */

function descriptor(d: RuntimeDomainDescriptor): RuntimeDomainDescriptor {
  return Object.freeze(d)
}

export const RUNTIME_REGISTRY: readonly RuntimeDomainDescriptor[] = Object.freeze([
  /* ---------------------------------------------------------- security spine */
  descriptor({
    id: 'core.security-spine',
    family: 'memory-security',
    title: 'Guard, Governor, STOP ALL, budgets and approvals',
    module: 'core/security/guard.ts, core/cognition, core/model',
    kind: 'spine',
    activation: 'core-owned',
    requirements: [require('journal', 'the durable event journal')],
    order: 5,
    note: 'The authority path every other domain is gated through. It is never optional.',
  }),
  descriptor({
    id: 'core.vault',
    family: 'memory-security',
    title: 'Encrypted Vault',
    module: 'core/vault',
    kind: 'spine',
    activation: 'core-owned',
    requirements: [
      require('journal', 'the durable event journal'),
      optional('vault', 'an open encrypted Vault'),
    ],
    order: 6,
    note: 'Absent Vault is reported degraded, never silently replaced by a weaker store.',
  }),

  /* ------------------------------------------------- mission / work family */
  descriptor({
    id: 'core.missions',
    family: 'mission-work',
    title: 'Missions',
    module: 'core/missions',
    kind: 'core-owned',
    activation: 'core-owned',
    requirements: [require('journal', 'the durable event journal')],
    order: 10,
    note: 'Falls back to an explicitly ephemeral store when no key is present; its own projection says which.',
  }),
  descriptor({
    id: 'core.work',
    family: 'mission-work',
    title: 'Work execution substrate',
    module: 'core/work',
    kind: 'core-owned',
    activation: 'core-owned',
    requirements: [require('journal', 'the durable event journal')],
    order: 11,
    note: 'Registered capabilities execute nothing until a capability is granted.',
  }),
  descriptor({
    id: 'core.conversation',
    family: 'mission-work',
    title: 'Conversation',
    module: 'core/conversation',
    kind: 'core-owned',
    activation: 'core-owned',
    requirements: [
      require('journal', 'the durable event journal'),
      optional('keyring', 'the Conversation keyring entry', 'conversation'),
    ],
    order: 12,
    note: 'No key means an ephemeral transcript that says it will not survive a restart.',
  }),
  descriptor({
    id: 'core.context',
    family: 'mission-work',
    title: 'Context',
    module: 'core/context',
    kind: 'core-owned',
    activation: 'core-owned',
    requirements: [require('journal', 'the durable event journal')],
    order: 13,
    note: 'Context states what "this" points at; it grants nothing.',
  }),
  descriptor({
    id: 'core.workforce',
    family: 'mission-work',
    title: 'Workforce',
    module: 'core/workforce',
    kind: 'core-owned',
    activation: 'core-owned',
    requirements: [require('journal', 'the durable event journal')],
    order: 14,
    note: 'Subordinate agents hold a closed capability vocabulary and no authority.',
  }),

  /* ------------------------------------------------------- mind / persona */
  descriptor({
    id: 'core.brain',
    family: 'memory-security',
    title: 'Brain and long-term memory',
    module: 'core/brain',
    kind: 'core-owned',
    activation: 'core-owned',
    requirements: [
      require('journal', 'the durable event journal'),
      optional('keyring', 'the Brain keyring entry', 'brain'),
    ],
    order: 15,
    note: 'The Brain never refuses service; a missing key is reported as non-durable.',
  }),
  descriptor({
    id: 'core.personality',
    family: 'mind-persona',
    title: 'Personality and relationship',
    module: 'core/personality',
    kind: 'core-owned',
    activation: 'core-owned',
    requirements: [
      require('journal', 'the durable event journal'),
      optional('keyring', 'the Personality keyring entry', 'personality'),
    ],
    order: 16,
    note: 'Without its key it serves no expression guidance rather than resetting memory.',
  }),
  descriptor({
    id: 'core.attention',
    family: 'mind-persona',
    title: 'Attention and focus',
    module: 'core/attention',
    kind: 'core-owned',
    activation: 'core-owned',
    requirements: [require('journal', 'the durable event journal')],
    order: 17,
    note: 'Deterministic; it decides, and it cannot reach a model on its own.',
  }),
  descriptor({
    id: 'core.office',
    family: 'mind-persona',
    title: 'Office',
    module: 'core/office',
    kind: 'core-owned',
    activation: 'core-owned',
    requirements: [require('journal', 'the durable event journal')],
    order: 18,
    note: 'A pure projection of real state; it invents no station and no percentage.',
  }),
  descriptor({
    id: 'core.relay',
    family: 'mind-persona',
    title: 'Relay connectors',
    module: 'core/relay',
    kind: 'core-owned',
    activation: 'core-owned',
    requirements: [
      require('journal', 'the durable event journal'),
      optional('external-connector', 'at least one external connector'),
    ],
    order: 19,
    note: 'A running engine with no connector is degraded, not absent.',
  }),
  descriptor({
    id: 'core.skills',
    family: 'mind-persona',
    title: 'Skills',
    module: 'core/skills',
    kind: 'core-owned',
    activation: 'core-owned',
    requirements: [require('journal', 'the durable event journal')],
    order: 20,
    note: 'A skill body never enters runtime code; promotion to runtime is refused.',
  }),
  descriptor({
    id: 'core.voice',
    family: 'mind-persona',
    title: 'Voice',
    module: 'core/voice',
    kind: 'core-owned',
    activation: 'core-owned',
    requirements: [
      require('journal', 'the durable event journal'),
      optional('host-adapter', 'a local speech engine', 'voice'),
    ],
    order: 21,
    note: 'No local engine means voice is degraded; no cloud engine is implied.',
  }),

  /* --------------------------------------------------------- world / life */
  descriptor({
    id: 'core.world',
    family: 'world-life',
    title: 'World and self model',
    module: 'core/world',
    kind: 'core-owned',
    activation: 'core-owned',
    requirements: [require('journal', 'the durable event journal')],
    order: 22,
    note: 'Evidence shares the one Vault; there is deliberately no second world key.',
  }),
  descriptor({
    id: 'core.life',
    family: 'world-life',
    title: 'Life history',
    module: 'core/life',
    kind: 'core-owned',
    activation: 'core-owned',
    requirements: [require('journal', 'the durable event journal')],
    order: 23,
    note: 'A derived layer; a Life fault degrades Life and never the security posture.',
  }),
  descriptor({
    id: 'core.consciousness',
    family: 'world-life',
    title: 'Unified conscious context',
    module: 'core/consciousness',
    kind: 'core-owned',
    activation: 'core-owned',
    requirements: [require('journal', 'the durable event journal')],
    order: 24,
    note: 'Derived and stored nowhere; it cannot become a second source of truth.',
  }),
  descriptor({
    id: 'core.lifeloop',
    family: 'world-life',
    title: 'Continuous life loop',
    module: 'core/lifeloop',
    kind: 'core-owned',
    activation: 'core-owned',
    requirements: [require('journal', 'the durable event journal')],
    order: 25,
    note: 'Zero idle inference: no wake, no spend, and no write verb in the vocabulary.',
  }),
  descriptor({
    id: 'core.foundry',
    family: 'world-life',
    title: 'Foundry',
    module: 'core/foundry',
    kind: 'core-owned',
    activation: 'core-owned',
    requirements: [require('journal', 'the durable event journal')],
    order: 26,
    note: 'Deterministic artifact identity; activation of an artifact grants no authority.',
  }),

  /* ------------------------------------------------------- long horizon */
  descriptor({
    id: 'core.long-horizon',
    family: 'long-horizon',
    title: 'Long-horizon autonomy',
    module: 'core/longhorizon',
    kind: 'phase-runtime',
    activation: 'blocked',
    requirements: [
      require('journal', 'the durable event journal'),
      require('continuation', 'the continuation subsystem'),
      require('store', 'a goal store'),
    ],
    order: 100,
    note: 'Implemented and unit-proved; the continuation subsystem is not wired into Core here.',
  }),

  /* ------------------------------------------------------- fail-closed */
  descriptor({
    id: 'core.economic',
    family: 'economic',
    title: 'Economic intelligence (paper only)',
    module: 'core/economic',
    kind: 'phase-runtime',
    activation: 'fail-closed',
    requirements: [require('journal', 'the durable event journal')],
    order: 101,
    note: 'Fail-closed: research, simulation and paper trading only; no real-money authority exists.',
  }),
  descriptor({
    id: 'core.enterprise',
    family: 'enterprise',
    title: 'Autonomous enterprise',
    module: 'core/enterprise',
    kind: 'phase-runtime',
    activation: 'fail-closed',
    requirements: [require('journal', 'the durable event journal')],
    order: 102,
    note: 'Fail-closed: bounded workflows only; no spending authority and no hidden inference.',
  }),

  /* ------------------------------------------------------- multi-device */
  descriptor({
    id: 'core.multidevice',
    family: 'multi-device',
    title: 'Multi-device',
    module: 'core/multidevice',
    kind: 'phase-runtime',
    activation: 'blocked',
    requirements: [
      require('journal', 'the durable event journal'),
      require('transport', 'a device transport'),
      require('trusted-device', 'a trusted enrolled device'),
    ],
    order: 103,
    note: 'Networking and device trust are not invented here; both are required and absent.',
  }),

  /* ------------------------------------------------------- device hands */
  descriptor({
    id: 'core.device-hands',
    family: 'device-hands',
    title: 'Device Hands (browser, terminal, clipboard, transfer)',
    module: 'core/devicehands',
    kind: 'phase-runtime',
    activation: 'blocked',
    requirements: [
      require('journal', 'the durable event journal'),
      require('host-adapter', 'the Device Hands host adapter', 'device-hands'),
      require('capability-grant', 'a Device Hands capability grant', 'device.hands'),
    ],
    order: 104,
    note: 'No real browser, terminal, clipboard or file authority without a truthful adapter and grants.',
  }),

  /* ------------------------------------------------------- resilience */
  descriptor({
    id: 'core.resilience',
    family: 'resilience',
    title: 'Resilience and self-recovery',
    module: 'core/resilience',
    kind: 'phase-runtime',
    activation: 'blocked',
    requirements: [
      require('journal', 'the durable event journal'),
      require('recovery-journal', 'a dedicated recovery journal seam'),
    ],
    order: 105,
    note: 'Integrated into the lifecycle only where its evidence and storage seams are satisfied.',
  }),

  /* ------------------------------------------------------- sovereignty */
  descriptor({
    id: 'core.sovereignty',
    family: 'sovereignty',
    title: 'Sovereign intelligence (provider independence, offline, portable data)',
    module: 'core/sovereign',
    kind: 'phase-runtime',
    activation: 'activatable',
    requirements: [require('journal', 'the durable event journal')],
    order: 106,
    note: 'Registered and dependency-checked; it causes no hidden model call by being available.',
  }),

  /* ------------------------------------------------------- evolution */
  descriptor({
    id: 'core.evolution',
    family: 'evolution',
    title: 'Cognitive evolution',
    module: 'core/evolution',
    kind: 'phase-runtime',
    activation: 'activatable',
    requirements: [require('journal', 'the durable event journal')],
    order: 107,
    note: 'A proposed change never applies itself; the drift check refuses any widening.',
  }),

  /* ------------------------------------------------------- threshold */
  descriptor({
    id: 'core.threshold',
    family: 'threshold',
    title: 'Mature Freya threshold framework',
    module: 'core/threshold',
    kind: 'framework',
    activation: 'activatable',
    requirements: [require('journal', 'the durable event journal')],
    order: 108,
    note: 'A measurement system, never an authority source: a mature result unlocks nothing.',
  }),
])

export function registryById(id: string): RuntimeDomainDescriptor | undefined {
  return RUNTIME_REGISTRY.find((entry) => entry.id === id)
}

/** The registry in deterministic activation order. */
export function orderedRegistry(): readonly RuntimeDomainDescriptor[] {
  return [...RUNTIME_REGISTRY].sort((a, b) => a.order - b.order)
}
