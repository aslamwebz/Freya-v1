import { DEVICE_HANDS_LIMITS, type DeviceHandsRefusalCode } from './types'
import { checkPath, checkUrl, type SurfacePolicy } from './paths'

/**
 * Downloads and uploads: the one surface that moves bytes, and therefore the one that
 * can take something off the machine or put something onto it.
 *
 * ## What is deliberately enforced
 *
 * - **Both ends are gated.** A download's destination *and* an upload's source go
 *   through the same {@link checkPath} as a terminal argument and a clipboard-free path
 *   request. There is no direction in which one end is trusted because the other was
 *   checked.
 * - **Text and documents only.** The media allowlist has **no image type in it**, which
 *   is a stronger statement than "images are allowed but not screenshots": with no
 *   image type allowed there is no path by which a captured frame could be smuggled
 *   through the transfer surface, and no `image/png` to reason about later.
 * - **Name and type must agree.** A `.txt` that claims to be `application/pdf` is
 *   `media-type-mismatch`. This closes the "harmless extension, different bytes" gap
 *   that a type allowlist alone leaves open.
 * - **No executables, ever.** No `.exe`, `.dll`, `.sh`, `.bat`, `.ps1`, `.app`,
 *   `.command`, `.js`, `.jar`, `.msi`, `.scr` — the type table has no member that
 *   names one, and {@link TRANSFER_DENIED_EXTENSIONS} refuses the name independently
 *   so a caller cannot reach the table by lying about the extension.
 * - **Size is bounded twice.** Per action *and* cumulatively per session, checked at
 *   the gate before the port is called rather than discovered halfway through a
 *   multi-gigabyte response.
 * - **No auto-extraction, no resume, no redirect to a new host.** A transfer target
 *   is one allowlisted URL or one allowlisted path; nothing in this module follows a
 *   redirect, expands an archive, or retries against a different host.
 *
 * ## What is deliberately absent
 *
 * No `node:fs`, no `fetch`, no network. This module judges a request; `./ports` acts.
 */

/* ----------------------------------------------------------- media allowlist */

/**
 * The media types this phase will move.
 *
 * Text and documents. **No `image/*`.** The reason is in the module comment and it is
 * the reason a reviewer should check this table first when a transfer is refused: a
 * captured screenshot is a file, and the only way to be sure a transferred file is
 * not one is for there to be no image type to declare.
 */
export const DEVICE_HANDS_ALLOWED_MEDIA_TYPES: readonly string[] = Object.freeze([
  'text/plain',
  'text/csv',
  'text/markdown',
  'application/json',
  'application/pdf',
])

/**
 * The extension each type must arrive with.
 *
 * One extension per type, and one type per extension, so the mapping is a function
 * rather than a relation. A request naming an extension that is not in this table is
 * `media-type-mismatch` whatever it claims to be.
 */
export const DEVICE_HANDS_EXTENSION_MEDIA_TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
})

/**
 * Extensions refused by name, whatever media type is claimed.
 *
 * Checked independently of the type table so that a caller cannot reach a type it was
 * refused by declaring a different extension, and so the refusal reason for an
 * executable is about the executable rather than about a lookup miss.
 */
export const TRANSFER_DENIED_EXTENSIONS: readonly string[] = Object.freeze([
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bat',
  '.cmd',
  '.com',
  '.ps1',
  '.psm1',
  '.vbs',
  '.js',
  '.mjs',
  '.cjs',
  '.jar',
  '.msi',
  '.scr',
  '.app',
  '.command',
  '.sh',
  '.bash',
  '.zsh',
  '.py',
  '.rb',
  '.pl',
  '.bin',
  '.img',
  '.iso',
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.jks',
  '.keystore',
  '.env',
  '.bak',
  '.db',
  '.sqlite',
])

/**
 * Whole file names refused by name, whatever media type is claimed.
 *
 * Separate from the extension list because the dangerous names are dot-*leading*: `.env`
 * has no extension at all as far as `lastIndexOf('.')` is concerned, so an
 * extension-only rule would answer "media-type-mismatch" — a refusal, but one about the
 * wrong thing. These are refused for what they are.
 */
export const TRANSFER_DENIED_FILE_NAMES: readonly string[] = Object.freeze([
  '.env',
  '.env.local',
  '.env.production',
  '.npmrc',
  '.netrc',
  '.git-credentials',
  '.pgpass',
  '.my.cnf',
  'credentials',
  'id_rsa',
  'id_ed25519',
  'freya.keyring.json',
  'shadow',
  'secrets.json',
  'keystore',
])

/**
 * Windows device names, refused because a path built around one addresses the device
 * rather than a file, and because `CON` as a "file name" is how a few very old tricks
 * still work.
 */
const RESERVED_STEMS: readonly string[] = Object.freeze([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'lpt1',
  'lpt2',
  'lpt3',
])

/* ------------------------------------------------------------------- shapes */

export const TRANSFER_DIRECTIONS = ['download', 'upload'] as const
export type TransferDirection = (typeof TRANSFER_DIRECTIONS)[number]

export interface TransferTarget {
  readonly direction: TransferDirection
  /** The checked, canonical URL. Never the caller's raw string. */
  readonly url: string
  readonly mediaType: string
  readonly bytes: number
  /** Normalised absolute path. Only ever produced by {@link checkPath}. */
  readonly path: string
  readonly fileName: string
}

export type TransferReading =
  | { readonly ok: true; readonly target: TransferTarget }
  | { readonly ok: false; readonly code: DeviceHandsRefusalCode; readonly reason: string }

function refuse(code: DeviceHandsRefusalCode, reason: string): TransferReading {
  return { ok: false, code, reason }
}

/**
 * Read and narrow one transfer request.
 *
 * `pathKey` differs by direction on purpose: a download is told where the file goes
 * (`destinationPath`), an upload where it comes from (`sourcePath`). Naming the key
 * differently rather than using one `path` field means a caller cannot satisfy a
 * download by supplying a source, and the refusal says which end was missing.
 */
export function readTransferRequest(
  input: unknown,
  direction: TransferDirection,
  policy: SurfacePolicy,
): TransferReading {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return refuse('request-malformed', 'A transfer request must be an object.')
  }
  const raw = input as Record<string, unknown>
  const pathKey = direction === 'download' ? 'destinationPath' : 'sourcePath'
  const verb = direction === 'download' ? 'A download' : 'An upload'

  /* -------------------------------------------------------------- the media type */
  if (typeof raw.mediaType !== 'string') {
    return refuse('request-malformed', `${verb} must declare a media type.`)
  }
  const mediaType = raw.mediaType.trim().toLowerCase().split(';')[0]?.trim() ?? ''
  if (!DEVICE_HANDS_ALLOWED_MEDIA_TYPES.includes(mediaType)) {
    return refuse(
      'media-type-not-allowed',
      `"${raw.mediaType}" is not on the transfer allowlist (${DEVICE_HANDS_ALLOWED_MEDIA_TYPES.join(', ')}). Device Hands moves text and documents; it moves no images, no executables and no binaries.`,
    )
  }

  /* -------------------------------------------------------------- the file name */
  if (typeof raw.fileName !== 'string' || raw.fileName.length === 0 || raw.fileName.length > 128) {
    return refuse('file-name-invalid', `${verb} must name a file of at most 128 characters.`)
  }
  const fileName = raw.fileName
  if (fileName.includes('/') || fileName.includes('\\')) {
    return refuse(
      'file-name-invalid',
      'A file name may not contain a path separator. The directory comes from the checked path, never from the name.',
    )
  }
  if (fileName === '.' || fileName === '..' || fileName.includes('..')) {
    return refuse('file-name-invalid', 'A file name may not contain a traversal segment.')
  }
  for (let index = 0; index < fileName.length; index += 1) {
    const code = fileName.charCodeAt(index)
    if (code < 32 || code === 127) {
      return refuse('file-name-invalid', 'A file name may not contain a control character.')
    }
  }
  const lowerName = fileName.toLowerCase()
  if (TRANSFER_DENIED_FILE_NAMES.includes(lowerName)) {
    return refuse(
      'media-type-not-allowed',
      `"${fileName}" is an operating-system or Freya credential file. Device Hands moves no credential, whatever media type it declares.`,
    )
  }
  if (RESERVED_STEMS.includes(lowerName.split('.')[0] ?? '')) {
    return refuse('file-name-invalid', `"${fileName}" is a reserved device name, not a file.`)
  }
  const dot = lowerName.lastIndexOf('.')
  const extension = dot > 0 ? lowerName.slice(dot) : ''
  if (TRANSFER_DENIED_EXTENSIONS.includes(extension)) {
    return refuse(
      'media-type-not-allowed',
      `".${extension.replace('.', '')}" files are never moved by Device Hands, whatever media type they claim.`,
    )
  }
  const expected = DEVICE_HANDS_EXTENSION_MEDIA_TYPES[extension]
  if (expected === undefined) {
    return refuse(
      'media-type-mismatch',
      `No media type is associated with the extension "${extension || '(none)'}". This phase only moves ${Object.keys(DEVICE_HANDS_EXTENSION_MEDIA_TYPES).join(', ')}.`,
    )
  }
  if (expected !== mediaType) {
    return refuse(
      'media-type-mismatch',
      `"${fileName}" is a ${expected} file and the request declared ${mediaType}. A name and a type that disagree is refused rather than reconciled.`,
    )
  }

  /* ----------------------------------------------------------------- the size */
  if (typeof raw.bytes !== 'number' || !Number.isFinite(raw.bytes)) {
    return refuse('request-malformed', `${verb} must declare its size in bytes.`)
  }
  if (!Number.isInteger(raw.bytes) || raw.bytes < 0) {
    return refuse(
      'file-name-invalid',
      'A size must be a non-negative whole number of bytes. A partial or negative size is refused rather than rounded.',
    )
  }
  const ceiling = Math.min(policy.maxTransferBytes, DEVICE_HANDS_LIMITS.maxTransferBytesPerAction)
  if (raw.bytes > ceiling) {
    return refuse(
      'file-too-large',
      `This transfer would move ${String(raw.bytes)} bytes; the ceiling is ${String(ceiling)}.`,
    )
  }

  /* ------------------------------------------------------------------ the URL */
  // Checked here rather than in the browser policy, and for *both* directions. A
  // transfer has a remote endpoint exactly as much as a page does, and an upload whose
  // URL was never checked would be the one path by which bytes left an allowlisted host
  // to anywhere on the internet. The canonical form is stored, so the port is handed a
  // URL this module judged rather than the caller's raw string.
  const url = checkUrl(raw.url, policy)
  if (!url.ok) return refuse(url.code, url.reason)

  /* ------------------------------------------------------------------ the path */
  const rawPath = raw[pathKey]
  if (typeof rawPath !== 'string') {
    return refuse('request-malformed', `${verb} must set ${pathKey}.`)
  }
  const path = checkPath(rawPath, policy)
  if (!path.ok) {
    return refuse(path.code, path.reason)
  }
  // The checked path is the *directory* the file lives in; the name comes from
  // `fileName`, which has already been refused if it carried a separator. The two are
  // joined here so no caller can address a file by putting a directory in the name.
  const full = `${path.normalised}/${fileName}`
  const finalCheck = checkPath(full, policy)
  if (!finalCheck.ok) {
    return refuse(finalCheck.code, finalCheck.reason)
  }

  return {
    ok: true,
    target: Object.freeze({
      direction,
      url: url.url,
      mediaType,
      bytes: raw.bytes,
      path: finalCheck.normalised,
      fileName,
    }),
  }
}

/**
 * The cumulative byte ceiling for a session.
 *
 * Separate from the per-action ceiling because they answer different questions: one
 * bounds a single transfer, the other bounds a session that could otherwise make a
 * hundred legal 1 MiB transfers. Both are checked before the port is called.
 */
export function sessionTransferCeiling(): number {
  return DEVICE_HANDS_LIMITS.maxTransferBytesPerSession
}

/** The canonical form of a transfer, for binding an approval to it. */
export function transferCanonicalForm(target: TransferTarget): string[] {
  return [
    target.direction,
    target.url,
    target.mediaType,
    String(target.bytes),
    target.path,
    target.fileName,
  ]
}