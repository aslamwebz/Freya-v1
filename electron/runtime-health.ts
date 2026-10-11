import { randomUUID } from 'node:crypto'
import { connectRpc, listenRpc } from '../shared/runtime/rpc'
import type { ComponentHealth } from '../shared/contracts/runtime'
import type { ProcessCoreHost } from './processCoreHost'

/** A live renderer probe plus fresh service checks; process existence is insufficient. */
export async function startSuperappHealth(host: ProcessCoreHost, rendererReady: () => Promise<boolean>, quit: () => void): Promise<void> {
  const endpoint = process.env.FREYA_SUPERAPP_HEALTH_ENDPOINT, token = process.env.FREYA_OWNER_TOKEN
  if (!endpoint || !token) throw new Error('Superapp readiness endpoint is missing')
  const instanceId = randomUUID(), startedAt = new Date().toISOString()
  await listenRpc(endpoint, token, peer => {
    peer.handle(async method => {
      if (method === 'runtime.quit') { setTimeout(quit, 50); return true }
      if (method !== 'runtime.health') throw new Error('operation unavailable')
      const issues = []
      let core: ComponentHealth | null = null, freya: ComponentHealth | null = null
      try { core = await host.health() } catch { /* Report disconnected Core below. */ }
      try {
        const client = await connectRpc(process.env.FREYA_INTELLIGENCE_HEALTH_ENDPOINT!, process.env.FREYA_INTELLIGENCE_HEALTH_TOKEN!)
        try { freya = await client.call<ComponentHealth>('runtime.health', null, 3_000) } finally { client.close() }
      } catch { /* Report disconnected Freya below. */ }
      if (!core || core.lifecycle !== 'ready') issues.push({ code: 'core-unavailable', message: 'Core is not ready' })
      if (!freya || freya.lifecycle !== 'ready') issues.push({ code: 'freya-unavailable', message: 'Freya is not ready' })
      if (!await rendererReady().catch(() => false)) issues.push({ code: 'renderer-unavailable', message: 'the existing desktop renderer has not passed its live readiness probe' })
      return { component: 'superapp', instanceId, pid: process.pid, startedAt, lifecycle: issues.length ? 'degraded' : 'ready', checkedAt: new Date().toISOString(),
        lastProgressAt: issues.length ? null : new Date().toISOString(), issues,
        dependencies: { core: { state: core?.lifecycle === 'ready' ? 'ready' : 'unavailable', checkedAt: new Date().toISOString() }, freya: { state: freya?.lifecycle === 'ready' ? 'ready' : 'unavailable', checkedAt: new Date().toISOString() } } } satisfies ComponentHealth
    })
  })
}
