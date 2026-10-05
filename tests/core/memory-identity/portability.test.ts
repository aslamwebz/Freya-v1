// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { MEMORY_BUNDLE_KIND, MEMORY_BUNDLE_VERSION } from '../../../core/memory-identity/portability'
import { OWNER_CHANNEL } from '../../../core/memory-identity/types'
import {
  HOSTILE_PASSPHRASE,
  admit,
  admitMany,
  beginScratch,
  bundleBody,
  bundleMemory,
  endScratch,
  harness,
  sealArbitraryBundle,
  type Harness,
} from './fixture'

/**
 * Portable memory: encrypted, verified, migratable, and powerless.
 *
 * The properties under test are the ones an owner is entitled to rely on when they
 * move Freya to another machine:
 *
 *  1. **A bundle round-trips.** Export, import into a *different* Brain, and the
 *     memories and pinning decisions arrive.
 *  2. **A bundle is sealed.** The envelope on disk contains no recognisable content,
 *     a wrong key fails, a tampered header fails, and an unknown version is refused
 *     rather than guessed at.
 *  3. **A bundle cannot grant anything.** Any authority-shaped or identity-shaped
 *     key refuses the *whole* import, so nothing is half-applied.
 *  4. **A bundle cannot lie about its own trust.** Every record arrives forced to the
 *     lowest source class, capped in confidence, and never `verified` — and each
 *     downgrade is reported rather than applied silently.
 */

let h: Harness

beforeAll(beginScratch)
afterAll(endScratch)

beforeEach(async () => {
  h = await harness()
})

describe('export', () => {
  it('seals memories and reports what it left out', async () => {
    await admitMany(h, [
      { subject: 'the lease', content: 'the lease runs to March' },
      { subject: 'the vet', content: 'the vet is called on Thursdays' },
    ])

    const result = await h.memoryIdentity.exportBundle()

    expect(result.ok).toBe(true)
    expect(result.envelope?.kind).toBe(MEMORY_BUNDLE_KIND)
    expect(result.envelope?.v).toBe(MEMORY_BUNDLE_VERSION)
    expect(result.manifest?.memoryCount).toBe(2)
    expect(result.manifest?.encrypted).toBe(true)
    // The omissions are stated, because a bundle that silently drops the identity
    // root and every permission looks like a complete copy of Freya.
    const omitted = result.manifest?.omitted.join(' ') ?? ''
    expect(omitted).toContain('identity root')
    expect(omitted).toContain('authority')
  })

  it('puts no recognisable content in the envelope', async () => {
    await admit(h)

    const result = await h.memoryIdentity.exportBundle()

    const serialised = JSON.stringify(result.envelope)
    expect(serialised).not.toContain('Lisbon')
    expect(serialised).not.toContain('offshore')
  })

  it('works with a passphrase as well as a key', async () => {
    await admit(h)

    const result = await h.memoryIdentity.exportBundle('a phrase the owner can remember')

    expect(result.ok).toBe(true)
    expect(result.envelope?.kdf?.name).toBe('scrypt')
  })
})

describe('import', () => {
  it('round-trips into a different Brain, including pinning', async () => {
    const id = await admit(h, { subject: 'the boat', content: 'the boat is called Marigold' })
    await h.memoryIdentity.ownerRequest({ action: 'pin', channel: OWNER_CHANNEL, memoryId: id, reason: 'always relevant' })
    const exported = await h.memoryIdentity.exportBundle()
    expect(exported.envelope).not.toBeNull()
    await h.dispose()

    const elsewhere = await harness()
    try {
      const result = await elsewhere.memoryIdentity.importBundle(exported.envelope, { channel: OWNER_CHANNEL })

      expect(result.ok).toBe(true)
      expect(result.report?.admitted).toBe(1)
      expect(result.report?.pinnedRestored).toBe(1)
      expect(elsewhere.brain.state().memories.size).toBe(1)
      expect(elsewhere.memoryIdentity.projection().pinned).toHaveLength(1)
    } finally {
      await elsewhere.dispose()
    }
  })

  it('refuses a bundle sealed with another key, and reports nothing imported', async () => {
    const other = await harness({ bundleKey: new Uint8Array(32).fill(7) })
    try {
      await admit(other)
      const sealed = await other.memoryIdentity.exportBundle()
      expect(sealed.envelope).not.toBeNull()

      const result = await h.memoryIdentity.importBundle(sealed.envelope, { channel: OWNER_CHANNEL })

      expect(result.ok).toBe(false)
      if (result.refusal === null) return
      expect(result.refusal.code).toBe('bundle_unreadable')
      expect(h.brain.state().memories.size).toBe(0)
    } finally {
      await other.dispose()
    }
  })

  it('refuses a tampered header rather than believing the new label', async () => {
    await admit(h)
    const sealed = await h.memoryIdentity.exportBundle()
    expect(sealed.envelope).not.toBeNull()

    const tampered = { ...sealed.envelope, exportedAt: '2020-01-01T00:00:00.000Z' }
    const result = await h.memoryIdentity.importBundle(tampered, { channel: OWNER_CHANNEL })

    // The header is authenticated as AAD, so re-labelling a bundle fails to open.
    expect(result.ok).toBe(false)
    if (result.refusal === null) return
    expect(result.refusal.code).toBe('bundle_unreadable')
  })

  it('refuses a file that is not a memory bundle', async () => {
    const result = await h.memoryIdentity.importBundle({ hello: 'world' }, { channel: OWNER_CHANNEL })

    expect(result.ok).toBe(false)
    if (result.refusal === null) return
    expect(result.refusal.code).toBe('bundle_malformed')
  })

  it('refuses a version this build does not read, rather than guessing', async () => {
    await admit(h)
    const sealed = await h.memoryIdentity.exportBundle()
    const future = { ...sealed.envelope, v: 99 }

    const result = await h.memoryIdentity.importBundle(future, { channel: OWNER_CHANNEL })

    expect(result.ok).toBe(false)
    if (result.refusal === null) return
    expect(result.refusal.code).toBe('bundle_version_unknown')
    expect(result.refusal.reason).toContain('99')
  })

  it('refuses an import that does not come from the owner', async () => {
    const sealed = await h.memoryIdentity.exportBundle()

    const result = await h.memoryIdentity.importBundle(sealed.envelope, {
      channel: 'not-the-owner' as typeof OWNER_CHANNEL,
    })

    expect(result.ok).toBe(false)
    if (result.refusal === null) return
    expect(result.refusal.code).toBe('not_an_owner_request')
  })

  it('refuses the whole bundle when a record carries a credential', async () => {
    // Sealed by hand rather than exported, because the Brain's own admission policy
    // already refuses secret-shaped text — so an exported bundle could never contain
    // one, and testing the import against it would prove nothing.
    const bundle = await sealArbitraryBundle(
      bundleBody([
        bundleMemory({
          content: 'the api key for the weather service is sk-abcdefghijklmnopqrstuvwx',
        }),
      ]),
    )

    const result = await h.memoryIdentity.importBundle(bundle, {
      channel: OWNER_CHANNEL,
      passphrase: HOSTILE_PASSPHRASE,
    })

    expect(result.ok).toBe(false)
    if (result.refusal === null) return
    expect(result.refusal.code).toBe('secret_shaped_content')
    // Whole-bundle refusal: nothing half-applied.
    expect(h.brain.state().memories.size).toBe(0)
  })

  it('refuses the whole bundle when it carries a permission', async () => {
    const bundle = await sealArbitraryBundle(
      bundleBody([bundleMemory({ structuredData: { grants: 'unlimited shell access' } })]),
    )

    const result = await h.memoryIdentity.importBundle(bundle, {
      channel: OWNER_CHANNEL,
      passphrase: HOSTILE_PASSPHRASE,
    })

    expect(result.ok).toBe(false)
    if (result.refusal === null) return
    expect(result.refusal.code).toBe('authority_not_importable')
    expect(h.brain.state().memories.size).toBe(0)
  })

  it('admits an ordinary bundle only as weak evidence, and reports every downgrade', async () => {
    const bundle = await sealArbitraryBundle(bundleBody([bundleMemory()]))

    const result = await h.memoryIdentity.importBundle(bundle, {
      channel: OWNER_CHANNEL,
      passphrase: HOSTILE_PASSPHRASE,
    })

    expect(result.ok).toBe(true)
    // The bundle claimed owner-assertion, high confidence and verified status.
    expect(result.report?.adjusted.length).toBeGreaterThanOrEqual(3)
    expect(result.report?.sourceForced).toBe('imported-document')

    const imported = [...h.brain.state().memories.values()][0]
    expect(imported?.source).toBe('imported-document')
    expect(imported?.confidence).toBe('low')
    expect(imported?.provenance.verificationStatus).not.toBe('verified')
  })

  it('cannot be made to overwrite an existing memory by reusing its id', async () => {
    const existing = await admit(h, { subject: 'the lease', content: 'the lease runs to March' })

    const bundle = await sealArbitraryBundle(
      bundleBody([bundleMemory({ memoryId: existing, subject: 'the lease', content: 'the lease runs to April' })]),
    )
    const result = await h.memoryIdentity.importBundle(bundle, {
      channel: OWNER_CHANNEL,
      passphrase: HOSTILE_PASSPHRASE,
    })

    expect(result.ok).toBe(true)
    // The pre-existing memory is untouched, and the bundle's claim arrived beside it
    // as a separate, weakly-sourced record.
    expect(h.brain.state().memories.get(existing)?.content).toBe('the lease runs to March')
    expect(h.brain.state().memories.size).toBe(2)
  })
})
