import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listenRpc, connectRpc, RpcTimeoutError, type RpcPeer } from '../../shared/runtime/rpc'

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

  it('tells a timeout apart from a disconnection, because they need different answers', async () => {
    // A live turn was cut off by the call ceiling and reported to the owner as
    // "Core could not be reached" — while Core was still working on the question.
    // The two failures need opposite responses: a dead connection is retried or
    // escalated, a slow answer is simply still in progress.
    const server = await listenRpc(endpoint(), 'token', peer => {
      peer.handle(async () => { await new Promise(resolve => setTimeout(resolve, 400)); return 'late' })
    })
    cleanup.push(() => server.close())
    const client = await connectRpc(server.endpoint, 'token')
    cleanup.push(() => client.close())

    const failure = async (promise: Promise<unknown>): Promise<Error> => {
      try { await promise } catch (error) {
        return error instanceof Error ? error : new Error(String(error))
      }
      throw new Error('the call was expected to fail and did not')
    }

    const timedOut = await failure(client.call('ui.submit', {}, 60))
    expect(timedOut).toBeInstanceOf(RpcTimeoutError)
    // It says what actually happened, and does not claim the peer is gone.
    expect(timedOut.message).toMatch(/still working/i)
    expect(timedOut.message).not.toMatch(/disconnect|could not be reached/i)

    const pending = client.call('other', {})
    client.close()
    const disconnected = await failure(pending)
    expect(disconnected).not.toBeInstanceOf(RpcTimeoutError)
    expect(disconnected.message).toMatch(/disconnected/i)
  })
})
