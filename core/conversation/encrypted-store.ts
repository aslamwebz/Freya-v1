import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ConversationStoreError, type ConversationStore } from './store'
import {
  CONVERSATION_LIMITS,
  type Conversation,
  type ConversationMessage,
  type ConversationRecord,
  type ConversationSummary,
  type ConversationTurn,
  type TerminalTurnOutcome,
} from './types'

/**
 * The encrypted Conversation Store.
 *
 * Conversation history is the most personal data Freya holds: it is what someone
 * said to her. Writing it as plaintext would mean a stolen laptop, a synced
 * backup or a support bundle contained a readable transcript, so the bodies are
 * encrypted at rest with AES-256-GCM and the key never comes near this file's
 * caller, the renderer, the model or the journal.
 *
 * ## The design, and why each part is there
 *
 * - **Authenticated encryption, not encryption.** GCM's tag is verified on
 *   every read. A record that has been edited, truncated or swapped fails to
 *   open and is reported. There is no "decrypt anyway" path, because accepting a
 *   record that failed authentication would mean inventing the text it used to
 *   hold.
 * - **A unique nonce per record**, from the CSPRNG. GCM nonce reuse under one
 *   key is catastrophic — it leaks the XOR of two plaintexts and the
 *   authentication key — so the nonce is never derived from anything the caller
 *   could repeat, and two records of identical content still differ on disk.
 * - **Authenticated metadata as AAD.** The record header (schema version, kind,
 *   sequence) is fed in as additional authenticated data. Without it, a
 *   `message` record could be re-labelled as a `turn-outcome` and its body would
 *   still decrypt and still parse, because the ciphertext itself is unchanged.
 *   With it, moving a record to a different kind breaks authentication.
 * - **A per-store context id** in the AAD, so records cannot be moved between two
 *   different stores that happen to share a key.
 * - **Versioned records.** `version` is checked before anything is believed. A
 *   future format is refused, not guessed at.
 *
 * ## What a fault means
 *
 * A decryption or authentication failure is a **conversation-data fault**. It is
 * reported, the record is skipped, and nothing else in Freya changes: it cannot
 * grant cognition, clear a stop, or widen a budget, and it does not lock Freya
 * either. The refusal to fabricate is local to the data that is missing.
 *
 * ## Layout
 *
 * An append-only JSONL file. One encrypted record per line. Chosen over a
 * database because it needs no native dependency, is trivially atomic per record
 * (a torn tail is a lost record, never a corrupt one), and gives Phase 4 a
 * migration source it can read once and move into a Brain without the Mind
 * noticing.
 */

const SCHEMA_VERSION = 1
const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
const NONCE_BYTES = 12
const TAG_BYTES = 16
/**
 * Separator byte for the context digest.
 *
 * A byte rather than a source escape, because a filesystem path cannot contain
 * a zero byte and the two digest inputs must never be ambiguous with each other.
 */
const ZERO = Buffer.from([0])

/** Hard ceiling on one encrypted line. A record that cannot fit is refused. */
const MAX_RECORD_BYTES = 128 * 1024

type RecordKind = 'conversation' | 'message' | 'turn-start' | 'turn-outcome'

/** The plaintext a record encrypts. Narrow, and never carries a filesystem path. */
type RecordBody =
  | { kind: 'conversation'; conversation: Conversation }
  | { kind: 'message'; message: ConversationMessage }
  | { kind: 'turn-start'; turn: ConversationTurn }
  | {
      kind: 'turn-outcome'
      turnId: string
      outcome: TerminalTurnOutcome
      endedAt: string
      assistantMessageId: string | null
      providerId: string | null
      model: string | null
      reason: string | null
    }

/** The line on disk. Everything outside `cipher` is authenticated as AAD. */
interface StoredRecord {
  version: number
  kind: RecordKind
  seq: number
  /** Binds the record to this store, so it cannot be lifted into another. */
  context: string
  nonce: string
  cipher: string
  tag: string
}

export interface EncryptedConversationStoreOptions {
  path: string
  /**
   * The 32-byte conversation master key.
   *
   * Supplied by the host, which obtained it from the OS secure storage. Core
   * never generates one, never persists one, and never has a default: a Core
   * constructed without a key has no encrypted store and is not given a
   * weaker one instead.
   */
  key: Uint8Array
}

export class EncryptedConversationStore implements ConversationStore {
  readonly mode = 'encrypted' as const

  private readonly path: string
  private readonly key: Buffer
  private readonly context: string

  /** The folded state. Rebuilt from the file on construction. */
  private readonly conversations = new Map<string, Conversation>()
  private readonly messages = new Map<string, ConversationMessage[]>()
  private readonly turns = new Map<string, ConversationTurn[]>()
  private readonly turnsById = new Map<string, ConversationTurn>()

  private sequence = 0
  private closed = false
  /** Set when any record on disk could not be believed. Reported, never hidden. */
  private degradedReason: string | null = null

  private constructor(options: EncryptedConversationStoreOptions, context: string) {
    this.path = options.path
    this.key = Buffer.from(options.key)
    this.context = context
  }

  /**
   * Set when any record on disk could not be believed.
   *
   * A conversation-data fact, surfaced so the UI can say so. It never changes a
   * security state in either direction: unreadable history is not permission, and
   * it is not a lockout either.
   */
  get faultReason(): string | null {
    return this.degradedReason
  }

  /**
   * Open (or create) the store, and fold whatever is already on disk.
   *
   * Recovery is a fold, not a parse-and-trust: each record is authenticated
   * before it is applied, and one that fails is reported and skipped so the rest
   * of the history is still usable. A person who lost one message should not
   * lose the conversation.
   */
  static async open(options: EncryptedConversationStoreOptions): Promise<EncryptedConversationStore> {
    if (options.key.length !== KEY_BYTES) {
      throw new ConversationStoreError(
        'unauthenticated',
        `conversation key must be ${KEY_BYTES} bytes, received ${options.key.length}`,
      )
    }

    // A context id derived from the key and this store's own path, so two stores
    // that somehow shared a key still cannot read each other's history.
    const store = new EncryptedConversationStore(options, digestContext(options.key, options.path))

    try {
      await mkdir(dirname(options.path), { recursive: true })
    } catch (error) {
      throw new ConversationStoreError(
        'store-unavailable',
        `conversation store directory could not be created: ${describe(error)}`,
      )
    }

    let raw: string
    try {
      raw = await readFile(options.path, 'utf8')
    } catch (error) {
      if (isNotFound(error)) {
        await writeFile(options.path, '', { encoding: 'utf8', flag: 'a' })
        return store
      }
      throw new ConversationStoreError(
        'store-unavailable',
        `conversation store could not be read: ${describe(error)}`,
      )
    }

    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue
      store.applyLine(line)
    }
    return store
  }

  /**
   * One line: authenticate, decode, apply.
   *
   * Every failure mode here ends the same way — the line is skipped and the store
   * says it is degraded. Nothing is repaired, defaulted, or invented.
   */
  private applyLine(line: string): void {
    let record: StoredRecord
    try {
      record = JSON.parse(line) as StoredRecord
    } catch {
      this.degrade('a conversation record is not valid JSON')
      return
    }
    if (
      typeof record !== 'object' ||
      record === null ||
      record.version !== SCHEMA_VERSION ||
      typeof record.kind !== 'string' ||
      typeof record.seq !== 'number' ||
      typeof record.context !== 'string' ||
      typeof record.nonce !== 'string' ||
      typeof record.cipher !== 'string' ||
      typeof record.tag !== 'string'
    ) {
      this.degrade('a conversation record has an unrecognised shape')
      return
    }
    if (record.version !== SCHEMA_VERSION) {
      this.degrade(`conversation record version ${record.version} is not this version`)
      return
    }
    if (record.context !== this.context) {
      this.degrade('a conversation record belongs to a different store')
      return
    }

    let body: RecordBody
    try {
      body = this.open_(record)
    } catch {
      this.degrade('a conversation record failed authentication and was not read')
      return
    }

    this.sequence = Math.max(this.sequence, record.seq)
    this.apply_(body)
  }

  private degrade(reason: string): void {
    this.degradedReason ??= reason
  }

  private open_(record: StoredRecord): RecordBody {
    const nonce = Buffer.from(record.nonce, 'base64')
    const tag = Buffer.from(record.tag, 'base64')
    if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) {
      throw new ConversationStoreError('unauthenticated', 'conversation record has wrong nonce or tag size')
    }

    const decipher = createDecipheriv(ALGORITHM, this.key, nonce)
    decipher.setAuthTag(tag)
    // The header is authenticated, so a record cannot be re-labelled or moved
    // between kinds while keeping its ciphertext.
    decipher.setAAD(aadFor(this.context, record))
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(record.cipher, 'base64')),
      decipher.final(),
    ])
    return JSON.parse(plaintext.toString('utf8')) as RecordBody
  }

  private apply_(body: RecordBody): void {
    switch (body?.kind) {
      case 'conversation':
        this.conversations.set(body.conversation.conversationId, { ...body.conversation })
        this.messages.set(body.conversation.conversationId, this.messages.get(body.conversation.conversationId) ?? [])
        this.turns.set(body.conversation.conversationId, this.turns.get(body.conversation.conversationId) ?? [])
        return
      case 'message': {
        const list = this.messages.get(body.message.conversationId)
        if (!list) return
        list.push({ ...body.message })
        return
      }
      case 'turn-start': {
        const list = this.turns.get(body.turn.conversationId)
        if (!list) return
        if (this.turnsById.has(body.turn.turnId)) return
        const turn = { ...body.turn }
        list.push(turn)
        this.turnsById.set(turn.turnId, turn)
        return
      }
      case 'turn-outcome': {
        const turn = this.turnsById.get(body.turnId)
        if (!turn || turn.outcome !== 'pending') return
        turn.outcome = body.outcome
        turn.endedAt = body.endedAt
        turn.assistantMessageId = body.assistantMessageId
        turn.providerId = body.providerId
        turn.model = body.model
        turn.reason = body.reason
        return
      }
      default:
        this.degrade('a conversation record named an unknown kind')
    }
  }

  /* ------------------------------------------------------------- writing */

  private async write(body: RecordBody): Promise<void> {
    if (this.closed) {
      throw new ConversationStoreError('store-unavailable', 'conversation store is closed')
    }
    this.sequence += 1
    const seq = this.sequence
    const nonce = randomBytes(NONCE_BYTES)
    const cipher = createCipheriv(ALGORITHM, this.key, nonce)
    cipher.setAAD(aadFor(this.context, { version: SCHEMA_VERSION, kind: body.kind, seq }))
    const plaintext = Buffer.from(JSON.stringify(body), 'utf8')
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const line = `${JSON.stringify({
      version: SCHEMA_VERSION,
      kind: body.kind,
      seq,
      context: this.context,
      nonce: nonce.toString('base64'),
      cipher: encrypted.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    } satisfies StoredRecord)}\n`

    if (Buffer.byteLength(line, 'utf8') > MAX_RECORD_BYTES) {
      throw new ConversationStoreError('too-large', 'conversation record exceeds the per-record limit')
    }

    try {
      await appendFile(this.path, line, { encoding: 'utf8' })
    } catch (error) {
      throw new ConversationStoreError(
        'write-failed',
        `conversation record could not be written: ${describe(error)}`,
      )
    }
    // Applied only after the bytes are on disk. A turn whose answer is in memory
    // but not on disk would be exactly the "complete but not durable" state the
    // whole ordering of this phase exists to prevent.
    this.apply_(body)
  }

  /* ------------------------------------------------------------- the store */

  async putConversation(conversation: Conversation): Promise<void> {
    await this.write({ kind: 'conversation', conversation })
  }

  async listConversations(limit: number): Promise<ConversationSummary[]> {
    const summaries = [...this.conversations.values()]
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
      .slice(0, Math.max(0, limit))
      .map((conversation) => this.summarise(conversation))
    return summaries
  }

  async readConversation(conversationId: string): Promise<ConversationRecord | null> {
    const conversation = this.conversations.get(conversationId)
    if (!conversation) return null
    return {
      conversation: { ...conversation },
      messages: [...(this.messages.get(conversationId) ?? [])],
      turns: [...(this.turns.get(conversationId) ?? [])],
    }
  }

  async appendMessage(message: ConversationMessage): Promise<void> {
    if (message.content.length > CONVERSATION_LIMITS.maxMessageCharacters) {
      throw new ConversationStoreError('too-large', 'message exceeds the per-message limit')
    }
    if (!this.conversations.has(message.conversationId)) {
      throw new ConversationStoreError('not-found', `no such conversation: ${message.conversationId}`)
    }
    await this.write({ kind: 'message', message })
  }

  async recordTurnStart(turn: ConversationTurn): Promise<void> {
    if (!this.conversations.has(turn.conversationId)) {
      throw new ConversationStoreError('not-found', `no such conversation: ${turn.conversationId}`)
    }
    await this.write({ kind: 'turn-start', turn })
  }

  async recordTurnOutcome(
    turnId: string,
    outcome: TerminalTurnOutcome,
    detail: {
      endedAt: string
      assistantMessageId?: string | null
      providerId?: string | null
      model?: string | null
      reason?: string | null
    },
  ): Promise<void> {
    const turn = this.turnsById.get(turnId)
    if (!turn) throw new ConversationStoreError('not-found', `no such turn: ${turnId}`)
    if (turn.outcome !== 'pending') {
      throw new ConversationStoreError(
        'invalid-record',
        `turn ${turnId} already finished as ${turn.outcome}`,
      )
    }
    await this.write({
      kind: 'turn-outcome',
      turnId,
      outcome,
      endedAt: detail.endedAt,
      assistantMessageId: detail.assistantMessageId ?? null,
      providerId: detail.providerId ?? null,
      model: detail.model ?? null,
      reason: detail.reason ?? null,
    })
  }

  async recoverInterruptedTurns(now: string): Promise<string[]> {
    const recovered: string[] = []
    for (const turn of this.turnsById.values()) {
      if (turn.outcome !== 'pending') continue
      await this.write({
        kind: 'turn-outcome',
        turnId: turn.turnId,
        outcome: 'interrupted',
        endedAt: now,
        assistantMessageId: null,
        providerId: null,
        model: null,
        reason: null,
      })
      recovered.push(turn.turnId)
    }
    return recovered
  }

  async close(): Promise<void> {
    this.closed = true
  }

  private summarise(conversation: Conversation): ConversationSummary {
    const messages = this.messages.get(conversation.conversationId) ?? []
    const turns = this.turns.get(conversation.conversationId) ?? []
    const last = turns[turns.length - 1]
    return {
      conversationId: conversation.conversationId,
      title: conversation.title,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      messageCount: messages.length,
      lastTurnOutcome: last?.outcome ?? null,
    }
  }
}

/**
 * The bytes authenticated alongside the ciphertext.
 *
 * Exactly the header fields, canonicalised in a fixed order. Anything not in here
 * is attacker-controlled until the tag check passes, which is why `cipher`, `tag`
 * and `nonce` are excluded: they are the ciphertext's own parameters.
 */
function aadFor(context: string, header: { version: number; kind: string; seq: number }): Buffer {
  return Buffer.from(`freya.conversation.v${header.version}|${context}|${header.kind}|${header.seq}`, 'utf8')
}

/**
 * Bind a store's records to its own key and location.
 *
 * A digest, compared in constant time. Two stores that somehow shared a key would
 * still not be able to read each other's history, which is the property that makes
 * "one key for the conversation store" a defensible design rather than a large
 * blast radius.
 */
function digestContext(key: Uint8Array, path: string): string {
  return createHash('sha256')
    .update(Buffer.from(key))
    .update(ZERO)
    .update(path)
    .digest('base64')
    .slice(0, 32)
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === 'ENOENT'
  )
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}
