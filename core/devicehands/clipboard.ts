import { DEVICE_HANDS_LIMITS, type DeviceHandsRefusalCode } from './types'
import { canonicalDigest } from './digest'

/**
 * The clipboard: the owner's own cross-application buffer, read and written
 * explicitly.
 *
 * The clipboard is the single most likely place for Freya to leak something without
 * intending to. It is where the password a password manager just filled in lives, and
 * where `Ctrl+C` on the wrong window puts a session cookie. So this module has two
 * jobs, and the second is the one that matters.
 *
 * ## What is deliberately enforced
 *
 * - **Explicit or nothing.** There is no watch, no poll, no change listener and no
 *   mirror. A clipboard read happens when somebody asks for one, and it is journaled
 *   when it happens.
 * - **Bounded.** Content is capped at
 *   {@link DEVICE_HANDS_LIMITS}.maxClipboardBytes and refused above it. A clipboard
 *   that can hold a file the size of the disk is not something to copy out of.
 * - **Text only.** Binary is refused. There is no path by which an image, an
 *   executable or a screenshot reaches this phase through the clipboard.
 * - **Credential-shaped content is neither returned nor recorded.**
 *   {@link classifyClipboardText} names the shapes — a private key block, a JWT, a
 *   URL with a password in it, a card number, a long unlabelled secret run. When one
 *   is found the runtime journals the *direction* and the byte count and nothing else.
 *   The content is dropped at the boundary and never becomes an observation.
 * - **The write is as guarded as the read.** Writing a credential into the buffer is
 *   how a secret gets exfiltrated to whatever the user pastes into next, so it is
 *   refused with the same code and the same reason.
 *
 * ## What is deliberately absent
 *
 * No I/O, no port call, no clock. This module judges a string; `./ports` owns the
 * system clipboard.
 */

/** The directions the clipboard can move in. */
export const CLIPBOARD_DIRECTIONS = ['in', 'out'] as const
export type ClipboardDirection = (typeof CLIPBOARD_DIRECTIONS)[number]

/* -------------------------------------------------------- credential shapes */

/**
 * Shapes that mean "this is somebody's secret".
 *
 * Matched on the *value*, not on the field name, because an allowlist of field names
 * is defeated by putting a private key in a field called `note`.
 *
 * Each entry is a closed pattern with a sentence attached, because "that looks like a
 * credential" is not an explanation a person can act on — "that contains what looks
 * like a PEM private key block" is.
 */
export const CLIPBOARD_CREDENTIAL_SHAPES: readonly { readonly name: string; readonly pattern: RegExp }[] =
  Object.freeze([
    {
      name: 'a PEM private key block',
      pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
    },
    {
      name: 'a PEM certificate or key of any kind',
      pattern: /-----BEGIN [A-Z0-9 ]{4,}-----/,
    },
    { name: 'a JSON web token', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./ },
    {
      name: 'what appears to be an AWS access key id',
      pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
    },
    { name: 'what appears to be a GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
    { name: 'what appears to be an OpenAI-style secret key', pattern: /\bsk-[A-Za-z0-9]{20,}\b/ },
    { name: 'a URL carrying a password', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i },
    {
      name: 'an assignment of something named like a secret',
      pattern: /\b(?:password|passwd|secret|api[_-]?key|token|private[_-]?key|client[_-]?secret)\s*[:=]\s*\S+/i,
    },
    {
      name: 'what appears to be a card number',
      pattern: /\b(?:\d[ -]?){12,19}\b/,
    },
    {
      name: 'a long unlabelled run that looks like a secret',
      pattern: /\b[A-Za-z0-9+/]{40,}={0,2}\b/,
    },
  ])

export type ClipboardReading =
  | { readonly ok: true; readonly text: string; readonly bytes: number }
  | { readonly ok: false; readonly code: DeviceHandsRefusalCode; readonly reason: string }

function refuse(code: DeviceHandsRefusalCode, reason: string): ClipboardReading {
  return { ok: false, code, reason }
}

/**
 * Which credential shape, if any, a piece of text matches.
 *
 * Returns the first match and nothing about the text itself, so a caller that logs
 * the answer logs a shape name and cannot leak the secret by accident.
 */
export function classifyClipboardText(text: string): string | null {
  for (const shape of CLIPBOARD_CREDENTIAL_SHAPES) {
    if (shape.pattern.test(text)) return shape.name
  }
  return null
}

/** Bytes, as the limits are written in them. */
export function clipboardByteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

/** Whether the text carries a control character that no plain-text paste contains. */
function hasBinaryCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    // Tab, newline and carriage return are ordinary text. Everything else below 32,
    // and DEL, means the buffer holds bytes rather than prose.
    if (code === 9 || code === 10 || code === 13) continue
    if (code < 32 || code === 127) return true
  }
  return false
}

/**
 * Judge clipboard content, in the order the refusals must win.
 *
 * Binary before size, because a megabyte of binary is refused as the wrong *kind* of
 * thing rather than as a large thing — the size ceiling is a ceiling on text, and
 * quoting it for a PNG would be answering a question nobody asked.
 *
 * Credential *after* size, because the two are different facts: an oversized paste is
 * refused for being large, and a credential-shaped paste is refused for being a
 * secret. An audit trail that merged them would make the second invisible.
 */
export function checkClipboardText(
  text: unknown,
  direction: ClipboardDirection,
): ClipboardReading {
  const verb = direction === 'in' ? 'read out of' : 'written to'
  if (typeof text !== 'string') {
    return refuse('request-malformed', 'Clipboard content must be a string.')
  }
  if (hasBinaryCharacter(text)) {
    return refuse(
      'clipboard-binary-content',
      'That clipboard content contains a control character no plain text contains, so the buffer holds bytes rather than prose. Device Hands moves no binary through the clipboard.',
    )
  }
  const bytes = clipboardByteLength(text)
  if (bytes > DEVICE_HANDS_LIMITS.maxClipboardBytes) {
    return refuse(
      'clipboard-too-large',
      `Clipboard content ${verb} this phase is capped at ${String(DEVICE_HANDS_LIMITS.maxClipboardBytes)} bytes; this was ${String(bytes)}.`,
    )
  }
  const shape = classifyClipboardText(text)
  if (shape !== null) {
    return refuse(
      'clipboard-credential-content',
      `That clipboard content ${verb} this phase contains ${shape}, so it was refused and was neither returned to a caller nor written to the journal. Only its direction and byte count were recorded.`,
    )
  }
  return { ok: true, text, bytes }
}

/**
 * The canonical form of clipboard content, for binding an approval to it.
 *
 * It carries the content, because an approval the owner gave for pasting one address
 * must not authorise pasting a different one. It is *not* journaled: `./runtime`
 * hashes this with {@link canonicalDigest} and writes only the digest, so the journal
 * can prove "this is the text you approved" without becoming the place the text is
 * stored. That split is the whole reason content and approval live in different files.
 */
export function clipboardCanonicalForm(text: string): string[] {
  return ['clipboard', text]
}

/** Hashes {@link clipboardCanonicalForm} for the journal and the approval subject. */
/** Hashes {@link clipboardCanonicalForm} for the journal and the approval subject. */
export function clipboardDigest(text: string): string {
  return canonicalDigest(clipboardCanonicalForm(text))
}