import { EventFabric } from '../../core/events/fabric'
import { JsonlEventStore } from '../../core/events/jsonl-store'
import { WorkforceEngine } from '../../core/workforce/engine'

/** Populate only the acceptance runner's newly created profile, before Core opens it. */
export async function seedWorkforce(path: string) {
  const fabric = await EventFabric.open({ store: await JsonlEventStore.open(path) })
  const engine = new WorkforceEngine({ fabric, principalId: 'owner', newId: (() => { let id = 0; return () => `fixture-${++id}` })(),
    core: { missionExists: () => false, requestCognition: async () => { throw new Error('fixture must not contact a model') } } })
  await engine.open()
  try {
    const owner = engine.ownerScope()
    const alpha = await owner.createWorker({ name: 'Alpha', specialisation: 'research' })
    const beta = await owner.createWorker({ name: 'Beta', specialisation: 'analysis' })
    if (!alpha.ok || !beta.ok || !alpha.workerId) throw new Error('worker fixture failed')
    await owner.assignCapability(alpha.workerId, 'cognition.request')
    if (!(await owner.assign({ workerId: alpha.workerId, capabilities: ['cognition.request'] })).ok) throw new Error('assignment fixture failed')
  } finally { await engine.close(); await fabric.close() }
}
