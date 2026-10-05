import { forgeIntegrityHash } from './manifest'
import type { ForgeManifest, ForgeRefusalCode } from './types'

/**
 * VERSIONING — immutable versions, explicit downgrades, and no silent overwrite.
 *
 * Three rules, each answering a specific way a runtime talks itself into running
 * something nobody approved:
 *
 * 1. **A version's bytes never change.** A version number that exists with
 *    different content is `version-conflict`, whether it was ever installed or is
 *    still a candidate. An attacker (or a careless generator retry) that can
 *    rewrite version 3 has rewritten the thing a person approved.
 * 2. **Installed versions are contiguous.** The next installed version is exactly
 *    one past the highest installed. A gap would make "which version is installed?"
 *    ambiguous after a rollback, and ambiguity about what is running is the whole
 *    thing rollback exists to prevent.
 * 3. **A downgrade is a decision, not a side effect.** Moving to an *older*
 *    installed version is refused unless the caller passes `allowDowngrade`,
 *    because that flag is the only place "I meant to do that" can live.
 *
 * ## Why candidates and installed versions are counted separately
 *
 * A candidate occupies a version number the moment it is generated — that is what
 * makes a retried generation idempotent rather than a second package. But it is
 * not *installed*, and the contiguity rule must not treat "a candidate at v3 exists"
 * as "v2 and v3 are installed". So the summary carries both lists, and the planner
 * asks about the installed one. Getting this wrong is how a first install turns into
 * "identical version, nothing to do" and a package silently never runs.
 */

export interface ForgeVersionSummary {
  /** Every version number this package has ever had a body for, ascending. */
  readonly versions: readonly number[]
  /** The version the catalog currently points at, whatever its lifecycle status. */
  readonly currentVersion: number | null
  /** Every version that was ever installed, ascending. */
  readonly installedVersions: readonly number[]
  /** The version that is installed right now, if any. */
  readonly installedVersion: number | null
  /** version → integrity hash, for every known version. */
  readonly hashes: Readonly<Record<number, string>>
}

export type VersionPlan =
  | { readonly ok: true; readonly action: 'install-new' | 'upgrade' | 'downgrade'; readonly version: number }
  | { readonly ok: false; readonly code: ForgeRefusalCode; readonly reason: string }

export function planInstall(
  summary: ForgeVersionSummary | null,
  manifest: ForgeManifest,
  integrityHash: string,
  allowDowngrade: boolean,
): VersionPlan {
  const version = manifest.version

  if (summary === null) {
    if (version !== 1) {
      return {
        ok: false,
        code: 'version-conflict',
        reason: `a new package starts at version 1; this candidate claims ${version}`,
      }
    }
    return { ok: true, action: 'install-new', version }
  }

  const recorded = summary.hashes[version]
  if (recorded !== undefined && recorded !== integrityHash) {
    return {
      ok: false,
      code: 'version-conflict',
      reason: `version ${version} already exists with different content; a version is immutable, so this would overwrite what was approved`,
    }
  }

  const alreadyInstalled = summary.installedVersions.includes(version)
  const highestInstalled = summary.installedVersions.length === 0
    ? null
    : (summary.installedVersions[summary.installedVersions.length - 1] as number)

  if (alreadyInstalled && (highestInstalled === null || version >= highestInstalled)) {
    return {
      ok: false,
      code: 'identical-version',
      reason: `version ${version} is already installed with these exact bytes, and a version that changes nothing is not a new version`,
    }
  }

  if (alreadyInstalled || version < (summary.currentVersion ?? version)) {
    if (!allowDowngrade) {
      return {
        ok: false,
        code: 'downgrade-not-explicit',
        reason: `version ${version} is older than the current ${summary.currentVersion}; moving back is allowed only when the owner asks for it explicitly`,
      }
    }
    return { ok: true, action: 'downgrade', version }
  }

  if (highestInstalled === null) {
    if (version !== 1) {
      return {
        ok: false,
        code: 'version-conflict',
        reason: `the first installed version of a package is 1; this candidate claims ${version}`,
      }
    }
    return { ok: true, action: 'install-new', version }
  }

  if (version === highestInstalled + 1) {
    return { ok: true, action: 'upgrade', version }
  }

  return {
    ok: false,
    code: 'version-conflict',
    reason: `the next installed version of this package is ${highestInstalled + 1}; ${version} would leave a gap in its history`,
  }
}

export type RollbackPlan =
  | { readonly ok: true; readonly version: number; readonly from: number }
  | { readonly ok: false; readonly code: ForgeRefusalCode; readonly reason: string }

export function planRollback(summary: ForgeVersionSummary, target: number): RollbackPlan {
  const current = summary.currentVersion
  if (current === null) {
    return { ok: false, code: 'not-installed', reason: 'this package has no version to roll back from' }
  }
  if (target === current) {
    return { ok: false, code: 'identical-version', reason: `version ${target} is already the current version` }
  }
  // Whether the version was ever installed is asked *before* the direction, because
  // "there is nothing to go back to" is a more useful sentence than "that is not
  // backwards" — and a version that was never installed is the same fact whichever
  // direction the caller thought they were going.
  if (!summary.installedVersions.includes(target)) {
    return {
      ok: false,
      code: 'no-such-version',
      reason: `version ${target} was never installed, so there is nothing to return to`,
    }
  }
  if (target > current) {
    return {
      ok: false,
      code: 'version-conflict',
      reason: `rolling forward to ${target} is an upgrade, not a rollback`,
    }
  }
  return { ok: true, version: target, from: current }
}

/**
 * Whether a stored body still is what the journal says it is.
 *
 * Checked on recovery and before every run. A mismatch is never repaired: the
 * package is quarantined and a person decides what happens next, because a body
 * that changed under a hash is exactly the case where "recompute and carry on" is
 * the attack.
 */
export function detectForgeTamper(
  manifest: ForgeManifest,
  recordedHash: string | null,
): { readonly tampered: boolean; readonly computed: string } {
  const computed = forgeIntegrityHash(manifest)
  if (recordedHash === null) return { tampered: true, computed }
  return { tampered: recordedHash !== computed, computed }
}