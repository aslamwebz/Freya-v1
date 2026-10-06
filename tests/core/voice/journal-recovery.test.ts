// @vitest-environment node
import { expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonlEventStore } from '../../../core/events/jsonl-store'
import { parseDurableEvent } from '../../../core/events/validate'
import { CORE_EVENT_SCHEMA_VERSION } from '../../../core/events/envelope'
function event(sequence: number, type: string, payload: unknown): string {
  return JSON.stringify({eventId: `evt-${sequence}`, sequence, type, schemaVersion: CORE_EVENT_SCHEMA_VERSION, occurredAt: '2026-10-06T20:00:00.000Z', source: 'core', actor: 'system', correlationId: 'wake', causationId: null, payload}) + '\n'
}
it('replays the real fractional wake sensitivity and rejects invalid thresholds', () => {
  expect(parseDurableEvent(event(1,'voice.wake.armed',{gate:'local-energy-wake',threshold:0.14,maxArmedMs:900000}).trim(),0).ok).toBe(true)
  for(const threshold of [-1, 1.1, '0.14']) expect(parseDurableEvent(event(1,'voice.wake.armed',{gate:'local-energy-wake',threshold,maxArmedMs:900000}).trim(),0).ok).toBe(false)
})
it('restores only a fully validated wake quarantine with the matching trusted prefix, preserving STOP ALL', async () => {
  const dir=await mkdtemp(join(tmpdir(),'freya-wake-recovery-'))
  const path=join(dir,'events.jsonl'), quarantine=path+'.quarantine'
  const prefix=event(1,'core.ready',{})
  await writeFile(quarantine,prefix+event(2,'voice.wake.armed',{gate:'local-energy-wake',threshold:0.14,maxArmedMs:900000})+event(3,'security.stop_all.activated',{by:'owner',reason:'preserve me'}))
  await writeFile(path,prefix+event(2,'core.integrity_fault',{reason:'payload does not match the shape of voice.wake.armed',line:2,quarantinePath:quarantine,trustedPrefixEvents:1,trustedPrefixBytes:0,damagedBytes:100}))
  const store=await JsonlEventStore.open(path)
  try {
    expect(store.knownRepairReport()?.code).toBe('voice-wake-threshold-validator')
    expect((await store.readAll()).at(-1)?.type).toBe('security.stop_all.activated')
    expect(await readFile(store.knownRepairReport()!.archivedDegradedPath!,'utf8')).toContain('core.integrity_fault')
  } finally { await store.close(); await rm(dir,{recursive:true,force:true}) }
})
