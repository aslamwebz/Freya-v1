// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  runCapabilityTest,
  runCapabilityTests,
  type CapabilityTestCase,
} from '../../../core/senses'

/**
 * Every routed capability action, exercised through the deterministic testing
 * framework. A valid case is admitted; an invalid case is refused with a closed
 * code. Same inputs = same result, every time.
 */

const CASES: readonly CapabilityTestCase[] = [
  // Browser
  { testId: 'browser.navigate.valid', capabilityKind: 'browser', action: 'navigate', input: { url: 'https://example.com' }, expectedOutcome: 'completed' },
  { testId: 'browser.navigate.invalid-url', capabilityKind: 'browser', action: 'navigate', input: { url: 'javascript:alert(1)' }, expectedOutcome: 'refused', expectedReason: 'invalid_input' },
  { testId: 'browser.click.valid', capabilityKind: 'browser', action: 'click', input: { selector: '#go' }, expectedOutcome: 'completed' },
  { testId: 'browser.click.invalid-selector', capabilityKind: 'browser', action: 'click', input: { selector: '' }, expectedOutcome: 'refused', expectedReason: 'invalid_input' },
  { testId: 'browser.type.valid', capabilityKind: 'browser', action: 'type', input: { selector: '#q', text: 'hello' }, expectedOutcome: 'completed' },
  { testId: 'browser.type.invalid-selector', capabilityKind: 'browser', action: 'type', input: { selector: '', text: 'hello' }, expectedOutcome: 'refused', expectedReason: 'invalid_input' },
  { testId: 'browser.read.valid', capabilityKind: 'browser', action: 'read', input: { selector: 'body' }, expectedOutcome: 'completed' },
  { testId: 'browser.read.invalid-selector', capabilityKind: 'browser', action: 'read', input: { selector: '' }, expectedOutcome: 'refused', expectedReason: 'invalid_input' },
  { testId: 'browser.form-fill.valid', capabilityKind: 'browser', action: 'form-fill', input: { selector: '#name', value: 'Ada' }, expectedOutcome: 'completed' },
  { testId: 'browser.form-fill.invalid-selector', capabilityKind: 'browser', action: 'form-fill', input: { selector: '', value: 'Ada' }, expectedOutcome: 'refused', expectedReason: 'invalid_input' },
  { testId: 'browser.element-click.valid', capabilityKind: 'browser', action: 'element-click', input: { selector: '.btn' }, expectedOutcome: 'completed' },
  { testId: 'browser.element-click.invalid-selector', capabilityKind: 'browser', action: 'element-click', input: { selector: '' }, expectedOutcome: 'refused', expectedReason: 'invalid_input' },
  { testId: 'browser.page-scroll.valid', capabilityKind: 'browser', action: 'page-scroll', input: { direction: 'down', amount: 200 }, expectedOutcome: 'completed' },
  { testId: 'browser.page-scroll.invalid-direction', capabilityKind: 'browser', action: 'page-scroll', input: { direction: 'sideways', amount: 200 }, expectedOutcome: 'refused', expectedReason: 'invalid_input' },
  { testId: 'browser.content-extract.valid', capabilityKind: 'browser', action: 'content-extract', input: { selector: 'main' }, expectedOutcome: 'completed' },
  { testId: 'browser.content-extract.invalid-selector', capabilityKind: 'browser', action: 'content-extract', input: { selector: '' }, expectedOutcome: 'refused', expectedReason: 'invalid_input' },

  // Terminal
  { testId: 'terminal.command-run.valid', capabilityKind: 'terminal', action: 'command-run', input: { command: 'echo hi' }, expectedOutcome: 'completed' },
  { testId: 'terminal.command-run.invalid-command', capabilityKind: 'terminal', action: 'command-run', input: { command: '' }, expectedOutcome: 'refused', expectedReason: 'invalid_input' },
  { testId: 'terminal.command-execute.valid', capabilityKind: 'terminal', action: 'command-execute', input: { command: 'echo hi', maxOutputBytes: 1024 }, expectedOutcome: 'completed' },
  { testId: 'terminal.command-execute.invalid-command', capabilityKind: 'terminal', action: 'command-execute', input: { command: '', maxOutputBytes: 1024 }, expectedOutcome: 'refused', expectedReason: 'invalid_input' },
  { testId: 'terminal.command-cancel.valid', capabilityKind: 'terminal', action: 'command-cancel', input: { commandId: 'cmd-1' }, expectedOutcome: 'completed' },
  { testId: 'terminal.command-cancel.invalid-id', capabilityKind: 'terminal', action: 'command-cancel', input: { commandId: 'not a valid id!' }, expectedOutcome: 'refused', expectedReason: 'invalid_input' },

  // Clipboard
  { testId: 'clipboard.read.valid', capabilityKind: 'clipboard', action: 'clipboard-read', input: {}, expectedOutcome: 'completed' },
  { testId: 'clipboard.read.empty', capabilityKind: 'clipboard', action: 'clipboard-read', input: {}, expectedOutcome: 'completed' },
  { testId: 'clipboard.write.valid', capabilityKind: 'clipboard', action: 'clipboard-write', input: { content: 'hello' }, expectedOutcome: 'completed' },
  { testId: 'clipboard.write.invalid-content', capabilityKind: 'clipboard', action: 'clipboard-write', input: { content: 42 }, expectedOutcome: 'refused', expectedReason: 'invalid_input' },

  // Download
  { testId: 'download.start.valid', capabilityKind: 'download', action: 'download-start', input: { url: 'https://example.com/f', destination: '/tmp/f' }, expectedOutcome: 'completed' },
  { testId: 'download.start.invalid-url', capabilityKind: 'download', action: 'download-start', input: { url: 'file:///etc/passwd', destination: '/tmp/f' }, expectedOutcome: 'refused', expectedReason: 'invalid_input' },
  { testId: 'download.start.invalid-destination', capabilityKind: 'download', action: 'download-start', input: { url: 'https://example.com/f', destination: '' }, expectedOutcome: 'refused', expectedReason: 'invalid_input' },
  { testId: 'download.cancel.valid', capabilityKind: 'download', action: 'download-cancel', input: { downloadId: 'dl-1' }, expectedOutcome: 'completed' },
  { testId: 'download.cancel.invalid-id', capabilityKind: 'download', action: 'download-cancel', input: { downloadId: '!!' }, expectedOutcome: 'refused', expectedReason: 'invalid_input' },
  { testId: 'download.status.valid', capabilityKind: 'download', action: 'download-status', input: { downloadId: 'dl-1' }, expectedOutcome: 'completed' },
  { testId: 'download.status.invalid-id', capabilityKind: 'download', action: 'download-status', input: { downloadId: '' }, expectedOutcome: 'refused', expectedReason: 'invalid_input' },

  // Upload
  { testId: 'upload.start.valid', capabilityKind: 'upload', action: 'upload-start', input: { source: '/tmp/f', destination: 'https://example.com/u' }, expectedOutcome: 'completed' },
  { testId: 'upload.start.invalid-source', capabilityKind: 'upload', action: 'upload-start', input: { source: '', destination: 'https://example.com/u' }, expectedOutcome: 'refused', expectedReason: 'invalid_input' },
  { testId: 'upload.start.invalid-destination', capabilityKind: 'upload', action: 'upload-start', input: { source: '/tmp/f', destination: '' }, expectedOutcome: 'refused', expectedReason: 'invalid_input' },
  { testId: 'upload.cancel.valid', capabilityKind: 'upload', action: 'upload-cancel', input: { uploadId: 'up-1' }, expectedOutcome: 'completed' },
  { testId: 'upload.cancel.invalid-id', capabilityKind: 'upload', action: 'upload-cancel', input: { uploadId: '!!' }, expectedOutcome: 'refused', expectedReason: 'invalid_input' },
  { testId: 'upload.status.valid', capabilityKind: 'upload', action: 'upload-status', input: { uploadId: 'up-1' }, expectedOutcome: 'completed' },
  { testId: 'upload.status.invalid-id', capabilityKind: 'upload', action: 'upload-status', input: { uploadId: '' }, expectedOutcome: 'refused', expectedReason: 'invalid_input' },
]

describe('capability test suite', () => {
  it('passes every declared case', () => {
    const results = runCapabilityTests(CASES)
    const failures = results.filter((result) => !result.passed)
    expect(failures).toEqual([])
    expect(results.length).toBe(CASES.length)
  })

  it('is deterministic: same inputs, same result', () => {
    const first = runCapabilityTests(CASES)
    const second = runCapabilityTests(CASES)
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
  })

  it('maps an admitted action to completed and a refusal to refused', () => {
    const admitted = runCapabilityTest(CASES[0]!)
    expect(admitted.actualOutcome).toBe('completed')
    const refused = runCapabilityTest(CASES[1]!)
    expect(refused.actualOutcome).toBe('refused')
    expect(refused.actualReason).toBe('invalid_input')
  })

  it('reports duration as zero: a deterministic test has no duration', () => {
    expect(runCapabilityTests(CASES).every((result) => result.durationMs === 0)).toBe(true)
  })
})
