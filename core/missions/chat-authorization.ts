import type { Capability } from '../../shared/contracts/capabilities'
import type { PrincipalId } from '../../shared/contracts/identity'
import { isGrantActive, type CognitionGrant } from '../cognition/grants'
import type { ChatMissionBinding } from './chat-types'

/**
 * WHETHER A CHAT MISSION MAY SPEND ANYTHING.
 *
 * Extracted from `core/index.ts` because these three questions are one decision — "is this
 * Mission still allowed to reach the outside world?" — and were three methods sitting in the
 * middle of a file about twenty other things.
 *
 * ## Why they are together
 *
 * Each is a necessary condition and none is sufficient:
 *
 * 1. `chatResearchAvailable` — Core has a research surface, is operational, is not stopped,
 *    is durable, has an encrypted conversation store, and the **owner principal** still holds
 *    every capability a Mission step could reach. This is the ambient check: it does not
 *    mention the Mission at all, so it answers "could anything run right now".
 * 2. `chatMissionGrantAvailable` — the Mission's own cognition grant exists, has not expired,
 *    was issued by the owner, and permits background work. This is the per-Mission check: a
 *    different Mission's valid grant does not help.
 * 3. `chatMissionAuthorized` — the binding names this owner, and its grant passes (2).
 *
 * ## The capability list is closed on purpose
 *
 * `CHAT_MISSION_CAPABILITIES` is a literal list, not a prefix test and not "all of them".
 * A capability added to the vocabulary later is therefore **not** automatically spendable by a
 * chat Mission until somebody adds it here — which means adding a capability to Freya cannot
 * silently widen what a chat Mission may do. The reverse of the browser rule in
 * `core/index.ts`'s `mayPlanChatCapability`, and the same principle: widening by omission is
 * the failure mode nobody reviews.
 */
export const CHAT_MISSION_CAPABILITIES: readonly Capability[] = [
  'mission.manage',
  'work.execute',
  'research.start',
  'search.web',
  'browser.read',
  'cognition.request',
]

/** The live facts an ambient availability check consults. All read at the moment of asking. */
export interface ChatMissionEnvironment {
  /** Core has a research surface wired at all. */
  readonly researchPresent: boolean
  /** Core is serving commands. */
  readonly operational: boolean
  /** Nothing is shutting down. */
  readonly stopped: boolean
  /** History is durable, so a claim about what happened survives a restart. */
  readonly durable: boolean
  /** STOP ALL is not latched. */
  readonly stopAllActive: boolean
  /** The conversation store is encrypted; an ephemeral one cannot hold an approved scope. */
  readonly conversationEncrypted: boolean
  /** Whether the owner principal still holds one capability. */
  holdsOwnerCapability(capability: Capability): boolean
}

/** The per-Mission facts an authorization check consults. */
export interface ChatMissionGrantEnvironment {
  readonly ownerId: PrincipalId
  /** The Missions' cognition grants, read live. */
  grants(): readonly CognitionGrant[]
  now(): Date
  /** This Mission's conversation binding, or null when it is not a chat Mission. */
  bindingFor(missionId: string): Promise<ChatMissionBinding | null>
}

/** Whether *anything* chat-Mission-shaped could run right now. Says nothing about a Mission. */
export function chatResearchAvailable(environment: ChatMissionEnvironment): boolean {
  return environment.researchPresent &&
    environment.operational &&
    !environment.stopped &&
    environment.durable &&
    !environment.stopAllActive &&
    environment.conversationEncrypted &&
    CHAT_MISSION_CAPABILITIES.every(capability => environment.holdsOwnerCapability(capability))
}

/**
 * Whether this exact grant is usable for this exact Mission.
 *
 * Four conditions, all necessary: it exists, it has not expired, the **owner** issued it, and
 * it permits background work. The actor check is what stops a grant another principal created
 * from authorising work on the owner's behalf, and `backgroundAllowed` is what stops a
 * foreground grant — issued for one answer — from being spent by a Mission that runs on.
 */
export function chatMissionGrantAvailable(
  missionId: string,
  grantId: string,
  environment: ChatMissionGrantEnvironment,
): boolean {
  const grant = environment.grants().find(candidate => candidate.goalId === missionId && candidate.id === grantId)
  return !!grant && isGrantActive(grant, environment.now()) && grant.actor === environment.ownerId && grant.backgroundAllowed
}

/**
 * Whether this Mission is still allowed to reach the outside world.
 *
 * The binding must exist and name this owner, and its grant must still be usable. It does
 * **not** consider whether the Mission is paused or settled — those are checked at the point
 * of use, where the live status is already being read, so a paused Mission is refused there
 * with a reason that names the pause rather than being refused here for a reason that does not.
 */
export async function chatMissionAuthorized(missionId: string, environment: ChatMissionGrantEnvironment): Promise<boolean> {
  const binding = await environment.bindingFor(missionId)
  return !!binding && binding.ownerId === environment.ownerId && chatMissionGrantAvailable(missionId, binding.grantId, environment)
}