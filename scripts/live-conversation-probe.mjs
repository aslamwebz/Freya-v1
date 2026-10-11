import { chromium } from 'playwright-core'
const b = await chromium.connectOverCDP('http://127.0.0.1:9234', { timeout: 8000 })
const p = b.contexts().flatMap(c => c.pages()).find(x => x.url().includes('/dist/index.html'))
p.setDefaultTimeout(6000)

const info = await p.evaluate(() => {
  const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  const heads = [...document.querySelectorAll('h1,h2,[data-testid],[class*="title"],[class*="header"]')]
    .filter(vis).map(e => ({ tag: e.tagName.toLowerCase(), cls: String(e.className || '').slice(0, 40), text: (e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 70) }))
    .filter(x => x.text !== '')
  const saved = document.querySelector('section[aria-label="Saved conversations"]')
  const convs = saved ? [...saved.querySelectorAll('button')].map(b => b.getAttribute('aria-label') || (b.textContent || '').trim()).slice(0, 12) : 'NONE'
  return { heads: heads.slice(0, 18), convs }
})
console.log('--- headings / titles ---')
info.heads.forEach(h => console.log(`  [${h.tag}] ${h.cls} :: ${h.text}`))
console.log('--- conversation list ---')
console.log(JSON.stringify(info.convs, null, 1))
await b.close()