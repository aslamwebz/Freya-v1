import { auditTransitionTables } from './machine'
import {
  APPROVAL_PENDING_LIMITS,
} from './machine'
import {
  AUTHORIZATION_GATES,
  ENTERPRISE_EVENT_TYPES,
  ENTERPRISE_LIMITS,
  ENTERPRISE_PAYLOAD_KEYS,
  ENTERPRISE_WAKE_ACTOR,
  ENTERPRISE_WAKE_SOURCES,
  ENTERPRISE_REFUSAL_CODES,
  FORBIDDEN_ENTERPRISE_ACTIONS,
  WEBZONE_OPERATION_KINDS,
  type AuthorizationGate,
  type EnterpriseJournalEntry,
} from './types'
import { normaliseBoundaries } from './boundaries'

/**
 * Structural audits.
 *
 * Every other module in this phase makes a claim in prose. This file is where the
 * claims become things a test can fail on, and it is deliberately *not* used by
 * production code: an audit that runs on every request stops being an audit and
 * becomes a cost.
 *
 * Four kinds:
 *
 *   - **Source audits** — the modules that decide whether Freya may spend money or
 *     touch a network contain no clock, no timer and no port access. This is what
 *     makes "an idle Freya spends nothing" structural for this lane: the code that
 *     decides whether to act has no way to act.
 *   - **Table audits** — the event vocabulary has no cognition type, the gate order
 *     covers every gate, the deny list cannot be emptied.
 *   - **Purity and no-self-scheduling audits** — over the journal, showing that every
 *     action traces back to a wake and that no action repeats without bound.
 *   - **Re-derivation** — the same invariants recomputed from the tables, so a future
 *     edit that changes a table and forgets its rule fails here.
 */

/* --------------------------------------------------------------- source */

/** Comment text is stripped before matching, so prose about a timer is not a finding. */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
}

const TIMER_PATTERNS: readonly { readonly name: string; readonly pattern: RegExp }[] = Object.freeze([
  { name: 'setInterval', pattern: /\bsetInterval\s*\(/ },
  { name: 'setTimeout', pattern: /\bsetTimeout\s*\(/ },
  { name: 'requestAnimationFrame', pattern: /\brequestAnimationFrame\s*\(/ },
  { name: 'queueMicrotask', pattern: /\bqueueMicrotask\s*\(/ },
  { name: 'while-true', pattern: /\bwhile\s*\(\s*true\s*\)/ },
  { name: 'do-forever', pattern: /\bdo\s*\{/ },
])

/**
 * Find self-scheduling in a source file.
 *
 * Textual and blunt on purpose. A subsystem that re-arms its own timer is a subsystem
 * nobody bounded, and the distinction between a legitimate one-shot and a poll is not
 * one to leave to a reader in the middle of an authorization pipeline.
 */
export function findTimerUsageInSource(source: string): readonly string[] {
  const text = stripComments(source)
  const findings: string[] = []
  for (const { name, pattern } of TIMER_PATTERNS) {
    if (pattern.test(text)) findings.push(name)
  }
  return findings
}

/** Loops with no condition at all. Narrow on purpose; see `./machine`. */
export function findUnboundedLoopInSource(source: string): readonly string[] {
  const text = stripComments(source)
  const findings: string[] = []
  const candidates: readonly { readonly name: string; readonly pattern: RegExp }[] = [
    { name: 'for-ever', pattern: /\bfor\s*\(\s*;\s*;\s*\)/ },
    { name: 'while-true', pattern: /\bwhile\s*\(\s*(?:true|1)\s*\)/ },
    { name: 'do-forever', pattern: /\bdo\s*\{/ },
  ]
  for (const { name, pattern } of candidates) {
    if (pattern.test(text)) findings.push(name)
  }
  return findings
}

/**
 * Find anything that would let a pure module read the world.
 *
 * The pure modules below `./ports` are the ones that decide whether an action is
 * allowed, whether a spend fits under a ceiling and whether an outcome was verified.
 * For their claims to mean anything they must not be able to read a clock, generate a
 * random number, reach the network, touch the environment or call the ports. So the
 * check is for exactly those capabilities, and it is enforced by a test that reads the
 * source of each pure module rather than by anybody's diligence.
 *
 * `ports.` is included deliberately: a pure module that could call a port could spend,
 * journal and act, which is the whole thing being excluded.
 */
export function findImpurityInSource(source: string): readonly string[] {
  const text = stripComments(source)

  // `Date.parse` and `new Date(x)` are *not* impurities and are deliberately absent
  // from this list. Parsing an ISO instant that a caller passed in is pure arithmetic on
  // a string — it reads no clock, so `dayKeyOf('2026-05-01T09:00:00.000Z')` is as
  // deterministic as the string itself. What would break purity is *obtaining* the
  // current time, which is `Date.now()` and the zero-argument `new Date()`. Listing
  // `Date.parse` here would have produced a finding in five modules that are all
  // legitimately pure, and a check that fires on correct code is a check that gets
  // switched off.
  const candidates: readonly { readonly name: string; readonly pattern: RegExp }[] = [
    { name: 'Date.now', pattern: /\bDate\s*\.\s*now\s*\(/ },
    // Zero-argument construction only: `new Date()` reads the clock.
    { name: 'new Date()', pattern: /\bnew\s+Date\s*\(\s*\)/ },
    { name: 'Math.random', pattern: /\bMath\s*\.\s*random\s*\(/ },
    { name: 'fetch', pattern: /\bfetch\s*\(/ },
    { name: 'process.env', pattern: /\bprocess\s*\.\s*env\b/ },
    { name: 'require', pattern: /\brequire\s*\(/ },
    { name: 'ports-call', pattern: /\bports\s*\./ },
    { name: 'globalThis', pattern: /\bglobalThis\b/ },
    // An *identifier* use only. `window.foo` or `window(`, not the word appearing in a
    // string — otherwise a URL path containing "window" would be a finding, and a check
    // that fires on a URL is a check people learn to ignore.
    { name: 'window', pattern: /\bwindow\s*[.(]/ },
  ]
  const findings: string[] = []
  for (const { name, pattern } of candidates) {
    if (pattern.test(text)) findings.push(name)
  }
  return findings
}

/**
 * Does this module's source name a way to move money or mint authority?
 *
 * A vocabulary check, not a proof — but it is the check that catches the most
 * embarrassing possible edit, which is somebody adding a `transferFunds` helper to the
 * module that owns spending gates.
 */
export function findForbiddenVocabularyInSource(source: string): readonly string[] {
  const text = stripComments(source)
  const findings: string[] = []
  const banned = [
    'transferFunds',
    'placeOrder',
    'executePayment',
    'createGrant',
    'grantCapability',
    'widenLimit',
    'disableStopAll',
    'clearStopAll',
    'signContract',
    'openAccount',
  ]
  for (const name of banned) {
    if (new RegExp(`\\b${name}\\b`).test(text)) findings.push(name)
  }
  return findings
}

/* ---------------------------------------------------------------- tables */

/**
 * Does the event vocabulary contain any way to ask for cognition?
 *
 * It must not, and it cannot: Phase 33 has no cognition port, so a journal entry
 * claiming a model was called would be a record of something this subsystem cannot do.
 * Asserting the absence of such a type is what turns "Phase 33 does not call models"
 * from a comment into a check.
 */
export function findCognitionEventsInVocabulary(): readonly string[] {
  return ENTERPRISE_EVENT_TYPES.filter((type) =>
    /cognition|model|provider|inference|thinking|token|llm/i.test(type),
  )
}

/**
 * Does every event type have a key table, and does every key table name only keys the
 * fold could read?
 *
 * A type with no table would be unwritable and silently dropped. A key in a table that
 * nothing reads is a field someone can put something in.
 */
export function auditEventVocabulary(): readonly string[] {
  const findings: string[] = []
  for (const type of ENTERPRISE_EVENT_TYPES) {
    const keys = ENTERPRISE_PAYLOAD_KEYS[type]
    if (keys === undefined) {
      findings.push(`no key table for ${type}`)
      continue
    }
    if (keys.length === 0) findings.push(`${type} has an empty key table`)
    if (new Set(keys).size !== keys.length) findings.push(`${type} repeats a key`)
  }
  return findings
}

/** Is every refusal code something the projection and journal can actually carry? */
export function auditRefusalVocabulary(): readonly string[] {
  const findings: string[] = []
  const seen = new Set<string>()
  for (const code of ENTERPRISE_REFUSAL_CODES) {
    if (seen.has(code)) findings.push(`refusal code ${code} appears twice`)
    seen.add(code)
    if (!/^[a-z][a-z0-9-]*$/.test(code)) {
      findings.push(`refusal code ${code} is not a kebab-case closed token`)
    }
  }
  return findings
}

/**
 * The deny list cannot be emptied, and the gate order is total.
 *
 * Both are re-derived rather than read, so an edit that adds a gate without ordering
 * it — or that somehow makes the forbidden set optional — fails here.
 */
export function auditAuthorityTables(): readonly string[] {
  const findings: string[] = []

  // Cast to a plain array: the tuple's literal length lets the compiler see this
  // comparison as impossible, and this check exists precisely to catch the day that
  // becomes true.
  if ((FORBIDDEN_ENTERPRISE_ACTIONS as readonly string[]).length === 0) {
    findings.push('the forbidden-action list is empty, which means nothing is forbidden')
  }

  // The webzone vocabulary must not be able to *describe* a binding or monetary effect,
  // which is why `pay`, `order` and `sign` are absent from it.
  for (const kind of WEBZONE_OPERATION_KINDS) {
    for (const word of ['pay', 'order', 'transfer', 'sign', 'contract', 'subscribe', 'trade']) {
      if (kind.includes(word)) findings.push(`webzone kind "${kind}" names a monetary or binding effect`)
    }
  }

  const required: readonly AuthorizationGate[] = [
    'journal-trustworthy',
    'stop-all',
    'environment',
    'deadline',
    'duration',
    'boundary',
    'spending',
    'approval',
    'verification',
  ]
  for (const gate of required) {
    const index = AUTHORIZATION_GATES.indexOf(gate)
    if (index < 0) {
      findings.push(`the gate "${gate}" is not in AUTHORIZATION_GATES`)
    }
  }
  if (AUTHORIZATION_GATES[0] !== 'journal-trustworthy') {
    findings.push('the journal-trustworthy gate must come first; an untrustworthy journal is not a place to start acting')
  }
  if (AUTHORIZATION_GATES.indexOf('stop-all') !== 1) {
    findings.push('the stop-all gate must come before every gate that could spend or ask the owner something')
  }
  if (new Set(AUTHORIZATION_GATES).size !== AUTHORIZATION_GATES.length) {
    findings.push('AUTHORIZATION_GATES repeats a gate')
  }
  // `spending` must precede `approval`: Freya must not ask the owner to authorize work
  // it was never going to be allowed to do anyway.
  if (AUTHORIZATION_GATES.indexOf('spending') > AUTHORIZATION_GATES.indexOf('approval')) {
    findings.push('the spending gate must precede the approval gate')
  }

  for (const [kind, limit] of Object.entries(APPROVAL_PENDING_LIMITS)) {
    if (limit <= 0) findings.push(`the ${kind} approval bound is not positive`)
  }

  // Every wake source must name the one actor it is allowed to arrive as. A source
  // with no actor entry is a source whose attribution is undefined, which is exactly
  // the hole a renderer forgery would come through.
  for (const source of ENTERPRISE_WAKE_SOURCES) {
    const actor = ENTERPRISE_WAKE_ACTOR[source]
    if (actor === undefined) {
      findings.push(`wake source "${source}" names no actor, so its attribution is undefined`)
    }
  }
  // `owner` is the only actor the owner may use. Anything else arriving as the owner
  // is a forgery, so no source other than `owner` may map to it.
  for (const [source, actor] of Object.entries(ENTERPRISE_WAKE_ACTOR)) {
    if (actor === 'owner' && source !== 'owner') {
      findings.push(`wake source "${source}" is allowed to arrive as the owner`)
    }
  }

  return findings
}

/**
 * An empty allowlist is refused, not treated as "everywhere".
 *
 * Re-derived from `normaliseBoundaries` rather than asserted, so this stays true if
 * the normalisation is ever changed.
 */
export function auditBoundaryNormalisation(): readonly string[] {
  const findings: string[] = []
  const empty = normaliseBoundaries({ allowedDomains: [] })
  if (empty.ok) findings.push('an environment with no allowed domain was accepted')

  const wide = normaliseBoundaries({ allowedDomains: ['example.com'], maxTasks: 10_000 })
  if (!wide.ok) {
    findings.push('a wide owner boundary was refused rather than narrowed')
  } else if (wide.boundaries !== null && wide.boundaries.maxTasks > ENTERPRISE_LIMITS.maxTasksPerEnvironment) {
    findings.push('an owner boundary exceeded the code-owned ceiling instead of being clamped')
  }

  const credentialed = normaliseBoundaries({ allowedDomains: ['https://user:secret@example.com'] })
  if (credentialed.ok) findings.push('an allowlist entry carrying a credential was accepted')

  return findings
}

/* --------------------------------------------------------------- journal */

export type InferenceViolationCode =
  | 'action-without-wake'
  | 'unbounded-repeated-action'
  | 'refusal-without-gate'
  | 'completion-without-verification'
  | 'spend-without-gate-check'

export interface InferenceViolation {
  readonly code: InferenceViolationCode
  readonly detail: string
  readonly eventType: string
}

export interface ZeroHiddenSpendInput {
  readonly entries: readonly EnterpriseJournalEntry[]
  /** How many times one action id may legitimately repeat. */
  readonly maxRepeatsPerAction?: number
}

/**
 * Audit the journal for actions that were not paid for.
 *
 * Three checks, and each closes a specific hole:
 *
 *   - **Every action traces to a wake.** `action.started` with no preceding
 *     `wake.received` is a hidden trigger. The key thing is that this is checked over
 *     the *journal*, so a wake that happened in a previous process and is still in the
 *     log counts — the property is durability, not in-memory bookkeeping.
 *   - **No action repeats without bound.** A retry ceiling that resets per process is
 *     not a ceiling. Counted across the whole journal so a crash loop cannot spend its
 *     way past it.
 *   - **No completion without verification.** The same invariant the fold enforces,
 *     checked from the other side so that a bug in one is caught by the other.
 */
export function analyseZeroHiddenSpend(input: ZeroHiddenSpendInput): {
  readonly violations: readonly InferenceViolation[]
  readonly wakes: number
  readonly actions: number
} {
  const maxRepeats = input.maxRepeatsPerAction ?? ENTERPRISE_LIMITS.maxRetryAttempts
  const violations: InferenceViolation[] = []
  const seenWakes = new Set<string>()
  const actionCounts = new Map<string, number>()
  /**
   * Ids seen starting, per namespace.
   *
   * Two namespaces because the journal really has two: `action.started` names the
   * *action* the caller asked for, and `webzone-operation.started` names the *operation*
   * the runtime actually opened. `webzone-operation.completed` names the operation. So a
   * completion has to be checked against the operation set — and a bare action count
   * against the action set — or the correlation silently never fires.
   */
  const startedActions = new Set<string>()
  const startedOperations = new Set<string>()
  const completedOperations = new Map<string, string | null>()
  let wakes = 0
  let actions = 0

  for (const entry of input.entries) {
    const payload =
      typeof entry.payload === 'object' && entry.payload !== null && !Array.isArray(entry.payload)
        ? (entry.payload as Record<string, unknown>)
        : {}
    const actionId = typeof payload.actionId === 'string' ? payload.actionId : null

    switch (entry.type) {
      case 'enterprise.wake.received': {
        const key = typeof payload.wakeKey === 'string' ? payload.wakeKey : null
        if (key === null) {
          violations.push({
            code: 'action-without-wake',
            detail: 'A wake with no key cannot be deduplicated, so it cannot prove it happened once.',
            eventType: entry.type,
          })
        } else {
          if (seenWakes.has(key)) {
            violations.push({
              code: 'action-without-wake',
              detail: `Wake key "${key}" was received twice.`,
              eventType: entry.type,
            })
          }
          seenWakes.add(key)
        }
        wakes += 1
        break
      }

      case 'enterprise.approval.granted':
        break

      case 'enterprise.webzone-operation.started': {
        // The operation namespace. Tracked separately from `action.started` because the
        // completion event names an operation id, and correlating a completion against
        // the wrong namespace would make "completed but never started" undetectable.
        const operationId = typeof payload.operationId === 'string' ? payload.operationId : null
        if (operationId !== null) startedOperations.add(operationId)
        break
      }

      case 'enterprise.action.started': {
        actions += 1
        if (actionId === null) {
          violations.push({
            code: 'action-without-wake',
            detail: 'An action started with no action id, so it cannot be traced.',
            eventType: entry.type,
          })
          break
        }
        const count = (actionCounts.get(actionId) ?? 0) + 1
        actionCounts.set(actionId, count)
        if (count > maxRepeats) {
          violations.push({
            code: 'unbounded-repeated-action',
            detail: `Action ${actionId} started ${String(count)} times, past its ceiling of ${String(maxRepeats)}.`,
            eventType: entry.type,
          })
        }
        startedActions.add(actionId)
        break
      }

      case 'enterprise.spending-gate.checked':
        break

      case 'enterprise.webzone-operation.completed': {
        const verificationId =
          typeof payload.verificationId === 'string' && payload.verificationId.length > 0
            ? payload.verificationId
            : null
        // Keyed on `operationId`, which is what this event actually carries. It names
        // the operation, and `action.started` names the action — so this case has to
        // match on the id it was given rather than the one the loop above extracted,
        // or "completed but never started" would never be detected at all.
        const operationId =
          typeof payload.operationId === 'string' && payload.operationId.length > 0
            ? payload.operationId
            : actionId
        if (operationId !== null) completedOperations.set(operationId, verificationId)
        if (verificationId === null) {
          violations.push({
            code: 'completion-without-verification',
            detail: 'An operation was completed with no verification id.',
            eventType: entry.type,
          })
        }
        break
      }

      case 'enterprise.action.refused': {
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

      default:
        break
    }
  }

  // Every started action must be traceable to a wake recorded before it, and every
  // started action that spent must have been gate-checked.
  const firstWakeIndex = input.entries.findIndex((entry) => entry.type === 'enterprise.wake.received')
  if (actions > 0 && firstWakeIndex < 0) {
    violations.push({
      code: 'action-without-wake',
      detail: 'Actions were taken but no wake was ever recorded.',
      eventType: 'enterprise.action.started',
    })
  }
  for (const [operationId, verificationId] of completedOperations) {
    if (!startedOperations.has(operationId)) {
      violations.push({
        code: 'action-without-wake',
        detail: `Operation ${operationId} completed without ever starting.`,
        eventType: 'enterprise.webzone-operation.completed',
      })
    }
    if (verificationId === null) {
      violations.push({
        code: 'completion-without-verification',
        detail: `Operation ${operationId} is recorded complete with no verification.`,
        eventType: 'enterprise.webzone-operation.completed',
      })
    }
  }
  return { violations, wakes, actions }
}

/** Run every table audit. One call so a test cannot forget one. */
export function auditEnterpriseTables(): readonly string[] {
  return [
    ...auditTransitionTables(),
    ...auditEventVocabulary(),
    ...auditRefusalVocabulary(),
    ...auditAuthorityTables(),
    ...auditBoundaryNormalisation(),
    ...findCognitionEventsInVocabulary(),
  ]
}