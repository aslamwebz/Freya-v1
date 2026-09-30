import { createHash } from 'node:crypto'

/**
 * A deterministic conversation key for tests.
 *
 * Derived from a constant so a test key is stable across runs and a test can
 * prove that a *different* key fails, while being obviously not a production
 * secret: it is a digest of a sentence that is published in this file.
 *
 * The value is never logged and never asserted on, only used. Nothing outside
 * tests imports this module.
 */
export function testConversationKey(seed = 'freya-test-conversation-key'): Uint8Array {
  return new Uint8Array(createHash('sha256').update(seed, 'utf8').digest())
}
