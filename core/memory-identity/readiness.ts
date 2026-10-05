import type { Brain } from '../brain/brain'
import {
  MEMORY_IDENTITY_DOMAINS,
  type DomainDurabilityPort,
  type DomainReadiness,
  type MemoryIdentityDomain,
  type MemoryIdentityDomainPorts,
} from './types'

/**
 * ONE TRUTHFUL ANSWER TO "WHAT IS FREYA'S MEMORY DOING RIGHT NOW?"
 *
 * Eight domains hold durable knowledge about the owner and the world. Each keeps its
 * own store, each fails in its own way, and until now nothing could say "which of
 * these will still be here tomorrow" without asking all eight. That is the gap this
 * file closes, and it is deliberately a **report and nothing else** — no port is
 * opened, no snapshot is committed, no key is touched.
 *
 * ## Two separations this file is built around
 *
 * **Durable is not healthy.** A domain can be durable and damaged (the bytes are on
 * disk and something in them could not be believed) or healthy and not durable (this
 * session's memory, which works perfectly and vanishes on restart). Those are
 * different problems with different fixes, and a single boolean would hide both.
 *
 * **None of it is a security fact.** Unreadable knowledge is neither permission nor
 * lockout. A Brain that cannot be opened does not stop a mission, does not clear a
 * stop and does not widen a budget. This report therefore carries no authority field
 * and no code path here reads one — `stopAllActive`, budgets and grants stay in
 * Guard and the Governor, read fresh at the moment of use. A memory surface that
 * displayed them would be showing a stale copy of the most security-relevant facts
 * in the system, which is worse than showing none.
 *
 * ## An absent domain is not a healthy domain
 *
 * Every port is optional, and a domain that was never wired in is reported as
 * `durable: false` with a reason saying it was not wired. Defaulting it to healthy
 * would let a partially assembled Core claim complete memory coverage.
 */
export function readinessOf(brain: Brain, ports: MemoryIdentityDomainPorts = {}): DomainReadiness[] {
  const brainHealth = brain.health()
  const state = brain.state()

  const memory: DomainReadiness = {
    domain: 'memory',
    wired: true,
    durable: brainHealth.persistence === 'encrypted',
    healthy: brainHealth.health === 'healthy',
    reason: brainReason(brainHealth.persistence, brainHealth.health, brainHealth.reason),
    held: state.memories.size,
  }

  const identity: DomainReadiness = {
    domain: 'identity',
    wired: true,
    // Identity is code, so it is as durable as the build. The interesting case is the
    // opposite one: a Brain that never got seeded has no identity, and that is
    // reported rather than papered over with a default.
    durable: state.identity !== null,
    healthy: state.identity !== null,
    reason: state.identity === null ? 'Freya has not been seeded with an identity on this machine yet' : null,
    held: state.identity === null ? 0 : state.identity.claims.length,
  }

  const self: DomainReadiness = {
    domain: 'self',
    wired: true,
    durable: state.self !== null,
    healthy: state.self !== null,
    reason: state.self === null ? 'Freya has no stored description of her own capabilities yet' : null,
    held: state.self === null ? 0 : state.self.limitations.length,
  }

  return [
    memory,
    identity,
    self,
    fromPort('personality', ports.personality),
    fromPort('relationship', ports.relationship),
    fromPort('context', ports.context),
    fromPort('life', ports.life),
    fromPort('sovereignty', ports.sovereignty),
  ]
}

/**
 * The sentence a surface shows for one domain, or null when there is nothing to say.
 *
 * Null is reserved for "durable and healthy", so a surface can render `reason`
 * unconditionally when it is non-null and never has to invent wording.
 */
function brainReason(persistence: string, health: string, reason: string | null): string | null {
  if (health !== 'healthy') return reason ?? `Freya's long-term memory is ${health}`
  if (persistence !== 'encrypted') {
    return persistence === 'unavailable'
      ? 'Freya cannot open her long-term memory right now'
      : 'Freya is holding her long-term memory in this process only: it will not survive a restart, and nothing was written in plain text instead'
  }
  return null
}

/**
 * One injected port, read for durability only.
 *
 * Nothing here calls `load` or `commit`. Those are asynchronous and can fail, and a
 * projection that awaited them would be able to hang or throw — while telling the
 * owner nothing they did not already have from the port's own fields. The durability
 * half of these ports is synchronous by design precisely so a surface can render it
 * on every frame.
 */
/** The domains that answer for themselves rather than through an injected port. */
const BRAIN_OWNED: readonly MemoryIdentityDomain[] = Object.freeze(['memory', 'identity', 'self'])

function fromPort(domain: MemoryIdentityDomain, port: DomainDurabilityPort | undefined): DomainReadiness {
  if (port === undefined) {
    return {
      domain,
      // Unknown rather than broken, and the distinction is load-bearing: a domain this
      // build never wired must not be able to make the whole subsystem report
      // `degraded`, or every un-wired assembly would cry wolf about damage that does
      // not exist.
      wired: false,
      durable: false,
      healthy: false,
      reason: `${domain} is not wired into this build, so nothing about it is known`,
      held: null,
    }
  }
  const faulted = port.faultReason !== null
  const durable = port.durable
  return {
    domain,
    wired: true,
    durable,
    healthy: !faulted,
    reason: faulted
      ? (port.faultReason ?? `${domain} could not be trusted`)
      : durable
        ? null
        : (port.durabilityReason ?? `${domain} will not survive a restart`),
    // Null rather than zero: these ports do not count, and inventing a count would
    // make an unwired domain look like an empty one.
    held: null,
  }
}

/**
 * The status across every domain, as one word.
 *
 * Three rules, and the second is the one a first implementation gets wrong:
 *
 *  1. `unavailable` beats `degraded` beats `healthy`, and only the Brain's own memory
 *     can be `unavailable` — it is the one domain with no fallback.
 *  2. **An unwired domain is not a degraded one.** Only `wired && !healthy` domains
 *     count towards `degraded`. Reporting a partially assembled build as damaged
 *     would train a person to ignore the word, which is exactly when a real fault
 *     needs reading.
 *  3. `durable` is about the **Brain**, deliberately. "Will a restart keep what was
 *     learned" is a question about the memory store, and answering it as an `every`
 *     over eight domains would report `false` for any build that has not wired
 *     personality yet — technically defensible and completely useless. Per-domain
 *     durability is available in `readinessOf` for anyone who needs it.
 */
export function overallReadiness(brain: Brain, ports: MemoryIdentityDomainPorts = {}): {
  health: 'healthy' | 'degraded' | 'unavailable'
  reason: string | null
  durable: boolean
} {
  const domains = readinessOf(brain, ports)
  const memory = domains.find((entry) => entry.domain === 'memory')

  if (memory?.healthy === false) {
    return { health: 'unavailable', reason: memory.reason, durable: false }
  }

  const broken = domains.filter((entry) => entry.wired && !BRAIN_OWNED.includes(entry.domain) && !entry.healthy)
  if (broken.length > 0) {
    return {
      health: 'degraded',
      reason: `${broken.length} part(s) of Freya's memory cannot be trusted: ${broken
        .map((entry) => entry.domain)
        .join(', ')}`,
      durable: memory?.durable === true,
    }
  }

  // Healthy, and possibly still not durable. The memory domain's own sentence is the
  // right one to surface here, because "it works, and it will not survive a restart"
  // is exactly what a person needs to know before they tell Freya something.
  return {
    health: 'healthy',
    reason: memory?.durable === true ? null : (memory?.reason ?? null),
    durable: memory?.durable === true,
  }
}

export { MEMORY_IDENTITY_DOMAINS }
