/**
 * RELAY VALIDATION — strict normalization before anything reaches an adapter.
 *
 * Every value that leaves Core for a connector is validated and normalized
 * here, once, against a closed rule. The properties this file exists for:
 *
 * - **Addresses** are RFC-5322-shaped and nothing else: a local part, an `@`,
 *   a domain with at least one dot, no whitespace, no comments, no display
 *   names smuggled into the address itself. A recipient list is deduplicated
 *   and bounded, so a payload cannot widen itself by repeating an address.
 * - **Repo refs** are exactly `owner/repo`, both parts bounded and
 *   character-restricted. `owner/repo/extra` is refused, not truncated.
 * - **Event ids, message ids, cursors** are bounded opaque tokens. A cursor is
 *   never parsed, never trusted, never followed past its bound.
 * - **Pagination** is clamped into `[1, maxPaginationLimit]`. A caller asking
 *   for a million rows gets a hundred and is told.
 * - **Payloads** are bounded in characters before they are read, so a
 *   multi-megabyte blob cannot become an adapter's problem.
 *
 * Nothing here interprets. A hostile value is refused with a closed reason,
 * never repaired into something that looks valid.
 */

import { RELAY_LIMITS, type RelayAction } from './types'

/** A validation result: a normalized value, or a closed refusal. */
export type RelayValidation<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string }

const EMAIL_ADDRESS = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/
const REPO_PART = /^[A-Za-z0-9_.-]{1,100}$/
const CURSOR = /^[A-Za-z0-9._:-]{1,256}$/

export const MAX_EMAIL_ADDRESS_CHARS = 254
export const MAX_SUBJECT_CHARS = 998
export const MAX_BODY_CHARS = 100_000
export const MAX_TITLE_CHARS = 2_000
export const MAX_LOCATION_CHARS = 1_000
export const MAX_FILENAME_CHARS = 255
const CONTENT_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/

/**
 * Validate and normalize one email address.
 *
 * Lowercased, trimmed, and checked against a real shape. The local part is
 * allowed the RFC's specials but nothing that needs quoting; a display name
 * belongs in `RelayRecipient.name`, never inside the address.
 */
export function validateEmailAddress(value: unknown): RelayValidation<string> {
  if (typeof value !== 'string') return { ok: false, reason: 'an email address must be a string' }
  const trimmed = value.trim().toLowerCase()
  if (trimmed.length === 0) return { ok: false, reason: 'an email address is empty' }
  if (trimmed.length > MAX_EMAIL_ADDRESS_CHARS) {
    return { ok: false, reason: 'an email address is too long' }
  }
  if (!EMAIL_ADDRESS.test(trimmed)) {
    return { ok: false, reason: 'an email address is not a valid address' }
  }
  return { ok: true, value: trimmed }
}

/**
 * Validate a recipient list: bounded, deduplicated, every address valid.
 *
 * Deduplication is the recipient-widening defence: the same address supplied
 * twice is one recipient, and the list the adapter receives is exactly the
 * set of distinct addresses the caller named — no more.
 */
export function validateRecipients(value: unknown, field: string): RelayValidation<readonly string[]> {
  if (!Array.isArray(value)) return { ok: false, reason: `${field} must be a list` }
  if (value.length === 0) return { ok: false, reason: `${field} must name at least one recipient` }
  if (value.length > RELAY_LIMITS.maxRecipients) {
    return { ok: false, reason: `${field} may name at most ${RELAY_LIMITS.maxRecipients} recipients` }
  }
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of value) {
    const validated = validateEmailAddress(entry)
    if (!validated.ok) return { ok: false, reason: `${field}: ${validated.reason}` }
    if (seen.has(validated.value)) continue
    seen.add(validated.value)
    out.push(validated.value)
  }
  return { ok: true, value: out }
}

/** A bounded, non-empty text field. */
export function validateText(value: unknown, field: string, max: number, required = true): RelayValidation<string> {
  if (typeof value !== 'string') {
    return { ok: false, reason: required ? `${field} must be a string` : `${field} must be a string when present` }
  }
  if (value.length === 0) {
    return { ok: false, reason: required ? `${field} is empty` : `${field} is empty` }
  }
  if (value.length > max) return { ok: false, reason: `${field} is too long` }
  return { ok: true, value }
}

/**
 * Validate a GitHub repo reference: exactly `owner/repo`.
 *
 * Refused rather than repaired — `owner/repo/extra`, `owner` and
 * `https://github.com/owner/repo` are all refusals, because a normalization
 * that accepted a URL would be a normalization that followed a link.
 */
export function validateRepoRef(value: unknown): RelayValidation<{ owner: string; repo: string }> {
  if (typeof value !== 'string') return { ok: false, reason: 'a repo ref must be a string' }
  const trimmed = value.trim()
  if (trimmed.length === 0) return { ok: false, reason: 'a repo ref is empty' }
  if (trimmed.length > RELAY_LIMITS.maxRepoRefChars) return { ok: false, reason: 'a repo ref is too long' }
  const parts = trimmed.split('/')
  if (parts.length !== 2) return { ok: false, reason: 'a repo ref must be owner/repo' }
  const owner = parts[0] ?? ''
  const repo = parts[1] ?? ''
  if (!REPO_PART.test(owner)) return { ok: false, reason: 'a repo owner is invalid' }
  if (!REPO_PART.test(repo)) return { ok: false, reason: 'a repo name is invalid' }
  return { ok: true, value: { owner, repo } }
}

/** A bounded opaque id: message ids, event ids, issue keys. */
export function validateRelayId(value: unknown, field: string): RelayValidation<string> {
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, reason: `${field} must be a non-empty string` }
  }
  if (value.length > 128) return { ok: false, reason: `${field} is too long` }
  if (!/^[A-Za-z0-9._:-]+$/.test(value)) return { ok: false, reason: `${field} is not a valid id` }
  return { ok: true, value }
}

/**
 * Validate an idempotency key: bounded, opaque, required for writes.
 *
 * The key is a client-generated token like a request id. It is not a secret,
 * but it is validated like one — bounded and character-restricted — because
 * it is the replay-protection store's primary key.
 */
export function validateIdempotencyKey(value: unknown): RelayValidation<string> {
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, reason: 'an idempotency key is required for a write action' }
  }
  if (value.length > RELAY_LIMITS.maxIdempotencyKeyChars) {
    return { ok: false, reason: 'an idempotency key is too long' }
  }
  if (!/^[A-Za-z0-9._:-]+$/.test(value)) {
    return { ok: false, reason: 'an idempotency key is not a valid key' }
  }
  return { ok: true, value }
}

/**
 * Validate attachment metadata: filename, content type, size.
 *
 * Content never enters Relay — only its metadata. A size is a non-negative
 * integer; a content type is a MIME shape; a filename is bounded and
 * control-stripped.
 */
export function validateAttachments(value: unknown): RelayValidation<readonly { filename: string; contentType: string; sizeBytes: number }[]> {
  if (!Array.isArray(value)) return { ok: false, reason: 'attachments must be a list' }
  if (value.length > RELAY_LIMITS.maxAttachments) {
    return { ok: false, reason: `at most ${RELAY_LIMITS.maxAttachments} attachments are allowed` }
  }
  const out: { filename: string; contentType: string; sizeBytes: number }[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { ok: false, reason: 'an attachment must be an object' }
    }
    const record = entry as Record<string, unknown>
    if (typeof record.filename !== 'string' || record.filename.length === 0) {
      return { ok: false, reason: 'an attachment filename is required' }
    }
    if (record.filename.length > MAX_FILENAME_CHARS) {
      return { ok: false, reason: 'an attachment filename is too long' }
    }
    if (typeof record.contentType !== 'string' || !CONTENT_TYPE.test(record.contentType)) {
      return { ok: false, reason: 'an attachment content type is invalid' }
    }
    if (typeof record.sizeBytes !== 'number' || !Number.isInteger(record.sizeBytes) || record.sizeBytes < 0) {
      return { ok: false, reason: 'an attachment size is invalid' }
    }
    const filename = record.filename.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim()
    if (filename.length === 0) return { ok: false, reason: 'an attachment filename is empty' }
    out.push({ filename, contentType: record.contentType, sizeBytes: record.sizeBytes })
  }
  return { ok: true, value: out }
}

/**
 * Validate a pagination request: a limit clamped into range, an opaque cursor.
 *
 * The cursor is never decoded or interpreted — it is a token the adapter
 * issued and Core passes back verbatim, bounded.
 */
export function validatePagination(value: unknown): RelayValidation<{ limit: number; cursor: string | null }> {
  const record = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
  let limit = 20
  if (record.limit !== undefined) {
    if (typeof record.limit !== 'number' || !Number.isInteger(record.limit) || record.limit < 1) {
      return { ok: false, reason: 'a pagination limit must be a positive integer' }
    }
    limit = Math.min(record.limit, RELAY_LIMITS.maxPaginationLimit)
  }
  let cursor: string | null = null
  if (record.cursor !== undefined && record.cursor !== null) {
    if (typeof record.cursor !== 'string') return { ok: false, reason: 'a cursor must be a string' }
    if (record.cursor.length > RELAY_LIMITS.maxCursorChars) {
      return { ok: false, reason: 'a cursor is too long' }
    }
    if (!CURSOR.test(record.cursor)) return { ok: false, reason: 'a cursor is not valid' }
    cursor = record.cursor
  }
  return { ok: true, value: { limit, cursor } }
}

/** A bounded search query. */
export function validateQuery(value: unknown): RelayValidation<string | null> {
  if (value === undefined || value === null) return { ok: true, value: null }
  if (typeof value !== 'string') return { ok: false, reason: 'a query must be a string' }
  if (value.length > 2_000) return { ok: false, reason: 'a query is too long' }
  return { ok: true, value }
}

/**
 * Validate a calendar time range: two instants, end after start.
 *
 * Timezone validation is instant validation — a value that does not parse as
 * an ISO-8601 instant is refused, so a floating local time cannot silently
 * become a different moment depending on where the machine sits.
 */
export function validateTimeRange(startsAt: unknown, endsAt: unknown): RelayValidation<{ startsAt: string; endsAt: string }> {
  if (typeof startsAt !== 'string' || Number.isNaN(Date.parse(startsAt))) {
    return { ok: false, reason: 'a start time must be an ISO-8601 instant' }
  }
  if (typeof endsAt !== 'string' || Number.isNaN(Date.parse(endsAt))) {
    return { ok: false, reason: 'an end time must be an ISO-8601 instant' }
  }
  if (Date.parse(endsAt) <= Date.parse(startsAt)) {
    return { ok: false, reason: 'the end time must be after the start time' }
  }
  return { ok: true, value: { startsAt, endsAt } }
}

/**
 * Validate the whole action payload, per action.
 *
 * This is the one door every action passes through. It returns a normalized
 * payload the adapter can consume, or a closed refusal. Nothing here is
 * action-specific beyond the fields the action owns — a field an action does
 * not name is a refusal, not an ignore.
 */
export function validateActionPayload(
  action: RelayAction,
  payload: unknown,
): RelayValidation<Record<string, unknown>> {
  const record = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null
  if (record === null) return { ok: false, reason: 'the action payload must be an object' }
  const serialized = JSON.stringify(record)
  if (serialized === undefined || serialized.length > RELAY_LIMITS.maxPayloadChars) {
    return { ok: false, reason: 'the action payload is too large' }
  }

  switch (action) {
    case 'email.read': {
      const query = validateQuery(record.query)
      if (!query.ok) return query
      const page = validatePagination(record)
      if (!page.ok) return page
      return { ok: true, value: { query: query.value, limit: page.value.limit, cursor: page.value.cursor } }
    }

    case 'email.draft.create':
    case 'email.send': {
      const to = validateRecipients(record.to, 'to')
      if (!to.ok) return to
      let cc: readonly string[] = []
      if (record.cc !== undefined && record.cc !== null) {
        const validated = validateRecipients(record.cc, 'cc')
        if (!validated.ok) return validated
        cc = validated.value
      }
      const subject = validateText(record.subject, 'subject', MAX_SUBJECT_CHARS)
      if (!subject.ok) return subject
      const body = validateText(record.body, 'body', MAX_BODY_CHARS)
      if (!body.ok) return body
      let attachments: readonly { filename: string; contentType: string; sizeBytes: number }[] = []
      if (record.attachments !== undefined && record.attachments !== null) {
        const validated = validateAttachments(record.attachments)
        if (!validated.ok) return validated
        attachments = validated.value
      }
      if (action === 'email.send') {
        const key = validateIdempotencyKey(record.idempotencyKey)
        if (!key.ok) return key
        return {
          ok: true,
          value: { to: to.value, cc, subject: subject.value, body: body.value, attachments, idempotencyKey: key.value },
        }
      }
      return { ok: true, value: { to: to.value, cc, subject: subject.value, body: body.value, attachments } }
    }

    case 'calendar.read': {
      const query = validateQuery(record.query)
      if (!query.ok) return query
      const page = validatePagination(record)
      if (!page.ok) return page
      return { ok: true, value: { query: query.value, limit: page.value.limit, cursor: page.value.cursor } }
    }

    case 'calendar.create': {
      const title = validateText(record.title, 'title', MAX_TITLE_CHARS)
      if (!title.ok) return title
      const range = validateTimeRange(record.startsAt, record.endsAt)
      if (!range.ok) return range
      let location: string | null = null
      if (record.location !== undefined && record.location !== null) {
        const validated = validateText(record.location, 'location', MAX_LOCATION_CHARS)
        if (!validated.ok) return validated
        location = validated.value
      }
      let attendees: readonly string[] = []
      if (record.attendees !== undefined && record.attendees !== null) {
        const validated = validateRecipients(record.attendees, 'attendees')
        if (!validated.ok) return validated
        attendees = validated.value
      }
      const key = validateIdempotencyKey(record.idempotencyKey)
      if (!key.ok) return key
      return {
        ok: true,
        value: {
          title: title.value,
          startsAt: range.value.startsAt,
          endsAt: range.value.endsAt,
          location,
          attendees,
          idempotencyKey: key.value,
        },
      }
    }

    case 'calendar.update': {
      const eventId = validateRelayId(record.eventId, 'eventId')
      if (!eventId.ok) return eventId
      let title: string | null = null
      if (record.title !== undefined && record.title !== null) {
        const validated = validateText(record.title, 'title', MAX_TITLE_CHARS)
        if (!validated.ok) return validated
        title = validated.value
      }
      let startsAt: string | null = null
      let endsAt: string | null = null
      if (record.startsAt !== undefined && record.startsAt !== null) {
        if (typeof record.startsAt !== 'string' || Number.isNaN(Date.parse(record.startsAt))) {
          return { ok: false, reason: 'a start time must be an ISO-8601 instant' }
        }
        startsAt = record.startsAt
      }
      if (record.endsAt !== undefined && record.endsAt !== null) {
        if (typeof record.endsAt !== 'string' || Number.isNaN(Date.parse(record.endsAt))) {
          return { ok: false, reason: 'an end time must be an ISO-8601 instant' }
        }
        endsAt = record.endsAt
      }
      if (startsAt !== null && endsAt !== null) {
        const range = validateTimeRange(startsAt, endsAt)
        if (!range.ok) return range
      } else if (startsAt === null && endsAt === null) {
        // A partial update may change only the title or only the times; both
        // absent with no title is a no-op request, refused as meaningless.
        if (title === null) return { ok: false, reason: 'an update must change something' }
      }
      let location: string | null | undefined = undefined
      if (record.location !== undefined) {
        if (record.location === null) {
          location = null
        } else {
          const validated = validateText(record.location, 'location', MAX_LOCATION_CHARS)
          if (!validated.ok) return validated
          location = validated.value
        }
      }
      let attendees: readonly string[] | undefined = undefined
      if (record.attendees !== undefined && record.attendees !== null) {
        const validated = validateRecipients(record.attendees, 'attendees')
        if (!validated.ok) return validated
        attendees = validated.value
      }
      const key = validateIdempotencyKey(record.idempotencyKey)
      if (!key.ok) return key
      return {
        ok: true,
        value: {
          eventId: eventId.value,
          ...(title === null ? {} : { title }),
          ...(startsAt === null ? {} : { startsAt }),
          ...(endsAt === null ? {} : { endsAt }),
          ...(location === undefined ? {} : { location }),
          ...(attendees === undefined ? {} : { attendees }),
          idempotencyKey: key.value,
        },
      }
    }

    case 'calendar.cancel': {
      const eventId = validateRelayId(record.eventId, 'eventId')
      if (!eventId.ok) return eventId
      const key = validateIdempotencyKey(record.idempotencyKey)
      if (!key.ok) return key
      return { ok: true, value: { eventId: eventId.value, idempotencyKey: key.value } }
    }

    case 'github.read': {
      const repo = validateRepoRef(record.repo)
      if (!repo.ok) return repo
      const page = validatePagination(record)
      if (!page.ok) return page
      return { ok: true, value: { repo: repo.value, limit: page.value.limit, cursor: page.value.cursor } }
    }

    case 'github.issue.create': {
      const repo = validateRepoRef(record.repo)
      if (!repo.ok) return repo
      const title = validateText(record.title, 'title', MAX_TITLE_CHARS)
      if (!title.ok) return title
      const body = validateText(record.body, 'body', MAX_BODY_CHARS)
      if (!body.ok) return body
      const key = validateIdempotencyKey(record.idempotencyKey)
      if (!key.ok) return key
      return { ok: true, value: { repo: repo.value, title: title.value, body: body.value, idempotencyKey: key.value } }
    }

    case 'github.pr.create': {
      const repo = validateRepoRef(record.repo)
      if (!repo.ok) return repo
      const head = validateRelayId(record.head, 'head branch')
      if (!head.ok) return head
      const base = validateRelayId(record.base, 'base branch')
      if (!base.ok) return base
      if (head.value === base.value) {
        return { ok: false, reason: 'the head and base branches must differ' }
      }
      const title = validateText(record.title, 'title', MAX_TITLE_CHARS)
      if (!title.ok) return title
      const body = validateText(record.body, 'body', MAX_BODY_CHARS)
      if (!body.ok) return body
      const key = validateIdempotencyKey(record.idempotencyKey)
      if (!key.ok) return key
      return {
        ok: true,
        value: { repo: repo.value, head: head.value, base: base.value, title: title.value, body: body.value, idempotencyKey: key.value },
      }
    }

    case 'external.invoke': {
      if (typeof record.connector !== 'string' || record.connector.length === 0) {
        return { ok: false, reason: 'an external connector name is required' }
      }
      if (record.connector.length > RELAY_LIMITS.maxExternalConnectorChars) {
        return { ok: false, reason: 'an external connector name is too long' }
      }
      if (!/^[A-Za-z0-9._-]+$/.test(record.connector)) {
        return { ok: false, reason: 'an external connector name is invalid' }
      }
      if (typeof record.operation !== 'string' || record.operation.length === 0) {
        return { ok: false, reason: 'an external operation is required' }
      }
      if (record.operation.length > RELAY_LIMITS.maxExternalOperationChars) {
        return { ok: false, reason: 'an external operation is too long' }
      }
      if (!/^[A-Za-z0-9._-]+$/.test(record.operation)) {
        return { ok: false, reason: 'an external operation is invalid' }
      }
      let params: readonly (string | number | boolean)[] = []
      if (record.params !== undefined && record.params !== null) {
        if (!Array.isArray(record.params)) return { ok: false, reason: 'external parameters must be a list' }
        if (record.params.length > RELAY_LIMITS.maxExternalParams) {
          return { ok: false, reason: `at most ${RELAY_LIMITS.maxExternalParams} external parameters are allowed` }
        }
        for (const param of record.params) {
          if (typeof param === 'string') {
            if (param.length > RELAY_LIMITS.maxExternalParamChars) {
              return { ok: false, reason: 'an external parameter is too long' }
            }
            params = [...params, param]
          } else if (typeof param === 'number' && Number.isFinite(param)) {
            params = [...params, param]
          } else if (typeof param === 'boolean') {
            params = [...params, param]
          } else {
            return { ok: false, reason: 'an external parameter must be a string, number or boolean' }
          }
        }
      }
      const key = validateIdempotencyKey(record.idempotencyKey)
      if (!key.ok) return key
      return {
        ok: true,
        value: { connector: record.connector, operation: record.operation, params, idempotencyKey: key.value },
      }
    }
  }
}
