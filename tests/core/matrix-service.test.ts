// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MatrixService } from '../../core/matrix/service'

const folders: string[] = []
const key = new Uint8Array(32).fill(27)
async function setup() {
  const folder = await mkdtemp(join(process.cwd(), '.kilo', 'matrix-test-'))
  folders.push(folder)
  const path = join(folder, 'matrix.enc')
  return { path, service: await MatrixService.open({ path, key }) }
}
afterEach(async () => { await Promise.all(folders.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

describe('Core-owned Matrix spaces', () => {
  it('persists space and record CRUD across restart without plaintext on disk', async () => {
    const { service, path } = await setup()
    const created = await service.execute('matrix.spaces.create', { name: 'Project Atlas', description: 'Private project' })
    expect(created, JSON.stringify(created)).toMatchObject({ ok: true })
    const id = created.space!.id
    const note = await service.execute('matrix.entries.create', { spaceId: id, kind: 'knowledge', title: 'Launch', content: 'Private launch date is Friday' })
    const person = await service.execute('matrix.entries.create', { spaceId: id, kind: 'person', title: 'Sam', content: 'Designer' })
    await service.execute('matrix.entries.update', { spaceId: id, entryId: note.entry!.id, title: 'Updated launch', content: 'Saturday' })
    await service.execute('matrix.entries.delete', { spaceId: id, entryId: person.entry!.id })
    await service.execute('matrix.spaces.update', { spaceId: id, name: 'Atlas updated', description: 'Still private' })
    await service.close()
    const raw = await readFile(path, 'utf8')
    expect(raw).not.toContain('Atlas')
    expect(raw).not.toContain('Saturday')
    const recovered = await MatrixService.open({ path, key })
    expect(recovered.projection().spaces).toMatchObject([{ id, name: 'Atlas updated', counts: { knowledge: 1, person: 0, file: 0 } }])
    const answer = await recovered.execute('matrix.entries.read', { spaceId: id })
    expect(answer.entries).toMatchObject([{ title: 'Updated launch', content: 'Saturday' }])
    await recovered.execute('matrix.spaces.delete', { spaceId: id })
    await recovered.close()
    const deleted = await MatrixService.open({ path, key })
    expect(deleted.projection().spaces).toEqual([])
    expect((await deleted.execute('matrix.entries.read', { spaceId: id })).ok).toBe(false)
    await deleted.close()
  })

  it('only lets Freya read or mutate explicitly attached spaces', async () => {
    const { service } = await setup()
    const a = (await service.execute('matrix.spaces.create', { name: 'Attached' })).space!.id
    const b = (await service.execute('matrix.spaces.create', { name: 'Private' })).space!.id
    const scope = { attachedSpaceIds: [a] }
    expect((await service.execute('matrix.entries.create', { spaceId: b, kind: 'knowledge', title: 'Leak', content: 'No' }, scope)).ok).toBe(false)
    expect((await service.execute('matrix.entries.read', { spaceId: b }, scope)).ok).toBe(false)
    expect((await service.execute('matrix.spaces.read', {}, scope)).projection?.spaces.map(space => space.id)).toEqual([a])
    expect((await service.execute('matrix.entries.create', { spaceId: a, kind: 'knowledge', title: 'Allowed', content: 'Yes' }, scope)).ok).toBe(true)
    expect((await service.execute('matrix.spaces.create', { name: 'Unattached' }, scope)).ok).toBe(false)
    await service.close()
  })

  it('retains bounded file bytes and can return a file explicitly after restart', async () => {
    const { service, path } = await setup()
    const id = (await service.execute('matrix.spaces.create', { name: 'Files' })).space!.id
    const created = await service.execute('matrix.entries.create', { spaceId: id, kind: 'file', title: 'notes.txt', content: 'Notes', mimeType: 'text/plain', dataBase64: Buffer.from('file bytes').toString('base64') })
    await service.close()
    const recovered = await MatrixService.open({ path, key })
    const result = await recovered.execute('matrix.entries.read', { spaceId: id, entryId: created.entry!.id })
    expect(result.entry?.dataBase64).toBe('ZmlsZSBieXRlcw==')
    expect((await recovered.execute('matrix.entries.create', { spaceId: id, kind: 'file', title: 'huge', content: '', dataBase64: Buffer.alloc(1_000_001).toString('base64') })).ok).toBe(false)
    expect((await recovered.execute('matrix.entries.create', { spaceId: id, kind: 'file', title: 'bad', content: '', dataBase64: 'not-base64!' })).ok).toBe(false)
    await recovered.close()
  })

  it('refuses writes without a key and preserves damaged storage', async () => {
    const { service, path } = await setup()
    await service.close()
    const noKey = await MatrixService.open({ path, key: null })
    expect(noKey.projection().durable).toBe(false)
    expect((await noKey.execute('matrix.spaces.create', { name: 'Unsaved' })).ok).toBe(false)
    await writeFile(path, 'damaged ciphertext')
    const damaged = await MatrixService.open({ path, key })
    expect(damaged.projection().health).toBe('degraded')
    expect((await damaged.execute('matrix.spaces.create', { name: 'Overwrite' })).ok).toBe(false)
    expect(await readFile(path, 'utf8')).toBe('damaged ciphertext')
    await noKey.close()
    await damaged.close()
  })

  it('serializes concurrent mutations and searches only within the selected space', async () => {
    const { service } = await setup()
    const id = (await service.execute('matrix.spaces.create', { name: 'Concurrent' })).space!.id
    await Promise.all(Array.from({ length: 8 }, (_, i) => service.execute('matrix.entries.create', { spaceId: id, kind: 'knowledge', title: `Item ${i}`, content: i === 3 ? 'Needle' : 'Other' })))
    expect(service.projection().spaces[0]!.counts.knowledge).toBe(8)
    expect((await service.execute('matrix.entries.read', { spaceId: id, query: 'needle' })).entries).toMatchObject([{ title: 'Item 3' }])
    expect((await service.execute('matrix.entries.create', { spaceId: id, kind: 'permission', title: 'Invalid' })).ok).toBe(false)
    await service.close()
  })

  it('keeps conversation attachments across restart and removes deleted spaces from them', async () => {
    const { service, path } = await setup()
    const spaceId = (await service.execute('matrix.spaces.create', { name: 'Chat context' })).space!.id
    expect((await service.execute('matrix.spaces.attach', { conversationId: 'chat-1', spaceIds: [spaceId] })).ok).toBe(true)
    expect((await service.execute('matrix.spaces.attach', { conversationId: 'chat-2', spaceIds: ['unknown'] })).ok).toBe(false)
    await service.close()
    const recovered = await MatrixService.open({ path, key })
    expect(recovered.attachedSpaceIds('chat-1')).toEqual([spaceId])
    expect((await recovered.execute('matrix.spaces.read', { conversationId: 'chat-1' })).attachedSpaceIds).toEqual([spaceId])
    expect((await recovered.execute('matrix.spaces.read', { conversationId: 'chat-1' }, { attachedSpaceIds: [] })).ok).toBe(false)
    expect(recovered.attachedSpaceIds('chat-2')).toEqual([])
    await recovered.execute('matrix.spaces.delete', { spaceId })
    expect(recovered.attachedSpaceIds('chat-1')).toEqual([])
    await recovered.close()
  })

  it('protects saved state from callers mutating response objects', async () => {
    const { service } = await setup()
    const spaceId = (await service.execute('matrix.spaces.create', { name: 'Protected' })).space!.id
    const updated = await service.execute('matrix.spaces.update', { spaceId, name: 'Saved name' })
    ;(updated.space as { name: string }).name = 'Changed outside Core'
    expect(service.projection().spaces[0]!.name).toBe('Saved name')
    const attached = await service.execute('matrix.spaces.attach', { conversationId: 'chat', spaceIds: [spaceId] })
    ;(attached.attachedSpaceIds as string[]).push('forged-space')
    expect(service.attachedSpaceIds('chat')).toEqual([spaceId])
    await service.close()
  })

  it('treats conversation IDs as opaque keys rather than object properties', async () => {
    const { service } = await setup()
    const spaceId = (await service.execute('matrix.spaces.create', { name: 'Key safety' })).space!.id
    expect(service.attachedSpaceIds('constructor')).toEqual([])
    expect((await service.execute('matrix.spaces.attach', { conversationId: '__proto__', spaceIds: [spaceId] })).ok).toBe(true)
    expect(service.attachedSpaceIds('__proto__')).toEqual([spaceId])
    expect(service.attachedSpaceIds('constructor')).toEqual([])
    await service.close()
  })
})
