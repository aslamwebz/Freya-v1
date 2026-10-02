import type { WorkCapability, WorkRegistry, WorkVerifier } from '../work/capability'
import type { WorkObservationContent } from '../work/capability'
import { isCapability } from '../security/guard'
import { APP_STATUSES, MODULE_STATUSES, TOOL_STATUSES } from './types'
import type { FoundryEngine } from './engine'

const SHA256_HEX = /^[a-f0-9]{64}$/

function hashFrom(input: Record<string, unknown>): string | null {
  const value = input.artifactHash
  return typeof value === 'string' && SHA256_HEX.test(value) ? value : null
}

function resultObservation(summary: string, data: Record<string, unknown>): WorkObservationContent {
  return { kind: 'result', summary, data }
}

function failureObservation(summary: string, reason: string): WorkObservationContent {
  return { kind: 'failure', summary, data: { ok: false, reason } }
}

function textField(input: Record<string, unknown>, key: string): string | null {
  const value = input[key]
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function stringList(input: Record<string, unknown>, key: string): string[] | null {
  const value = input[key]
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) return null
  return [...value]
}

/**
 * Register the only Work routes allowed to mutate Foundry.
 *
 * A renderer cannot acquire these objects. Work owns the registry, Guard evaluates
 * the declared capability, and consequential transitions stop for owner approval
 * before execute() is called.
 */
export function registerFoundryWorkCapabilities(registry: WorkRegistry, engine: FoundryEngine): void {
  const create: WorkCapability = {
    name: 'foundry.artifact.create',
    capability: 'foundry.artifact.manage',
    risk: 'routine',
    describe: () => 'creates one bounded Foundry artifact from this Work step output',
    async execute(request) {
      const outcome = await engine.createArtifact({
        runId: request.runId,
        stepId: request.stepId,
        createdBy: 'owner',
        kind: 'build_output',
        content: request.input,
      })
      if (!outcome.ok || !outcome.hash) {
        return {
          observation: failureObservation(
            'Foundry refused artifact creation',
            outcome.reason ?? 'artifact creation was refused',
          ),
        }
      }
      return {
        observation: resultObservation('created a Foundry artifact', {
          ok: true,
          artifactHash: outcome.hash,
          status: 'draft',
        }),
      }
    },
  }

  const verify: WorkCapability = {
    name: 'foundry.artifact.verify',
    capability: 'foundry.artifact.manage',
    risk: 'routine',
    describe: () => 'checks a Foundry artifact against the independent verdict of its creating Work step',
    async execute(request) {
      const hash = hashFrom(request.input)
      if (hash === null) {
        return { observation: failureObservation('Foundry verification refused', 'artifact identity is invalid') }
      }
      const outcome = await engine.verifyArtifact({
        artifactHash: hash,
        verifierName: 'work.step.verified',
        requestedBy: 'owner',
      })
      if (!outcome.ok || outcome.verification?.verdict !== 'passed') {
        return {
          observation: failureObservation(
            'Foundry verification failed',
            outcome.reason ?? 'the creating Work step is not independently verified',
          ),
        }
      }
      return {
        observation: resultObservation('verified a Foundry artifact', {
          ok: true,
          artifactHash: hash,
          status: 'verified',
        }),
      }
    },
  }

  const promote: WorkCapability = {
    name: 'foundry.artifact.promote',
    capability: 'foundry.activation.manage',
    risk: 'consequential',
    describe(request) {
      const hash = hashFrom(request.input)
      return hash === null
        ? 'would promote a Foundry artifact, but its identity is invalid'
        : `would promote Foundry artifact ${hash.slice(0, 12)} for reuse`
    },
    async execute(request) {
      const hash = hashFrom(request.input)
      if (hash === null) {
        return { observation: failureObservation('Foundry promotion refused', 'artifact identity is invalid') }
      }
      const outcome = await engine.promoteArtifact({
        artifactHash: hash,
        toStatus: 'promoted',
        promotedBy: 'owner',
        reason: 'approved through a consequential Work step',
      })
      if (!outcome.ok) {
        return {
          observation: failureObservation(
            'Foundry promotion refused',
            outcome.reason ?? 'artifact promotion was refused',
          ),
        }
      }
      return {
        observation: resultObservation('promoted a Foundry artifact', {
          ok: true,
          artifactHash: hash,
          status: 'promoted',
        }),
      }
    },
  }

  const activate: WorkCapability = {
    name: 'foundry.artifact.activate',
    capability: 'foundry.activation.manage',
    risk: 'consequential',
    describe(request) {
      const hash = hashFrom(request.input)
      return hash === null
        ? 'would activate a Foundry artifact, but its identity is invalid'
        : `would activate Foundry artifact ${hash.slice(0, 12)}`
    },
    async execute(request) {
      const hash = hashFrom(request.input)
      if (hash === null) {
        return { observation: failureObservation('Foundry activation refused', 'artifact identity is invalid') }
      }
      const outcome = await engine.activateArtifact({
        artifactHash: hash,
        toStatus: 'active',
        activatedBy: 'owner',
        reason: 'approved through a consequential Work step',
      })
      if (!outcome.ok) {
        return {
          observation: failureObservation(
            'Foundry activation refused',
            outcome.reason ?? 'artifact activation was refused',
          ),
        }
      }
      return {
        observation: resultObservation('activated a Foundry artifact', {
          ok: true,
          artifactHash: hash,
          status: 'active',
        }),
      }
    },
  }

  const deactivate: WorkCapability = {
    name: 'foundry.artifact.deactivate',
    capability: 'foundry.activation.manage',
    risk: 'consequential',
    describe: () => 'would deactivate a Foundry artifact and return it to promoted state',
    async execute(request) {
      const hash = hashFrom(request.input)
      if (hash === null) {
        return { observation: failureObservation('Foundry deactivation refused', 'artifact identity is invalid') }
      }
      const outcome = await engine.deactivateArtifact({
        artifactHash: hash,
        deactivatedBy: 'owner',
        reason: 'approved through a consequential Work step',
      })
      if (!outcome.ok) {
        return {
          observation: failureObservation(
            'Foundry deactivation refused',
            outcome.reason ?? 'artifact deactivation was refused',
          ),
        }
      }
      return {
        observation: resultObservation('deactivated a Foundry artifact', {
          ok: true,
          artifactHash: hash,
          status: 'promoted',
        }),
      }
    },
  }

  const entityRegister: WorkCapability = {
    name: 'foundry.entity.register',
    capability: 'foundry.artifact.manage',
    risk: 'consequential',
    describe: () => 'would register a reusable Tool, Module or App backed by a Foundry artifact',
    async execute(request) {
      const entityKind = textField(request.input, 'entityKind')
      const hash = textField(request.input, 'hash')
      const name = textField(request.input, 'name')
      const artifactHash = hashFrom(request.input)
      if (!entityKind || !hash || !name || !artifactHash) {
        return { observation: failureObservation('Foundry registration refused', 'entity registration input is invalid') }
      }

      let outcome
      if (entityKind === 'tool') {
        const capability = request.input.capability
        if (!isCapability(capability)) {
          return { observation: failureObservation('Foundry registration refused', 'tool capability is invalid') }
        }
        outcome = await engine.registerTool({ hash, name, capability, createdBy: 'owner', artifactHash })
      } else if (entityKind === 'module') {
        outcome = await engine.registerModule({ hash, name, createdBy: 'owner', artifactHash })
      } else if (entityKind === 'app') {
        const moduleHashes = stringList(request.input, 'moduleHashes')
        if (moduleHashes === null) {
          return { observation: failureObservation('Foundry registration refused', 'app module identities are invalid') }
        }
        outcome = await engine.registerApp({ hash, name, createdBy: 'owner', artifactHash, moduleHashes })
      } else {
        return { observation: failureObservation('Foundry registration refused', 'entity kind is invalid') }
      }

      return outcome.ok
        ? { observation: resultObservation('registered a Foundry entity', { ok: true, entityKind, hash, status: 'registered' }) }
        : { observation: failureObservation('Foundry registration refused', outcome.reason ?? 'registration was refused') }
    },
  }

  const entityTransition: WorkCapability = {
    name: 'foundry.entity.transition',
    capability: 'foundry.activation.manage',
    risk: 'consequential',
    describe: () => 'would move a reusable Foundry entity along its closed lifecycle',
    async execute(request) {
      const entityKind = textField(request.input, 'entityKind')
      const hash = textField(request.input, 'hash')
      const status = textField(request.input, 'status')
      if (!entityKind || !hash || !status) {
        return { observation: failureObservation('Foundry transition refused', 'entity transition input is invalid') }
      }

      let outcome
      if (entityKind === 'tool' && TOOL_STATUSES.includes(status as never)) {
        outcome = await engine.transitionTool({ hash, toStatus: status as never, changedBy: 'owner' })
      } else if (entityKind === 'module' && MODULE_STATUSES.includes(status as never)) {
        outcome = await engine.transitionModule({ hash, toStatus: status as never, changedBy: 'owner' })
      } else if (entityKind === 'app' && APP_STATUSES.includes(status as never)) {
        outcome = await engine.transitionApp({ hash, toStatus: status as never, changedBy: 'owner' })
      } else {
        return { observation: failureObservation('Foundry transition refused', 'entity status is invalid') }
      }

      return outcome.ok
        ? { observation: resultObservation('transitioned a Foundry entity', { ok: true, entityKind, hash, status }) }
        : { observation: failureObservation('Foundry transition refused', outcome.reason ?? 'transition was refused') }
    },
  }

  registry.register(create)
  registry.register(verify)
  registry.register(promote)
  registry.register(activate)
  registry.register(deactivate)
  registry.register(entityRegister)
  registry.register(entityTransition)
  registry.registerVerifier(foundryVerifier('foundry.artifact.created', 'draft'))
  registry.registerVerifier(foundryVerifier('foundry.artifact.verified', 'verified'))
  registry.registerVerifier(foundryVerifier('foundry.artifact.promoted', 'promoted'))
  registry.registerVerifier(foundryVerifier('foundry.artifact.activated', 'active'))
  registry.registerVerifier(foundryEntityVerifier(engine))
}

function foundryVerifier(name: string, expectedStatus: string): WorkVerifier {
  return {
    name,
    verify(request) {
      const data = request.observation.data
      const artifactHash = data.artifactHash
      const status = data.status
      const passed =
        request.observation.kind !== 'failure' &&
        data.ok === true &&
        typeof artifactHash === 'string' &&
        SHA256_HEX.test(artifactHash) &&
        status === expectedStatus

      return passed
        ? {
            verdict: 'passed',
            reason: `Foundry reported ${expectedStatus} with a valid artifact identity`,
          }
        : {
            verdict: 'failed',
            reason: `Foundry did not establish ${expectedStatus}`,
          }
    },
  }
}
