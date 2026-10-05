// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import type { Vault, VaultTransaction } from '../../../core/vault'
import { VaultConversationStore } from '../../../core/vault'
import { VAULT_MIGRATIONS, VAULT_SCHEMA_VERSION, applyMigrations } from '../../../core/vault/schema'
import type { ConversationTurn } from '../../../core/conversation/types'
import { openMemoryConnection } from './sql-adapter'

let connection: ReturnType<typeof openMemoryConnection>

beforeEach(() => {
  connection = openMemoryConnection()
  applyMigrations(connection as never, VAULT_MIGRATIONS, () => new Date('2026-10-05T12:00:00.000Z'))
})

function harnessVault(): Vault {
  const db = connection
  const vault: VaultTransaction & Pick<Vault, 'transaction'> = {
    exec: (sql) => db.exec(sql),
    run: (sql, params) => db.prepare(sql).run(params),
    get: <T>(sql: string, params?: readonly unknown[] | Readonly<Record<string, unknown>>): T | undefined =>
      db.prepare(sql).get(params) as T | undefined,
    all: <T>(sql: string, params?: readonly unknown[] | Readonly<Record<string, unknown>>): T[] =>
      db.prepare(sql).all(params) as T[],
    transaction: <T>(fn: (tx: VaultTransaction) => T): T => {
      db.exec('BEGIN IMMEDIATE')
      try {
        const result = fn(vault)
        db.exec('COMMIT')
        return result
      } catch (error) {
        try {
          db.exec('ROLLBACK')
        } catch {
          // The transaction is already gone.
        }
        throw error
      }
    },
  }
  return vault as Vault
}

function turn(): ConversationTurn {
  return {
    turnId: 't1',
    conversationId: 'c1',
    userMessageId: 'm1',
    assistantMessageId: null,
    outcome: 'pending',
    startedAt: '2026-10-05T12:00:01.000Z',
    endedAt: null,
    requestId: 't1',
    providerId: null,
    model: null,
    reason: null,
  }
}

describe('Vault conversation schema', () => {
  it('migrates conversation history into relational tables inside the canonical Vault', () => {
    const tables = connection
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => (row as { name: string }).name)

    expect(VAULT_SCHEMA_VERSION).toBeGreaterThanOrEqual(3)
    expect(tables).toEqual(expect.arrayContaining([
      'chat_conversations',
      'chat_messages',
      'chat_turns',
    ]))
  })
})

describe('VaultConversationStore', () => {
  it('round-trips a completed conversation without a second persistence format', async () => {
    const store = new VaultConversationStore(harnessVault())
    await store.putConversation({
      conversationId: 'c1',
      title: 'A private chat',
      createdAt: '2026-10-05T12:00:00.000Z',
      updatedAt: '2026-10-05T12:00:00.000Z',
    })
    await store.appendMessage({
      messageId: 'm1',
      conversationId: 'c1',
      role: 'user',
      content: 'hello freya',
      createdAt: '2026-10-05T12:00:01.000Z',
      turnId: 't1',
    })
    await store.recordTurnStart(turn())
    await store.appendMessage({
      messageId: 'm2',
      conversationId: 'c1',
      role: 'assistant',
      content: 'hello',
      createdAt: '2026-10-05T12:00:02.000Z',
      turnId: 't1',
    })
    await store.recordTurnOutcome('t1', 'completed', {
      endedAt: '2026-10-05T12:00:02.000Z',
      assistantMessageId: 'm2',
      providerId: 'provider',
      model: 'model',
    })

    const record = await store.readConversation('c1')
    expect(record?.messages.map((message) => message.content)).toEqual(['hello freya', 'hello'])
    expect(record?.turns[0]?.outcome).toBe('completed')
    expect((await store.listConversations(10))[0]).toMatchObject({
      conversationId: 'c1',
      messageCount: 2,
      lastTurnOutcome: 'completed',
    })
  })

  it('hides an archived conversation while keeping its relational rows', async () => {
    const store = new VaultConversationStore(harnessVault())
    await store.putConversation({
      conversationId: 'c1',
      title: 'Archive me',
      createdAt: '2026-10-05T12:00:00.000Z',
      updatedAt: '2026-10-05T12:00:00.000Z',
    })
    await store.appendMessage({
      messageId: 'm1',
      conversationId: 'c1',
      role: 'user',
      content: 'history stays',
      createdAt: '2026-10-05T12:00:01.000Z',
      turnId: 't1',
    })
    await store.putConversation({
      conversationId: 'c1',
      title: 'Archive me',
      createdAt: '2026-10-05T12:00:00.000Z',
      updatedAt: '2026-10-05T12:02:00.000Z',
      archivedAt: '2026-10-05T12:02:00.000Z',
    })

    expect(await store.listConversations(10)).toEqual([])
    expect(await store.readConversation('c1')).toBeNull()
    const row = connection.prepare('SELECT content FROM chat_messages WHERE message_id = ?').get('m1') as { content: string }
    expect(row.content).toBe('history stays')
  })

  it('recovers a pending turn as interrupted and never invents an answer', async () => {
    const store = new VaultConversationStore(harnessVault())
    await store.putConversation({
      conversationId: 'c1',
      title: 'Interrupted',
      createdAt: '2026-10-05T12:00:00.000Z',
      updatedAt: '2026-10-05T12:00:00.000Z',
    })
    await store.appendMessage({
      messageId: 'm1',
      conversationId: 'c1',
      role: 'user',
      content: 'did this finish?',
      createdAt: '2026-10-05T12:00:01.000Z',
      turnId: 't1',
    })
    await store.recordTurnStart(turn())

    expect(await store.recoverInterruptedTurns('2026-10-05T12:05:00.000Z')).toEqual(['t1'])
    const record = await store.readConversation('c1')
    expect(record?.messages).toHaveLength(1)
    expect(record?.turns[0]).toMatchObject({ outcome: 'interrupted', assistantMessageId: null })
  })
})
