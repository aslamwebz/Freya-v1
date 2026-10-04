import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { openDeviceHandsJournal } from '../../../electron/devicehands/journal'

const directories: string[] = []

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), 'freya-dh-journal-'))
  directories.push(directory)
  return directory
}

afterEach(() => {
  // The scratch directories are small and in the OS temp dir; leaving them is
  // harmless, but the paths are forgotten so a later test cannot reuse one.
  directories.length = 0
})

describe('durable Device Hands journal', () => {
  it('appends durably and replays the entries in order', async () => {
    const path = join(scratch(), 'device-hands.jsonl')
    const journal = openDeviceHandsJournal(path)
    await journal.append('hands.runtime.opened', { at: '2026-07-01T09:00:00.000Z', recoveredActions: 0 })
    await journal.append('hands.policy.set', { policyDigest: 'abc', rootCount: 1, hostCount: 1, commandCount: 1, envCount: 0, at: '2026-07-01T09:00:00.000Z' })
    expect(existsSync(path)).toBe(true)

    const replayed = await journal.replay()
    expect(replayed.map((entry) => entry.type)).toEqual(['hands.runtime.opened', 'hands.policy.set'])
    expect(journal.trustworthy()).toBe(true)
  })

  it('replays what a previous process wrote', async () => {
    const path = join(scratch(), 'device-hands.jsonl')
    const first = openDeviceHandsJournal(path)
    await first.append('hands.runtime.opened', { at: '2026-07-01T09:00:00.000Z', recoveredActions: 0 })

    const second = openDeviceHandsJournal(path)
    const replayed = await second.replay()
    expect(replayed).toHaveLength(1)
    expect(second.trustworthy()).toBe(true)
  })

  it('reports a tampered line as untrustworthy and refuses to replay past it', async () => {
    const path = join(scratch(), 'device-hands.jsonl')
    const journal = openDeviceHandsJournal(path)
    await journal.append('hands.runtime.opened', { at: '2026-07-01T09:00:00.000Z', recoveredActions: 0 })
    await journal.append('hands.policy.set', { policyDigest: 'abc', rootCount: 1, hostCount: 1, commandCount: 1, envCount: 0, at: '2026-07-01T09:00:00.000Z' })

    const lines = readFileSync(path, 'utf8').trimEnd().split('\n')
    const second = JSON.parse(lines[1] ?? '{}') as Record<string, unknown>
    // Edit the second payload without re-chaining it: the first line still chains, so
    // the trusted prefix is one entry, and the second line is where belief stops.
    writeFileSync(path, `${lines[0] ?? ''}\n${JSON.stringify({ ...second, payload: { policyDigest: 'evil', rootCount: 9, hostCount: 9, commandCount: 9, envCount: 9, at: '2026-07-01T09:00:00.000Z' } })}\n`)

    const reopened = openDeviceHandsJournal(path)
    const replayed = await reopened.replay()
    expect(reopened.trustworthy()).toBe(false)
    // The trusted prefix is returned; the runtime folds it and then refuses to act.
    expect(replayed).toHaveLength(1)
  })

  it('reports a line that does not parse as untrustworthy', async () => {
    const path = join(scratch(), 'device-hands.jsonl')
    writeFileSync(path, 'not json at all\n')
    const journal = openDeviceHandsJournal(path)
    expect(journal.trustworthy()).toBe(false)
    expect(await journal.replay()).toHaveLength(0)
  })

  it('rejects an append that cannot be written rather than swallowing it', async () => {
    const directory = scratch()
    const blocking = join(directory, 'blocking')
    writeFileSync(blocking, 'a file, not a directory')
    const journal = openDeviceHandsJournal(join(blocking, 'nested', 'device-hands.jsonl'))
    await expect(
      journal.append('hands.runtime.opened', { at: '2026-07-01T09:00:00.000Z', recoveredActions: 0 }),
    ).rejects.toThrow()
  })
})
