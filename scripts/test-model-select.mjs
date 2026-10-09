import { chromium } from 'playwright-core'
import { execFileSync } from 'node:child_process'

async function run() {
  console.log('[test] Focusing Freya window...')
  try {
    execFileSync(process.execPath, ['bin/freya.mjs', 'focus'], { stdio: 'inherit' })
  } catch (e) {
    console.error('Focus error:', e.message)
  }

  console.log('[test] Connecting to Freya over CDP...')
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9234', { timeout: 10000 })
  const pages = browser.contexts().flatMap(c => c.pages())
  const page = pages.find(p => p.url().includes('/dist/index.html'))
  if (!page) throw new Error('Main Freya window not found!')
  page.setDefaultTimeout(8000)

  console.log('[test] Opening Chats...')
  const newChatBtn = page.locator('button[aria-label="Start a new conversation"]')
  const openChatsBtn = page.locator('button[aria-label="Open Chats"]')
  if (await newChatBtn.count()) {
    await newChatBtn.click()
  } else if (await openChatsBtn.count()) {
    await openChatsBtn.click()
  }
  await page.waitForTimeout(1000)

  console.log('[test] Locating model selector...')
  const modelBtn = page.locator('button[aria-label="Choose model"]')
  console.log('Model button count:', await modelBtn.count(), 'Current text:', await modelBtn.innerText())

  console.log('[test] Clicking model selector to open catalogue...')
  await modelBtn.click()
  await page.waitForTimeout(1000)

  const searchInput = page.locator('input[aria-label="Search models"]')
  console.log('Search input count:', await searchInput.count())
  if (await searchInput.count()) {
    console.log('[test] Typing deepseek/deepseek-v4.1-flash...')
    await searchInput.fill('deepseek/deepseek-v4.1-flash')
    await page.waitForTimeout(1000)

    const pickButtons = page.locator('button.hd-model-pick')
    const count = await pickButtons.count()
    console.log('Matching model picks count:', count)
    for (let i = 0; i < count; i++) {
      console.log(`  [${i}]:`, await pickButtons.nth(i).innerText())
    }

    if (count > 0) {
      console.log('[test] Selecting model...')
      await pickButtons.first().click()
      await page.waitForTimeout(1000)
    }
  }

  console.log('Model button after select:', await modelBtn.innerText())
  await browser.close()
}

run().catch(console.error)
