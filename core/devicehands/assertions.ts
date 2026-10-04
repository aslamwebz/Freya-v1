import {
  AUTHORITY_ACTIONS,
  CAPTURE_ACTIONS,
  CREDENTIAL_ACTIONS,
  DEVICE_HANDS_ACTIONS_WITHOUT_APPROVAL,
  DEVICE_HANDS_BANNED_ACTION_WORDS,
  DEVICE_HANDS_CONSEQUENCE,
  DEVICE_HANDS_EVENT_TYPES,
  DEVICE_HANDS_GATES,
  DEVICE_HANDS_LIMITS,
  DEVICE_HANDS_PAYLOAD_KEYS,
  DEVICE_HANDS_PROBE_GATES,
  DEVICE_HANDS_REFUSAL_CODES,
  DEVICE_HANDS_SURFACE_ACTIONS,
  DEVICE_HANDS_SURFACES,
  FORBIDDEN_DEVICE_HANDS_ACTIONS,
  FORBIDDEN_DEVICE_HANDS_PAYLOAD_KEYS,
  PHYSICAL_WORLD_ACTIONS,
  deviceHandsApprovalRequired,
  type DeviceHandsActionKey,
} from './types'
import { DEVICE_HANDS_ALLOWED_MEDIA_TYPES } from './transfer'
import { DENIED_PATH_SEGMENTS, normaliseSurfacePolicy } from './paths'
import { SHELL_METACHARACTERS } from './commands'
import { DEVICE_HANDS_PROBE_OUTCOME_KEYS, AUTHORITY_SHAPED_KEYS } from './probe'
import { auditTransitionTables } from './machine'

/**
 * Structural audits.
 *
 * Every other module in this phase makes a claim in prose. This file is where the claims
 * become things a test can fail on, and it is deliberately **not** used by production
 * code: an audit that runs on every request stops being an audit and becomes a cost.
 *
 * Five kinds:
 *
 *   - **Source audits** — the modules that decide whether Freya may reach the disk, run
 *     a program or move a file contain no clock, no timer, no port access, no capture
 *     vocabulary and no authority minter. This is what makes "this phase cannot
 *     screenshot anything and cannot widen anything" structural rather than a promise.
 *   - **Table audits** — the deny list cannot be emptied, the gate order is total and
 *     the stop gate comes early, the routed action vocabulary contains no capture word,
 *     and the transfer media allowlist contains no image type.
 *   - **Policy audits** — re-derived from `normaliseSurfacePolicy`, so a future edit
 *     that makes an empty allowlist mean "everywhere" fails here.
 *   - **Journal audits** — every effect traces back to a start, every settled action has
 *     a verification, every refusal names a gate, and the byte ledger never moves on a
 *     verdict that was not `passed`.
 *   - **Re-derivation** — the invariants recomputed from the tables rather than read, so
 *     a change that alters a table and forgets its rule is caught.
 */

/* ------------------------------------------------------------------ source */

/** Comment text is stripped before matching, so prose about a timer is not a finding. */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/(['"`])(?:(?!\1)[^\\]|\\.)*\1/g, '""')
}

/** Self-scheduling. A phase with no timer cannot act when nobody is watching. */
export function findTimerUsageInSource(source: string): readonly string[] {
  const text = stripComments(source)
  const patterns: readonly { readonly name: string; readonly pattern: RegExp }[] = [
    { name: 'setInterval', pattern: /\bsetInterval\s*\(/ },
    { name: 'setTimeout', pattern: /\bsetTimeout\s*\(/ },
    { name: 'setImmediate', pattern: /\bsetImmediate\s*\(/ },
    { name: 'requestAnimationFrame', pattern: /\brequestAnimationFrame\s*\(/ },
    { name: 'requestIdleCallback', pattern: /\brequestIdleCallback\s*\(/ },
  ]
  const findings: string[] = []
  for (const { name, pattern } of patterns) if (pattern.test(text)) findings.push(name)
  return findings
}

/** Loops with no condition at all. */
export function findUnboundedLoopInSource(source: string): readonly string[] {
  const text = stripComments(source)
  const patterns: readonly { readonly name: string; readonly pattern: RegExp }[] = [
    { name: 'for-ever', pattern: /\bfor\s*\(\s*;\s*;\s*\)/ },
    { name: 'while-true', pattern: /\bwhile\s*\(\s*(?:true|1)\s*\)/ },
    { name: 'do-forever', pattern: /\bdo\s*\{/ },
  ]
  const findings: string[] = []
  for (const { name, pattern } of patterns) if (pattern.test(text)) findings.push(name)
  return findings
}

/**
 * Find anything that would let a pure module read the world.
 *
 * `Date.parse` and `new Date(x)` are *not* impurities and are deliberately absent:
 * parsing an ISO instant a caller passed in is arithmetic on a string, so
 * `dayKeyOf('2026-05-01T09:00:00.000Z')` is as deterministic as the string itself. What
 * would break purity is *obtaining* the current time, which is `Date.now()` and the
 * zero-argument `new Date()`.
 *
 * `resolve(` and `join(` are listed too, for a specific reason: a pure policy module
 * that can call `path.resolve` can read `process.cwd()`, which is an ambient value this
 * phase would then make a security decision from. The one module that does need path
 * arithmetic (`./paths`) implements it explicitly and takes a base as an argument.
 */
export function findImpurityInSource(source: string): readonly string[] {
  const text = stripComments(source)
  const patterns: readonly { readonly name: string; readonly pattern: RegExp }[] = [
    { name: 'Date.now', pattern: /\bDate\s*\.\s*now\s*\(/ },
    { name: 'new Date()', pattern: /\bnew\s+Date\s*\(\s*\)/ },
    { name: 'Math.random', pattern: /\bMath\s*\.\s*random\s*\(/ },
    { name: 'fetch', pattern: /\bfetch\s*\(/ },
    { name: 'process.env', pattern: /\bprocess\s*\.\s*env\b/ },
    { name: 'process.cwd', pattern: /\bprocess\s*\.\s*cwd\b/ },
    { name: 'child_process', pattern: /\bchild_process\b/ },
    { name: 'node:fs', pattern: /\bnode:fs\b/ },
    { name: 'path.resolve', pattern: /\b(?:path\s*\.\s*resolve|\bresolve\s*\()/ },
    { name: 'ports-call', pattern: /\bports\s*\./ },
    { name: 'globalThis', pattern: /\bglobalThis\b/ },
    { name: 'window', pattern: /\bwindow\s*[.(]/ },
  ]
  const findings: string[] = []
  for (const { name, pattern } of patterns) if (pattern.test(text)) findings.push(name)
  return findings
}

/**
 * Identifiers that would be a capture, a credential read, or an authority minter.
 *
 * Matched as whole words and case-insensitively, so `captureScreen`, `CaptureScreen` and
 * `CAPTURE_SCREEN` are all the same finding while `CAPTURE_ACTIONS` — a table of things
 * that are *refused* — is not. String literals are stripped first, so a URL path or a
 * refusal message containing the word does not trip the check; a check that fires on
 * correct code is a check that gets switched off.
 */
export const FORBIDDEN_SOURCE_IDENTIFIERS: readonly string[] = Object.freeze([
  // capture
  'screenshot',
  'takeScreenshot',
  'getScreenshot',
  'captureScreen',
  'captureWindow',
  'captureDisplay',
  'recordScreen',
  'getDisplayMedia',
  'getUserMedia',
  'capturePage',
  'captureFrame',
  'renderPdf',
  'printToPDF',
  'toDataURL',
  'canvas',
  'ImageBitmap',
  'createImageBitmap',
  'devicePixelRatio',
  // physical world
  'getCamera',
  'readSensor',
  'readLocation',
  'actuate',
  // credentials and the vault
  'readKeyring',
  'loadKeyring',
  'readVault',
  'openVault',
  'readSecret',
  'getSecret',
  'readCredential',
  'listCredentials',
  // authority minters
  'grantCapability',
  'createGrant',
  'widenLimit',
  'widenBoundary',
  'widenBudget',
  'disableStopAll',
  'clearStopAll',
  'bypassGuard',
  'bypassGovernor',
  'selfApprove',
  'forgeApproval',
])

export function findForbiddenVocabularyInSource(source: string): readonly string[] {
  const text = stripComments(source)
  const findings: string[] = []
  for (const name of FORBIDDEN_SOURCE_IDENTIFIERS) {
    if (new RegExp(`\\b${name}\\b`, 'i').test(text)) findings.push(name)
  }
  return findings
}

/* ------------------------------------------------------------------ tables */

/** Every event type has a non-empty, duplicate-free key table. */
export function auditEventVocabulary(): readonly string[] {
  const findings: string[] = []
  for (const type of DEVICE_HANDS_EVENT_TYPES) {
    const keys = DEVICE_HANDS_PAYLOAD_KEYS[type]
    if (keys === undefined) {
      findings.push(`no key table for ${type}`)
      continue
    }
    if (keys.length === 0) findings.push(`${type} has an empty key table`)
    if (new Set(keys).size !== keys.length) findings.push(`${type} repeats a key`)
    for (const key of keys) {
      if (FORBIDDEN_DEVICE_HANDS_PAYLOAD_KEYS.has(key)) {
        findings.push(`${type} may carry "${key}", which names authority, a capture or raw content`)
      }
    }
  }
  // A type in the payload table that is not an event type is a field nothing writes.
  for (const type of Object.keys(DEVICE_HANDS_PAYLOAD_KEYS)) {
    if (!(DEVICE_HANDS_EVENT_TYPES as readonly string[]).includes(type)) {
      findings.push(`${type} has a key table but is not an event type`)
    }
  }
  return findings
}

/** Refusal codes are closed, kebab-case and unique. */
export function auditRefusalVocabulary(): readonly string[] {
  const findings: string[] = []
  const seen = new Set<string>()
  for (const code of DEVICE_HANDS_REFUSAL_CODES) {
    if (seen.has(code)) findings.push(`refusal code ${code} appears twice`)
    seen.add(code)
    if (!/^[a-z][a-z0-9-]*$/.test(code)) findings.push(`refusal code ${code} is not kebab-case`)
  }
  return findings
}

/**
 * The deny list cannot be emptied, its groups are real subsets, and the routed action
 * vocabulary contains no capture, credential or physical-world word.
 */
export function auditAuthorityTables(): readonly string[] {
  const findings: string[] = []

  // Cast to a plain array: the tuple's literal length lets the compiler see this
  // comparison as impossible, and this check exists precisely to catch the day that
  // becomes true.
  if ((FORBIDDEN_DEVICE_HANDS_ACTIONS as readonly string[]).length === 0) {
    findings.push('the forbidden-action list is empty, which means nothing is forbidden')
  }

  const groups: readonly { readonly name: string; readonly entries: readonly string[] }[] = [
    { name: 'credential', entries: CREDENTIAL_ACTIONS },
    { name: 'capture', entries: CAPTURE_ACTIONS },
    { name: 'physical-world', entries: PHYSICAL_WORLD_ACTIONS },
    { name: 'authority', entries: AUTHORITY_ACTIONS },
  ]
  for (const group of groups) {
    if (group.entries.length === 0) findings.push(`the ${group.name} deny group is empty`)
    for (const entry of group.entries) {
      if (!(FORBIDDEN_DEVICE_HANDS_ACTIONS as readonly string[]).includes(entry)) {
        findings.push(`${entry} is in the ${group.name} group but not in the forbidden-action list`)
      }
    }
  }

  // Every routed action is checked against the banned words. This is the positive form
  // of "there is no screenshot capability": rather than trusting a reviewer to notice a
  // new action called `capture-frame`, adding one fails the build.
  for (const surface of DEVICE_HANDS_SURFACES) {
    for (const action of DEVICE_HANDS_SURFACE_ACTIONS[surface]) {
      const lower = action.toLowerCase()
      for (const word of DEVICE_HANDS_BANNED_ACTION_WORDS) {
        if (lower.includes(word)) {
          findings.push(`the routed action "${surface}.${action}" contains the banned word "${word}"`)
        }
      }
    }
  }

  // The transfer allowlist must contain no image type, so there is no media type a
  // captured frame could ever declare.
  for (const type of DEVICE_HANDS_ALLOWED_MEDIA_TYPES) {
    if (type.startsWith('image/') || type.includes('image')) {
      findings.push(`the transfer allowlist contains "${type}"; this phase moves no images`)
    }
  }
  // Every routed action has a consequence, and the exception list only names routed ones.
  for (const surface of DEVICE_HANDS_SURFACES) {
    for (const action of DEVICE_HANDS_SURFACE_ACTIONS[surface]) {
      const key = `${surface}.${action}` as DeviceHandsActionKey
      if (DEVICE_HANDS_CONSEQUENCE[key] === undefined) {
        findings.push(`${key} has no consequence class`)
      }
    }
  }
  for (const key of DEVICE_HANDS_ACTIONS_WITHOUT_APPROVAL) {
    if (DEVICE_HANDS_CONSEQUENCE[key] === undefined) {
      findings.push(`${key} is exempt from approval but is not a routed action`)
    }
    if (deviceHandsApprovalRequired(key)) {
      findings.push(`${key} is listed as not requiring approval but the rule says it does`)
    }
  }

  // Nothing that executes may be exempt from an approval. This is the single most
  // important line in the audit: if `terminal.run` were ever added to the exception
  // list, Freya could run a program with nobody asked.
  for (const key of Object.keys(DEVICE_HANDS_CONSEQUENCE) as DeviceHandsActionKey[]) {
    if (DEVICE_HANDS_CONSEQUENCE[key] !== 'executes') continue
    if (!deviceHandsApprovalRequired(key)) {
      findings.push(`${key} executes and is exempt from approval`)
    }
  }

  return findings
}

/** The gate order is total, the stop gate is early, and policy precedes approval. */
export function auditGateTables(): readonly string[] {
  const findings: string[] = []
  const gates: readonly string[] = DEVICE_HANDS_GATES
  const probeGates: readonly string[] = DEVICE_HANDS_PROBE_GATES
  if (new Set(gates).size !== gates.length) {
    findings.push('DEVICE_HANDS_GATES repeats a gate')
  }
  const required: readonly string[] = [
    'journal-trustworthy',
    'stop-all',
    'enabled',
    'replay',
    'surface',
    'grant',
    'deadline',
    'budget',
    'policy',
    'approval',
  ]
  for (const gate of required) {
    if (!gates.includes(gate)) {
      findings.push(`the gate "${gate}" is not in DEVICE_HANDS_GATES`)
    }
  }
  if (gates.indexOf('journal-trustworthy') !== 0) {
    findings.push('the journal-trustworthy gate must come first')
  }
  if (gates.indexOf('stop-all') !== 1) {
    findings.push('the stop-all gate must come before every gate that could act or ask')
  }
  if (gates.indexOf('policy') > gates.indexOf('approval')) {
    findings.push('the policy gate must precede the approval gate: never ask a person about work that is forbidden')
  }
  if (gates.indexOf('grant') > gates.indexOf('policy')) {
    findings.push('the grant gate must precede the policy gate')
  }

  // The probe list must be a strict subset of the action list and must be *shorter*:
  // no grant gate, no approval gate, no budget gate. That is what makes "a successful
  // probe grants nothing" true of the pipeline rather than only of the result type.
  if (probeGates.length >= gates.length) {
    findings.push('the probe gates must be a strict subset of the action gates')
  }
  for (const gate of probeGates) {
    if (!gates.includes(gate)) {
      findings.push(`the probe gate "${gate}" is not an action gate`)
    }
    if (gate === 'grant' || gate === 'approval' || gate === 'budget') {
      findings.push(`the probe pipeline must not contain "${gate}": a probe produces no authority`)
    }
  }
  return findings
}

/**
 * A probe result carries no key shaped like a permission.
 *
 * Re-derived from the two tables rather than asserted, so a future field named
 * `authorised` — or a renamed `available` — fails here.
 */
export function auditProbeOutcome(): readonly string[] {
  const findings: string[] = []
  for (const key of DEVICE_HANDS_PROBE_OUTCOME_KEYS) {
    if (AUTHORITY_SHAPED_KEYS.includes(key.toLowerCase())) {
      findings.push(`a probe outcome may not carry "${key}": a probe grants nothing`)
    }
  }
  if (!DEVICE_HANDS_PROBE_OUTCOME_KEYS.includes('available')) {
    findings.push('a probe outcome must say whether the surface answered')
  }
  if (DEVICE_HANDS_PROBE_OUTCOME_KEYS.some((key) => /^(scope|expiresAt)$/.test(key))) {
    findings.push('a probe outcome may not carry a scope or an expiry: both are permission shapes')
  }
  return findings
}

/**
 * Policy normalisation stays fail-closed, re-derived rather than asserted.
 *
 * Each case below is the failure this phase is most likely to introduce by accident:
 * an empty allowlist quietly meaning "everywhere", a missing denylist quietly meaning
 * "nothing is protected", and a credential-shaped variable quietly entering an
 * environment.
 */
export function auditPolicyNormalisation(): readonly string[] {
  const findings: string[] = []
  const good = {
    allowedRoots: ['/workspace'],
    deniedRoots: ['/user-data/Freya/vault'],
    allowedHosts: ['example.com'],
    allowedCommands: ['git'],
    allowedEnvNames: ['CI'],
  }

  const emptyRoots = normaliseSurfacePolicy({ ...good, allowedRoots: [] })
  if (emptyRoots.ok) findings.push('a policy with no allowed root was accepted')

  const emptyDenied = normaliseSurfacePolicy({ ...good, deniedRoots: [] })
  if (emptyDenied.ok) findings.push('a policy with no denied root was accepted')

  const emptyHosts = normaliseSurfacePolicy({ ...good, allowedHosts: [] })
  if (emptyHosts.ok) findings.push('a policy with no allowed host was accepted')

  const emptyCommands = normaliseSurfacePolicy({ ...good, allowedCommands: [] })
  if (emptyCommands.ok) findings.push('a policy with no allowed command was accepted')

  const credentialEnv = normaliseSurfacePolicy({ ...good, allowedEnvNames: ['AWS_SECRET_ACCESS_KEY'] })
  if (credentialEnv.ok) findings.push('a policy carrying a credential-shaped variable name was accepted')

  const pathCommand = normaliseSurfacePolicy({ ...good, allowedCommands: ['/bin/sh'] })
  if (pathCommand.ok) findings.push('a command allowlist entry carrying a path was accepted')

  const hugeCeiling = normaliseSurfacePolicy({ ...good, maxTransferBytes: 10_000_000_000 })
  if (!hugeCeiling.ok) {
    findings.push('an over-ceiling transfer ceiling was refused rather than clamped')
  } else if (
    hugeCeiling.policy !== null &&
    hugeCeiling.policy.maxTransferBytes > DEVICE_HANDS_LIMITS.maxTransferBytesPerAction
  ) {
    findings.push('an over-ceiling transfer ceiling was not clamped')
  }

  if (DENIED_PATH_SEGMENTS.length === 0) {
    findings.push('the denied path-segment list is empty')
  }
  if (SHELL_METACHARACTERS.length === 0) {
    findings.push('the shell metacharacter list is empty')
  }
  return findings
}

/* ----------------------------------------------------------------- journal */

export type JournalViolationCode =
  | 'effect-without-start'
  | 'settled-without-verification'
  | 'refusal-without-gate'
  | 'ledger-moved-without-passed-verdict'
  | 'duplicate-action-id'
  | 'probe-recorded-as-authority'

export interface JournalViolation {
  readonly code: JournalViolationCode
  readonly detail: string
  readonly eventType: string
}

export interface JournalEntryLike {
  readonly type: string
  readonly payload?: unknown
}

/**
 * Audit the journal for effects that were not paid for, and for authority that was not
 * earned.
 *
 * Each check closes a specific hole:
 *
 *   - **Every effect traces to a start.** A `terminal.performed` with no preceding
 *     `action.started` is a hidden action. Checked over the *journal*, so an action from
 *     a previous process still counts: the property is durability, not bookkeeping.
 *   - **Every settled action has a verification.** Same invariant the fold enforces,
 *     checked from the other side so a bug in one is caught by the other.
 *   - **Every refusal names a gate.** A refusal that cannot say what stopped it is not an
 *     audit record.
 *   - **The byte ledger moves only on a passed verdict.** This is the budget-integrity
 *     check: a number that moves on a *report* can be inflated by a claim.
 *   - **No probe record names authority.** A probe entry carrying a grant-shaped key
 *     means something changed between the type and the writer.
 */
export function analyseJournal(entries: readonly JournalEntryLike[]): {
  readonly violations: readonly JournalViolation[]
  readonly effects: number
  readonly refusals: number
  readonly verifications: number
} {
  const violations: JournalViolation[] = []
  const started = new Set<string>()
  const verified = new Map<string, string>()
  const settled = new Set<string>()
  const starts = new Set<string>()
  let effects = 0
  let refusals = 0
  let verifications = 0

  const payloadOf = (entry: JournalEntryLike): Record<string, unknown> =>
    typeof entry.payload === 'object' && entry.payload !== null && !Array.isArray(entry.payload)
      ? (entry.payload as Record<string, unknown>)
      : {}

  for (const entry of entries) {
    const payload = payloadOf(entry)
    const actionId = typeof payload.actionId === 'string' ? payload.actionId : null

    switch (entry.type) {
      case 'hands.action.started': {
        if (actionId === null) {
          violations.push({
            code: 'effect-without-start',
            detail: 'An action started with no action id, so it cannot be traced.',
            eventType: entry.type,
          })
          break
        }
        if (starts.has(actionId)) {
          violations.push({
            code: 'duplicate-action-id',
            detail: `Action ${actionId} started twice. An id identifies one action.`,
            eventType: entry.type,
          })
        }
        starts.add(actionId)
        started.add(actionId)
        break
      }

      case 'hands.browser.performed':
      case 'hands.terminal.performed':
      case 'hands.clipboard.read':
      case 'hands.clipboard.written':
      case 'hands.clipboard.cleared':
      case 'hands.transfer.failed': {
        effects += 1
        if (actionId === null || !started.has(actionId)) {
          violations.push({
            code: 'effect-without-start',
            detail: `A ${entry.type} entry has no preceding action start. An effect with no trace is a hidden effect.`,
            eventType: entry.type,
          })
        }
        break
      }

      case 'hands.verified': {
        verifications += 1
        const result = typeof payload.result === 'string' ? payload.result : null
        const verificationId =
          typeof payload.verificationId === 'string' ? payload.verificationId : null
        if (actionId === null || verificationId === null) {
          violations.push({
            code: 'settled-without-verification',
            detail: 'A verification entry carries no action id or no verification id.',
            eventType: entry.type,
          })
          break
        }
        verified.set(actionId, result ?? '')
        settled.add(actionId)
        break
      }

      case 'hands.action.cancelled':
      case 'hands.action.timed-out':
      case 'hands.action.interrupted':
      case 'hands.reconciled': {
        if (actionId === null) {
          violations.push({
            code: 'settled-without-verification',
            detail: `A ${entry.type} entry carries no action id.`,
            eventType: entry.type,
          })
          break
        }
        // A cancellation, a timeout and a reconciliation all settle an action without a
        // verification — correctly, because none of them claims the action did the
        // thing. What must never happen is a *completion* without one, and that is the
        // `transfer.completed` case below.
        settled.add(actionId)
        break
      }

      case 'hands.action.refused': {
        refusals += 1
        const gate = typeof payload.gate === 'string' ? payload.gate : null
        if (gate === null || gate.length === 0) {
          violations.push({
            code: 'refusal-without-gate',
            detail: 'A refusal was recorded with no gate, so it does not say what stopped it.',
            eventType: entry.type,
          })
        }
        break
      }

      case 'hands.transfer.completed': {
        effects += 1
        if (actionId === null || !started.has(actionId)) {
          violations.push({
            code: 'effect-without-start',
            detail: `A ${entry.type} entry has no preceding action start. An effect with no trace is a hidden effect.`,
            eventType: entry.type,
          })
        }
        const verificationId =
          typeof payload.verificationId === 'string' ? payload.verificationId : null
        const result = actionId === null ? null : verified.get(actionId)
        if (verificationId === null) {
          violations.push({
            code: 'settled-without-verification',
            detail: 'A transfer was recorded complete with no verification id.',
            eventType: entry.type,
          })
        } else if (result !== 'passed') {
          violations.push({
            code: 'ledger-moved-without-passed-verdict',
            detail: `A transfer moved bytes on a verification result of "${String(result)}". The byte ledger must move only on a passed verification.`,
            eventType: entry.type,
          })
        }
        break
      }

      case 'hands.probe.performed':
      case 'hands.probe.refused': {
        for (const key of Object.keys(payload)) {
          if (AUTHORITY_SHAPED_KEYS.includes(key.toLowerCase())) {
            violations.push({
              code: 'probe-recorded-as-authority',
              detail: `A probe entry carries "${key}". A probe is a measurement and grants nothing.`,
              eventType: entry.type,
            })
          }
        }
        break
      }

      default:
        break
    }
  }

  for (const actionId of verified.keys()) {
    if (!started.has(actionId)) {
      violations.push({
        code: 'effect-without-start',
        detail: `Action ${actionId} was verified but never started.`,
        eventType: 'hands.verified',
      })
    }
  }
  for (const actionId of settled) {
    if (!started.has(actionId)) {
      violations.push({
        code: 'effect-without-start',
        detail: `Action ${actionId} settled without ever starting.`,
        eventType: 'hands.action.cancelled',
      })
    }
  }

  return { violations, effects, refusals, verifications }
}

/** Run every table and policy audit. One call, so a test cannot forget one. */
export function auditDeviceHandsTables(): readonly string[] {
  return [
    ...auditTransitionTables(),
    ...auditEventVocabulary(),
    ...auditRefusalVocabulary(),
    ...auditAuthorityTables(),
    ...auditGateTables(),
    ...auditProbeOutcome(),
    ...auditPolicyNormalisation(),
  ]
}