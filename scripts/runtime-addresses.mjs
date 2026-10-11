import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

export function runtimeAddresses(profile) {
  const id = createHash('sha256').update(resolve(profile)).digest('hex').slice(0, 20)
  const address = name => process.platform === 'win32' ? `\\\\.\\pipe\\freya-${name}-${id}` : join(tmpdir(), `freya-${name}-${id}.sock`)
  return { core: address('core-owner'), intelligence: address('core-intelligence'), freya: address('freya-health'), superapp: address('superapp-health'), supervisor: address('supervisor') }
}
