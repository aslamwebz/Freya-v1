/**
 * RELAY ADAPTERS — the narrow ports between Core and a connector.
 *
 * An adapter is the only place a credential can exist. Core hands it a
 * validated, normalized request and receives a bounded result; it can never
 * ask the adapter for a token, a raw account handle or an arbitrary method,
 * because the port has no such method. A future adapter that wanted to leak
 * a credential would have to do so through a result field — and every result
 * field is a bounded, validated shape the projection and the journal have
 * already agreed to carry.
 *
 * ## The fakes
 *
 * `FakeEmailAdapter`, `FakeCalendarAdapter`, `FakeGitHubAdapter` and
 * `FakeExternalAdapter` are deterministic and offline. They hold no
 * credentials, make no network calls and can be scripted to fail — including
 * failing transiently a bounded number of times, which is the only way the
 * retry policy can be tested without a real provider. Every test in this
 * repository uses them; a test that reached for a real account would be a
 * test that could not run in CI.
 */

import type {
  RelayCalendarEvent,
  RelayDriveFile,
  RelayDriveFileInput,
  RelayEmailDraft,
  RelayEmailMessage,
  RelayEmailSend,
  RelayExternalInvoke,
  RelayGitHubIssue,
  RelayGitHubIssueInput,
  RelayGitHubPrInput,
  RelayGitHubRepoRef,
  RelayReadQuery,
  RelayTelegramMessage,
  RelayTelegramMessageInput,
} from './types'

/**
 * An adapter failure that is worth one bounded retry.
 *
 * A transient failure is a property of the *transport* — a timeout, a
 * provider rate limit — not of the request. The engine retries these up to
 * `RELAY_LIMITS.maxRetries` and no further. Every other failure is terminal:
 * retrying a validation error or a permission denial is how a retry storm
 * starts.
 */
export class RelayTransientError extends Error {
  constructor(message = 'the connector reported a transient failure') {
    super(message)
    this.name = 'RelayTransientError'
  }
}

/** An adapter failure that is the request's fault. Never retried. */
export class RelayAdapterError extends Error {
  constructor(message = 'the connector refused the request') {
    super(message)
    this.name = 'RelayAdapterError'
  }
}

/** The email port. Three methods, one per email action. */
export interface EmailAdapter {
  listMessages(query: RelayReadQuery): Promise<readonly RelayEmailMessage[]>
  createDraft(draft: RelayEmailDraft): Promise<{ draftId: string }>
  send(message: RelayEmailSend): Promise<{ messageId: string }>
}

/** The calendar port. Four methods, one per calendar action. */
export interface CalendarAdapter {
  listEvents(query: RelayReadQuery): Promise<readonly RelayCalendarEvent[]>
  createEvent(input: {
    title: string
    startsAt: string
    endsAt: string
    location: string | null
    attendees: readonly string[]
  }): Promise<{ eventId: string }>
  updateEvent(input: {
    eventId: string
    title: string | null
    startsAt: string | null
    endsAt: string | null
    location: string | null | undefined
    attendees: readonly string[] | undefined
  }): Promise<{ eventId: string }>
  cancelEvent(eventId: string): Promise<{ eventId: string }>
}

/** The GitHub port. Three methods: read, issue create, PR create. */
export interface GitHubAdapter {
  listIssues(repo: RelayGitHubRepoRef, query: RelayReadQuery): Promise<readonly RelayGitHubIssue[]>
  createIssue(input: RelayGitHubIssueInput): Promise<{ number: number }>
  createPr(input: RelayGitHubPrInput): Promise<{ number: number }>
}

/** The external port. One method, bounded by the caller's validated input. */
export interface ExternalAdapter {
  invoke(input: RelayExternalInvoke): Promise<{ data: unknown }>
}

/**
 * The Google Drive port. Two methods: bounded read, and create.
 *
 * `createFile` receives bounded content once, exactly as the email port does.
 * There is no recursive sync, no folder walk and no delete — the vocabulary
 * does not contain them, so they cannot be smuggled.
 */
export interface DriveAdapter {
  listFiles(query: RelayReadQuery): Promise<readonly RelayDriveFile[]>
  createFile(input: RelayDriveFileInput): Promise<{ fileId: string }>
}

/**
 * The Telegram port. Two methods: read configured chats, send to one.
 *
 * `listMessages` takes an explicit, allowlisted `chatId`; there is no chat or
 * contact enumeration in the port, because enumeration is how a bot turns into
 * a directory of everyone its owner knows.
 */
export interface TelegramAdapter {
  listMessages(chatId: string, query: RelayReadQuery): Promise<readonly RelayTelegramMessage[]>
  sendMessage(input: RelayTelegramMessageInput): Promise<{ messageId: string }>
}

/** The whole adapter set the host can supply. Any part may be absent. */
export interface RelayAdapterSet {
  readonly email?: EmailAdapter
  readonly calendar?: CalendarAdapter
  readonly github?: GitHubAdapter
  readonly drive?: DriveAdapter
  readonly telegram?: TelegramAdapter
  /** Named external connectors. Registering one widens nothing by itself. */
  readonly external?: Readonly<Record<string, ExternalAdapter>>
}

/* ------------------------------------------------------------------ fakes */

/**
 * A deterministic email adapter.
 *
 * Holds a script of messages and a failure script. `failTimes` makes the next
 * N adapter calls throw a transient error — the only way to exercise the
 * retry policy deterministically. Everything it returns is bounded and fake.
 */
export class FakeEmailAdapter implements EmailAdapter {
  private sent: RelayEmailSend[] = []
  private drafts: RelayEmailDraft[] = []
  private remainingTransientFailures = 0

  constructor(
    private readonly messages: readonly RelayEmailMessage[] = [],
    options: { failTimes?: number } = {},
  ) {
    this.remainingTransientFailures = options.failTimes ?? 0
  }

  private maybeFail(): void {
    if (this.remainingTransientFailures > 0) {
      this.remainingTransientFailures -= 1
      throw new RelayTransientError('the fake email connector timed out')
    }
  }

  async listMessages(query: RelayReadQuery): Promise<readonly RelayEmailMessage[]> {
    this.maybeFail()
    if (query.messageId !== undefined && query.messageId !== null) {
      return this.messages.filter((message) => message.messageId === query.messageId).slice(0, 1)
    }
    const needle = query.query === null ? null : query.query.toLowerCase()
    const filtered = needle === null
      ? [...this.messages]
      : this.messages.filter(
          (message) =>
            message.subject.toLowerCase().includes(needle) ||
            message.from.toLowerCase().includes(needle),
        )
    return filtered.slice(0, query.limit)
  }

  async createDraft(draft: RelayEmailDraft): Promise<{ draftId: string }> {
    this.maybeFail()
    this.drafts.push(draft)
    return { draftId: `draft-${this.drafts.length}` }
  }

  async send(message: RelayEmailSend): Promise<{ messageId: string }> {
    this.maybeFail()
    this.sent.push(message)
    return { messageId: `msg-${this.sent.length}` }
  }

  /** Test seam: what the adapter actually received. */
  get sentMessages(): readonly RelayEmailSend[] {
    return this.sent
  }

  get draftList(): readonly RelayEmailDraft[] {
    return this.drafts
  }
}

/** A deterministic calendar adapter. */
export class FakeCalendarAdapter implements CalendarAdapter {
  private events: RelayCalendarEvent[] = []
  private remainingTransientFailures = 0

  constructor(
    initial: readonly RelayCalendarEvent[] = [],
    options: { failTimes?: number } = {},
  ) {
    this.events = [...initial]
    this.remainingTransientFailures = options.failTimes ?? 0
  }

  private maybeFail(): void {
    if (this.remainingTransientFailures > 0) {
      this.remainingTransientFailures -= 1
      throw new RelayTransientError('the fake calendar connector timed out')
    }
  }

  async listEvents(query: RelayReadQuery): Promise<readonly RelayCalendarEvent[]> {
    this.maybeFail()
    const needle = query.query === null ? null : query.query.toLowerCase()
    const filtered = needle === null
      ? [...this.events]
      : this.events.filter((event) => event.title.toLowerCase().includes(needle))
    return filtered.slice(0, query.limit)
  }

  async createEvent(input: {
    title: string
    startsAt: string
    endsAt: string
    location: string | null
    attendees: readonly string[]
  }): Promise<{ eventId: string }> {
    this.maybeFail()
    const eventId = `evt-${this.events.length + 1}`
    this.events.push({
      eventId,
      title: input.title,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      location: input.location,
      attendeeCount: input.attendees.length,
      organizer: 'owner',
    })
    return { eventId }
  }

  async updateEvent(input: {
    eventId: string
    title: string | null
    startsAt: string | null
    endsAt: string | null
    location: string | null | undefined
    attendees: readonly string[] | undefined
  }): Promise<{ eventId: string }> {
    this.maybeFail()
    const index = this.events.findIndex((event) => event.eventId === input.eventId)
    if (index < 0) throw new RelayAdapterError('no such event')
    const existing = this.events[index]
    if (existing === undefined) throw new RelayAdapterError('no such event')
    this.events[index] = {
      ...existing,
      title: input.title ?? existing.title,
      startsAt: input.startsAt ?? existing.startsAt,
      endsAt: input.endsAt ?? existing.endsAt,
      location: input.location === undefined ? existing.location : input.location,
      attendeeCount: input.attendees === undefined ? existing.attendeeCount : input.attendees.length,
    }
    return { eventId: input.eventId }
  }

  async cancelEvent(eventId: string): Promise<{ eventId: string }> {
    this.maybeFail()
    const index = this.events.findIndex((event) => event.eventId === eventId)
    if (index < 0) throw new RelayAdapterError('no such event')
    this.events.splice(index, 1)
    return { eventId }
  }

  /** Test seam: the events the adapter holds. */
  get currentEvents(): readonly RelayCalendarEvent[] {
    return this.events
  }
}

/** A deterministic GitHub adapter. */
export class FakeGitHubAdapter implements GitHubAdapter {
  private issues: RelayGitHubIssue[] = []
  private pullRequests: { repo: RelayGitHubRepoRef; number: number; title: string }[] = []
  private remainingTransientFailures = 0

  constructor(
    initialIssues: readonly RelayGitHubIssue[] = [],
    options: { failTimes?: number } = {},
  ) {
    this.issues = [...initialIssues]
    this.remainingTransientFailures = options.failTimes ?? 0
  }

  private maybeFail(): void {
    if (this.remainingTransientFailures > 0) {
      this.remainingTransientFailures -= 1
      throw new RelayTransientError('the fake GitHub connector timed out')
    }
  }

  async listIssues(repo: RelayGitHubRepoRef, query: RelayReadQuery): Promise<readonly RelayGitHubIssue[]> {
    this.maybeFail()
    const filtered = this.issues.filter(
      (issue) => issue.repo.owner === repo.owner && issue.repo.repo === repo.repo,
    )
    return filtered.slice(0, query.limit)
  }

  async createIssue(input: RelayGitHubIssueInput): Promise<{ number: number }> {
    this.maybeFail()
    const number = this.issues.length + 1
    this.issues.push({
      repo: input.repo,
      number,
      title: input.title,
      state: 'open',
      author: 'owner',
      updatedAt: new Date().toISOString(),
    })
    return { number }
  }

  async createPr(input: RelayGitHubPrInput): Promise<{ number: number }> {
    this.maybeFail()
    const number = this.pullRequests.length + 1
    this.pullRequests.push({ repo: input.repo, number, title: input.title })
    return { number }
  }

  /** Test seam: what the adapter holds. */
  get currentIssues(): readonly RelayGitHubIssue[] {
    return this.issues
  }

  get currentPullRequests(): readonly { repo: RelayGitHubRepoRef; number: number; title: string }[] {
    return this.pullRequests
  }
}

/** A deterministic external adapter. */
export class FakeExternalAdapter implements ExternalAdapter {
  private remainingTransientFailures = 0
  private readonly invocations: RelayExternalInvoke[] = []

  constructor(options: { failTimes?: number } = {}) {
    this.remainingTransientFailures = options.failTimes ?? 0
  }

  async invoke(input: RelayExternalInvoke): Promise<{ data: unknown }> {
    if (this.remainingTransientFailures > 0) {
      this.remainingTransientFailures -= 1
      throw new RelayTransientError('the fake external connector timed out')
    }
    this.invocations.push(input)
    return { data: { echoed: input.operation, params: input.params.length } }
  }

  /** Test seam: the invocations the adapter received. */
  get received(): readonly RelayExternalInvoke[] {
    return this.invocations
  }
}

/** A deterministic Google Drive adapter. */
export class FakeDriveAdapter implements DriveAdapter {
  private files: RelayDriveFile[] = []
  private readonly created: RelayDriveFileInput[] = []
  private remainingTransientFailures = 0

  constructor(initial: readonly RelayDriveFile[] = [], options: { failTimes?: number } = {}) {
    this.files = [...initial]
    this.remainingTransientFailures = options.failTimes ?? 0
  }

  private maybeFail(): void {
    if (this.remainingTransientFailures > 0) {
      this.remainingTransientFailures -= 1
      throw new RelayTransientError('the fake Drive connector timed out')
    }
  }

  async listFiles(query: RelayReadQuery): Promise<readonly RelayDriveFile[]> {
    this.maybeFail()
    if (query.messageId !== undefined && query.messageId !== null) {
      return this.files.filter((file) => file.fileId === query.messageId).slice(0, 1)
    }
    const needle = query.query === null ? null : query.query.toLowerCase()
    const filtered = needle === null
      ? [...this.files]
      : this.files.filter((file) => file.name.toLowerCase().includes(needle))
    return filtered.slice(0, query.limit)
  }

  async createFile(input: RelayDriveFileInput): Promise<{ fileId: string }> {
    this.maybeFail()
    const fileId = `file-${this.files.length + 1}`
    this.files.push({
      fileId,
      name: input.name,
      mimeType: input.mimeType,
      modifiedAt: new Date().toISOString(),
      sizeBytes: input.content.length,
      parents: [],
    })
    this.created.push(input)
    return { fileId }
  }

  /** Test seam: what the adapter holds. */
  get currentFiles(): readonly RelayDriveFile[] {
    return this.files
  }

  get createdFiles(): readonly RelayDriveFileInput[] {
    return this.created
  }
}

/** A deterministic Telegram adapter. */
export class FakeTelegramAdapter implements TelegramAdapter {
  private messages: RelayTelegramMessage[] = []
  private readonly sent: RelayTelegramMessageInput[] = []
  private remainingTransientFailures = 0

  constructor(initial: readonly RelayTelegramMessage[] = [], options: { failTimes?: number } = {}) {
    this.messages = [...initial]
    this.remainingTransientFailures = options.failTimes ?? 0
  }

  private maybeFail(): void {
    if (this.remainingTransientFailures > 0) {
      this.remainingTransientFailures -= 1
      throw new RelayTransientError('the fake Telegram connector timed out')
    }
  }

  async listMessages(chatId: string, query: RelayReadQuery): Promise<readonly RelayTelegramMessage[]> {
    this.maybeFail()
    const needle = query.query === null ? null : query.query.toLowerCase()
    const filtered = this.messages.filter(
      (message) => message.chatId === chatId && (needle === null || message.text.toLowerCase().includes(needle)),
    )
    return filtered.slice(0, query.limit)
  }

  async sendMessage(input: RelayTelegramMessageInput): Promise<{ messageId: string }> {
    this.maybeFail()
    const messageId = `tg-${this.messages.length + 1}`
    this.messages.push({
      messageId,
      chatId: input.chatId,
      from: 'owner',
      text: input.text,
      sentAt: new Date().toISOString(),
    })
    this.sent.push(input)
    return { messageId }
  }

  /** Test seam: what the adapter holds. */
  get currentMessages(): readonly RelayTelegramMessage[] {
    return this.messages
  }

  get sentMessages(): readonly RelayTelegramMessageInput[] {
    return this.sent
  }
}
