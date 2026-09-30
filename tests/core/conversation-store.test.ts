// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDecipheriv } from 'node:crypto'
import { EncryptedConversationStore } from '../../core/conversation/encrypted-store'
import { MemoryConversationStore } from '../../core/conversation/memory-store'
import { ConversationStoreError, type ConversationStore } from '../../core/conversation/store'
import { deriveConversationTitle, type Conversation, type ConversationMessage } from '../../core/conversation/types'
import { testConversationKey } from './testKey'

/**
 * Conversation storage.
 *
 * The property under test is narrow and absolute: **what someone said to Freya is
 * never on disk in the clear.** Everything else here — nonces, authentication,
 * recovery, tamper detection — exists to make that true in the presence of
 * something hostile rather than merely absent.
 *
 * The key is a deterministic test key. Its value is never printed and never
 * asserted on, only used, and nothing outside tests imports it.
 */

let dir = ''
const key = testConversationKey()

const SECRET_USER = 'my bank password is hunter2 and my github token is ghp_abcdef'
const SECRET_ASSISTANT = 'you mentioned ghp_abcdef earlier; rotate it'

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-convstore-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function openStore(name = 'conversations.enc', withKey: Uint8Array = key): Promise<EncryptedConversationStore> {
  return EncryptedConversationStore.open({ path: join(dir, name), key: withKey })
}

function conversation(id = 'c1'): Conversation {
  return {
    conversationId: id,
    title: 'a private conversation',
    createdAt: '2026-03-01T12:00:00.000Z',
    updatedAt: '2026-03-01T12:00:00.000Z',
  }
}

function message(id: string, role: 'user' | 'assistant', content: string, turnId = 't1'): ConversationMessage {
  return {
    messageId: id,
    conversationId: 'c1',
    role,
    content,
    createdAt: '2026-03-01T12:00:01.000Z',
    turnId,
  }
}

async function seed(
  store: ConversationStore,
  userText = SECRET_USER,
  assistantText = SECRET_ASSISTANT,
): Promise<void> {
  await store.putConversation(conversation())
  await store.appendMessage(message('m1', 'user', userText))
  await store.recordTurnStart({
    turnId: 't1',
    conversationId: 'c1',
    userMessageId: 'm1',
    assistantMessageId: null,
    outcome: 'pending',
    startedAt: '2026-03-01T12:00:01.000Z',
    endedAt: null,
    requestId: 't1',
    providerId: null,
    model: null,
    reason: null,
  })
  if (assistantText !== '') {
    await store.appendMessage(message('m2', 'assistant', assistantText))
    await store.recordTurnOutcome('t1', 'completed', {
      endedAt: '2026-03-01T12:00:02.000Z',
      assistantMessageId: 'm2',
    })
  }
}

describe('encrypted round trip', () => {
  it('reads back exactly what was written', async () => {
    const store = await openStore()
    await seed(store)

    const record = await store.readConversation('c1')
    expect(record?.messages.map((m) => m.content)).toEqual([SECRET_USER, SECRET_ASSISTANT])
    expect(record?.turns[0]?.outcome).toBe('completed')
    expect(store.mode).toBe('encrypted')
    expect(store.faultReason).toBeNull()
  })

  it('survives a restart', async () => {
    const path = join(dir, 'restart.enc')
    const first = await EncryptedConversationStore.open({ path, key })
    await seed(first)
    await first.close()

    const second = await EncryptedConversationStore.open({ path, key })
    const record = await second.readConversation('c1')
    expect(record?.messages).toHaveLength(2)
    expect((await second.listConversations(10)).map((s) => s.title)).toEqual(['a private conversation'])
  })
})

describe('nothing readable reaches the disk', () => {
  it('contains neither the user message nor the answer', async () => {
    const path = join(dir, 'private.enc')
    const store = await EncryptedConversationStore.open({ path, key })
    await seed(store)
    await store.close()

    const bytes = await readFile(path, 'utf8')

    // The whole point. A stolen laptop, a synced backup or a support bundle must
    // not contain a readable transcript.
    expect(bytes).not.toContain(SECRET_USER)
    expect(bytes).not.toContain('hunter2')
    expect(bytes).not.toContain('ghp_abcdef')
    expect(bytes).not.toContain(SECRET_ASSISTANT)
    expect(bytes).not.toContain('a private conversation')
    // Not even a fragment of a word, because the records are opaque.
    expect(bytes).not.toMatch(/bank password/)
  })

  it('never writes the key, in any form', async () => {
    const path = join(dir, 'nokey.enc')
    const store = await EncryptedConversationStore.open({ path, key })
    await seed(store)
    await store.close()

    const bytes = await readFile(path, 'utf8')
    expect(bytes).not.toContain(Buffer.from(key).toString('base64'))
    expect(bytes).not.toContain(Buffer.from(key).toString('hex'))
  })
})

describe('authenticated encryption', () => {
  it('refuses the history under the wrong key, without inventing it', async () => {
    const path = join(dir, 'wrongkey.enc')
    const store = await EncryptedConversationStore.open({ path, key })
    await seed(store)
    await store.close()

    // A different key must produce *nothing*, not a plausible transcript. This is
    // the difference between authenticated encryption and a checksum.
    const wrong = await EncryptedConversationStore.open({ path, key: testConversationKey('a different key') })
    // Nothing at all comes back. Not a partial transcript, not a placeholder.
    expect(await wrong.readConversation('c1')).toBeNull()
    expect(await wrong.listConversations(10)).toEqual([])
    // And it says so, rather than pretending the store is healthy.
    //
    // The reason is "different store" rather than "authentication" because the
    // store's context id is itself derived from the key: a wrong key names a
    // different store, and is caught before any record is even decrypted. The
    // authentication path itself is exercised by the tampering tests below, which
    // keep the context and break the ciphertext.
    expect(wrong.faultReason).toMatch(/different store|authentication/i)
  })

  it('rejects a tampered ciphertext rather than decrypting it', async () => {
    const path = join(dir, 'tampered.enc')
    const store = await EncryptedConversationStore.open({ path, key })
    await seed(store)
    await store.close()

    const lines = (await readFile(path, 'utf8')).split('\n').filter((l) => l.trim().length > 0)
    // Flip one byte of one record's ciphertext, the way an edit to a file would.
    const target = lines.findIndex((l) => l.includes('"kind":"message"'))
    expect(target).toBeGreaterThanOrEqual(0)
    const record = JSON.parse(lines[target] as string) as { cipher: string }
    const flipped = Buffer.from(record.cipher, 'base64')
    flipped[0] = (flipped[0] ?? 0) ^ 0xff
    lines[target] = JSON.stringify({ ...record, cipher: flipped.toString('base64') })
    await writeFile(path, lines.join('\n') + '\n', 'utf8')

    const reopened = await EncryptedConversationStore.open({ path, key })
    // The tampered message is gone rather than corrupted into something plausible.
    const record2 = await reopened.readConversation('c1')
    const contents = (record2?.messages ?? []).map((m) => m.content)
    expect(contents).not.toContain(SECRET_USER)
    expect(reopened.faultReason).toMatch(/authentication/i)
  })

  it('rejects a record whose kind was swapped, because the header is authenticated', async () => {
    const path = join(dir, 'relabelled.enc')
    const store = await EncryptedConversationStore.open({ path, key })
    await seed(store)
    await store.close()

    const lines = (await readFile(path, 'utf8')).split('\n').filter((l) => l.trim().length > 0)
    const target = lines.findIndex((l) => l.includes('"kind":"message"'))
    const record = JSON.parse(lines[target] as string) as Record<string, unknown>

    // The ciphertext is untouched, so without AAD this would decrypt and parse
    // perfectly while claiming to be something else. The kind is authenticated.
    lines[target] = JSON.stringify({ ...record, kind: 'turn-start' })
    await writeFile(path, lines.join('\n') + '\n', 'utf8')

    const reopened = await EncryptedConversationStore.open({ path, key })
    expect(reopened.faultReason).toMatch(/authentication/i)
    const record2 = await reopened.readConversation('c1')
    // The relabelled record was rejected, so it is neither a message nor a turn.
    // The real turn record is still there, which is the point: the forged one did
    // not become a second turn, and the message did not vanish into one.
    expect(record2?.turns).toHaveLength(1)
    expect(record2?.messages).toHaveLength(1)
    expect(record2?.messages[0]?.content).toBe(SECRET_ASSISTANT)
  })

  it('rejects a duplicated authenticated record instead of replaying it twice', async () => {
    const path = join(dir, 'duplicate.enc')
    const store = await EncryptedConversationStore.open({ path, key })
    await seed(store)
    await store.close()

    const lines = (await readFile(path, 'utf8')).split('\n').filter((l) => l.trim().length > 0)
    // Duplicate a genuine, correctly authenticated user-message record. AEAD by
    // itself cannot detect replay because the copied line is still authentic.
    lines.push(lines[1] as string)
    await writeFile(path, lines.join('\n') + '\n', 'utf8')

    const reopened = await EncryptedConversationStore.open({ path, key })
    expect(reopened.faultReason).toMatch(/sequence|out of order/i)
    const record = await reopened.readConversation('c1')
    expect(record?.messages.map((m) => m.content)).toEqual([SECRET_USER, SECRET_ASSISTANT])
  })

  it('detects reordered authenticated records instead of accepting a new history', async () => {
    const path = join(dir, 'reordered.enc')
    const store = await EncryptedConversationStore.open({ path, key })
    await seed(store)
    await store.close()

    const lines = (await readFile(path, 'utf8')).split('\n').filter((l) => l.trim().length > 0)
    ;[lines[1], lines[2]] = [lines[2] as string, lines[1] as string]
    await writeFile(path, lines.join('\n') + '\n', 'utf8')

    const reopened = await EncryptedConversationStore.open({ path, key })
    expect(reopened.faultReason).toMatch(/sequence|out of order/i)
    const record = await reopened.readConversation('c1')
    // The reordered turn-start is not allowed to become history that happened
    // before its user message, and later records behind the resulting gap are
    // not silently treated as a clean transcript.
    expect(record?.messages.map((m) => m.content)).toEqual([SECRET_USER])
    expect(record?.turns).toEqual([])
  })

  it('serialises concurrent appends so file order matches authenticated sequence order', async () => {
    const path = join(dir, 'concurrent.enc')
    const store = await EncryptedConversationStore.open({ path, key })
    await store.putConversation(conversation())

    await Promise.all(
      Array.from({ length: 24 }, (_unused, i) =>
        store.appendMessage(message(`m-${i}`, 'user', `concurrent message ${i}`, `t-${i}`)),
      ),
    )
    await store.close()

    const lines = (await readFile(path, 'utf8')).split('\n').filter((l) => l.trim().length > 0)
    const sequences = lines.map((line) => (JSON.parse(line) as { seq: number }).seq)
    expect(sequences).toEqual(Array.from({ length: 25 }, (_unused, i) => i + 1))

    const reopened = await EncryptedConversationStore.open({ path, key })
    expect(reopened.faultReason).toBeNull()
    expect((await reopened.readConversation('c1'))?.messages).toHaveLength(24)
  })

  it('gives every record a unique nonce, even for identical content', async () => {
    const path = join(dir, 'nonces.enc')
    const store = await EncryptedConversationStore.open({ path, key })
    await store.putConversation(conversation())
    // Two byte-identical messages. If the nonce were derived from the content,
    // these would encrypt to the same ciphertext, which under GCM leaks the XOR of
    // the two plaintexts and the authentication key.
    await store.appendMessage(message('m1', 'user', 'exactly the same text'))
    await store.appendMessage(message('m2', 'user', 'exactly the same text'))
    await store.close()

    const lines = (await readFile(path, 'utf8')).split('\n').filter((l) => l.trim().length > 0)
    const nonces = lines.map((l) => (JSON.parse(l) as { nonce: string }).nonce)
    const ciphers = lines.filter((l) => l.includes('"kind":"message"'))
      .map((l) => (JSON.parse(l) as { cipher: string }).cipher)

    expect(nonces).toHaveLength(3)
    expect(new Set(nonces).size).toBe(3)
    expect(new Set(ciphers).size).toBe(2)
  })

  it('binds a record to its own store, so two stores cannot read each other', async () => {
    const first = await openStore('a.enc')
    const second = await openStore('b.enc')
    await seed(first)
    await seed(second, 'a different secret entirely')

    const record = await first.readConversation('c1')
    expect(record?.messages[0]?.content).toBe(SECRET_USER)

    // A record lifted from b into a would fail its context check, and vice versa.
    const linesA = (await readFile(join(dir, 'a.enc'), 'utf8')).split('\n').filter((l) => l.trim().length > 0)
    const linesB = (await readFile(join(dir, 'b.enc'), 'utf8')).split('\n').filter((l) => l.trim().length > 0)
    await writeFile(join(dir, 'a.enc'), [...linesA, ...linesB.slice(0, 1)].join('\n') + '\n', 'utf8')

    const reopened = await openStore('a.enc')
    expect(reopened.faultReason).toMatch(/different store/i)
  })

  it('refuses a key of the wrong length', async () => {
    await expect(
      EncryptedConversationStore.open({ path: join(dir, 'short.enc'), key: new Uint8Array(16) }),
    ).rejects.toBeInstanceOf(ConversationStoreError)
  })
})

describe('schema and corruption', () => {
  it('refuses a record from a future version rather than guessing at it', async () => {
    const path = join(dir, 'future.enc')
    const store = await EncryptedConversationStore.open({ path, key })
    await seed(store)
    await store.close()

    const lines = (await readFile(path, 'utf8')).split('\n').filter((l) => l.trim().length > 0)
    const record = JSON.parse(lines[0] as string) as Record<string, unknown>
    lines[0] = JSON.stringify({ ...record, version: 99 })
    await writeFile(path, lines.join('\n') + '\n', 'utf8')

    const reopened = await EncryptedConversationStore.open({ path, key })
    expect(reopened.faultReason).toMatch(/not this version/i)
    // Nothing was believed, and nothing was invented.
    expect(await reopened.listConversations(10)).toEqual([])
  })

  it('skips an unreadable line and keeps the rest of the history', async () => {
    const path = join(dir, 'partial.enc')
    const store = await EncryptedConversationStore.open({ path, key })
    await seed(store)
    await store.close()

    const lines = (await readFile(path, 'utf8')).split('\n').filter((l) => l.trim().length > 0)
    // Corrupt the middle record only.
    lines.splice(1, 1, '{"version":1,"kind":"message","seq":99,"context":"x","nonce":"!!","cipher":"@@","tag":"##"}')
    await writeFile(path, lines.join('\n') + '\n', 'utf8')

    const reopened = await EncryptedConversationStore.open({ path, key })
    // Someone who lost one record should not lose the conversation.
    expect(reopened.faultReason).not.toBeNull()
    expect(await reopened.readConversation('c1')).not.toBeNull()
  })

  it('ignores a torn final line, the way the event journal does', async () => {
    const path = join(dir, 'torn.enc')
    const store = await EncryptedConversationStore.open({ path, key })
    await seed(store)
    await store.close()

    const raw = await readFile(path, 'utf8')
    await writeFile(path, `${raw}{"version":1,"kind":"mess`, 'utf8')

    const reopened = await EncryptedConversationStore.open({ path, key })
    const record = await reopened.readConversation('c1')
    expect(record?.messages).toHaveLength(2)
  })
})

describe('turn bookkeeping', () => {
  it('gives one turn one outcome', async () => {
    const store = await openStore()
    await store.putConversation(conversation())
    await store.appendMessage(message('m1', 'user', 'hello'))
    await store.recordTurnStart({
      turnId: 't1',
      conversationId: 'c1',
      userMessageId: 'm1',
      assistantMessageId: null,
      outcome: 'pending',
      startedAt: '2026-03-01T12:00:01.000Z',
      endedAt: null,
      requestId: 't1',
      providerId: null,
      model: null,
      reason: null,
    })

    await store.recordTurnOutcome('t1', 'completed', { endedAt: '2026-03-01T12:00:02.000Z' })
    await expect(
      store.recordTurnOutcome('t1', 'failed', { endedAt: '2026-03-01T12:00:03.000Z' }),
    ).rejects.toBeInstanceOf(ConversationStoreError)
  })

  it('marks an unfinished turn interrupted without inventing a reason', async () => {
    const store = await openStore()
    await store.putConversation(conversation())
    await store.appendMessage(message('m1', 'user', 'a question with no answer'))
    await store.recordTurnStart({
      turnId: 't1',
      conversationId: 'c1',
      userMessageId: 'm1',
      assistantMessageId: null,
      outcome: 'pending',
      startedAt: '2026-03-01T12:00:01.000Z',
      endedAt: null,
      requestId: 't1',
      providerId: null,
      model: null,
      reason: null,
    })

    const recovered = await store.recoverInterruptedTurns('2026-03-02T09:00:00.000Z')
    expect(recovered).toEqual(['t1'])

    const record = await store.readConversation('c1')
    expect(record?.turns[0]?.outcome).toBe('interrupted')
    // The process died. The record cannot say why, and a guessed cause would be a
    // fabrication about a real event.
    expect(record?.turns[0]?.reason).toBeNull()
    // The question survives; no answer was invented.
    expect(record?.messages).toHaveLength(1)
  })

  it('is idempotent about recovery', async () => {
    const store = await openStore()
    await store.putConversation(conversation())
    await store.appendMessage(message('m1', 'user', 'hello'))
    await store.recordTurnStart({
      turnId: 't1',
      conversationId: 'c1',
      userMessageId: 'm1',
      assistantMessageId: null,
      outcome: 'pending',
      startedAt: '2026-03-01T12:00:01.000Z',
      endedAt: null,
      requestId: 't1',
      providerId: null,
      model: null,
      reason: null,
    })
    expect(await store.recoverInterruptedTurns('2026-03-02T09:00:00.000Z')).toEqual(['t1'])
    // A second pass finds nothing to do, so a restart cannot rewrite history.
    expect(await store.recoverInterruptedTurns('2026-03-02T10:00:00.000Z')).toEqual([])
  })
})

describe('content limits', () => {
  it('refuses an oversized message rather than writing it', async () => {
    const store = await openStore()
    await store.putConversation(conversation())
    await expect(
      store.appendMessage(message('m1', 'user', 'x'.repeat(9000))),
    ).rejects.toBeInstanceOf(ConversationStoreError)
  })

  it('refuses a message for a conversation that does not exist', async () => {
    const store = await openStore()
    await expect(store.appendMessage(message('m1', 'user', 'hi'))).rejects.toBeInstanceOf(
      ConversationStoreError,
    )
  })
})

describe('the memory store', () => {
  it('is a real store, honestly labelled, and never a silent substitute', async () => {
    const store = new MemoryConversationStore({ mode: 'memory' })
    await seed(store)
    expect(store.mode).toBe('memory')
    expect((await store.readConversation('c1'))?.messages).toHaveLength(2)
  })

  it('labels an ephemeral store as ephemeral, so the UI can say it will not persist', async () => {
    const store = new MemoryConversationStore({ mode: 'ephemeral', faultReason: 'no key' })
    expect(store.mode).toBe('ephemeral')
    expect(store.faultReason).toBe('no key')
  })
})

describe('ciphertext is not plaintext with extra steps', () => {
  it('does not merely obfuscate: the key is what makes it readable', async () => {
    const path = join(dir, 'proof.enc')
    const store = await EncryptedConversationStore.open({ path, key })
    await store.putConversation(conversation())
    await store.appendMessage(message('m1', 'user', SECRET_USER))
    await store.close()

    const raw = await readFile(path, 'utf8')
    // The record is opaque: there is no readable field, only a nonce and a blob.
    const record = JSON.parse(raw.split('\n')[1] as string) as Record<string, unknown>
    expect(Object.keys(record).sort()).toEqual(
      ['cipher', 'context', 'kind', 'nonce', 'seq', 'tag', 'version'],
    )
    // And decrypting by hand with the key is the only way to read it.
    const decipher = createDecipherivLike(record, key)
    expect(decipher).toContain('hunter2')
  })
})

/** Prove the plaintext really is recoverable only with the key. */
function createDecipherivLike(record: Record<string, unknown>, withKey: Uint8Array): string {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(withKey),
    Buffer.from(record.nonce as string, 'base64'),
  )
  decipher.setAuthTag(Buffer.from(record.tag as string, 'base64'))
  decipher.setAAD(
    Buffer.from(
      `freya.conversation.v${record.version}|${record.context}|${record.kind}|${record.seq}`,
      'utf8',
    ),
  )
  return Buffer.concat([
    decipher.update(Buffer.from(record.cipher as string, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}

describe('titles are local', () => {
  it('derives a title without a model call', () => {
    expect(deriveConversationTitle('  what   is\nthis  ')).toBe('what is this')
    expect(deriveConversationTitle('')).toBe('New conversation')
    const long = deriveConversationTitle('word '.repeat(60))
    expect(long.length).toBeLessThanOrEqual(81)
    expect(long.endsWith('…')).toBe(true)
  })
})
