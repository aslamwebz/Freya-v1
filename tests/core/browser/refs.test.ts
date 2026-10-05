import { describe, expect, it } from 'vitest'
import {
  RefTable,
  auditRefMinting,
  describePage,
  mintRef,
} from '../../../core/browser'
import { normaliseSurfacePolicy, normaliseDeviceAction } from '../../../core/devicehands'

/**
 * Every described locator is run through the **real** Phase 35 gate.
 *
 * This is the assertion that makes "a description never offers something the gate would
 * refuse" true rather than hopeful: `describePage` and the gate keep their own copies of the
 * selector rule, and the only way to know the copies still agree is to feed one to the other.
 */
const POLICY_READING = normaliseSurfacePolicy({
  allowedRoots: ['/tmp/freya'],
  deniedRoots: ['/freya/vault'],
  allowedHosts: ['example.com'],
  allowedCommands: ['echo'],
  allowedEnvNames: ['LANG'],
})
if (!POLICY_READING.ok) throw new Error(`setup failed: ${POLICY_READING.reason}`)
const POLICY = POLICY_READING.policy

describe('stable references', () => {
  it('binds a reference to a page id and a revision', () => {
    expect(auditRefMinting()).toEqual([])
  })

  it('gives two elements on one page different references', () => {
    const described = describePage(
      {
        elements: [
          { kind: 'button', label: 'Continue', selector: '#continue' },
          { kind: 'link', label: 'Terms', selector: '#terms' },
        ],
      },
      { pageId: 'page-1', revision: 1, url: 'https://example.com/' },
    )
    expect(described.ok).toBe(true)
    if (!described.ok) return
    const [first, second] = described.elements
    expect(first?.ref).not.toBe(second?.ref)
    expect(first?.ref.startsWith('r1-')).toBe(true)
  })

  it('drops an element it cannot describe rather than coercing it', () => {
    const described = describePage(
      {
        elements: [
          { kind: 'button', label: 'Continue', selector: '#continue' },
          { kind: 'nonsense', label: 'Unknown', selector: '#x' },
          { kind: 'link', label: 'Bad', selector: 'a[onclick=alert(1)]' },
          { kind: 'link', label: 'No locator', selector: '' },
          null,
        ],
      },
      { pageId: 'page-1', revision: 1, url: 'https://example.com/' },
    )
    expect(described.ok).toBe(true)
    if (!described.ok) return
    expect(described.snapshot.elements).toHaveLength(1)
    expect(described.snapshot.truncated).toBe(true)
  })

  it('never offers a locator the Device Hands gate would refuse', () => {
    const selectors = ['#continue', 'a[name="terms"]', 'button.primary', 'h1', 'input#search', 'p', 'a', '#a_b-c.d']
    const described = describePage(
      { elements: selectors.map((selector) => ({ kind: 'link', label: selector, selector })) },
      { pageId: 'page-1', revision: 1, url: 'https://example.com/' },
    )
    expect(described.ok).toBe(true)
    if (!described.ok) return
    for (const element of described.elements) {
      const reading = normaliseDeviceAction(POLICY, 'browser.click', {
        url: 'https://example.com/',
        selector: element.selector,
      })
      expect(reading.ok, `${element.selector}: ${reading.ok ? '' : reading.reason}`).toBe(true)
    }
  })

  it('bounds the text and reports the byte count rather than the content', () => {
    const described = describePage({ elements: [], text: 'x'.repeat(50_000) }, {
      pageId: 'page-1',
      revision: 1,
      url: 'https://example.com/',
    })
    expect(described.ok).toBe(true)
    if (!described.ok) return
    expect(described.snapshot.textBytes).toBeLessThanOrEqual(4096)
    expect(described.snapshot.truncated).toBe(true)
    expect(Object.keys(described.snapshot)).not.toContain('text')
  })
})

describe('the reference table', () => {
  function describedAt(revision: number): ReturnType<typeof describePage> {
    return describePage(
      { elements: [{ kind: 'button', label: 'Continue', selector: '#continue' }], text: 'hello' },
      { pageId: 'page-1', revision, url: 'https://example.com/' },
    )
  }

  it('resolves a reference it minted for the current revision', () => {
    const table = new RefTable('page-1', 1)
    const described = describedAt(1)
    if (!described.ok) throw new Error('setup failed')
    const [element] = table.adopt(described.snapshot)
    const resolved = table.resolve(element?.ref)
    expect(resolved.ok).toBe(true)
    if (resolved.ok) expect(resolved.element.selector).toBe('#continue')
  })

  it('refuses a reference from an older page, and says which revision it came from', () => {
    const table = new RefTable('page-1', 1)
    const first = describedAt(1)
    if (!first.ok) throw new Error('setup failed')
    const [old] = table.adopt(first.snapshot)
    table.retire(2)
    const resolved = table.resolve(old?.ref)
    expect(resolved.ok).toBe(false)
    if (!resolved.ok) {
      expect(resolved.code).toBe('page-stale')
      expect(resolved.reason).toContain('revision 1')
      expect(resolved.reason).toContain('revision 2')
    }
  })

  it('refuses a reference nobody minted, rather than resolving to whatever is first', () => {
    const table = new RefTable('page-1', 1)
    const resolved = table.resolve('r1-deadbeefdeadbeef')
    expect(resolved.ok).toBe(false)
    if (!resolved.ok) expect(resolved.code).toBe('ref-unknown')
    const shaped = table.resolve(mintRef({ pageId: 'page-1', revision: 1, ordinal: 0, kind: 'button', selector: '#continue' }))
    expect(shaped.ok).toBe(false)
    if (!shaped.ok) expect(shaped.code).toBe('ref-unknown')
  })

  it('does not treat looking at the same page twice as a navigation', () => {
    const table = new RefTable('page-1', 1)
    const first = describedAt(1)
    if (!first.ok) throw new Error('setup failed')
    const [element] = table.adopt(first.snapshot)
    table.retire(1)
    expect(table.resolve(element?.ref).ok).toBe(true)
    expect(table.currentRevision).toBe(1)
  })

  it('refuses a protected field and a disabled element by name', () => {
    const table = new RefTable('page-1', 1)
    const described = describePage(
      {
        elements: [
          { kind: 'field', label: 'Password', selector: '#password', protected: true },
          { kind: 'button', label: 'Send', selector: '#send', disabled: true },
          { kind: 'button', label: 'Go', selector: '#go' },
        ],
      },
      { pageId: 'page-1', revision: 1, url: 'https://example.com/' },
    )
    if (!described.ok) throw new Error('setup failed')
    const elements = table.adopt(described.snapshot)
    const protectedField = table.resolve(elements[0]?.ref)
    expect(protectedField.ok).toBe(false)
    if (!protectedField.ok) expect(protectedField.code).toBe('protected-field')
    const disabled = table.resolve(elements[1]?.ref)
    expect(disabled.ok).toBe(false)
    if (!disabled.ok) expect(disabled.code).toBe('element-disabled')
    expect(table.resolve(elements[2]?.ref).ok).toBe(true)
  })

  it('refuses a reference that is not a reference at all', () => {
    const table = new RefTable('page-1', 1)
    for (const value of ['', '#continue', null, 42, 'r1-' + 'x'.repeat(200)]) {
      expect(table.resolve(value).ok, String(value)).toBe(false)
    }
  })

  it('forgets everything on close, so a closed window has no usable references', () => {
    const table = new RefTable('page-1', 1)
    const described = describedAt(1)
    if (!described.ok) throw new Error('setup failed')
    const [element] = table.adopt(described.snapshot)
    table.clear()
    expect(table.size).toBe(0)
    expect(table.resolve(element?.ref).ok).toBe(false)
  })
})