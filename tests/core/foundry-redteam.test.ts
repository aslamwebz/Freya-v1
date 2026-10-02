// @vitest-environment node

import { describe, expect, it } from 'vitest'

import type { AnyCoreEvent } from '../../core/events/envelope'

import { FoundryEngine } from '../../core/foundry/engine'

import type { FoundryVerifier } from '../../core/foundry/engine'

import { FOUNDRY_LIMITS } from '../../core/foundry/types'

/**
 * FOUNDRY RED TEAM.
 *
 * These tests attack the Foundry's security boundaries:
 *
 *  1. **Forged verification.** A verifier that claims "passed" without
 *     evidence must not be able to mark an artifact as verified.
 *
 *  2. **Path escape.** An artifact's content must not be able to escape its
 *     sanitised boundary.
 *
 *  3. **Capability laundering.** A tool must not be able to launder a
 *     capability it does not hold.
 *
 *  4. **Fake progress.** A model claim must not be able to mark work as
 *     verified without evidence.
 *
 *  5. **Stale evidence.** An old verification must not be able to promote an
 *     artifact that has since changed.
 *
 *  6. **Activation bypass.** An artifact must not be able to become active
 *     without explicit owner authorization.
 *
 *  7. **Private leakage.** An artifact's content must not leak into the
 *     journal.
 *
 *  8. **Model-call amplification.** A verifier must not be able to make
 *     unbounded model calls.
 *
 */

describe('Foundry red team', () => {
  function createEngine() {
    const events: AnyCoreEvent[] = []
    const engine = new FoundryEngine((event) => {
      events.push(event)
    })
    return { engine, events }
  }

  describe('forged verification', () => {
    it('refuses a verifier that claims passed without evidence', () => {
      const { engine } = createEngine()
      const verifier: FoundryVerifier = {
        name: 'forged.pass',
        verify: () => '',
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
        verifierName: 'forged.pass',
        requestedBy: 'owner',
      })

      expect(verifyResult.ok).toBe(true)
      expect(verifyResult.verification?.verdict).toBe('inconclusive')
    })

    it('refuses a verifier that claims passed with ambiguous evidence', () => {
      const { engine } = createEngine()
      const verifier: FoundryVerifier = {
        name: 'forged.ambiguous',
        verify: () => 'UNCLEAR',
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
        verifierName: 'forged.ambiguous',
        requestedBy: 'owner',
      })

      expect(verifyResult.ok).toBe(true)
      expect(verifyResult.verification?.verdict).toBe('inconclusive')
    })

    it('does not transition artifact to verified on inconclusive verdict', () => {
      const { engine } = createEngine()
      const verifier: FoundryVerifier = {
        name: 'forged.inconclusive',
        verify: () => 'UNCLEAR',
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
        verifierName: 'forged.inconclusive',
        requestedBy: 'owner',
      })

      const promoteResult = engine.promoteArtifact({
        artifactHash: createResult.hash!,
        toStatus: 'promoted',
        promotedBy: 'owner',
        reason: 'attempted promotion',
      })

      expect(promoteResult.ok).toBe(false)
      expect(promoteResult.reason).toBe('the artifact has not been verified and cannot be promoted')
    })
  })

  describe('path escape', () => {
    it('refuses content with constructor key', () => {
      const { engine } = createEngine()
      const result = engine.createArtifact({
        runId: 'run_123',
        stepId: 'step_456',
        createdBy: 'owner',
        kind: 'build_output',
        content: { constructor: { polluted: true } },
      })

      expect(result.ok).toBe(false)
    })

    it('refuses content with constructor key', () => {
      const { engine } = createEngine()
      const result = engine.createArtifact({
        runId: 'run_123',
        stepId: 'step_456',
        createdBy: 'owner',
        kind: 'build_output',
        content: { constructor: { polluted: true } },
      })

      expect(result.ok).toBe(false)
    })

    it('refuses content with nested objects', () => {
      const { engine } = createEngine()
      const result = engine.createArtifact({
        runId: 'run_123',
        stepId: 'step_456',
        createdBy: 'owner',
        kind: 'build_output',
        content: { nested: { deep: { deeper: 'value' } } },
      })

      expect(result.ok).toBe(false)
    })

    it('refuses content with arrays', () => {
      const { engine } = createEngine()
      const result = engine.createArtifact({
        runId: 'run_123',
        stepId: 'step_456',
        createdBy: 'owner',
        kind: 'build_output',
        content: { arr: [1, 2, 3] },
      })

      expect(result.ok).toBe(false)
    })

    it('refuses content with functions', () => {
      const { engine } = createEngine()
      const result = engine.createArtifact({
        runId: 'run_123',
        stepId: 'step_456',
        createdBy: 'owner',
        kind: 'build_output',
        content: { fn: () => 'malicious' },
      })

      expect(result.ok).toBe(false)
    })
  })

  describe('capability laundering', () => {
    it('refuses tool registration with a capability the owner does not hold', () => {
      const { engine } = createEngine()
      const result = engine.registerTool({
        hash: 'abc123',
        name: 'test-tool',
        capability: 'security.stop',
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

  describe('fake progress', () => {
    it('refuses promotion without verification evidence', () => {
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
        reason: 'no verification',
      })

      expect(promoteResult.ok).toBe(false)
      expect(promoteResult.reason).toBe('the artifact has not been verified and cannot be promoted')
    })

    it('refuses activation without promotion', () => {
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
        reason: 'no promotion',
      })

      expect(activateResult.ok).toBe(false)
      expect(activateResult.reason).toBe('the artifact has not been promoted and cannot be activated')
    })
  })

  describe('stale evidence', () => {
    it('refuses promotion when artifact content has changed', () => {
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
        content: { name: 'test-tool', version: '1.0.0' },
      })

      engine.verifyArtifact({
        artifactHash: createResult.hash!,
        verifierName: 'test.pass',
        requestedBy: 'owner',
      })

      const createResult2 = engine.createArtifact({
        runId: 'run_123',
        stepId: 'step_456',
        createdBy: 'owner',
        kind: 'build_output',
        content: { name: 'test-tool', version: '2.0.0' },
      })

      const promoteResult = engine.promoteArtifact({
        artifactHash: createResult2.hash!,
        toStatus: 'promoted',
        promotedBy: 'owner',
        reason: 'stale evidence',
      })

      expect(promoteResult.ok).toBe(false)
    })
  })

  describe('activation bypass', () => {
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
        reason: 'attempted bypass',
      })

      expect(activateResult.ok).toBe(false)
      expect(activateResult.reason).toBe('the caller is not authorized to perform this operation')
    })

    it('refuses activation of an already active artifact', () => {
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

      engine.activateArtifact({
        artifactHash: createResult.hash!,
        toStatus: 'active',
        activatedBy: 'owner',
        reason: 'first activation',
      })

      const secondActivation = engine.activateArtifact({
        artifactHash: createResult.hash!,
        toStatus: 'active',
        activatedBy: 'owner',
        reason: 'second activation',
      })

      expect(secondActivation.ok).toBe(false)
    })
  })

  describe('private leakage', () => {
    it('does not leak artifact content into the journal', () => {
      const { engine, events } = createEngine()
      engine.createArtifact({
        runId: 'run_123',
        stepId: 'step_456',
        createdBy: 'owner',
        kind: 'build_output',
        content: { name: 'secret-tool', secret: 'password123' },
      })

      const contentEvent = events.find((e) => e.type === 'foundry.artifact.created')
      expect(contentEvent).toBeDefined()
      expect(JSON.stringify(contentEvent)).not.toContain('secret-tool')
      expect(JSON.stringify(contentEvent)).not.toContain('password123')
    })

    it('does not leak full verification evidence into the journal', () => {
      const { engine, events } = createEngine()
      const verifier: FoundryVerifier = {
        name: 'test.pass',
        verify: () => 'PASS: '.repeat(100),
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

      const verificationEvent = events.find((e) => e.type === 'foundry.verification.recorded')
      expect(verificationEvent).toBeDefined()
      const evidence = (verificationEvent as { payload: { evidence: string } }).payload.evidence
      expect(evidence.length).toBeLessThanOrEqual(FOUNDRY_LIMITS.maxSummaryChars)
    })
  })

  describe('model-call amplification', () => {
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

    it('enforces the promotion-per-artifact ceiling', () => {
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
        reason: 'test',
      })

      expect(promoteResult.ok).toBe(true)

      const overflow = engine.promoteArtifact({
        artifactHash: createResult.hash!,
        toStatus: 'promoted',
        promotedBy: 'owner',
        reason: 'test',
      })

      expect(overflow.ok).toBe(false)
    })
  })
})
