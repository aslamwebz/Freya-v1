// Reads the model/provider selection the app is actually running on, and the
// model catalogue each configured provider reports. A diagnosis tool.
import { chromium } from 'playwright-core'

const browser = await chromium.connectOverCDP(process.env.FREYA_CDP ?? 'http://127.0.0.1:9234', { timeout: 8000 })
const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('/dist/index.html'))
if (!page) throw new Error('Freya app page missing')
page.setDefaultTimeout(5000)

console.log('# composer selection')
for (const label of ['Provider default', 'MiniMax', 'qwen']) void label
const chips = await page.evaluate(() => {
  const out = []
  for (const el of document.querySelectorAll('button, select, [role="combobox"], [role="listbox"]')) {
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    const t = (el.innerText ?? '').trim().replace(/\s+/g, ' ')
    if (!t || t.length > 90) continue
    if (/qwen|minimax|nano|provider|flash|model/i.test(t)) out.push({ tag: el.tagName.toLowerCase(), role: el.getAttribute('role') ?? '', text: t, aria: el.getAttribute('aria-label') ?? '' })
  }
  return out
})
for (const c of chips) console.log(`  · [${c.tag}]${c.role ? ' role=' + c.role : ''} ${c.aria ? 'aria=' + JSON.stringify(c.aria) + ' ' : ''}${JSON.stringify(c.text)}`)

// The provider/model projection the app received from Core.
const status = await page.evaluate(() => {
  const bridge = globalThis.freya ?? globalThis.window?.freya
  if (!bridge) return { note: 'no bridge on window' }
  return { keys: Object.keys(bridge).slice(0, 40) }
})
console.log('\n# bridge', JSON.stringify(status))

await browser.close()