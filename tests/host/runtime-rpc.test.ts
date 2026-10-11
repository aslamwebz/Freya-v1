import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listenRpc, connectRpc, type RpcPeer } from '../../shared/runtime/rpc'

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

describe('authenticated runtime communication', () => {
  const endpoint = () => process.platform === 'win32'
    ? `\\\\.\\pipe\\freya-test-${randomUUID()}` : join(tmpdir(), `freya-${randomUUID()}.sock`)

  it('permits concurrent calls in both directions only after authentication', async () => {
    let serverPeer: RpcPeer | undefined
    const server = await listenRpc(endpoint(), 'private-token', peer => {
      serverPeer = peer
      peer.handle(async (method, value) => {
        if (method !== 'double') throw new Error('unknown operation')
        return Number(value) * 2
      })
    })
    cleanup.push(() => server.close())
    await expect(connectRpc(server.endpoint, 'incorrect-token')).rejects.toThrow('authentication')
    const client = await connectRpc(server.endpoint, 'private-token')
    cleanup.push(() => client.close())
    client.handle(async (method, value) => method === 'hello' ? `hello ${String(value)}` : null)
    expect(await Promise.all([client.call('double', 2), client.call('double', 3)])).toEqual([4, 6])
    expect(await serverPeer!.call('hello', 'Freya')).toBe('hello Freya')
  })

  it('rejects unfinished requests on disconnect and never replays them on reconnect', async () => {
    let executions = 0
    const server = await listenRpc(endpoint(), 'token', peer => {
      peer.handle(async () => { executions++; await new Promise(resolve => setTimeout(resolve, 100)); return true })
    })
    cleanup.push(() => server.close())
    const first = await connectRpc(server.endpoint, 'token')
    const unfinished = first.call('effect', {})
    const rejection = expect(unfinished).rejects.toThrow('disconnected')
    await new Promise(resolve => setTimeout(resolve, 30))
    first.close()
    await rejection
    const second = await connectRpc(server.endpoint, 'token')
    cleanup.push(() => second.close())
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(executions).toBe(1)
  })
})
