import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * The shape of one record written to the runtime diagnostics log.
 *
 * Kept deliberately small and free of any field that could hold a secret:
 * never log API keys, tokens, Authorization headers, prompts, responses,
 * file contents, or anything else that crosses a trust boundary. IDs and
 * context are enough to reconstruct a timeline.
 */
export interface DiagnosticRecord {
  /** ISO timestamp, in Core's clock domain. */
  at: string
  /** Severity. `info` for lifecycle, `warn` for recoverable surprises, `error` for failures. */
  level: 'info' | 'warn' | 'error'
  /** Which subsystem produced the record. Lowercase, dot-separated. */
  component: string
  /** Short, stable event name. Prefer snake_case. */
  event: string
  /** Human sentence explaining what happened. Never null. */
  message: string
  /** Optional structured detail. Must be JSON-safe and free of secrets. */
  detail?: Record<string, unknown>
  /** Safe exception summary, when an exception was captured. */
  error?: { name: string; message: string; stack?: string }
  /** Lifecycle posture before the event, when relevant. */
  lifecycleBefore?: string
  /** Lifecycle posture after the event, when relevant. */
  lifecycleAfter?: string
  /** Request id of the command that produced the event, when known. */
  requestId?: string | null
  /** Conversation id, when known. */
  conversationId?: string | null
}

/**
 * The append-only runtime diagnostics writer.
 *
 * Independent of the main EventStore: even when the durable journal is
 * unavailable (the case the ephemeral fallback exists for) the diagnostics
 * file still receives records, because the operator needs evidence of the
 * very failure that took the journal down.
 *
 * Records are JSONL: one object per line, terminated by `\n`. The file is
 * written synchronously on each record. This does not guarantee a disk flush
 * across power loss, and it does not depend on the event journal's writer.
 */
export class RuntimeDiagnostics {
  private readonly filePath: string
  private writeFailures = 0

  /** Create a diagnostics writer bound to a file path. Creates parent dirs. */
  constructor(filePath: string) {
    this.filePath = filePath
    try {
      mkdirSync(dirname(filePath), { recursive: true })
    } catch {
      this.writeFailures += 1
    }
  }

  /**
   * The path records are written to. Exposed for status projection and tests.
   */
  get path(): string {
    return this.filePath
  }

  /**
   * Append one record. Never throws: a failing write is counted, and a
   * secondary error from the writer itself is swallowed so a diagnostics
   * outage can never break the runtime it is trying to record.
   */
  record(record: DiagnosticRecord): void {
    try {
      const line = `${JSON.stringify(record, (key, value: unknown) => {
        if (/^(api[-_]?key|token|secret|password|authorization|cookie|prompt|response|content|body)$/i.test(key)) return '[redacted]'
        return typeof value === 'string' ? redact(value) : value
      })}\n`
      appendFileSync(this.filePath, line, 'utf8')
    } catch (writeError) {
      this.writeFailures += 1
      // Best effort: try one console.error so the operator at least sees the
      // failure on stderr. Do not recurse through `record()`.
      try {
        console.error('[freya.diagnostics] write failed', redact(describe(writeError)))
      } catch {
        // give up silently
      }
    }
  }

  /** How many record writes have failed since this writer was created. */
  get failureCount(): number {
    return this.writeFailures
  }

  /**
   * Convenience: record an exception with the standard fields filled in.
   *
   * Uses a caller-owned summary and a local stack, never an exception's text:
   * upstream errors can reflect credentials, prompts or private file contents.
   */
  recordError(component: string, event: string, error: unknown, message: string, detail?: Record<string, unknown>): void {
    const e = error instanceof Error ? error : new Error(typeof error === 'string' ? error : 'unknown error')
    const frames = new Error('diagnostic capture').stack?.split('\n').slice(1).join('\n')
    this.record({
      at: new Date().toISOString(),
      level: 'error',
      component,
      event,
      message,
      detail,
      error: { name: ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError', 'AggregateError'].includes(e.name) ? e.name : 'Error', message,
        ...(frames ? { stack: frames } : {}) },
    })
  }
}

function redact(value: string): string {
  return value
    .replace(/\b(Bearer|Basic)\s+[^\s"']+/gi, '$1 [redacted]')
    .replace(/\b(api[-_]?key|access[-_]?token|token|secret|password)(["']?\s*[:=]\s*["']?)[^\s&,"']+/gi, '$1$2[redacted]')
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return 'unknown error'
  }
}

/**
 * The default location of the diagnostics log, given the same `dataPath`
 * the main EventStore uses. Kept as a sibling file so a missing parent
 * directory is the same problem the main store would have hit, and the
 * log is co-located with the journal for forensic convenience.
 */
export function defaultDiagnosticsPath(dataPath: string): string {
  return `${dataPath}.diagnostics.jsonl`
}
