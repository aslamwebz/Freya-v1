/** Copy within the browser's existing permissions; never report refused writes as success. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Some embedded browsers expose the API but deny its permission. The
    // existing selection-based copy action can still be available there.
  }

  const previousFocus = document.activeElement
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  try {
    area.select()
    return document.execCommand?.('copy') === true
  } catch {
    return false
  } finally {
    area.remove()
    if (previousFocus instanceof HTMLElement) previousFocus.focus()
  }
}
