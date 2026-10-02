import { readFileSync } from 'node:fs'

/**
 * The local `.env` loader — Electron main process only.
 *
 * Freya reads provider configuration from a `.env` file beside the app root, but
 * only here, in the trusted main process, and only into `process.env`. Preload
 * forwards named *commands*, never environment values, and the renderer has no
 * path to anything this file reads. A `.env` therefore never reaches a window, a
 * journal line, a log, or a chat transcript.
 *
 * Two rules make this safe to run unconditionally:
 *
 *   - A variable already present in the real environment always wins. `.env` is
 *     a convenience for a developer's machine, not a way to override an explicit
 *     process launch.
 *   - Nothing is ever logged by value. The loader returns the count of keys it
 *     set, and that is the whole of what a caller may say about what it read.
 *
 * A missing file is the normal state on a fresh clone: silence, and the provider
 * stays `unconfigured`, which chat already reports truthfully.
 */

/** An env file is configuration, not content. Anything larger is refused whole. */
const MAX_ENV_BYTES = 32 * 1024

/** Shape of a legitimate shell-ish variable name; anything else is dropped. */
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

export interface LoadedEnv {
  /** How many keys were set from the file. Never their names or values. */
  loaded: number
}

/**
 * Read `path` as a `.env` file and apply it to `process.env` without clobbering
 * anything already set. Returns the number of keys actually applied.
 */
export function loadLocalEnv(path: string): LoadedEnv {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    // No file, or an unreadable one. Both mean "no local overrides". A malformed
    // or unreadable `.env` must not prevent the app from starting on the real
    // environment it does have.
    return { loaded: 0 }
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_ENV_BYTES) {
    // Too large is refused whole rather than half-applied. A truncated key that
    // looks configured is worse than one that is honestly absent.
    console.warn(`[freya] ignoring local .env: larger than ${MAX_ENV_BYTES} bytes`)
    return { loaded: 0 }
  }
  let loaded = 0
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    const separator = trimmed.indexOf('=')
    if (separator <= 0) continue
    const key = trimmed.slice(0, separator).trim()
    if (!KEY_PATTERN.test(key)) continue
    if (process.env[key] !== undefined) continue
    const value = unquote(trimmed.slice(separator + 1).trim())
    process.env[key] = value
    loaded += 1
  }
  return { loaded }
}

/** Strip one layer of matching quotes. `#` inside them is data, not a comment. */
function unquote(raw: string): string {
  if (raw.length >= 2) {
    const first = raw[0]
    const last = raw[raw.length - 1]
    if ((first === '"' || first === "'") && first === last) return raw.slice(1, -1)
  }
  // Unquoted value: an inline comment is only a comment after a space, the same
  // convention dotenv implementations use.
  const comment = raw.indexOf(' #')
  return comment >= 0 ? raw.slice(0, comment).trim() : raw
}
