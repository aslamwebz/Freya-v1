// @vitest-environment node
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { writeRuntimeDescriptor } from '../../scripts/runtime-descriptor.mjs'

it('retries a transient Windows reader lock without removing the old descriptor', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'freya-descriptor-')), file = join(dir, 'state.json')
  await writeFile(file, 'old')
  let calls = 0
  try {
    await writeRuntimeDescriptor(file, 'new', async (from: string, to: string) => {
      if (++calls === 1) {
        expect(await readFile(file, 'utf8')).toBe('old')
        throw Object.assign(new Error('locked'), { code: 'EPERM' })
      }
      await rename(from, to)
    })
    expect(calls).toBe(2)
    expect(await readFile(file, 'utf8')).toBe('new')
    calls = 0
    await expect(writeRuntimeDescriptor(file, 'bad', async () => { calls++; throw Object.assign(new Error('denied'), { code: 'EINVAL' }) })).rejects.toThrow('denied')
    expect(calls).toBe(1)
    expect(await readFile(file, 'utf8')).toBe('new')
    calls = 0
    await expect(writeRuntimeDescriptor(file, 'locked', async () => { calls++; throw Object.assign(new Error('still locked'), { code: 'EPERM' }) })).rejects.toThrow('still locked')
    expect(calls).toBe(8)
    expect(await readFile(file, 'utf8')).toBe('new')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
