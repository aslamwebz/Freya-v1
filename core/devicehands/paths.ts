import { DEVICE_HANDS_LIMITS, isDeviceHandsRefusalCode, type DeviceHandsRefusalCode } from './types'
import { listDigest } from './digest'

/**
 * Paths and URLs: the surface policy, and the two predicates every file-touching
 * action must pass before a port is called.
 *
 * ## What is deliberately enforced
 *
 * - **Denial outranks permission.** A path is refused when it is inside any denied
 *   root, when any segment of it matches a code-owned credential-store pattern, or
 *   when it traverses — in that order. It is never rescued by being inside an allowed
 *   root.
 * - **An empty allowlist is a refusal, not "everywhere".** A policy with no roots, no
 *   hosts, no commands or no env names is refused by
 *   {@link normaliseSurfacePolicy}, so a host that forgets to configure something
 *   fails closed rather than open.
 * - **A policy with no denied root is refused.** This is the load-bearing asymmetry:
 *   the Vault and keyring paths are the one thing that may never be optional, so a
 *   policy that arrives without them does not become a policy with no protection.
 * - **Traversal is refused, not resolved.** `..` is a refusal
 *   (`path-traversal`) rather than something normalised away. Normalising is the
 *   right answer for a filesystem library and the wrong answer for a gate: a path
 *   that *asked* to leave its directory has already said something.
 * - **No process working directory.** Normalisation takes an explicit base and an
 *   absent base means "absolute only". Reading `process.cwd()` would make a security
 *   decision depend on an ambient value this module cannot see or bound.
 *
 * ## What is deliberately absent
 *
 * No `node:fs`, no `node:path`, no `node:os`. This module decides; a port acts. It
 * cannot tell you whether a file exists, which is exactly why a caller cannot use it
 * to discover the shape of the disk.
 */

/* ------------------------------------------------------------ denied tables */

/**
 * Directory and file names refused wherever they appear in a path.
 *
 * Code-owned and unremovable, because these are the *operating system's* and
 * *browser's* credential stores, and they are credential stores wherever Freya runs.
 * A path is denied by containing one of these as a segment — so
 * `/tmp/.aws/credentials` is refused even though `/tmp` might be an allowed root, and
 * `C:/Users/x/project/logins.json` is refused even though the project is allowed.
 */
export const DENIED_PATH_SEGMENTS: readonly string[] = Object.freeze([
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.kube',
  '.docker',
  '.npmrc',
  '.netrc',
  '.git-credentials',
  '.env',
  'credentials',
  'credential',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'logins.json',
  'login data',
  'cookies',
  'cookies.sqlite',
  'key4.db',
  'cert9.db',
  'signons.sqlite',
  'local state',
  'freya.keyring.json',
  'shadow',
  'secrets',
  'secrets.json',
  '.pgpass',
  '.my.cnf',
  'keystore',
  'private-keys',
])

/**
 * Patterns refused wherever they appear as a path segment.
 *
 * A second table because names alone cannot cover every credential store: a backup
 * of a keyring called `freya.keyring.json.bak` contains none of the exact names, and
 * a vault export called `vault-export-2026.zip` contains none of the glob patterns
 * either without `*vault*`. Both patterns are intentionally broad — the cost of a
 * false positive is one refused path, and the cost of a false negative is a secret.
 */
export const DENIED_PATH_SEGMENT_PATTERNS: readonly string[] = Object.freeze([
  '*vault*',
  '*keyring*',
  '*keychain*',
  '*credential*',
  '*secret*',
  '*password*',
  '*.key',
  '*.pem',
  '*.p12',
  '*.pfx',
  '*.kdbx',
  '*.keystore',
  '*private*key*',
  '.env.*',
])

/**
 * Environment-variable names refused wherever they are named.
 *
 * Matched case-insensitively as substrings of the name, so `AWS_SECRET_ACCESS_KEY`,
 * `GITHUB_TOKEN`, `FREYA_VAULT_PASSPHRASE` and `DATABASE_PASSWORD` are all refused
 * without a rule per vendor. The surface policy's `allowedEnvNames` is validated
 * against this table, so a policy cannot opt one in.
 */
export const DENIED_ENV_NAME_WORDS: readonly string[] = Object.freeze([
  'secret',
  'token',
  'password',
  'passwd',
  'passphrase',
  'credential',
  'private',
  'apikey',
  'api_key',
  'accesskey',
  'access_key',
  'auth',
  'session',
  'cookie',
  'keyring',
  'vault',
  'encryption_key',
  'master_key',
])

/* --------------------------------------------------------------- the policy */

/** The narrowed policy one session operates within. */
export interface SurfacePolicy {
  /** Explicit local-development profile. Omitted/false means the strict policy. */
  readonly localUnrestricted?: boolean
  /** Normalised absolute roots. Strict mode refuses an empty list. */
  readonly allowedRoots: readonly string[]
  /** Normalised absolute denied roots. Never empty: a policy without them is refused. */
  readonly deniedRoots: readonly string[]
  /** Lower-case hostnames. Never empty. */
  readonly allowedHosts: readonly string[]
  /** Bare executable names, no separator. Never empty. */
  readonly allowedCommands: readonly string[]
  /** Upper-case variable names. Never empty. */
  readonly allowedEnvNames: readonly string[]
  /** Bytes one transfer may move. Clamped to the code-owned ceiling. */
  readonly maxTransferBytes: number
  /** The canonical digest of everything above, compared across a restart. */
  readonly digest: string
}

export type PolicyReading =
  | { readonly ok: true; readonly policy: SurfacePolicy }
  | {
      readonly ok: false
      readonly code: DeviceHandsRefusalCode
      readonly reason: string
    }

export interface PolicyInput {
  /** Explicit local-development profile. Packaged/production callers omit this. */
  readonly localUnrestricted?: boolean
  readonly allowedRoots: readonly string[]
  readonly deniedRoots: readonly string[]
  readonly allowedHosts: readonly string[]
  readonly allowedCommands: readonly string[]
  readonly allowedEnvNames: readonly string[]
  readonly maxTransferBytes?: number
}

/* ------------------------------------------------------------- normalising */

/**
 * Normalise a path without consulting the process.
 *
 * `base` defaults to `null`, which means *absolute only*. Every accepted path comes
 * back with forward slashes, no `.` segments, no empty segments and no trailing
 * slash — so `C:\Users\x\..\x` and `/tmp/./` reduce to something comparable, and a
 * Windows drive letter is upper-cased because the filesystem is case-insensitive
 * there and `c:` and `C:` are the same directory.
 *
 * Returns null for anything this build will not interpret: a NUL or control
 * character, a `~` (whose meaning depends on a shell this module does not use), a
 * UNC path or a `\\?\` device path (whose target is opaque), or a traversal segment.
 */
export function normalisePath(input: string, base: string | null = null): string | null {
  if (typeof input !== 'string') return null
if (input.length === 0 || input.length > 4096) return null
  // A NUL byte truncates a path in every C API underneath, and the rest are control
  // characters no legitimate file name carries. Refusing them here means a path
  // cannot be split into "the part this gate checked" and "the part the OS sees".
  for (let index = 0; index < input.length; index += 1) { const code = input.charCodeAt(index); if (code < 32 || code === 127) return null }
  if (input.startsWith('~')) return null
  if (input.startsWith('\\\\') || input.startsWith('//?/')) return null

  const windows = /^[A-Za-z]:[\\/]/.test(input)
  const absolute = windows || input.startsWith('/')

  let prefix = ''
  let rest = input.replace(/\\/g, '/')
  if (windows) {
    // The prefix keeps its trailing separator, so `C:/workspace` does not become
    // `C:workspace` — which on Windows means something entirely different: a path
    // relative to the current directory *on that drive*.
    prefix = `${rest.slice(0, 2).toUpperCase()}/`
    rest = rest.slice(2)
  } else if (rest.startsWith('/')) {
    prefix = '/'
    rest = rest.slice(1)
  }

  if (!absolute) {
    if (base === null) return null
    const normalisedBase = normalisePath(base)
    if (normalisedBase === null) return null
    prefix = normalisedBase.slice(0, normalisedBase.lastIndexOf('/') + 1) || '/'
    rest = `${normalisedBase.slice(normalisedBase.lastIndexOf('/') + 1)}/${rest}`
  }

  const out: string[] = []
  for (const segment of rest.split('/')) {
    if (segment === '' || segment === '.') continue
    // Refused, not resolved. A path that asked to climb out has already said what it
    // wanted, and "we normalised it back inside" is not a decision a gate should make
    // on the caller's behalf.
    if (segment === '..') return null
    out.push(segment)
  }
  if (out.length === 0) return null
  return `${prefix === '' ? '/' : prefix}${out.join('/')}`
}

/** A case-sensitive comparison of two normalised paths. */
function isInside(child: string, root: string): boolean {
  if (child === root) return true
  const prefix = root.endsWith('/') ? root : `${root}/`
  return child.startsWith(prefix)
}

/**
 * A case-insensitive comparison, used **only** for denials.
 *
 * The asymmetry is the whole point: on a case-insensitive filesystem
 * `C:/users/x/.AWS/credentials` *is* `C:/Users/x/.aws/credentials`, so a
 * case-sensitive denial check would miss it. But allowing a path because it
 * differed only in case would be a way to escape an allowlist, so {@link isPathAllowed}
 * never does that. Denials match either way; permissions match exactly.
 */
function isInsideIgnoringCase(child: string, root: string): boolean {
  return isInside(child.toLowerCase(), root.toLowerCase())
}

/** Anchored, case-insensitive glob where `*` is the only metacharacter. */
function matchesPattern(segment: string, pattern: string): boolean {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${source}$`, 'i').test(segment)
}

/**
 * Why a path is denied, or null when it is not denied.
 *
 * Checked in the order the refusals should win: an absolute denied root (the Vault
 * itself) beats a segment pattern (a `*.pem` somewhere), which beats the traversal
 * and control-character checks already applied in {@link normalisePath}.
 */
export function pathDenialReason(
  candidate: string,
  policy: Pick<SurfacePolicy, 'deniedRoots'>,
): { readonly code: DeviceHandsRefusalCode; readonly reason: string } | null {
  const normalised = normalisePath(candidate)
  if (normalised === null) {
    return {
      code: 'path-malformed',
      reason: 'That path is not one this build can read: it is empty, absolute-only, a home shorthand, a UNC or device path, or it contains a traversal segment.',
    }
  }
  for (const root of policy.deniedRoots) {
    if (isInsideIgnoringCase(normalised, root)) {
      return {
        code: 'vault-path-denied',
        reason: `"${normalised}" is inside Freya protected state (${root}). The Vault and its backups are never reachable through Device Hands, by any request.`,
      }
    }
  }
  for (const segment of normalised.split('/')) {
    const lower = segment.toLowerCase()
    if (DENIED_PATH_SEGMENTS.includes(lower)) {
      return {
        code: 'credential-store-denied',
        reason: `"${segment}" is an operating-system or browser credential store. Device Hands never reads or writes one, even when the directory above it is allowed.`,
      }
    }
    for (const pattern of DENIED_PATH_SEGMENT_PATTERNS) {
      if (matchesPattern(lower, pattern)) {
        return {
          code: 'credential-store-denied',
          reason: `"${segment}" matches ${pattern}, which is refused wherever it appears because it can name a credential, a key or an encrypted vault.`,
        }
      }
    }
  }
  return null
}

/** Whether a normalised path is inside an allowed root. Exact, never case-folded. */
export function isPathAllowed(
  candidate: string,
  policy: Pick<SurfacePolicy, 'allowedRoots' | 'localUnrestricted'>,
): boolean {
  const normalised = normalisePath(candidate)
  if (normalised === null) return false
  if (policy.localUnrestricted) return true
  return policy.allowedRoots.some((root) => isInside(normalised, root))
}

/**
 * The full path decision, in the order the refusals must win.
 *
 * Deny first, then malformed, then allowlist. A caller that asks "may I use this
 * path" cannot get a yes for a path that is both allowed and denied, because the deny
 * check runs before the allow check and returns immediately.
 */
export function checkPath(
  candidate: string,
  policy: Pick<SurfacePolicy, 'allowedRoots' | 'deniedRoots' | 'localUnrestricted'>,
): { readonly ok: true; readonly normalised: string } | { readonly ok: false; readonly code: DeviceHandsRefusalCode; readonly reason: string } {
  const normalised = normalisePath(candidate)
  if (policy.localUnrestricted) {
    if (normalised === null) {
      return { ok: false, code: 'path-malformed', reason: 'That path is not one this build can interpret.' }
    }
    return { ok: true, normalised }
  }
  const denial = pathDenialReason(candidate, policy)
  if (denial !== null) return { ok: false, code: denial.code, reason: denial.reason }
  if (normalised === null) {
    return {
      ok: false,
      code: 'path-malformed',
      reason: 'That path is not one this build can read.',
    }
  }
  if (!isPathAllowed(normalised, policy)) {
    return {
      ok: false,
      code: 'path-outside-allowlist',
      reason: `"${normalised}" is outside every root this grant permits (${policy.allowedRoots.join(', ')}).`,
    }
  }
  return { ok: true, normalised }
}

/* --------------------------------------------------------------------- URLs */

export type UrlReading =
  | { readonly ok: true; readonly url: string; readonly host: string }
  | { readonly ok: false; readonly code: DeviceHandsRefusalCode; readonly reason: string }

/** The only two schemes. `file:`, `data:`, `javascript:`, `blob:` and `view-source:` are absent. */
export const DEVICE_HANDS_ALLOWED_URL_SCHEMES: readonly string[] = Object.freeze(['http:', 'https:'])

/**
 * Judge a URL against the policy's host allowlist.
 *
 * Three refusals, each its own code, because "not https" and "not on the list" and
 * "carries a password" are different facts and an audit trail that merged them would
 * hide the third one — which is the one that means somebody is trying to hand Freya
 * a URL with a credential already in it.
 */
export function checkUrl(
  candidate: unknown,
  policy: Pick<SurfacePolicy, 'allowedHosts' | 'localUnrestricted'>,
): UrlReading {
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 2048) {
    return {
      ok: false,
      code: 'url-host-not-allowed',
      reason: 'A URL must be a non-empty string of at most 2048 characters.',
    }
  }
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return {
      ok: false,
      code: 'url-scheme-not-allowed',
      reason: 'That is not a URL this build can parse, and it was not repaired into one.',
    }
  }
  if (!DEVICE_HANDS_ALLOWED_URL_SCHEMES.includes(parsed.protocol)) {
    return {
      ok: false,
      code: 'url-scheme-not-allowed',
      reason: `The scheme "${parsed.protocol}" is not routable. Only ${DEVICE_HANDS_ALLOWED_URL_SCHEMES.join(' and ')} are.`,
    }
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return {
      ok: false,
      code: 'url-carries-credential',
      reason: 'That URL carries a username or password in it. A credential in a URL is refused rather than stripped, because stripping it would hide that somebody sent one.',
    }
  }
  const host = parsed.hostname.toLowerCase()
  if (host === '') {
    return { ok: false, code: 'url-host-not-allowed', reason: 'That URL has no host.' }
  }
  if (!policy.localUnrestricted && !policy.allowedHosts.includes(host)) {
    return {
      ok: false,
      code: 'url-host-not-allowed',
      reason: `"${host}" is not on this grant's host allowlist (${policy.allowedHosts.join(', ')}).`,
    }
  }
  // The canonical form drops the fragment's ability to name anything and keeps the
  // port, which the host allowlist does not carry: an allowlisted host on a
  // surprising port is still the same host, and the harness's transport decides the
  // port. Recorded here so the choice is visible rather than incidental.
  return { ok: true, url: parsed.toString(), host }
}

/* --------------------------------------------------------- policy building */

/** A host: lower-case letters, digits, dots and hyphens, with no port or scheme. */
const HOST_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/

/** A bare executable name: no separator, no drive, no dot-leading name. */
const COMMAND_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/

/** An environment variable name: the shape the platforms actually use. */
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,31}$/

function refuse(code: DeviceHandsRefusalCode, reason: string): PolicyReading {
  // A code this vocabulary does not have would be a lie; fail closed on our own bug
  // rather than emitting a refusal the caller cannot look up.
  if (!isDeviceHandsRefusalCode(code)) {
    return {
      ok: false,
      code: 'request-malformed',
      reason: 'This build produced a refusal code outside its own closed vocabulary.',
    }
  }
  return { ok: false, code, reason }
}

function readList(
  value: unknown,
  label: string,
  ceiling: number,
  allowEmpty = false,
): string[] | { readonly error: string } {
  if (!Array.isArray(value)) return { error: `${label} must be a list.` }
  if (value.length === 0 && !allowEmpty) return { error: `${label} must name at least one entry.` }
  if (value.length > ceiling) return { error: `${label} is capped at ${String(ceiling)} entries.` }
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0) {
      return { error: `Every ${label} entry must be a non-empty string.` }
    }
    if (out.includes(entry)) return { error: `${label} repeats "${entry}".` }
    out.push(entry)
  }
  return out
}

/**
 * Read and narrow a surface policy.
 *
 * Every field is validated *under* a code-owned ceiling, and the two directions
 * differ deliberately:
 *
 *   - an **allowlist** that is empty is refused (`must name at least one entry`),
 *     because "nothing is permitted" must be a decision somebody made rather than a
 *     consequence of forgetting to configure something;
 *   - a **denylist** that is empty is refused too, and this is the one that matters
 *     most: a policy that arrives without the Vault and keyring roots is not a policy
 *     with no protection, it is a policy this build refuses to operate.
 */
export function normaliseSurfacePolicy(input: unknown): PolicyReading {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return refuse('request-malformed', 'A surface policy must be an object.')
  }
  const raw = input as Record<string, unknown>
  const localUnrestricted = raw.localUnrestricted === true

  const deniedRootsRaw = readList(
    raw.deniedRoots,
    'deniedRoots',
    DEVICE_HANDS_LIMITS.maxAllowedRoots,
    localUnrestricted,
  )
  if ('error' in deniedRootsRaw) {
    return refuse(
      'policy-missing',
      `A surface policy must name the directories it protects, and this one does not: ${deniedRootsRaw.error}`,
    )
  }
  const allowedRootsRaw = readList(raw.allowedRoots, 'allowedRoots', DEVICE_HANDS_LIMITS.maxAllowedRoots, localUnrestricted)
  if ('error' in allowedRootsRaw) return refuse('request-malformed', allowedRootsRaw.error)
  const hostsRaw = readList(raw.allowedHosts, 'allowedHosts', DEVICE_HANDS_LIMITS.maxAllowedHosts, localUnrestricted)
  if ('error' in hostsRaw) return refuse('request-malformed', hostsRaw.error)
  const commandsRaw = readList(
    raw.allowedCommands,
    'allowedCommands',
    DEVICE_HANDS_LIMITS.maxAllowedCommands,
    localUnrestricted,
  )
  if ('error' in commandsRaw) return refuse('request-malformed', commandsRaw.error)
  const envRaw = readList(raw.allowedEnvNames, 'allowedEnvNames', DEVICE_HANDS_LIMITS.maxAllowedEnvNames, localUnrestricted)
  if ('error' in envRaw) return refuse('request-malformed', envRaw.error)

  const deniedRoots: string[] = []
  for (const entry of deniedRootsRaw) {
    const normalised = normalisePath(entry)
    if (normalised === null) {
      return refuse('policy-missing', `The protected root "${entry}" is not a path this build can read, so it cannot be protected.`)
    }
    deniedRoots.push(normalised)
  }

  const allowedRoots: string[] = []
  for (const entry of allowedRootsRaw) {
    const normalised = normalisePath(entry)
    if (normalised === null) {
      return refuse(
        'request-malformed',
        `The allowed root "${entry}" must be an absolute path with no traversal segment.`,
      )
    }
    allowedRoots.push(normalised)
  }

  const allowedHosts: string[] = []
  for (const entry of hostsRaw) {
    const host = entry.trim().toLowerCase()
    if (!HOST_PATTERN.test(host) || host.length > 253) {
      return refuse(
        'url-host-not-allowed',
        `"${entry}" is not a bare hostname. A host entry carries no scheme, no port and no path, because anything more is a place a rule could be hidden.`,
      )
    }
    allowedHosts.push(host)
  }

  const allowedCommands: string[] = []
  for (const entry of commandsRaw) {
    const name = entry.trim().toLowerCase()
    if (!COMMAND_PATTERN.test(name)) {
      return refuse(
        'command-not-allowed',
        `"${entry}" is not a bare program name. A command entry carries no path and no separator, so the allowlist cannot be pointed at a directory.`,
      )
    }
    allowedCommands.push(name)
  }

  const allowedEnvNames: string[] = []
  for (const entry of envRaw) {
    const name = entry.trim().toUpperCase()
    if (!ENV_NAME_PATTERN.test(name)) {
      return refuse(
        'environment-variable-not-allowed',
        `"${entry}" is not a variable name. A name is upper-case letters, digits and underscores, at most 32 characters.`,
      )
    }
    const lower = name.toLowerCase()
    for (const word of DENIED_ENV_NAME_WORDS) {
      if (lower.includes(word)) {
        return refuse(
          'environment-variable-denied',
          `"${name}" names credential material (${word}), so it cannot be on the allowlist. The environment is built from this list alone, never inherited.`,
        )
      }
    }
    allowedEnvNames.push(name)
  }

  const maxTransferBytes = readCeiling(
    raw.maxTransferBytes,
    DEVICE_HANDS_LIMITS.maxTransferBytesPerAction,
  )

  const policy: SurfacePolicy = Object.freeze({
    localUnrestricted,
    allowedRoots: Object.freeze(allowedRoots),
    deniedRoots: Object.freeze(deniedRoots),
    allowedHosts: Object.freeze(allowedHosts),
    allowedCommands: Object.freeze(allowedCommands),
    allowedEnvNames: Object.freeze(allowedEnvNames),
    maxTransferBytes,
    // Counted, then ordered as declared. `listDigest` is order-sensitive on purpose:
    // two roots swapped is a different policy and must not share a digest.
    digest: listDigest([
      localUnrestricted ? 'local-unrestricted' : 'strict',
      ...[...allowedRoots].sort(),
      ...[...deniedRoots].sort(),
      ...[...allowedHosts].sort(),
      ...[...allowedCommands].sort(),
      ...[...allowedEnvNames].sort(),
      String(maxTransferBytes),
    ]),
  })

  // Strict mode proves its protected roots. Local development deliberately has no
  // path denylist; its one hard prohibition (delete/destructive removal) is enforced
  // at the action semantics layer instead of hiding parts of the developer machine.
  if (!localUnrestricted) {
    const probe = pathDenialReason(`${deniedRoots[0] ?? '/'}/probe`, policy)
    if (probe === null) {
      return refuse('policy-missing', 'The policy this build just read would not refuse its own protected root, so it is not a policy.')
    }
  }

  return { ok: true, policy }
}

/**
 * Read a ceiling a caller may lower and never raise.
 *
 * A caller may set `0` to mean "this session transfers nothing", which is a
 * *narrowing* and therefore legitimate. Anything non-integer, negative or above the
 * code-owned ceiling is the ceiling.
 */
function readCeiling(value: unknown, ceiling: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return ceiling
  if (value < 0) return 0
  if (value > ceiling) return ceiling
  return Math.floor(value)
}

/**
 * Whether the host's declared policy is the one this build enforces.
 *
 * Compared at open time against the digest in the journal, so a restart cannot come
 * back with a wider policy than the one whose actions are on the record: a mismatch is
 * `policy-mismatch` and refuses everything until somebody reads why.
 */
export function policyMatchesDigest(policy: SurfacePolicy, digest: string): boolean {
  return policy.digest === digest
}
