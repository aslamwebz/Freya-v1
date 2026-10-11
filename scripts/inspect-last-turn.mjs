import { chromium } from 'playwright-core'

async function inspect() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9235')
  try {
    const pages = browser.contexts().flatMap(c => c.pages())
    const page = pages.find(p => p.url().includes('/dist/index.html'))
    if (!page) throw new Error('Index page not found')
    const turn = page.locator('.chats-turn[data-role="assistant"]').last()

    const buttons = await turn.locator('button').allInnerTexts()
    console.log('Buttons:', buttons)

    // Check conversation projection from core
    const conv = await page.evaluate(async () => window.freyaHost.coreConversation())
    const lastMsg = conv?.messages?.[conv.messages.length - 1]
    console.log('Turn outcome in Core:', {
      outcome: conv?.turns?.[conv.turns.length - 1]?.outcome,
      reason: conv?.turns?.[conv.turns.length - 1]?.reason,
      contentStart: lastMsg?.content?.slice(0, 200),
    })
  } finally {
    await browser.close()
    process.exit(0)
  }
}

inspect().catch(err => {
  console.error(err)
  process.exit(1)
})
