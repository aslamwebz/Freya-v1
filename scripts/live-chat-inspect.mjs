// A picture of what the app is currently showing, plus the landmarks a chat test
// needs to address. Diagnosis tool, not an assertion.
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'

const CDP = process.env.FREYA_CDP ?? 'http://127.0.0.1:9234'
const browser = await chromium.connectOverCDP(CDP, { timeout: 8000 })
const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('/dist/index.html'))
if (!page) throw new Error('Freya app page missing')
page.setDefaultTimeout(5000)

mkdirSync('.kilo/live-shots', { recursive: true })
await page.screenshot({ path: '.kilo/live-shots/app.png' })
console.log('screenshot -> .kilo/live-shots/app.png')

const info = await page.evaluate(() => {
  const vis = el => {
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  const interesting = [...document.querySelectorAll('textarea, input, button, [role], section, main, aside')]
    .filter(vis)
    .map(el => ({
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') ?? '',
      label: el.getAttribute('aria-label') ?? el.getAttribute('placeholder') ?? '',
      cls: (el.className && String(el.className).slice(0, 48)) ?? '',
      testid: el.getAttribute('data-testid') ?? '',
    }))
    .filter(x => x.label || x.testid || x.role === 'switch')
  return {
    title: document.title,
    headings: [...document.querySelectorAll('h1,h2,h3')].filter(vis).map(h => h.innerText.trim().slice(0, 60)).slice(0, 20),
    landmarks: interesting.slice(0, 60),
  }
})

console.log('\ntitle:', info.title)
console.log('\nheadings:'); info.headings.forEach(h => console.log('  ·', h))
console.log('\naddressable:'); info.landmarks.forEach(l => console.log(`  · [${l.tag}]${l.role ? ' role=' + l.role : ''}${l.label ? ' label=' + JSON.stringify(l.label) : ''}${l.testid ? ' testid=' + l.testid : ''}`))

await browser.close()