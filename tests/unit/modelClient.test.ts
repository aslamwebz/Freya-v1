// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readModelCatalog, selectModel } from '../../src/platform/modelClient'
import { resetCoreMirror } from '../../src/platform/coreClient'
import type { CoreCommandResult } from '../../core/protocol/core-protocol'

/**
 * The model lane from the window's side.
 *
 * Three properties worth pinning, all about not lying:
 *
 *   - a command whose reply has no model outcome becomes an *honest refusal*,
 *     not an empty catalogue and not a thrown rejection;
 *   - `selectModel(null)` spells "back to the default" as an empty payload —
 *     absence is a real instruction, and flattening it to a refusal would make
 *     the default unspellable;
 *   - a window with no bridge resolves rather than throwing, because every
 *     call site is a React effect that cannot be made to catch.
 */

let coreSubmit: ReturnType<typeof vi.fn>

function bridge(result: Partial<CoreCommandResult>): void {
  coreSubmit = vi.fn(async (_command: string, _payload?: unknown) => ({
    requestId: 'r1',
    ok: true,
    ...result,
  }))
  window.freyaHost = {
    isDesktop: true,
    coreSubmit: coreSubmit as never,
  } as never
}

beforeEach(() => {
  resetCoreMirror()
})

afterEach(() => {
  delete window.freyaHost
  resetCoreMirror()
})

describe('readModelCatalog', () => {
  it('returns exactly what Core said', async () => {
    bridge({
      model: {
        operation: 'catalog',
        models: [{ id: 'anthropic/claude-sonnet-5', ownedBy: 'anthropic' }],
        defaultModel: 'openai/gpt-4.1-nano',
        selected: null,
      },
    })
    const outcome = await readModelCatalog()
    expect(outcome.operation).toBe('catalog')
    expect(outcome.models).toEqual([{ id: 'anthropic/claude-sonnet-5', ownedBy: 'anthropic' }])
    expect(coreSubmit).toHaveBeenCalledWith('model.catalog.read', undefined)
  })

  it('carries Core refusal sentences through instead of inventing empties', async () => {
    bridge({
      ok: false,
      refusal: { reason: 'no configured provider can list models' },
      model: { operation: 'refused', reason: 'no configured provider can list models' },
    })
    const outcome = await readModelCatalog()
    expect(outcome.operation).toBe('refused')
    expect(outcome.reason).toBe('no configured provider can list models')
    expect(outcome.models).toBeUndefined()
  })

  it('reports a missing bridge as a refusal, not a rejection', async () => {
    // No `window.freyaHost` at all: the browser, the test runner, a preview.
    const outcome = await readModelCatalog()
    expect(outcome.operation).toBe('refused')
    expect(outcome.reason).toMatch(/core bridge unavailable/i)
  })
})

describe('selectModel', () => {
  it('names a model with its id', async () => {
    bridge({ model: { operation: 'selected', selected: 'anthropic/claude-sonnet-5' } })
    const outcome = await selectModel('anthropic/claude-sonnet-5')
    expect(outcome.operation).toBe('selected')
    expect(outcome.selected).toBe('anthropic/claude-sonnet-5')
    expect(coreSubmit).toHaveBeenCalledWith('model.select', { model: 'anthropic/claude-sonnet-5' })
  })

  it('spells the default as absence, which Core reads as clearing', async () => {
    bridge({ model: { operation: 'selected', selected: null } })
    const outcome = await selectModel(null)
    expect(outcome.operation).toBe('selected')
    expect(outcome.selected).toBeNull()
    expect(coreSubmit).toHaveBeenCalledWith('model.select', {})
  })

  it('a refused selection is Core\'s sentence, kept whole', async () => {
    const reason = 'no configured provider can serve model "ghost/model"'
    bridge({
      ok: false,
      refusal: { reason },
      model: { operation: 'refused', reason, selected: 'openai/gpt-4.1-nano' },
    })
    const outcome = await selectModel('ghost/model')
    expect(outcome.operation).toBe('refused')
    expect(outcome.reason).toBe(reason)
    // And what it says it kept is what it says: the caller's view of the old
    // selection comes from Core's field, not from this module's memory.
    expect(outcome.selected).toBe('openai/gpt-4.1-nano')
  })
})
