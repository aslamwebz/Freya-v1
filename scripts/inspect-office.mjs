import { chromium } from 'playwright-core'

async function inspect() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9235')
  try {
    const pages = browser.contexts().flatMap(c => c.pages())
    const page = pages.find(p => p.url().includes('/dist/index.html'))
    if (!page) throw new Error('Page not found')

    const officeBtn = page.locator('button.hd-place:has-text("Office")').first()
    console.log('Clicking Office place button...')
    await officeBtn.click()
    await page.waitForTimeout(1000)

    const screen = await page.locator('.hd-dashboard').getAttribute('data-screen')
    console.log('Current screen:', screen)

    const mainContent = await page.locator('.hd-main').innerText()
    console.log('Office content:\n', mainContent.slice(0, 600))

    // Switch back to Chats
    const chatBtn = page.locator('button.hd-place[aria-label="Open Chats"]').first()
    await chatBtn.click()
    await page.waitForTimeout(500)
    console.log('Switched back to Chat.')
  } finally {
    await browser.close()
    process.exit(0)
  }
}

inspect().catch(err => {
  console.error(err)
  process.exit(1)
})
