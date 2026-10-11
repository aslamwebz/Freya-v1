import { chromium } from 'playwright-core'
const b = await chromium.connectOverCDP('http://127.0.0.1:9234', { timeout: 8000 })
const p = b.contexts().flatMap(c => c.pages()).find(x => x.url().includes('/dist/index.html'))
p.setDefaultTimeout(6000)
const t = await p.locator('section[aria-label="Conversation"]').innerText()
const i = Math.max(0, t.lastIndexOf('Open those'))
console.log('--- assistant reply to the "open those" request ---')
console.log(t.slice(i, i + 1600).split('\n').filter(Boolean).slice(0, 34).join('\n'))
const tabs = await p.evaluate(() => {
  const all = [...document.querySelectorAll('[aria-label]')]
  return all.filter(e => /tab/i.test(e.getAttribute('aria-label') || '')).map(e => (e.getAttribute('aria-label') || '').slice(0, 100)).slice(0, 24)
})
console.log('\n--- browser tab controls visible in the UI ---')
if (!tabs.length) console.log('  (none found)')
tabs.forEach(x => console.log('  · ' + x))
await b.close()