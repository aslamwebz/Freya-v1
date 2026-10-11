// @vitest-environment node
import { expect, it } from 'vitest'
import { NanoGptProvider } from '../../../core/model/nanogpt-provider'
import { ModelGateway } from '../../../core/model/gateway'

it('keeps provider-reported efforts for the configured model and sends selected effort', async () => {
  const bodies: Record<string, unknown>[] = []
  const provider = new NanoGptProvider({ config: { apiKey: 'test-only-key', baseUrl: 'https://nano-gpt.com/api/v1', model: 'test/model', liveEnabled: true }, fetchImpl: (async (_url, init) => {
    if (init?.method === 'GET') return new Response(JSON.stringify({ data: [{ id: 'test/model', reasoning_efforts: ['low', 'high'] }] }))
    bodies.push(JSON.parse(String(init?.body)))
    return new Response(JSON.stringify({ choices: [{ message: { content: 'answer' }, finish_reason: 'stop' }] }))
  }) as typeof fetch })
  const gateway = new ModelGateway({ providers: [provider], recorder: { started: async () => {}, completed: async () => {}, failed: async () => {}, cancelled: async () => {} } })
  const catalogue = await gateway.readModelCatalog()
  expect(catalogue.ok && catalogue.models[0]?.reasoningEfforts).toEqual(['low', 'high'])
  await gateway.execute({ requestId: 'allowed', correlationId: 'allowed', grantId: null, providerId: 'auto', maxOutputTokens: 32, model: 'test/model', reasoningEffort: 'high' }, 'hello')
  expect(bodies[0]?.reasoning_effort).toBe('high')
  await expect(gateway.execute({ requestId: 'refused', correlationId: 'refused', grantId: null, providerId: 'auto', maxOutputTokens: 32, model: 'test/model', reasoningEffort: 'invented' }, 'hello')).rejects.toThrow(/reasoning effort/i)
  expect(bodies).toHaveLength(1)
})
