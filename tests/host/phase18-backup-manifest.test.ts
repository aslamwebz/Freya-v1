import { describe, expect, it } from 'vitest'
import { backupManifest, validateRestoreSet } from '../../electron/recovery/backupManifest'

describe('Phase 18 backup/recovery contract', () => {
  const dataPath = 'C:\\FreyaData\\core-events.jsonl'

  it('derives every durable path from the one Core data path', () => {
    const entries = backupManifest(dataPath)
    const paths = entries.map((entry) => entry.path)
    expect(paths).toContain(dataPath)
    expect(paths).toContain(`${dataPath}.conversations`)
    expect(paths).toContain(`${dataPath}.brain`)
    expect(paths).toContain(`${dataPath}.missions`)
    expect(paths).toContain(`${dataPath}.context.enc`)
    expect(paths).toContain(`${dataPath}.personality.enc`)
    expect(paths).toContain(`${dataPath}.skills.enc`)
    expect(paths).toContain('C:\\FreyaData\\freya.keyring.json')
    expect(paths).toContain('C:\\FreyaData\\workspace.json')
    expect(entries.find((entry) => entry.class === 'protected-keyring')?.portableAcrossProfiles).toBe(false)
  })

  it('refuses to call an encrypted-data-only copy a complete restore', () => {
    const present = new Set([`${dataPath}.brain`])
    const failures = validateRestoreSet(dataPath, present).join('\n')
    expect(failures).toContain('protected keyring')
    expect(failures).toContain('event journal')
  })

  it('accepts the minimum same-profile security-state restore set', () => {
    const present = new Set([dataPath, 'C:\\FreyaData\\freya.keyring.json'])
    expect(validateRestoreSet(dataPath, present, 'same-profile')).toEqual([])
  })

  it('refuses to claim cross-profile migration from an OS-bound keyring backup', () => {
    const present = new Set([dataPath, 'C:\\FreyaData\\freya.keyring.json'])
    expect(validateRestoreSet(dataPath, present, 'migration').join('\n')).toContain('cross-profile migration is not supported')
  })
})
