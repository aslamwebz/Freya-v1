import { chromium } from 'playwright-core'

/**
 * Live UI driver that acts exactly as a real human user sitting in front of Freya:
 * 1. Connects to Electron over CDP.
 * 2. Switches tabs to the Chats workspace if not already there.
 * 3. Starts a new conversation if requested (clicking `+` new chat in the sidebar).
 * 4. Checks and sets the "Web search" toggle switch as requested.
 * 5. Checks and sets the "Browser" toggle switch as requested.
 * 6. Types the user prompt into the composer textarea.
 * 7. Clicks the Send button.
 * 8. Watches the live UI during generation (observing `.chats-active-turn` and busy send orb).
 * 9. Waits for generation to finish completely.
 * 10. Extracts the real rendered assistant turn directly from the DOM.
 */
export async function runLiveUiTest(options) {
  const {
    prompt,
    webSearch = false,
    browser = false,
    newConversation = false,
    cdpPort = 9235,
    timeoutMs = 60000,
  } = options

  console.log(`[UI-USER] Connecting to Freya on CDP 127.0.0.1:${cdpPort}...`)
  const cdpBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, { timeout: 10000 })
  const pages = cdpBrowser.contexts().flatMap(c => c.pages())
  const page = pages.find(p => p.url().includes('/dist/index.html'))
  if (!page) {
    await cdpBrowser.close()
    throw new Error('Freya main window (/dist/index.html) not found!')
  }

  try {
    page.setDefaultTimeout(10000)


  // 1. Ensure user is on Chats tab
  const activeScreen = await page.locator('.hd-dashboard').getAttribute('data-screen')
  if (activeScreen !== 'chat') {
    console.log(`[UI-USER] Switching workspace from "${activeScreen}" to "chat"...`)
    const openChatsBtn = page.locator('button.hd-place[aria-label="Open Chats"]').first()
    if (await openChatsBtn.count()) {
      await openChatsBtn.click()
      await page.waitForTimeout(600)
    }
  }

  // 2. Start a fresh conversation if requested
  if (newConversation) {
    console.log('[UI-USER] Clicking "Start a new conversation" (+) in sidebar...')
    const newChatBtn = page.locator('button.chats-new[aria-label="Start a new conversation"]').first()
    if (await newChatBtn.count()) {
      await newChatBtn.click()
      await page.waitForTimeout(600)
    }
  }

  // 3. Be mindful about Web search toggle
  const searchToggle = page.locator('button[role="switch"][aria-label="Web search"]')
  if (await searchToggle.count()) {
    const isChecked = (await searchToggle.getAttribute('aria-checked')) === 'true'
    console.log(`[UI-USER] Web search toggle is currently: ${isChecked ? 'ON' : 'OFF'}`)
    if (isChecked !== webSearch) {
      console.log(`[UI-USER] Clicking Web search toggle to turn it ${webSearch ? 'ON' : 'OFF'}...`)
      await searchToggle.click()
      await page.waitForTimeout(300)
      const after = (await searchToggle.getAttribute('aria-checked')) === 'true'
      console.log(`[UI-USER] Web search toggle is now: ${after ? 'ON' : 'OFF'}`)
    }
  }

  // 4. Be mindful about Browser toggle
  const browserToggle = page.locator('button[role="switch"][aria-label="Browser"]')
  if (await browserToggle.count()) {
    const isChecked = (await browserToggle.getAttribute('aria-checked')) === 'true'
    console.log(`[UI-USER] Browser toggle is currently: ${isChecked ? 'ON' : 'OFF'}`)
    if (isChecked !== browser) {
      console.log(`[UI-USER] Clicking Browser toggle to turn it ${browser ? 'ON' : 'OFF'}...`)
      await browserToggle.click()
      await page.waitForTimeout(300)
      const after = (await browserToggle.getAttribute('aria-checked')) === 'true'
      console.log(`[UI-USER] Browser toggle is now: ${after ? 'ON' : 'OFF'}`)
    }
  }

  // 5. Fill composer textarea
  console.log(`[UI-USER] Typing into composer: "${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}"`)
  const textarea = page.locator('textarea[placeholder="Ask Freya..."], textarea[aria-label="Ask Freya"]').first()
  await textarea.fill(prompt)
  await page.waitForTimeout(300)

  // 6. Record turn count before sending
  const turnsBefore = await page.locator('.chats-turn[data-role="assistant"]').count()

  // 7. Click Send button
  console.log('[UI-USER] Clicking Send button...')
  const sendBtn = page.locator('button.hd-send[aria-label="Send message"], button.hd-send[type="submit"]').first()
  if (await sendBtn.count() && await sendBtn.isEnabled()) {
    await sendBtn.click()
  } else {
    console.log('[UI-USER] Send button not enabled, pressing Enter in textarea...')
    await textarea.press('Enter')
  }

  // 8. Wait for Freya response generation to start & finish
  console.log('[UI-USER] Watching live Freya generation...')
  const startWait = Date.now()
  let hasStarted = false
  let completed = false
  let wasInterrupted = false

  while (Date.now() - startWait < timeoutMs) {
    await page.waitForTimeout(600)
    const isGenerating = (await page.locator('.chats-active-turn, .f-chat-thinking, .hd-send-busy').count()) > 0
    if (isGenerating) {
      hasStarted = true
      if (options.interruptAfterMs && !wasInterrupted && (Date.now() - startWait >= options.interruptAfterMs)) {
        console.log(`[UI-USER] Generation detected. Clicking "Stop response" button...`)
        const stopBtn = page.locator('button[aria-label="Stop response"], .hd-send-busy').first()
        if (await stopBtn.count()) {
          await stopBtn.click()
          wasInterrupted = true
          console.log('[UI-USER] "Stop response" clicked!')
        }
      }
    }

    const turnsNow = await page.locator('.chats-turn[data-role="assistant"]').count()
    if (!isGenerating && (hasStarted || turnsNow > turnsBefore)) {
      completed = true
      break
    }
  }

  if (!completed) {
    console.warn(`[UI-USER] Response generation did not finish within ${timeoutMs / 1000}s.`)
  }

  // 9. Extract rendered assistant message directly from the DOM
  const assistantTurns = page.locator('.chats-turn[data-role="assistant"]')
  const totalAssistantTurns = await assistantTurns.count()
  let replyText = ''
  if (totalAssistantTurns > 0) {
    const lastTurn = assistantTurns.nth(totalAssistantTurns - 1)
    replyText = await lastTurn.innerText()
  }

  // Also check if any browser workspace opened
  const browserDocked = (await page.locator('.hd-docked-browser, .chats-browser-view').count()) > 0
  const browserTabs = await page.locator('.hd-browser-tab, .chats-browser-tab').allInnerTexts()

    console.log(`[UI-USER] Generated response received (${replyText.length} chars).`)

    return {
      success: completed,
      hasStarted,
      wasInterrupted,
      turnsCount: totalAssistantTurns,
      replyText,
      browserDocked,
      browserTabs,
    }
  } finally {
    try {
      await cdpBrowser.close()
    } catch {
      // ignore
    }
  }
}


// CLI usage
if (process.argv[1]?.endsWith('live-ui-driver.mjs')) {
  const args = process.argv.slice(2)
  const prompt = args.find(a => !a.startsWith('--')) ?? 'Hello Freya!'
  const web = args.includes('--web')
  const browser = args.includes('--browser')
  const newChat = args.includes('--new')
  const interruptArg = args.find(a => a.startsWith('--interrupt'))
  const interruptAfterMs = interruptArg ? (interruptArg.includes('=') ? Number(interruptArg.split('=')[1]) : 1500) : 0

  runLiveUiTest({ prompt, webSearch: web, browser, newConversation: newChat, interruptAfterMs })
    .then((res) => {
      console.log('\n================ RENDERED UI RESPONSE ================')
      console.log(res.replyText)
      console.log('======================================================')
      if (res.wasInterrupted) {
        console.log('[UI-USER] Turn was successfully interrupted by user click on "Stop response".')
      }
      process.exit(0)
    })
    .catch((err) => {
      console.error(err)
      process.exit(1)
    })
}
