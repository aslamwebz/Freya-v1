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
    it('creates an artifact through a Run', () => {
      const { engine } = createEngine()
      const result = engine.createArtifact({
        runId: 'run_123',
        stepId: 'step_456',
        createdBy: 'owner',
        kind: 'build_output',
        content: { name: 'test-tool', version: '1.0.0' },
      })

      expect(result.ok).toBe(true)
      expect(result.hash).toBeDefined()
      expect(result.hash).toHaveLength(16)
    })

    it('refuses creation by a non-owner principal', () => {
      const { engine } = createEngine()
      const result = engine.createArtifact({
        runId: 'run_123',
        stepId: 'step_456',
        createdBy: 'system',
        kind: 'build_output',
        content: { name: 'test-tool' },
      })

      expect(result.ok).toBe(false)
      expect(result.reason).toBe('the caller is not authorized to perform this operation')
    })

    it('refuses creation with non-data content', () => {
      const { engine } = createEngine()
      const result = engine.createArtifact({
        runId: 'run_123',
        stepId: 'step_456',
        createdBy: 'owner',
        kind: 'build_output',
        content: { fn: () => {} },
      })

      expect(result.ok).toBe(false)
      expect(result.reason).toBe('the artifact content is not valid data')
    })

    it('refuses creation with oversized content', () => {
      const { engine } = createEngine()
      const result = engine.createArtifact({
        runId: 'run_123',
        stepId: 'step_456',
        createdBy: 'owner',
        kind: 'build_output',
        content: { data: 'x'.repeat(FOUNDRY_LIMITS.maxContentBytes + 1) },
      })

      expect(result.ok).toBe(false)
      expect(result.reason).toBe('the artifact content is too large')
    })

    it('produces deterministic identity for identical content', () => {
      const { engine } = createEngine()
      const content = { name: 'test-tool', version: '1.0.0' }

      const result1 = engine.createArtifact({
        runId: 'run_123',
        stepId: 'step_456',
        createdBy: 'owner',
        kind: 'build_output',
        content,
      })

      const result2 = engine.createArtifact({
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

    it('produces different identity for different content', () => {
      const { engine } = createEngine()
      const result1 = engine.createArtifact({
        runId: 'run_123',
        stepId: 'step_456',
        createdBy: 'owner',
        kind: 'build_output',
        content: { name: 'test-tool', version: '1.0.0' },
      })

      const result2 = engine.createArtifact({
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

    it('refuses duplicate artifact creation', () => {
      const { engine } = createEngine()
      const content = { name: 'test-tool', version: '1.0.0' }

      const result1 = engine.createArtifact({
        runId: 'run_123',
        stepId: 'step_456',
        createdBy: 'owner',
        kind: 'build_output',
        content,
      })

      const result2 = engine.createArtifact({
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
  })

  describe('verification', () => {
    it('verifies an artifact and derives verdict from evidence', () => {
      const { engine } = createEngine()
      const verifier: FoundryVerifier = {
        name: 'test.pass',
        verify: () => 'PASS: all checks passed',
      }
      engine.registerVerifier(verifier)

      const createResult = engine.createArtifact({
        runId: 'run_123',
        stepId: 'step_456',
        createdBy: 'owner',
        kind: 'build_output',
        content: { name: 'test-tool' },
      })

      expect(createResult.ok).toBe(true)

      const verifyResult = engine.verifyArtifact({
        artifactHash: createResult.hash!,
        verifierName: 'test.pass',
        requestedBy: 'owner',
      })

      expect(verifyResult.ok).toBe(true)
      expect(verifyResult.verification?.verdict).toBe('passed')
      expect(verifyResult.verification?.evidence).toBe('PASS: all checks passed')
    })

    it('derives failed verdict from failing evidence', () => {
      const { engine } = createEngine()
      const verifier: FoundryVerifier = {
        name: 'test.fail',
        verify: () => 'FAIL: spec mismatch',
      }
      engine.registerVerifier(verifier)

      const createResult = engine.createArtifact({
        runId: 'run_123',
        stepId: 'step_456',
        createdBy: 'owner',
        kind: 'build_output',
        content: { name: 'test-tool' },
      })

      const verifyResult = engine.verifyArtifact({
        artifactHash: createResult.hash!,
        verifierName: 'test.fail',
        requestedBy: 'owner',
      })

      expect(verifyResult.ok).toBe(true)
      expect(verifyResult.verification?.verdict).toBe('failed')
    })

    it('derives inconclusive verdict from ambiguous evidence', () => {
      const { engine } = createEngine()
      const verifier: FoundryVerifier = {
        name: 'test.inconclusive',
        verify: () => 'MAYBE: unclear',
      }
      engine.registerVerifier(verifier)

      const createResult = engine.createArtifact({
        runId: 'run_123',
        stepId: 'step_456',
        createdBy: 'owner',
        kind: 'build_output',
        content: { name: 'test-tool' },
      })

      const verifyResult = engine.verifyArtifact({
        artifactHash: createResult.hash!,
        verifierName: 'test.inconclusive',
        requestedBy: 'owner',
      })

      expect(verifyResult.ok).toBe(true)
      expect(verifyResult.verification?.verdict).toBe('inconclusive')
    })

    it('refuses verification by a non-owner principal', () => {
      const { engine } = createEngine()
      const verifier: FoundryVerifier = {
        name: 'test.pass',
        verify: () => 'PASS',
      }
      engine.registerVerifier(verifier)

      const createResult = engine.createArtifact({
        runId: 'run_123',
        stepId: 'step_456',
        createdBy: 'owner',
        kind: 'build_output',
        content: { name: 'test-tool' },
      })

      const verifyResult = engine.verifyArtifact({
        artifactHash: createResult.hash!,
        verifierName: 'test.pass',
        requestedBy: 'system',
      })

      expect(verifyResult.ok).toBe(false)
      expect(verifyResult.reason).toBe('the caller is not authorized to perform this operation')
    })

    it('refuses verification of a non-existent artifact', () => {
      const { engine } = createEngine()
      const verifier: FoundryVerifier = {
        name: 'test.pass',
        verify: () => 'PASS',
      }
      engine.registerVerifier(verifier)

      const verifyResult = engine.verifyArtifact({
        artifactHash: 'nonexistent',
        verifierName: 'test.pass',
        requestedBy: 'owner',
      })

      expect(verifyResult.ok).toBe(false)
      expect(verifyResult.reason).toBe('the artifact does not exist')
    })

    it('refuses verification with an unregistered verifier', () => {
      const { engine } = createEngine()
      const createResult = engine.createArtifact({
        runId: 'run_123',
        stepId: 'step_456',
        createdBy: 'owner',
        kind: 'build_output',
        content: { name: 'test-tool' },
      })

      const verifyResult = engine.verifyArtifact({
        artifactHash: createResult.hash!,
        verifierName: 'unregistered',
        requestedBy: 'owner',
      })

      expect(verifyResult.ok).toBe(false)
      expect(verifyResult.reason).toBe('verification evidence is required before this operation')
    })
  })

  describe('promotion', () => {
    it('promotes a verified artifact', () => {
      const { engine } = createEngine()
      const verifier: FoundryVerifier = {
        name: 'test.pass',
        verify: () => 'PASS',
      }
      engine.registerVerifier(verifier)

      const createResult = engine.createArtifact({
        runId: 'run_123',
        stepId: 'step_456',
        createdBy: 'owner',
        kind: 'build_output',
        content: { name: 'test-tool' },
      })

      engine.verifyArtifact({
        artifactHash: createResult.hash!,
        verifierName: 'test.pass',
        requestedBy: 'owner',
      })

      const promoteResult = engine.promoteArtifact({
        artifactHash: createResult.hash!,
        toStatus: 'promoted',
        promotedBy: 'owner',
        reason: 'verified and ready',
      })

      expect(promoteResult.ok).toBe(true)
      expect(promoteResult.promotion?.toStatus).toBe('promoted')
    })

    it('refuses promotion of an unverified artifact', () => {
      const { engine } = createEngine()
      const createResult = engine.createArtifact({
        runId: 'run_123',
        stepId: 'step_456',
        createdBy: 'owner',
        kind: 'build_output',
        content: { name: 'test-tool' },
      })

      const promoteResult = engine.promoteArtifact({
        artifactHash: createResult.hash!,
        toStatus: 'promoted',
        promotedBy: 'owner',
        reason: 'not verified',
      })

      expect(promoteResult.ok).toBe(false)
      expect(promoteResult.reason).toBe('the artifact has not been verified and cannot be promoted')
    })

    it('refuses promotion by a non-owner principal', () => {
      const { engine } = createEngine()
      const verifier: FoundryVerifier = {
        name: 'test.pass',
        verify: () => 'PASS',
      }
      engine.registerVerifier(verifier)

      const createResult = engine.createArtifact({
        runId: 'run_123',
        stepId: 'step_456',
        createdBy: 'owner',
        kind: 'build_output',
        content: { name: 'test-tool' },
      })

      engine.verifyArtifact({
        artifactHash: createResult.hash!,
        verifierName: 'test.pass',
        requestedBy: 'owner',
      })

      const promoteResult = engine.promoteArtifact({
        artifactHash: createResult.hash!,
        toStatus: 'promoted',
        promotedBy: 'system',
        reason: 'attempted by system',
      })

      expect(promoteResult.ok).toBe(false)
      expect(promoteResult.reason).toBe('the caller is not authorized to perform this operation')
    })
  })

  describe('activation', () => {
    it('activates a promoted artifact', () => {
      const { engine } = createEngine()
      const verifier: FoundryVerifier = {
        name: 'test.pass',
        verify: () => 'PASS',
      }
      engine.registerVerifier(verifier)

      const createResult = engine.createArtifact({
        runId: 'run_123',
        stepId: 'step_456',
        createdBy: 'owner',
        kind: 'build_output',
        content: { name: 'test-tool' },
      })

      engine.verifyArtifact({
        artifactHash: createResult.hash!,
        verifierName: 'test.pass',
        requestedBy: 'owner',
      })

      engine.promoteArtifact({
        artifactHash: createResult.hash!,
        toStatus: 'promoted',
        promotedBy: 'owner',
        reason: 'verified',
      })

      const activateResult = engine.activateArtifact({
        artifactHash: createResult.hash!,
        toStatus: 'active',
        activatedBy: 'owner',
        reason: 'ready for use',
      })

      expect(activateResult.ok).toBe(true)
      expect(activateResult.activation?.toStatus).toBe('active')
    })

    it('refuses activation of an unpromoted artifact', () => {
      const { engine } = createEngine()
      const verifier: FoundryVerifier = {
        name: 'test.pass',
        verify: () => 'PASS',
      }
      engine.registerVerifier(verifier)

      const createResult = engine.createArtifact({
        runId: 'run_123',
        stepId: 'step_456',
        createdBy: 'owner',
        kind: 'build_output',
        content: { name: 'test-tool' },
      })

      engine.verifyArtifact({
        artifactHash: createResult.hash!,
        verifierName: 'test.pass',
        requestedBy: 'owner',
      })

      const activateResult = engine.activateArtifact({
        artifactHash: createResult.hash!,
        toStatus: 'active',
        activatedBy: 'owner',
        reason: 'not promoted',
      })

      expect(activateResult.ok).toBe(false)
      expect(activateResult.reason).toBe('the artifact has not been promoted and cannot be activated')
    })

    it('refuses activation by a non-owner principal', () => {
      const { engine } = createEngine()
      const verifier: FoundryVerifier = {
        name: 'test.pass',
        verify: () => 'PASS',
      }
      engine.registerVerifier(verifier)

      const createResult = engine.createArtifact({
        runId: 'run_123',
        stepId: 'step_456',
        createdBy: 'owner',
        kind: 'build_output',
        content: { name: 'test-tool' },
      })

      engine.verifyArtifact({
        artifactHash: createResult.hash!,
        verifierName: 'test.pass',
        requestedBy: 'owner',
      })

      engine.promoteArtifact({
        artifactHash: createResult.hash!,
        toStatus: 'promoted',
        promotedBy: 'owner',
        reason: 'verified',
      })

      const activateResult = engine.activateArtifact({
        artifactHash: createResult.hash!,
        toStatus: 'active',
        activatedBy: 'system',
        reason: 'attempted by system',
      })

      expect(activateResult.ok).toBe(false)
      expect(activateResult.reason).toBe('the caller is not authorized to perform this operation')
    })
  })

  describe('tools', () => {
    it('registers a tool', () => {
      const { engine } = createEngine()
      const result = engine.registerTool({
        hash: 'abc123',
        name: 'test-tool',
        capability: 'work.execute',
        createdBy: 'owner',
        artifactHash: 'art_123',
      })

      expect(result.ok).toBe(true)
    })

    it('refuses tool registration by a non-owner principal', () => {
      const { engine } = createEngine()
      const result = engine.registerTool({
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
    it('registers a module', () => {
      const { engine } = createEngine()
      const result = engine.registerModule({
        hash: 'abc123',
        name: 'test-module',
        createdBy: 'owner',
        artifactHash: 'art_123',
      })

      expect(result.ok).toBe(true)
    })

    it('refuses module registration by a non-owner principal', () => {
      const { engine } = createEngine()
      const result = engine.registerModule({
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
    it('refuses app registration with an inactive module', () => {
      const { engine } = createEngine()
      const moduleResult = engine.registerModule({
        hash: 'mod_123',
        name: 'test-module',
        createdBy: 'owner',
        artifactHash: 'art_123',
      })

      expect(moduleResult.ok).toBe(true)

      const result = engine.registerApp({
        hash: 'app_123',
        name: 'test-app',
        createdBy: 'owner',
        artifactHash: 'art_456',
        moduleHashes: ['mod_123'],
      })

      expect(result.ok).toBe(false)
      expect(result.reason).toBe('a required module is not active')
    })

    it('refuses app registration with a non-existent module', () => {
      const { engine } = createEngine()
      const result = engine.registerApp({
        hash: 'app_123',
        name: 'test-app',
        createdBy: 'owner',
        artifactHash: 'art_456',
        moduleHashes: ['nonexistent'],
      })

      expect(result.ok).toBe(false)
      expect(result.reason).toBe('the module does not exist')
    })

    it('refuses app registration by a non-owner principal', () => {
      const { engine } = createEngine()
      const result = engine.registerApp({
        hash: 'app_123',
        name: 'test-app',
        createdBy: 'system',
        artifactHash: 'art_456',
        moduleHashes: [],
      })

      expect(result.ok).toBe(false)
      expect(result.reason).toBe('the caller is not authorized to perform this operation')
    })
  })

  describe('limits', () => {
    it('enforces the artifact-per-run ceiling', () => {
      const { engine } = createEngine()
      for (let i = 0; i < FOUNDRY_LIMITS.maxArtifactsPerRun; i++) {
        const result = engine.createArtifact({
          runId: 'run_123',
          stepId: 'step_456',
          createdBy: 'owner',
          kind: 'build_output',
          content: { index: i },
        })
        expect(result.ok).toBe(true)
      }

      const overflow = engine.createArtifact({
        runId: 'run_123',
        stepId: 'step_456',
        createdBy: 'owner',
        kind: 'build_output',
        content: { index: 999 },
      })

      expect(overflow.ok).toBe(false)
      expect(overflow.reason).toBe('the run reached its artifact ceiling')
    })

    it('enforces the verification-per-artifact ceiling', () => {
      const { engine } = createEngine()
      const verifier: FoundryVerifier = {
        name: 'test.pass',
        verify: () => 'PASS',
      }
      engine.registerVerifier(verifier)

      const createResult = engine.createArtifact({
        runId: 'run_123',
        stepId: 'step_456',
        createdBy: 'owner',
        kind: 'build_output',
        content: { name: 'test-tool' },
      })

      for (let i = 0; i < FOUNDRY_LIMITS.maxVerificationsPerArtifact; i++) {
        const result = engine.verifyArtifact({
          artifactHash: createResult.hash!,
          verifierName: 'test.pass',
          requestedBy: 'owner',
        })
        expect(result.ok).toBe(true)
      }

      const overflow = engine.verifyArtifact({
        artifactHash: createResult.hash!,
        verifierName: 'test.pass',
        requestedBy: 'owner',
      })

      expect(overflow.ok).toBe(false)
      expect(overflow.reason).toBe('the artifact reached its verification ceiling')
    })
  })
})
