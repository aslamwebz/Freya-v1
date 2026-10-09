import { chromium } from 'playwright-core'

async function main() {
  console.log('[1] Connecting to Freya on CDP port 9234...')
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9234', { timeout: 10000 })
  const pages = browser.contexts().flatMap(c => c.pages())
  const page = pages.find(p => p.url().includes('/dist/index.html'))
  if (!page) throw new Error('Freya main page not found!')

  console.log('[2] Connected to page:', page.url())
  const bodyBefore = await page.innerText('body')
  console.log('[3] Was in chat before click:', bodyBefore.includes('FREYA · CHAT'))

  console.log('[4] Clicking Chats icon in the rail...')
  const chatBtn = page.locator('.chats-history-title')
  await chatBtn.click()
  await page.waitForTimeout(1000)

  const bodyAfter = await page.innerText('body')
  const inChat = bodyAfter.includes('FREYA · CHAT')
  console.log('[5] Now in Chats workspace:', inChat)

  const composer = page.locator('textarea[placeholder="Ask Freya..."]')
  console.log('[6] Composer visible:', await composer.isVisible())

  await browser.close()
}

main().catch(err => {
  console.error('Error:', err)
  process.exit(1)
})
