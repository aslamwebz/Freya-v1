/**
 * THE BOUNDED PROVIDER ADAPTERS — Gmail, Drive, Calendar, GitHub and Telegram.
 *
 * Each adapter implements exactly the Relay port for its connector, loads its
 * token from the host-side secure store on each call, and reaches the provider
 * only through `fetchJson`'s host allowlist and timeout. There is no method that
 * returns a token and no payload field one could hide in.
 *
 * A connector with no stored token refuses with `RelayAdapterError` rather than
 * making an unauthenticated call, so a misconfigured host cannot accidentally
 * reach a provider.
 *
 * Telegram's Bot API does not expose chat history, so its read port refuses with
 * that reason and Telegram reads are delivered as authenticated events instead.
 * That is a real limitation, stated rather than hidden.
 */

import {
  RelayAdapterError,
  type CalendarAdapter,
  type DriveAdapter,
  type EmailAdapter,
  type GitHubAdapter,
  type RelayAdapterSet,
  type TelegramAdapter,
} from '../../core/relay/adapters'
import type {
  RelayCalendarEvent,
  RelayDriveFile,
  RelayDriveFileInput,
  RelayEmailDraft,
  RelayEmailMessage,
  RelayEmailSend,
  RelayGitHubIssue,
  RelayGitHubIssueInput,
  RelayGitHubPrInput,
  RelayGitHubRepoRef,
  RelayReadQuery,
  RelayTelegramMessage,
  RelayTelegramMessageInput,
} from '../../core/relay/types'
import type { ConnectorTokenStore } from '../../core/connectors/token-store'
import type { ConnectorKind } from '../../core/connectors/types'
import { fetchJson, type FetchLike } from './http'

const GMAIL_HOSTS = ['gmail.googleapis.com']
const GOOGLE_HOSTS = ['www.googleapis.com']
const GITHUB_HOSTS = ['api.github.com']
const TELEGRAM_HOSTS = ['api.telegram.org']

export interface AdapterDependencies {
  tokenStore: ConnectorTokenStore
  fetchImpl: FetchLike
}

async function tokenFor(deps: AdapterDependencies, connector: ConnectorKind): Promise<string> {
  const record = await deps.tokenStore.load(connector)
  if (record === null || record.accessToken.length === 0) {
    throw new RelayAdapterError(`the ${connector} connector has no stored authorization`)
  }
  return record.accessToken
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

/* ------------------------------------------------------------------ Gmail */

export function createGmailAdapter(deps: AdapterDependencies): EmailAdapter {
  return {
    async listMessages(query: RelayReadQuery): Promise<readonly RelayEmailMessage[]> {
      const token = await tokenFor(deps, 'gmail')
      if (query.messageId !== undefined && query.messageId !== null) {
        const message = await gmailMessage(deps, token, query.messageId)
        return message === null ? [] : [message]
      }
      const params = new URLSearchParams({ maxResults: String(query.limit) })
      if (query.query !== null && query.query.length > 0) params.set('q', query.query)
      const list = asRecord(await fetchJson(deps.fetchImpl, {
        url: `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params.toString()}`,
        method: 'GET',
        token,
        allowedHosts: GMAIL_HOSTS,
      }))
      const ids = Array.isArray(list.messages) ? list.messages : []
      const out: RelayEmailMessage[] = []
      for (const entry of ids.slice(0, query.limit)) {
        const id = asRecord(entry).id
        if (typeof id !== 'string') continue
        const message = await gmailMessage(deps, token, id)
        if (message !== null) out.push(message)
      }
      return out
    },
    async createDraft(draft: RelayEmailDraft): Promise<{ draftId: string }> {
      const token = await tokenFor(deps, 'gmail')
      const result = asRecord(await fetchJson(deps.fetchImpl, {
        url: 'https://gmail.googleapis.com/gmail/v1/users/me/drafts',
        method: 'POST',
        token,
        allowedHosts: GMAIL_HOSTS,
        body: { message: { raw: rawMessage(draft) } },
      }))
      const draftId = asRecord(result.draft).id
      return { draftId: typeof draftId === 'string' ? draftId : 'draft' }
    },
    async send(message: RelayEmailSend): Promise<{ messageId: string }> {
      const token = await tokenFor(deps, 'gmail')
      const result = asRecord(await fetchJson(deps.fetchImpl, {
        url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
        method: 'POST',
        token,
        allowedHosts: GMAIL_HOSTS,
        body: { raw: rawMessage(message) },
      }))
      const messageId = result.id
      return { messageId: typeof messageId === 'string' ? messageId : 'message' }
    },
  }
}

function rawMessage(draft: RelayEmailDraft): string {
  const to = draft.to.map((recipient) => recipient.address).join(', ')
  const cc = draft.cc.map((recipient) => recipient.address).join(', ')
  const lines = [`To: ${to}`, ...(cc.length > 0 ? [`Cc: ${cc}`] : []), `Subject: ${draft.subject}`, '', draft.body]
  return Buffer.from(lines.join('\r\n')).toString('base64url')
}

async function gmailMessage(deps: AdapterDependencies, token: string, id: string): Promise<RelayEmailMessage | null> {
  const data = asRecord(await fetchJson(deps.fetchImpl, {
    url: `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject`,
    method: 'GET',
    token,
    allowedHosts: GMAIL_HOSTS,
  }))
  if (typeof data.id !== 'string') return null
  const headerList = Array.isArray(asRecord(data.payload).headers) ? (asRecord(data.payload).headers as unknown[]) : []
  const header = (name: string): string => {
    for (const entry of headerList) {
      const record = asRecord(entry)
      if (typeof record.name === 'string' && record.name.toLowerCase() === name) {
        return typeof record.value === 'string' ? record.value : ''
      }
    }
    return ''
  }
  return {
    messageId: data.id,
    threadId: typeof data.threadId === 'string' ? data.threadId : null,
    from: header('from'),
    to: header('to') === '' ? [] : [header('to')],
    subject: header('subject'),
    snippet: typeof data.snippet === 'string' ? data.snippet : '',
    receivedAt: typeof data.internalDate === 'string' ? new Date(Number(data.internalDate)).toISOString() : new Date().toISOString(),
    hasAttachments: false,
    attachmentCount: 0,
  }
}

/* ------------------------------------------------------ Google Calendar */

export function createGoogleCalendarAdapter(deps: AdapterDependencies): CalendarAdapter {
  return {
    async listEvents(query: RelayReadQuery): Promise<readonly RelayCalendarEvent[]> {
      const token = await tokenFor(deps, 'google-calendar')
      const params = new URLSearchParams({ maxResults: String(query.limit), singleEvents: 'true', orderBy: 'startTime' })
      if (query.query !== null && query.query.length > 0) params.set('q', query.query)
      const data = asRecord(await fetchJson(deps.fetchImpl, {
        url: `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`,
        method: 'GET',
        token,
        allowedHosts: GOOGLE_HOSTS,
      }))
      const items = Array.isArray(data.items) ? data.items : []
      return items.slice(0, query.limit).map((item): RelayCalendarEvent => {
        const event = asRecord(item)
        return {
          eventId: typeof event.id === 'string' ? event.id : '',
          title: typeof event.summary === 'string' ? event.summary : '',
          startsAt: typeof asRecord(event.start).dateTime === 'string' ? asRecord(event.start).dateTime as string : '',
          endsAt: typeof asRecord(event.end).dateTime === 'string' ? asRecord(event.end).dateTime as string : '',
          location: typeof event.location === 'string' ? event.location : null,
          attendeeCount: Array.isArray(event.attendees) ? event.attendees.length : 0,
          organizer: typeof asRecord(event.organizer).email === 'string' ? asRecord(event.organizer).email as string : '',
        }
      })
    },
    async createEvent(input): Promise<{ eventId: string }> {
      const token = await tokenFor(deps, 'google-calendar')
      const data = asRecord(await fetchJson(deps.fetchImpl, {
        url: 'https://www.googleapis.com/calendar/v3/calendars/primary/events',
        method: 'POST',
        token,
        allowedHosts: GOOGLE_HOSTS,
        body: {
          summary: input.title,
          start: { dateTime: input.startsAt },
          end: { dateTime: input.endsAt },
          ...(input.location === null ? {} : { location: input.location }),
          ...(input.attendees.length === 0 ? {} : { attendees: input.attendees.map((email) => ({ email })) }),
        },
      }))
      return { eventId: typeof data.id === 'string' ? data.id : 'event' }
    },
    async updateEvent(input): Promise<{ eventId: string }> {
      const token = await tokenFor(deps, 'google-calendar')
      await fetchJson(deps.fetchImpl, {
        url: `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(input.eventId)}`,
        method: 'PATCH',
        token,
        allowedHosts: GOOGLE_HOSTS,
        body: {
          ...(input.title === null ? {} : { summary: input.title }),
          ...(input.startsAt === null ? {} : { start: { dateTime: input.startsAt } }),
          ...(input.endsAt === null ? {} : { end: { dateTime: input.endsAt } }),
          ...(input.location === undefined ? {} : { location: input.location }),
          ...(input.attendees === undefined ? {} : { attendees: input.attendees.map((email) => ({ email })) }),
        },
      })
      return { eventId: input.eventId }
    },
    async cancelEvent(eventId: string): Promise<{ eventId: string }> {
      const token = await tokenFor(deps, 'google-calendar')
      await fetchJson(deps.fetchImpl, {
        url: `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`,
        method: 'PATCH',
        token,
        allowedHosts: GOOGLE_HOSTS,
        body: { status: 'cancelled' },
      })
      return { eventId }
    },
  }
}

/* --------------------------------------------------------- Google Drive */

export function createGoogleDriveAdapter(deps: AdapterDependencies): DriveAdapter {
  return {
    async listFiles(query: RelayReadQuery): Promise<readonly RelayDriveFile[]> {
      const token = await tokenFor(deps, 'google-drive')
      if (query.messageId !== undefined && query.messageId !== null) {
        const data = asRecord(await fetchJson(deps.fetchImpl, {
          url: `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(query.messageId)}?fields=id,name,mimeType,modifiedTime,size,parents`,
          method: 'GET',
          token,
          allowedHosts: GOOGLE_HOSTS,
        }))
        return data.id === undefined ? [] : [driveFile(data)]
      }
      const params = new URLSearchParams({ pageSize: String(query.limit), fields: 'files(id,name,mimeType,modifiedTime,size,parents)' })
      if (query.query !== null && query.query.length > 0) params.set('q', `name contains '${query.query.replace(/'/g, '')}'`)
      const data = asRecord(await fetchJson(deps.fetchImpl, {
        url: `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
        method: 'GET',
        token,
        allowedHosts: GOOGLE_HOSTS,
      }))
      const files = Array.isArray(data.files) ? data.files : []
      return files.slice(0, query.limit).map((file) => driveFile(asRecord(file)))
    },
    async createFile(input: RelayDriveFileInput): Promise<{ fileId: string }> {
      const token = await tokenFor(deps, 'google-drive')
      const metadata = asRecord(await fetchJson(deps.fetchImpl, {
        url: 'https://www.googleapis.com/drive/v3/files?fields=id',
        method: 'POST',
        token,
        allowedHosts: GOOGLE_HOSTS,
        body: { name: input.name, mimeType: input.mimeType },
      }))
      const fileId = typeof metadata.id === 'string' ? metadata.id : null
      if (fileId === null) throw new RelayAdapterError('the Drive connector did not return a file id')
      return { fileId }
    },
  }
}

function driveFile(file: Record<string, unknown>): RelayDriveFile {
  return {
    fileId: typeof file.id === 'string' ? file.id : '',
    name: typeof file.name === 'string' ? file.name : '',
    mimeType: typeof file.mimeType === 'string' ? file.mimeType : '',
    modifiedAt: typeof file.modifiedTime === 'string' ? file.modifiedTime : '',
    sizeBytes: typeof file.size === 'string' ? Number(file.size) : null,
    parents: Array.isArray(file.parents) ? file.parents.filter((parent): parent is string => typeof parent === 'string') : [],
  }
}

/* --------------------------------------------------------------- GitHub */

export function createGitHubAdapter(deps: AdapterDependencies): GitHubAdapter {
  return {
    async listIssues(repo: RelayGitHubRepoRef, query: RelayReadQuery): Promise<readonly RelayGitHubIssue[]> {
      const token = await tokenFor(deps, 'github')
      const data = await fetchJson(deps.fetchImpl, {
        url: `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/issues?per_page=${query.limit}&state=all`,
        method: 'GET',
        token,
        allowedHosts: GITHUB_HOSTS,
      })
      const issues = Array.isArray(data) ? data : []
      return issues.slice(0, query.limit).map((item): RelayGitHubIssue => {
        const issue = asRecord(item)
        return {
          repo,
          number: typeof issue.number === 'number' ? issue.number : 0,
          title: typeof issue.title === 'string' ? issue.title : '',
          state: issue.state === 'closed' ? 'closed' : 'open',
          author: typeof asRecord(issue.user).login === 'string' ? asRecord(issue.user).login as string : '',
          updatedAt: typeof issue.updated_at === 'string' ? issue.updated_at : '',
        }
      })
    },
    async createIssue(input: RelayGitHubIssueInput): Promise<{ number: number }> {
      const token = await tokenFor(deps, 'github')
      const data = asRecord(await fetchJson(deps.fetchImpl, {
        url: `https://api.github.com/repos/${encodeURIComponent(input.repo.owner)}/${encodeURIComponent(input.repo.repo)}/issues`,
        method: 'POST',
        token,
        allowedHosts: GITHUB_HOSTS,
        body: { title: input.title, body: input.body },
      }))
      return { number: typeof data.number === 'number' ? data.number : 0 }
    },
    async createPr(input: RelayGitHubPrInput): Promise<{ number: number }> {
      const token = await tokenFor(deps, 'github')
      const data = asRecord(await fetchJson(deps.fetchImpl, {
        url: `https://api.github.com/repos/${encodeURIComponent(input.repo.owner)}/${encodeURIComponent(input.repo.repo)}/pulls`,
        method: 'POST',
        token,
        allowedHosts: GITHUB_HOSTS,
        body: { title: input.title, body: input.body, head: input.head, base: input.base },
      }))
      return { number: typeof data.number === 'number' ? data.number : 0 }
    },
  }
}

/* ------------------------------------------------------------- Telegram */

export function createTelegramAdapter(deps: AdapterDependencies): TelegramAdapter {
  return {
    async listMessages(_chatId: string, _query: RelayReadQuery): Promise<readonly RelayTelegramMessage[]> {
      // The Bot API exposes no chat-history endpoint. Telegram reads are
      // delivered as authenticated events by the host, so a pull read is
      // refused truthfully rather than faked with an empty list.
      throw new RelayAdapterError('the Telegram Bot API does not expose chat history; reads are delivered as authenticated events')
    },
    async sendMessage(input: RelayTelegramMessageInput): Promise<{ messageId: string }> {
      const token = await tokenFor(deps, 'telegram')
      const data = asRecord(await fetchJson(deps.fetchImpl, {
        url: `https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`,
        method: 'POST',
        token,
        allowedHosts: TELEGRAM_HOSTS,
        body: { chat_id: input.chatId, text: input.text },
      }))
      const result = asRecord(data.result)
      return { messageId: typeof result.message_id === 'number' ? String(result.message_id) : 'message' }
    },
  }
}

/**
 * Build the whole adapter set from the secure store and a fetch implementation.
 *
 * Every adapter is registered; whether it can act is decided by whether a token
 * exists, which is what makes a missing credential fail closed at the adapter
 * rather than at the call site.
 */
export function createBoundedAdapters(deps: AdapterDependencies): RelayAdapterSet {
  return {
    email: createGmailAdapter(deps),
    calendar: createGoogleCalendarAdapter(deps),
    drive: createGoogleDriveAdapter(deps),
    github: createGitHubAdapter(deps),
    telegram: createTelegramAdapter(deps),
  }
}
