import { chromium } from 'playwright-core'

const browser = await chromium.connectOverCDP('http://127.0.0.1:9235')
const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('/dist/index.html'))

const turns = await page.locator('.chats-turn').allInnerTexts()
console.log('Total .chats-turn count:', turns.length)
for (let i = 0; i < turns.length; i++) {
  console.log(`\n--- TURN ${i} ---`)
  console.log(turns[i])
}

const activeTurn = await page.locator('.chats-active-turn').allInnerTexts()
console.log('Active turn count:', activeTurn.length)

await browser.close()
