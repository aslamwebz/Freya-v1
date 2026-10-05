import { createCore } from '../index'
import type { Core } from '../index'
import type { RuntimeProjection } from '../runtime/types'

/**
 * The live half of the qualification lane.
 *
 * The rest of `core/qualification/` is pure: it derives answers from a descriptor and
 * a fact set. Something has to actually start a Core for those answers to be about
 * this build rather than about a hypothetical one, and this is that something.
 *
 * It is deliberately tiny and deliberately honest:
 *
 *   - It starts a **real** Core against a **real** directory. Nothing here is faked and
 *     nothing is stubbed, so the journal it writes is a journal somebody could read.
 *   - It supplies **no** key, no Vault, no provider credential and no host seam. That
 *     is not a limitation, it is the measurement: a bare Core on a bare machine is
 *     the floor, and any capability that reports `active` at that floor is claiming more
 *     than the evidence supports.
 *   - It returns the controller's own projection. The inventory reads that rather than
 *     recomputing it, so the release report cannot describe a different runtime from
 *     the one that started.
 */

/** The environment a qualification run declares. Read, never invented. */
export interface QualificationEnvironment {
  /** Whether the operator's environment names a provider credential. */
  readonly providerCredentialInEnv: boolean
  /** Whether the run was given a live-traffic switch. Never set by this module. */
  readonly liveModelRequested: boolean
  /** Whether an OS keyring was available for the run. Reported, never assumed. */
  readonly keyringAvailable: boolean
  /** The platform the qualification is being performed on. */
  readonly platform: string
}

/**
 * What a real Core reports about itself once it has started.
 *
 * `facts` is deliberately absent. The projection already carries everything the
 * inventory needs — each domain's own measured dependency evidence and the status the
 * controller decided from it — so the report reads those rather than reconstructing a
 * fact set and risking a second, more flattering answer. `core/qualification/
 * inventory.ts#buildInventoryFromProjection` consumes the projection directly.
 */
export interface LiveQualification {
  readonly core: Core
  readonly projection: RuntimeProjection
  readonly lifecycle: string
  readonly environment: QualificationEnvironment
  /** Stop and release. Idempotent. */
  stop(): Promise<void>
}

export interface StartLiveQualificationOptions {
  /** A real directory the Core may write its journal and stores into. */
  readonly dataPath: string
  readonly environment: QualificationEnvironment
  readonly now?: () => Date
  readonly newId?: () => string
}

/**
 * Start a real Core and read what it actually reports.
 *
 * No provider credential, no key, no Vault, no host seam. A caller that wants a
 * different floor has to say so explicitly, because the whole value of this function is
 * that it reports the *plainest* one.
 */
export async function startLiveQualification(
  options: StartLiveQualificationOptions,
): Promise<LiveQualification> {
  const core = createCore({
    dataPath: options.dataPath,
    // An explicitly empty provider environment. Nothing here reads the operator's own
    // environment, so a qualification run cannot accidentally spend a real credential
    // or inherit a real keyring entry from the shell that launched it.
    env: {},
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.newId === undefined ? {} : { newId: options.newId }),
  })

  await core.start()

  let stopped = false
  return {
    core,
    projection: core.runtime(),
    lifecycle: core.status().lifecycle,
    environment: options.environment,
    async stop(): Promise<void> {
      if (stopped) return
      stopped = true
      await core.stop('phase 49 qualification run finished')
    },
  }
}