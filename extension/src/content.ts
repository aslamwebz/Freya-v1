/**
 * Page operations, injected into the top frame on demand.
 *
 * Every function here is self-contained: `chrome.scripting.executeScript` serialises a
 * function and runs it in the page, so it cannot close over module scope. That is why
 * the protected-field check is written out inside each function rather than imported.
 *
 * The extension refuses protected fields and subframes here for speed and honesty, and
 * the host re-checks the descriptor, so a page that lies about a field's type cannot
 * widen what is allowed.
 */

export interface InspectDescriptor {
  readonly tagName: string
  readonly type: string | null
  readonly name: string | null
  readonly id: string | null
  readonly autocomplete: string | null
  readonly placeholder: string | null
  readonly ariaLabel: string | null
  readonly protected: boolean
}

export type InspectResult =
  | { readonly kind: 'ok'; readonly descriptor: InspectDescriptor }
  | { readonly kind: 'protected'; readonly field: string }
  | { readonly kind: 'missing' }

/** The current selection, as text. Empty when nothing is selected. */
export function collectSelection(): { text: string } {
  const selection = window.getSelection()
  return { text: selection === null ? '' : selection.toString() }
}

/** Visible text of the page, or of one element when a selector is given. */
export function collectText(selector: string | null): { text: string } {
  const root = selector === null ? document.body : document.querySelector(selector)
  if (root === null) return { text: '' }
  const element = root as HTMLElement
  const text = typeof element.innerText === 'string' ? element.innerText : (root.textContent ?? '')
  return { text }
}

/** A bounded descriptor of the first element matching a selector. */
export function inspectElement(selector: string): InspectResult {
  function protectedKind(element: Element): string | null {
    const input = element as HTMLInputElement
    const type = (input.type || '').toLowerCase()
    if (type === 'password') return 'password'
    if (type === 'hidden') return 'hidden'
    const autocomplete = (input.autocomplete || '').toLowerCase()
    for (const token of [
      'current-password',
      'new-password',
      'cc-number',
      'cc-csc',
      'cc-exp',
      'one-time-code',
      'webauthn',
    ]) {
      if (autocomplete.split(/\s+/).indexOf(token) !== -1) {
        if (token.indexOf('cc-') === 0) return 'payment-card'
        if (token === 'one-time-code') return 'one-time-code'
        if (token.indexOf('password') !== -1) return 'password'
        return 'authentication'
      }
    }
    const haystack = [
      input.name || '',
      input.id || '',
      input.placeholder || '',
      element.getAttribute('aria-label') || '',
    ]
      .join(' ')
      .toLowerCase()
    if (/pass(word|wd|phrase)?|\bpwd\b/.test(haystack)) return 'password'
    if (/credit.?card|card.?(number|num|no)\b|\bcc.?(num|number|no)\b|\bcvc\b|\bcvv\b|\bcsc\b|\bcvn\b|security.?code/.test(haystack)) {
      return 'payment-card'
    }
    if (/social.?security|\bssn\b/.test(haystack)) return 'authentication'
    if (/\botp\b|one.?time|\b2fa\b|\bmfa\b/.test(haystack)) return 'one-time-code'
    if (/auth.?token|access.?token|api.?key|secret|passphrase/.test(haystack)) return 'authentication'
    return null
  }

  const element = document.querySelector(selector)
  if (element === null) return { kind: 'missing' }
  const field = protectedKind(element)
  if (field !== null) return { kind: 'protected', field }
  const input = element as HTMLInputElement
  return {
    kind: 'ok',
    descriptor: {
      tagName: element.tagName.toLowerCase(),
      type: input.type || null,
      name: input.name || null,
      id: input.id || null,
      autocomplete: input.autocomplete || null,
      placeholder: input.placeholder || null,
      ariaLabel: element.getAttribute('aria-label'),
      protected: false,
    },
  }
}

/** Click the first element matching a selector. */
export function clickElement(selector: string): { clicked: boolean; reason: string } {
  const element = document.querySelector(selector)
  if (element === null) return { clicked: false, reason: 'not-found' }
  if (element instanceof HTMLElement) {
    if (element.isContentEditable === true || element.tagName.toLowerCase() === 'body') {
      // A click on the page body or an editable region is a no-op we refuse to report
      // as a click, so the audit does not claim something happened that did not.
      return { clicked: false, reason: 'not-clickable' }
    }
    element.click()
    return { clicked: true, reason: 'clicked' }
  }
  return { clicked: false, reason: 'not-clickable' }
}

/** Type text into an input, textarea or contenteditable. Refuses protected fields. */
export function typeIntoElement(
  selector: string,
  text: string,
): { typed: boolean; reason: string; field?: string } {
  function protectedKind(element: Element): string | null {
    const input = element as HTMLInputElement
    const type = (input.type || '').toLowerCase()
    if (type === 'password') return 'password'
    if (type === 'hidden') return 'hidden'
    const autocomplete = (input.autocomplete || '').toLowerCase()
    for (const token of ['current-password', 'new-password', 'cc-number', 'cc-csc', 'cc-exp', 'one-time-code']) {
      if (autocomplete.split(/\s+/).indexOf(token) !== -1) {
        if (token.indexOf('cc-') === 0) return 'payment-card'
        if (token === 'one-time-code') return 'one-time-code'
        return 'password'
      }
    }
    const haystack = [input.name || '', input.id || '', input.placeholder || '', element.getAttribute('aria-label') || '']
      .join(' ')
      .toLowerCase()
    if (/pass(word|wd|phrase)?|\bpwd\b/.test(haystack)) return 'password'
    if (/credit.?card|card.?(number|num|no)\b|\bcc.?(num|number|no)\b|\bcvc\b|\bcvv\b|\bcsc\b/.test(haystack)) {
      return 'payment-card'
    }
    if (/auth.?token|access.?token|api.?key|secret|passphrase|\botp\b|one.?time/.test(haystack)) {
      return 'authentication'
    }
    return null
  }

  const element = document.querySelector(selector)
  if (element === null) return { typed: false, reason: 'not-found' }
  const field = protectedKind(element)
  if (field !== null) return { typed: false, reason: 'protected', field }
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const prototype = Object.getPrototypeOf(element)
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value')
    if (descriptor !== undefined && typeof descriptor.set === 'function') {
      descriptor.set.call(element, text)
    } else {
      element.value = text
    }
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
    return { typed: true, reason: 'typed' }
  }
  if (element instanceof HTMLElement && element.isContentEditable) {
    element.textContent = text
    element.dispatchEvent(new Event('input', { bubbles: true }))
    return { typed: true, reason: 'typed' }
  }
  return { typed: false, reason: 'not-editable' }
}
