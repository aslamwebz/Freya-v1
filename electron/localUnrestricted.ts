/**
 * Whether this host is allowed to run unrestricted — the decision, and nothing else.
 *
 * ## What "unrestricted" means here
 *
 * A single boolean widens, at once, every hard limit the desktop host otherwise
 * enforces: Device Hands' five allowlists become empty lists, `allowPrivateHosts`
 * turns on, `allowProtectedFields` turns on, and `requestOwnerApproval` starts
 * answering `granted: true` with `decidedBy: 'owner'` (`electron/main.ts`). So
 * this is not a debugging convenience. It is a grant of every local authority the
 * product has, including an owner approval that nothing actually asked for.
 *
 * That is why it used to be so easy to get wrong. The original read:
 *
 *     return process.env.FREYA_LOCAL_UNRESTRICTED === '1' || !app.isPackaged
 *
 * which meant *every unpackaged build was unrestricted unless somebody remembered
 * to opt out*. The documented onboarding path (`npm start`, `npm run electron:dev`)
 * both produce unpackaged builds. So a developer following the README ran with
 * private-host browsing, protected-field access and a self-issued owner approval
 * enabled, silently, having asked for none of it.
 *
 * The same expression also made `FREYA_LOCAL_UNRESTRICTED=1` an escalation path
 * for **packaged** builds, because the `=== '1'` arm was evaluated before the
 * packaging question was asked at all.
 *
 * ## The rule now
 *
 * Three conditions, all required, and they fail closed:
 *
 *   1. **The build is not packaged.** Checked first and never overridable. No
 *      environment variable, on any platform, re-opens a packaged build.
 *   2. **The operator asked**, with `FREYA_LOCAL_UNRESTRICTED=1`. Absent, or set
 *      to anything else — including `0`, `true`, `yes`, `on` — it stays off.
 *   3. **A separate, disposable profile was named.** `FREYA_DEV_USER_DATA` must be
 *      a non-empty string, and the process must be dev-tagged (`--dev`). This is
 *      the same pair of conditions `electron/main.ts` already requires before it
 *      will move `userData` at all, so "unrestricted" and "operating on somebody's
 *      real profile" can never both be true.
 *
 * Condition 3 is what makes condition 2 safe to grant. A flag that widens every
 * local authority is only defensible when the thing being widened is a scratch
 * directory that gets deleted; on a real profile it is a silent privilege grant
 * aimed at the owner's own files.
 *
 * ## Failing loudly instead of silently
 *
 * `localUnrestrictedDecision` returns the reason alongside the boolean. A
 * developer who set `FREYA_LOCAL_UNRESTRICTED=1` and is still restricted gets told
 * *which* condition failed, instead of discovering it as a browser that refuses to
 * open localhost. That is the difference between a security control and a trap.
 */

export interface LocalUnrestrictedInputs {
  /** `app.isPackaged`. The packaging question, asked first and answered absolutely. */
  readonly isPackaged: boolean
  /** `process.env.FREYA_LOCAL_UNRESTRICTED`. Exact `'1'` or nothing. */
  readonly requested: string | undefined
  /** `process.env.FREYA_DEV_USER_DATA`. The separate profile the host would use. */
  readonly devUserData: string | undefined
  /** `process.argv`. Unrestricted mode additionally requires the `--dev` tag. */
  readonly argv: readonly string[]
}

export type LocalUnrestrictedReason =
  | 'packaged-build-always-strict'
  | 'not-requested'
  | 'no-separate-profile'
  | 'not-dev-tagged'
  | 'granted'

export interface LocalUnrestrictedDecision {
  /** The single boolean every call site reads. */
  readonly mode: boolean
  /** Why. Never thrown, never logged with a value, never inferred. */
  readonly reason: LocalUnrestrictedReason
}

/**
 * Decide whether this host runs unrestricted.
 *
 * Pure: it reads four inputs and returns a verdict. That is deliberate — the
 * property under test is "a packaged build is strict", and a property that can
 * only be checked by booting Electron is a property nobody checks.
 */
export function localUnrestrictedDecision(inputs: LocalUnrestrictedInputs): LocalUnrestrictedDecision {
  // Checked first, and returned before anything else is consulted. This is the
  // ordering that makes a packaged build strict no matter what the environment says.
  if (inputs.isPackaged) return { mode: false, reason: 'packaged-build-always-strict' }
  if (inputs.requested !== '1') return { mode: false, reason: 'not-requested' }
  if (inputs.devUserData === undefined || inputs.devUserData.length === 0) {
    return { mode: false, reason: 'no-separate-profile' }
  }
  if (!inputs.argv.includes('--dev')) return { mode: false, reason: 'not-dev-tagged' }
  return { mode: true, reason: 'granted' }
}

/**
 * The host's own inputs, read at the moment of the call.
 *
 * A function rather than three module constants so a test cannot pass one truth
 * and the host act on another: the decision and the inputs it was given are the
 * same expression. `electron/main.ts` passes these in and keeps its
 * `localUnrestrictedMode(): boolean` contract unchanged.
 */
export function localUnrestrictedFromProcess(
  isPackaged: boolean,
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
): LocalUnrestrictedDecision {
  return localUnrestrictedDecision({
    isPackaged,
    requested: env.FREYA_LOCAL_UNRESTRICTED,
    devUserData: env.FREYA_DEV_USER_DATA,
    argv,
  })
}