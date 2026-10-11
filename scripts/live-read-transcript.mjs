import { chromium } from 'playwright-core'
const b = await chromium.connectOverCDP('http://127.0.0.1:9234', { timeout: 8000 })
const p = b.contexts().flatMap(c => c.pages()).find(x => x.url().includes('/dist/index.html'))
p.setDefaultTimeout(6000)
const t = await p.locator('section[aria-label="Conversation"]').innerText()
console.log(`=== transcript, ${t.length} chars, from the TOP ===`)
console.log(t.slice(0, 2600))
await b.close()