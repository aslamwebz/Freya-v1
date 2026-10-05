import {
  FORGE_ACCESS_FIELDS,
  FORGE_LIMITS,
  canonicalForgeJson,
  type ForgeManifest,
  type ForgeSecurityFinding,
} from './types'

/**
 * THE STATIC SCAN — what a candidate's text is refused for before it is run.
 *
 * ## Why a lexical scan is the right *shape* of control here
 *
 * Two reasons, and the second is the important one.
 *
 * 1. **It is a backstop, not the boundary.** The boundary is `program.ts`: the
 *    only thing that can execute is a straight-line list of operations from a
 *    closed table. There is no `eval` anywhere in this phase, so a candidate
 *    cannot reach a JavaScript evaluator by any route, and the scan cannot
 *    create one by missing something.
 *
 * 2. **It exists to explain refusals, not to find every possible abuse.** A
 *    declarative manifest is either in the closed vocabulary or it is not, and
 *    `parseForgeManifest` already said so. What a manifest *cannot* express —
 *    `require('child_process')`, `process.env`, `../../core/security/guard.ts`,
 *    a `capabilities` field smuggled beside the real one — still arrives as text
 *    in the payload, and refusing it with a specific finding is what lets the
 *    owner read what happened instead of watching a package die as
 *    `malformed-manifest`.
 *
 * So: honest about being lexical. A regex over text cannot be a proof of
 * safety. The proof of safety is that nothing here is executed as text.
 *
 * ## What is never kept
 *
 * A finding carries a **code** and a sentence about the *kind* of thing found.
 * It never carries the offending substring, because the substring is the
 * attacker's payload and a journal is not a place to keep one.
 */

/** The only top-level keys a manifest may carry. */
const ALLOWED_MANIFEST_KEYS: readonly string[] = Object.freeze([
  'name',
  'runtime',
  'description',
  'inputs',
  'outputs',
  'capabilitiesRequired',
  'access',
  'dependencies',
  'tags',
  'program',
  'version',
])

/**
 * Keys that would be an attempt to carry authority in the payload.
 *
 * A manifest has no such fields, so any of these appearing at the top level is
 * not a typo — it is an attempt to have a second, unaudited copy of the truth.
 * The refusal names the key and nothing else.
 */
const AUTHORITY_KEYS: readonly string[] = Object.freeze([
  'authority',
  'grant',
  'grants',
  'principal',
  'owner',
  'trusted',
  'bypassguard',
  'override',
  'clearstopall',
  'signature',
  'integrityhash',
  'enabled',
  'approval',
  'sandbox',
  'eval',
])

export interface ForgeScanFinding {
  readonly code: ForgeSecurityFinding
  readonly reason: string
}

export interface ForgeScanResult {
  readonly findings: readonly ForgeScanFinding[]
  readonly clean: boolean
  /** Bytes measured, never the bytes themselves. */
  readonly sourceLength: number
}

interface Rule {
  readonly code: ForgeSecurityFinding
  readonly pattern: RegExp
  readonly reason: string
}

/**
 * The closed rule table.
 *
 * Each entry is a pattern and the sentence a person reads when it fires. Adding a
 * rule is a code change on purpose: a scan that a candidate could extend for
 * itself would be an attacker's tool.
 */
const RULES: readonly Rule[] = Object.freeze([
  // Order matters only for the sentence a person reads first, and it is deliberate:
  // naming protected Core or a secret is the more important thing to say, so it is
  // said before the more generic "that is a path".
  {
    code: 'protected-core-reference',
    pattern: /(\bcore\/(security|authority|events|protocol|vault|skills|forge|work)\b)|(freya\.core)|(\bsrc\/core\b)|(PHASE-\d+)|(core-protocol)/i,
    reason: 'the candidate references Freya protected Core or security source, which no generated package may read or name',
  },
  {
    code: 'secret-access',
    pattern: /(process\.env)|(os\.environ)|(\bkeytar\b)|(\bsafeStorage\b)|(\bkeyring\b)|(\bsqlcipher\b)|(\bcredential(s)?\b)|(\bprivate[_-]?key\b)|(\bapi[_-]?key\b)|(\baccess[_-]?token\b)|(\bpassword\b)|(\bsecrets?\b)/i,
    reason: 'the candidate reaches for an environment secret, a keyring or the Vault',
  },
  {
    code: 'path-traversal',
    // The `://` exclusion matters: a URL is not a path, and a rule that fires on
    // every `https://` would report "that is a filesystem path" about a candidate
    // that is honestly asking for a network declaration — and the more important
    // finding would never be read.
    pattern: /(\.\.[\\/])|(\.\.%2f)|([A-Za-z]:\\)|(^|[^:])\/\/(?!\/)/i,
    reason: 'the candidate names a filesystem path; a Forge package has no filesystem to name',
  },
  {
    code: 'path-traversal',
    pattern: /(^|["'\s])(\/(etc|proc|sys|dev|usr|var|home|root|windows|users)\b)/i,
    reason: 'the candidate names a host path',
  },
  {
    code: 'forbidden-host-api',
    pattern: /(\beval\b)|(\bnew\s+Function\b)|(\brequire\s*\()|(\bimport\s*\()|(\bchild_process\b)|(\bexecSync\b)|(\bspawn\b)|(\bglobalThis\b)|(\b__dirname\b)|(\b__filename\b)|(\bWebAssembly\b)|(\bprocess\b)|(\bBuffer\b)|(\bnode:)|\bvm\.[a-z]/,
    reason: 'the candidate names a host API this runtime does not have and will not provide',
  },
  {
    code: 'unrestricted-network',
    pattern: /(https?:\/\/)|(\bfetch\s*\()|(\bXMLHttpRequest\b)|(\bWebSocket\b)|(\bnet\.connect\b)|(\bdns\.)|(\baxios\b)|(\bnavigator\.sendBeacon\b)/i,
    reason: 'the candidate reaches the network; network is a downstream act performed by Research or Relay under their own authority',
  },
  {
    code: 'hidden-dependency',
    pattern: /(npm\s+install)|(yarn\s+add)|(pnpm\s+add)|(\bfrom\s+['"][a-z@][^'"]+['"])|(\bnode_modules\b)|(\bpackage\.json\b)/i,
    reason: 'the candidate asks for an install or an import; Forge installs nothing and fetches nothing',
  },
])

/**
 * Scan a candidate payload as it arrived, plus its parsed manifest.
 *
 * The payload is re-serialised canonically so the scan sees the bytes that were
 * *submitted*, not the shape a parser may have coerced. Nothing is repaired
 * first, and nothing is dropped before the rules run.
 *
 * **One exclusion, and it is a narrow one.** The `access` object is removed from
 * the text the lexical rules see. A manifest is *required* to state
 * `keyring: 'denied'` and `process: 'denied'`, so leaving those keys in would make
 * every honest package match the rules that hunt for keyring and process access —
 * which is a scan that cries wolf on every package and so gets ignored. The access
 * declaration is instead checked **structurally**, twice: the manifest door refuses
 * any `declared` value for `keyring`, `process` or `filesystem` outright, and the
 * `impossible-access-declaration` rule below fires on a parsed manifest that says
 * so anyway.
 */
export function scanForgeCandidate(payload: unknown, manifest: ForgeManifest | null): ForgeScanResult {
  const findings: ForgeScanFinding[] = []
  const text = safeStringify(withoutAccessDeclaration(payload))
  const sourceLength = text.length

  if (sourceLength > FORGE_LIMITS.maxManifestBytes) {
    findings.push({
      code: 'oversized-source',
      reason: `the candidate is ${sourceLength} characters and the ceiling is ${FORGE_LIMITS.maxManifestBytes}`,
    })
    return { findings, clean: false, sourceLength }
  }

  // Top-level keys first: an authority key is a refusal whatever else is true,
  // and it is checked before the lexical rules so the message names the attempt
  // rather than whatever token it happened to contain.
  if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
    for (const key of Object.keys(payload as Record<string, unknown>)) {
      if (AUTHORITY_KEYS.includes(key.toLowerCase())) {
        findings.push({
          code: 'grant-metadata-tampering',
          reason: `the candidate carries a ${key} field; a manifest does not grant, approve, sign or enable anything`,
        })
      } else if (!ALLOWED_MANIFEST_KEYS.includes(key)) {
        findings.push({
          code: 'grant-metadata-tampering',
          reason: `the candidate carries an unknown field ${key}; a manifest has a closed shape`,
        })
      }
    }
    const access = (payload as Record<string, unknown>).access
    if (typeof access === 'object' && access !== null && !Array.isArray(access)) {
      for (const field of Object.keys(access as Record<string, unknown>)) {
        if (!(FORGE_ACCESS_FIELDS as readonly string[]).includes(field)) {
          findings.push({
            code: 'grant-metadata-tampering',
            reason: `the candidate declares an access field ${field}, which is not one of ${FORGE_ACCESS_FIELDS.join(', ')}`,
          })
        }
      }
    }
  }

  for (const rule of RULES) {
    if (rule.pattern.test(text)) {
      findings.push({ code: rule.code, reason: rule.reason })
    }
  }

  if (manifest !== null) {
    for (const field of FORGE_ACCESS_FIELDS) {
      if (manifest.access[field] === 'declared' && (field === 'keyring' || field === 'process' || field === 'filesystem')) {
        findings.push({
          code: 'impossible-access-declaration',
          reason: `the candidate declares ${field} access; this runtime cannot grant it to anything`,
        })
      }
    }
    if (manifest.access.network === 'declared' && manifest.runtime === 'pure-transform') {
      findings.push({
        code: 'impossible-access-declaration',
        reason: 'a pure-transform package declares network access, which its runtime kind has no operation to use',
      })
    }
  }

  const deduped: ForgeScanFinding[] = []
  for (const finding of findings) {
    if (deduped.some((existing) => existing.code === finding.code && existing.reason === finding.reason)) continue
    deduped.push(finding)
  }
  return { findings: deduped, clean: deduped.length === 0, sourceLength }
}

/** Re-serialise a payload for scanning. A cycle becomes a marker, not a throw. */
function safeStringify(payload: unknown): string {
  try {
    return canonicalForgeJson(payload)
  } catch {
    return JSON.stringify(payload) ?? ''
  }
}

/** A copy of the payload with the access declaration removed. See the note above. */
function withoutAccessDeclaration(payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return payload
  const copy: Record<string, unknown> = { ...(payload as Record<string, unknown>) }
  delete copy.access
  return copy
}
