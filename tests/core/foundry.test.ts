// @vitest-environment node

import { describe, expect, it } from 'vitest'

import type { AnyCoreEvent } from '../../core/events/envelope'

import { FoundryEngine } from '../../core/foundry/engine'

import type { FoundryVerifier } from '../../core/foundry/engine'

import { FOUNDRY_LIMITS } from '../../core/foundry/types'

/**
 * THE FOUNDRY ENGINE, unit tests.
 *
 * These tests drive the FoundryEngine directly, because the properties that
 * matter here are properties of the engine itself:
 *
 *  1. **Creation is through Work, never raw.** An artifact is created by a
 *     Step inside a Run, under the authority of the principal that owns the Run.
 *
 *  2. **Verification is separate from creation.** A verifier is a separately
 *     registered piece of code that checks an artifact against its spec and
 *     produces evidence. The verdict is derived from the evidence by the
 *     engine, not by the verifier itself.
 *
 *  3. **Promotion is explicit and owner-only.** A thing that was verified is
 *     not thereby promoted; promotion is a separate decision that requires the
 *     owner's explicit authorization.
 *
 *  4. **Activation is explicit, owner-only, bounded and reversible.** A thing
 *     that was promoted is not thereby active; activation is a separate
 *     decision that requires the owner's explicit authorization.
 *
 *  5. **A model claim can never mark work verified.** The verdict is derived
 *     from evidence, not from the model's claim.
 *
 *  6. **Nothing learned reaches the journal.** An artifact's content, its spec,
 *     and its verification evidence are measured, not recorded.
 *
 */

describe('Foundry engine', () => {
  function createEngine() {
    const events: AnyCoreEvent[] = []
    const engine = new FoundryEngine((event) => {
      events.push(event)
    })
    return { engine, events }
  }

  describe('artifact creation', () => {
    it('creates an artifact through a Run', async () => {
      const { engine } = createEngine()
      const result = await engine.createArtifact({
        runId: 'run_123',
        stepId: 'step_456',
        createdBy: 'owner',
        kind: 'build_output',
        content: { name: 'test-tool', version: '1.0.0' },
      })

      expect(result.ok).toBe(true)
      expect(result.hash).toBeDefined()
      expect(result.hash).toHaveLength(64)
    })

    it('refuses creation by a non-owner principal', async () => {
      const { engine } = createEngine()
      const result = await engine.createArtifact({
        runId: 'run_123',
        stepId: 'step_456',
        createdBy: 'system',
        kind: 'build_output',
        content: { name: 'test-tool' },
      })

      expect(result.ok).toBe(false)
      expect(result.reason).toBe('the caller is not authorized to perform this operation')
    })

    it('refuses creation with non-data content', async () => {
      const { engine } = createEngine()
      const result = await engine.createArtifact({
        runId: 'run_123',
        stepId: 'step_456',
        createdBy: 'owner',
        kind: 'build_output',
        content: { fn: () => {} },
      })

      expect(result.ok).toBe(false)
      expect(result.reason).toBe('the artifact content is not valid data')
    })

    it('refuses creation with oversized content', async () => {
      const { engine } = createEngine()
      const result = await engine.createArtifact({
        runId: 'run_123',
        stepId: 'step_456',
        createdBy: 'owner',
        kind: 'build_output',
        content: { data: 'x'.repeat(FOUNDRY_LIMITS.maxContentBytes + 1) },
      })

      expect(result.ok).toBe(false)
      expect(result.reason).toBe('the artifact content is too large')
    })

    it('produces deterministic identity for identical content', async () => {
      const { engine } = createEngine()
      const content = { name: 'test-tool', version: '1.0.0' }

      const result1 = await engine.createArtifact({
        runId: 'run_123',
        stepId: 'step_456',
        createdBy: 'owner',
        kind: 'build_output',
        content,
      })

      const result2 = await engine.createArtifact({
        runId: 'run_789',
        stepId: 'step_012',
        createdBy: 'owner',
        kind: 'build_output',
        content,
      })

      expect(result1.ok).toBe(true)
      expect(result2.ok).toBe(false)
      expect(result2.reason).toBe('an artifact with this identity already exists')
      expect(result1.hash).toBeDefined()
    })

    it('produces different identity for different content', async () => {
      const { engine } = createEngine()
      const result1 = await engine.createArtifact({
        runId: 'run_123',
        stepId: 'step_456',
        createdBy: 'owner',
        kind: 'build_output',
        content: { name: 'test-tool', version: '1.0.0' },
      })

      const result2 = await engine.createArtifact({
        runId: 'run_123',
        stepId: 'step_456',
        createdBy: 'owner',
        kind: 'build_output',
        content: { name: 'test-tool', version: '2.0.0' },
      })

      expect(result1.ok).toBe(true)
      expect(result2.ok).toBe(true)
      expect(result1.hash).not.toBe(result2.hash)
    })

    it('refuses duplicate artifact creation', async () => {
      const { engine } = createEngine()
      const content = { name: 'test-tool', version: '1.0.0' }

      const result1 = await engine.createArtifact({
        runId: 'run_123',
        stepId: 'step_456',
        createdBy: 'owner',
        kind: 'build_output',
        content,
      })

      const result2 = await engine.createArtifact({
        runId: 'run_123',
        stepId: 'step_456',
        createdBy: 'owner',
        kind: 'build_output',
        content,
      })

      expect(result1.ok).toBe(true)
      expect(result2.ok).toBe(false)
      expect(result2.reason).toBe('an artifact with this identity already exists')
    })

    it('canonicalises object key order before computing identity', async () => {
      const { engine } = createEngine()
      const first = await engine.createArtifact({
        runId: 'run_123',
        stepId: 'step_456',
        createdBy: 'owner',
        kind: 'build_output',
        content: { beta: 'two', alpha: 'one' },
      })
      const second = await engine.createArtifact({
        runId: 'run_789',
        stepId: 'step_012',
        createdBy: 'owner',
        kind: 'build_output',
        content: { alpha: 'one', beta: 'two' },
      })

      expect(first.ok).toBe(true)
      expect(second.ok).toBe(false)
      expect(second.hash).toBe(first.hash)
    })

    it('refuses provenance links to artifacts that do not exist', async () => {
      const { engine } = createEngine()
      const missingParent = await engine.createArtifact({
        runId: 'run_123',
        stepId: 'step_456',
        createdBy: 'owner',
        kind: 'build_output',
        content: { name: 'child' },
        parentHash: 'a'.repeat(64),
      })
      const missingSpec = await engine.createArtifact({
        runId: 'run_123',
        stepId: 'step_456',
        createdBy: 'owner',
        kind: 'build_output',
        content: { name: 'built' },
        specHash: 'b'.repeat(64),
      })

      expect(missingParent.ok).toBe(false)
      expect(missingParent.reason).toBe('the parent artifact does not exist')
      expect(missingSpec.ok).toBe(false)
      expect(missingSpec.reason).toBe('the spec artifact does not exist')
    })
  })

  describe('verification', () => {
    it('verifies an artifact and derives verdict from evidence', async () => {
      const { engine } = createEngine()
      const verifier: FoundryVerifier = {
        name: 'test.pass',
        verify: () => 'PASS: all checks passed',
      }
      engine.registerVerifier(verifier)

      const createResult = await engine.createArtifact({
        runId: 'run_123',
        stepId: 'step_456',
        createdBy: 'owner',
        kind: 'build_output',
        content: { name: 'test-tool' },
      })

      expect(createResult.ok).toBe(true)

      const verifyResult = await engine.verifyArtifact({
        artifactHash: createResult.hash!,
        verifierName: 'test.pass',
        requestedBy: 'owner',
      })

      expect(verifyResult.ok).toBe(true)
      expect(verifyResult.verification?.verdict).toBe('passed')
      expect(verifyResult.verification?.evidence).toBe('PASS: all checks passed')
    })

    it('derives failed verdict from failing evidence', async () => {
      const { engine } = createEngine()
      const verifier: FoundryVerifier = {
        name: 'test.fail',
        verify: () => 'FAIL: spec mismatch',
      }
      engine.registerVerifier(verifier)

      const createResult = await engine.createArtifact({
        runId: 'run_123',
        stepId: 'step_456',
        createdBy: 'owner',
        kind: 'build_output',
        content: { name: 'test-tool' },
      })

      const verifyResult = await engine.verifyArtifact({
        artifactHash: createResult.hash!,
        verifierName: 'test.fail',
        requestedBy: 'owner',
      })

      expect(verifyResult.ok).toBe(true)
      expect(verifyResult.verification?.verdict).toBe('failed')
    })

    it('derives inconclusive verdict from ambiguous evidence', async () => {
      const { engine } = createEngine()
      const verifier: FoundryVerifier = {
        name: 'test.inconclusive',
        verify: () => 'MAYBE: unclear',
      }
      engine.registerVerifier(verifier)

      const createResult = await engine.createArtifact({
        runId: 'run_123',
        stepId: 'step_456',
        createdBy: 'owner',
        kind: 'build_output',
        content: { name: 'test-tool' },
      })

      const verifyResult = await engine.verifyArtifact({
        artifactHash: createResult.hash!,
        verifierName: 'test.inconclusive',
        requestedBy: 'owner',
      })

      expect(verifyResult.ok).toBe(true)
      expect(verifyResult.verification?.verdict).toBe('inconclusive')
    })

    it('refuses verification by a non-owner principal', async () => {
      const { engine } = createEngine()
      const verifier: FoundryVerifier = {
        name: 'test.pass',
        verify: () => 'PASS',
      }
      engine.registerVerifier(verifier)

      const createResult = await engine.createArtifact({
        runId: 'run_123',
        stepId: 'step_456',
        createdBy: 'owner',
        kind: 'build_output',
        content: { name: 'test-tool' },
      })

      const verifyResult = await engine.verifyArtifact({
        artifactHash: createResult.hash!,
        verifierName: 'test.pass',
        requestedBy: 'system',
      })

      expect(verifyResult.ok).toBe(false)
      expect(verifyResult.reason).toBe('the caller is not authorized to perform this operation')
    })

    it('refuses verification of a non-existent artifact', async () => {
      const { engine } = createEngine()
      const verifier: FoundryVerifier = {
        name: 'test.pass',
        verify: () => 'PASS',
      }
      engine.registerVerifier(verifier)

      const verifyResult = await engine.verifyArtifact({
        artifactHash: 'nonexistent',
        verifierName: 'test.pass',
        requestedBy: 'owner',
      })

      expect(verifyResult.ok).toBe(false)
      expect(verifyResult.reason).toBe('the artifact does not exist')
    })

    it('refuses verification with an unregistered verifier', async () => {
      const { engine } = createEngine()
      const createResult = await engine.createArtifact({
        runId: 'run_123',
        stepId: 'step_456',
        createdBy: 'owner',
        kind: 'build_output',
        content: { name: 'test-tool' },
      })

      const verifyResult = await engine.verifyArtifact({
        artifactHash: createResult.hash!,
        verifierName: 'unregistered',
        requestedBy: 'owner',
      })

      expect(verifyResult.ok).toBe(false)
      expect(verifyResult.reason).toBe('verification evidence is required before this operation')
    })
  })

  describe('promotion', () => {
    it('promotes a verified artifact', async () => {
      const { engine } = createEngine()
      const verifier: FoundryVerifier = {
        name: 'test.pass',
        verify: () => 'PASS',
      }
      engine.registerVerifier(verifier)

      const createResult = await engine.createArtifact({
        runId: 'run_123',
        stepId: 'step_456',
        createdBy: 'owner',
        kind: 'build_output',
        content: { name: 'test-tool' },
      })

      await engine.verifyArtifact({
        artifactHash: createResult.hash!,
        verifierName: 'test.pass',
        requestedBy: 'owner',
      })

      const promoteResult = await engine.promoteArtifact({
        artifactHash: createResult.hash!,
        toStatus: 'promoted',
        promotedBy: 'owner',
        reason: 'verified and ready',
      })

      expect(promoteResult.ok).toBe(true)
      expect(promoteResult.promotion?.toStatus).toBe('promoted')
    })

    it('refuses promotion of an unverified artifact', async () => {
      const { engine } = createEngine()
      const createResult = await engine.createArtifact({
        runId: 'run_123',
        stepId: 'step_456',
        createdBy: 'owner',
        kind: 'build_output',
        content: { name: 'test-tool' },
      })

      const promoteResult = await engine.promoteArtifact({
        artifactHash: createResult.hash!,
        toStatus: 'promoted',
        promotedBy: 'owner',
        reason: 'not verified',
      })

      expect(promoteResult.ok).toBe(false)
      expect(promoteResult.reason).toBe('the artifact has not been verified and cannot be promoted')
    })

    it('refuses promotion by a non-owner principal', async () => {
      const { engine } = createEngine()
      const verifier: FoundryVerifier = {
        name: 'test.pass',
        verify: () => 'PASS',
      }
      engine.registerVerifier(verifier)

      const createResult = await engine.createArtifact({
        runId: 'run_123',
        stepId: 'step_456',
        createdBy: 'owner',
        kind: 'build_output',
        content: { name: 'test-tool' },
      })

      await engine.verifyArtifact({
        artifactHash: createResult.hash!,
        verifierName: 'test.pass',
        requestedBy: 'owner',
      })

      const promoteResult = await engine.promoteArtifact({
        artifactHash: createResult.hash!,
        toStatus: 'promoted',
        promotedBy: 'system',
        reason: 'attempted by system',
      })

      expect(promoteResult.ok).toBe(false)
      expect(promoteResult.reason).toBe('the caller is not authorized to perform this operation')
    })

    it('refuses promotion when the latest verification failed', async () => {
      const { engine } = createEngine()
      engine.registerVerifier({ name: 'test.pass', verify: () => 'PASS' })
      engine.registerVerifier({ name: 'test.fail', verify: () => 'FAIL: regression' })
      const created = await engine.createArtifact({
        runId: 'run_123', stepId: 'step_456', createdBy: 'owner',
        kind: 'build_output', content: { name: 'test-tool' },
      })
      await engine.verifyArtifact({ artifactHash: created.hash!, verifierName: 'test.pass', requestedBy: 'owner' })
      await engine.verifyArtifact({ artifactHash: created.hash!, verifierName: 'test.fail', requestedBy: 'owner' })

      const result = await engine.promoteArtifact({
        artifactHash: created.hash!, toStatus: 'promoted', promotedBy: 'owner', reason: 'ship it',
      })

      expect(result.ok).toBe(false)
      expect(result.reason).toBe('the artifact has not been verified and cannot be promoted')
    })

    it('refuses a forged promotion target at runtime', async () => {
      const { engine } = createEngine()
      const result = await engine.promoteArtifact({
        artifactHash: 'a'.repeat(64),
        toStatus: 'active' as never,
        promotedBy: 'owner',
        reason: 'skip the gate',
      })

      expect(result.ok).toBe(false)
      expect(result.reason).toBe('the requested lifecycle transition is not permitted')
    })
  })

  describe('activation', () => {
    it('activates a promoted artifact', async () => {
      const { engine } = createEngine()
      const verifier: FoundryVerifier = {
        name: 'test.pass',
        verify: () => 'PASS',
      }
      engine.registerVerifier(verifier)

      const createResult = await engine.createArtifact({
        runId: 'run_123',
        stepId: 'step_456',
        createdBy: 'owner',
        kind: 'build_output',
        content: { name: 'test-tool' },
      })

      await engine.verifyArtifact({
        artifactHash: createResult.hash!,
        verifierName: 'test.pass',
        requestedBy: 'owner',
      })

      await engine.promoteArtifact({
        artifactHash: createResult.hash!,
        toStatus: 'promoted',
        promotedBy: 'owner',
        reason: 'verified',
      })

      const activateResult = await engine.activateArtifact({
        artifactHash: createResult.hash!,
        toStatus: 'active',
        activatedBy: 'owner',
        reason: 'ready for use',
      })

      expect(activateResult.ok).toBe(true)
      expect(activateResult.activation?.toStatus).toBe('active')
    })

    it('refuses activation of an unpromoted artifact', async () => {
      const { engine } = createEngine()
      const verifier: FoundryVerifier = {
        name: 'test.pass',
        verify: () => 'PASS',
      }
      engine.registerVerifier(verifier)

      const createResult = await engine.createArtifact({
        runId: 'run_123',
        stepId: 'step_456',
        createdBy: 'owner',
        kind: 'build_output',
        content: { name: 'test-tool' },
      })

      await engine.verifyArtifact({
        artifactHash: createResult.hash!,
        verifierName: 'test.pass',
        requestedBy: 'owner',
      })

      const activateResult = await engine.activateArtifact({
        artifactHash: createResult.hash!,
        toStatus: 'active',
        activatedBy: 'owner',
        reason: 'not promoted',
      })

      expect(activateResult.ok).toBe(false)
      expect(activateResult.reason).toBe('the artifact has not been promoted and cannot be activated')
    })

    it('refuses activation by a non-owner principal', async () => {
      const { engine } = createEngine()
      const verifier: FoundryVerifier = {
        name: 'test.pass',
        verify: () => 'PASS',
      }
      engine.registerVerifier(verifier)

      const createResult = await engine.createArtifact({
        runId: 'run_123',
        stepId: 'step_456',
        createdBy: 'owner',
        kind: 'build_output',
        content: { name: 'test-tool' },
      })

      await engine.verifyArtifact({
        artifactHash: createResult.hash!,
        verifierName: 'test.pass',
        requestedBy: 'owner',
      })

      await engine.promoteArtifact({
        artifactHash: createResult.hash!,
        toStatus: 'promoted',
        promotedBy: 'owner',
        reason: 'verified',
      })

      const activateResult = await engine.activateArtifact({
        artifactHash: createResult.hash!,
        toStatus: 'active',
        activatedBy: 'system',
        reason: 'attempted by system',
      })

      expect(activateResult.ok).toBe(false)
      expect(activateResult.reason).toBe('the caller is not authorized to perform this operation')
    })

    it('refuses forged targets, empty reasons and expired activation windows', async () => {
      const { engine } = createEngine()
      const forgedTarget = await engine.activateArtifact({
        artifactHash: 'a'.repeat(64), toStatus: 'promoted' as never,
        activatedBy: 'owner', reason: 'skip the gate',
      })
      const emptyReason = await engine.activateArtifact({
        artifactHash: 'a'.repeat(64), toStatus: 'active',
        activatedBy: 'owner', reason: '   ',
      })
      const expired = await engine.activateArtifact({
        artifactHash: 'a'.repeat(64), toStatus: 'active',
        activatedBy: 'owner', reason: 'bounded', expiresAt: '2000-01-01T00:00:00.000Z',
      })

      expect(forgedTarget.reason).toBe('the requested lifecycle transition is not permitted')
      expect(emptyReason.reason).toBe('the reason must be non-empty and within the Foundry reason limit')
      expect(expired.reason).toBe('the activation expiry must be a valid future instant')
    })

    it('deactivates explicitly back to promoted state', async () => {
      const { engine } = createEngine()
      engine.registerVerifier({ name: 'test.pass', verify: () => 'PASS' })
      const created = await engine.createArtifact({
        runId: 'run_deactivate', stepId: 'step_deactivate', createdBy: 'owner',
        kind: 'build_output', content: { name: 'reversible' },
      })
      await engine.verifyArtifact({ artifactHash: created.hash!, verifierName: 'test.pass', requestedBy: 'owner' })
      await engine.promoteArtifact({ artifactHash: created.hash!, toStatus: 'promoted', promotedBy: 'owner', reason: 'tested' })
      await engine.activateArtifact({ artifactHash: created.hash!, toStatus: 'active', activatedBy: 'owner', reason: 'approved' })

      const result = await engine.deactivateArtifact({
        artifactHash: created.hash!, deactivatedBy: 'owner', reason: 'turn it off',
      })

      expect(result.ok).toBe(true)
      expect([...engine.getState().artifacts.values()][0]?.status).toBe('promoted')
    })
  })

  describe('tools', () => {
    it('registers a tool', async () => {
      const { engine } = createEngine()
      const result = await engine.registerTool({
        hash: 'abc123',
        name: 'test-tool',
        capability: 'work.execute',
        createdBy: 'owner',
        artifactHash: 'art_123',
      })

      expect(result.ok).toBe(true)
    })

    it('refuses tool registration by a non-owner principal', async () => {
      const { engine } = createEngine()
      const result = await engine.registerTool({
        hash: 'abc123',
        name: 'test-tool',
        capability: 'work.execute',
        createdBy: 'system',
        artifactHash: 'art_123',
      })

      expect(result.ok).toBe(false)
      expect(result.reason).toBe('the caller is not authorized to perform this operation')
    })
  })

  describe('modules', () => {
    it('registers a module', async () => {
      const { engine } = createEngine()
      const result = await engine.registerModule({
        hash: 'abc123',
        name: 'test-module',
        createdBy: 'owner',
        artifactHash: 'art_123',
      })

      expect(result.ok).toBe(true)
    })

    it('refuses module registration by a non-owner principal', async () => {
      const { engine } = createEngine()
      const result = await engine.registerModule({
        hash: 'abc123',
        name: 'test-module',
        createdBy: 'system',
        artifactHash: 'art_123',
      })

      expect(result.ok).toBe(false)
      expect(result.reason).toBe('the caller is not authorized to perform this operation')
    })
  })

  describe('apps', () => {
    it('refuses app registration with an inactive module', async () => {
      const { engine } = createEngine()
      const moduleResult = await engine.registerModule({
        hash: 'mod_123',
        name: 'test-module',
        createdBy: 'owner',
        artifactHash: 'art_123',
      })

      expect(moduleResult.ok).toBe(true)

      const result = await engine.registerApp({
        hash: 'app_123',
        name: 'test-app',
        createdBy: 'owner',
        artifactHash: 'art_456',
        moduleHashes: ['mod_123'],
      })

      expect(result.ok).toBe(false)
      expect(result.reason).toBe('a required module is not active')
    })

    it('refuses app registration with a non-existent module', async () => {
      const { engine } = createEngine()
      const result = await engine.registerApp({
        hash: 'app_123',
        name: 'test-app',
        createdBy: 'owner',
        artifactHash: 'art_456',
        moduleHashes: ['nonexistent'],
      })

      expect(result.ok).toBe(false)
      expect(result.reason).toBe('the module does not exist')
    })

    it('refuses app registration by a non-owner principal', async () => {
      const { engine } = createEngine()
      const result = await engine.registerApp({
        hash: 'app_123',
        name: 'test-app',
        createdBy: 'system',
        artifactHash: 'art_456',
        moduleHashes: [],
      })

      expect(result.ok).toBe(false)
      expect(result.reason).toBe('the caller is not authorized to perform this operation')
    })

    it('can reach active Tool, Module and App states only through their closed graphs', async () => {
      const { engine } = createEngine()
      engine.registerVerifier({ name: 'test.pass', verify: () => 'PASS' })
      const artifact = await engine.createArtifact({
        runId: 'run_entities', stepId: 'step_entities', createdBy: 'owner',
        kind: 'build_output', content: { name: 'entity-backing' },
      })
      await engine.verifyArtifact({ artifactHash: artifact.hash!, verifierName: 'test.pass', requestedBy: 'owner' })
      await engine.promoteArtifact({ artifactHash: artifact.hash!, toStatus: 'promoted', promotedBy: 'owner', reason: 'tested' })
      await engine.activateArtifact({ artifactHash: artifact.hash!, toStatus: 'active', activatedBy: 'owner', reason: 'approved' })

      await engine.registerTool({
        hash: 'tool_lifecycle', name: 'tool', capability: 'work.execute', createdBy: 'owner', artifactHash: artifact.hash!,
      })
      expect((await engine.transitionTool({ hash: 'tool_lifecycle', toStatus: 'active', changedBy: 'owner' })).ok).toBe(false)
      expect((await engine.transitionTool({ hash: 'tool_lifecycle', toStatus: 'verified', changedBy: 'owner' })).ok).toBe(true)
      expect((await engine.transitionTool({ hash: 'tool_lifecycle', toStatus: 'promoted', changedBy: 'owner' })).ok).toBe(true)
      expect((await engine.transitionTool({ hash: 'tool_lifecycle', toStatus: 'active', changedBy: 'owner' })).ok).toBe(true)

      await engine.registerModule({
        hash: 'module_lifecycle', name: 'module', createdBy: 'owner', artifactHash: artifact.hash!,
      })
      expect((await engine.transitionModule({ hash: 'module_lifecycle', toStatus: 'verified', changedBy: 'owner' })).ok).toBe(true)
      expect((await engine.transitionModule({ hash: 'module_lifecycle', toStatus: 'promoted', changedBy: 'owner' })).ok).toBe(true)
      expect((await engine.transitionModule({ hash: 'module_lifecycle', toStatus: 'active', changedBy: 'owner' })).ok).toBe(true)

      expect((await engine.registerApp({
        hash: 'app_lifecycle', name: 'app', createdBy: 'owner', artifactHash: artifact.hash!, moduleHashes: ['module_lifecycle'],
      })).ok).toBe(true)
      expect((await engine.transitionApp({ hash: 'app_lifecycle', toStatus: 'verified', changedBy: 'owner' })).ok).toBe(true)
      expect((await engine.transitionApp({ hash: 'app_lifecycle', toStatus: 'promoted', changedBy: 'owner' })).ok).toBe(true)
      expect((await engine.transitionApp({ hash: 'app_lifecycle', toStatus: 'installed', changedBy: 'owner' })).ok).toBe(true)
      expect((await engine.transitionApp({ hash: 'app_lifecycle', toStatus: 'active', changedBy: 'owner' })).ok).toBe(true)

      expect([...engine.getState().tools.values()][0]?.status).toBe('active')
      expect([...engine.getState().modules.values()][0]?.status).toBe('active')
      expect([...engine.getState().apps.values()][0]?.status).toBe('active')
    })
  })

  describe('limits', () => {
    it('enforces the artifact-per-run ceiling', async () => {
      const { engine } = createEngine()
      for (let i = 0; i < FOUNDRY_LIMITS.maxArtifactsPerRun; i++) {
        const result = await engine.createArtifact({
          runId: 'run_123',
          stepId: 'step_456',
          createdBy: 'owner',
          kind: 'build_output',
          content: { index: i },
        })
        expect(result.ok).toBe(true)
      }

      const overflow = await engine.createArtifact({
        runId: 'run_123',
        stepId: 'step_456',
        createdBy: 'owner',
        kind: 'build_output',
        content: { index: 999 },
      })

      expect(overflow.ok).toBe(false)
      expect(overflow.reason).toBe('the run reached its artifact ceiling')
    })

    it('enforces the verification-per-artifact ceiling', async () => {
      const { engine } = createEngine()
      const verifier: FoundryVerifier = {
        name: 'test.pass',
        verify: () => 'PASS',
      }
      engine.registerVerifier(verifier)

      const createResult = await engine.createArtifact({
        runId: 'run_123',
        stepId: 'step_456',
        createdBy: 'owner',
        kind: 'build_output',
        content: { name: 'test-tool' },
      })

      for (let i = 0; i < FOUNDRY_LIMITS.maxVerificationsPerArtifact; i++) {
        const result = await engine.verifyArtifact({
          artifactHash: createResult.hash!,
          verifierName: 'test.pass',
          requestedBy: 'owner',
        })
        expect(result.ok).toBe(true)
      }

      const overflow = await engine.verifyArtifact({
        artifactHash: createResult.hash!,
        verifierName: 'test.pass',
        requestedBy: 'owner',
      })

      expect(overflow.ok).toBe(false)
      expect(overflow.reason).toBe('the artifact reached its verification ceiling')
    })
  })
})
