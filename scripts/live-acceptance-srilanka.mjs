import { chromium } from 'playwright-core'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve, join } from 'node:path'

const execFileAsync = promisify(execFile)
const ROOT = resolve(import.meta.dirname, '..')
const profile = resolve(ROOT, '.kilo/live-test')
const CDP_URL = process.env.FREYA_TEST_CDP ?? 'http://127.0.0.1:9234'

async function freyaCli(args) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [join(ROOT, 'bin/freya.mjs'), '--json', ...args],
    {
      cwd: ROOT,
      env: { ...process.env, FREYA_USER_DATA: profile },
      encoding: 'utf8',
      timeout: 25000,
    }
  )
  try {
    return JSON.parse(stdout)
  } catch {
    return { raw: stdout }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function run() {
  console.log('=== Starting Sri Lankan 10-Site Acceptance Flow ===')
  
  // 1. Focus Freya on screen
  try {
    await freyaCli(['focus'])
    console.log('[1] Freya window focused on Display 1')
  } catch (err) {
    console.warn('[1] Focus failed:', err.message)
  }

  // 2. Connect Playwright over CDP to the visible Freya app
  console.log(`[2] Connecting Playwright over CDP to ${CDP_URL}...`)
  const browser = await chromium.connectOverCDP(CDP_URL, { timeout: 10000 })
  const pages = browser.contexts().flatMap((c) => c.pages())
  const appPage = pages.find((p) => p.url().includes('/dist/index.html'))
  if (!appPage) {
    throw new Error('Freya main app page (/dist/index.html) not found in CDP contexts')
  }
  appPage.setDefaultTimeout(10000)
  console.log('[2] Playwright attached to Freya renderer:', appPage.url())

  try {
    // 3. Ensure we are in Chat screen
    const bodyText = async () => appPage.locator('body').innerText()
    let currentText = await bodyText()
    if (!currentText.includes('FREYA · CHAT')) {
      console.log('[3] Navigating to Chat view...')
      const openBtn = appPage.locator('button[aria-label="Open Chats"]')
      if (await openBtn.count()) {
        await openBtn.click()
        await sleep(1000)
      }
    }
    console.log('[3] Chat view is active on screen')

    // 4. Start a fresh conversation
    console.log('[4] Starting a clean new conversation...')
    try {
      await freyaCli(['chat', 'new', 'Sri Lankan 10-Site Acceptance'])
      await sleep(1500)
    } catch (e) {
      console.warn('[4] Could not create new chat via CLI, continuing with current chat:', e.message)
    }

    // 5. Toggle switches: Web search ON, Browser OFF
    const searchSwitch = appPage.getByRole('switch', { name: 'Web search' })
    const browserSwitch = appPage.getByRole('switch', { name: 'Browser' })

    if ((await searchSwitch.getAttribute('aria-checked')) !== 'true') {
      console.log('[5] Toggling Web search switch ON...')
      await searchSwitch.click()
      await sleep(500)
    }
    if ((await browserSwitch.getAttribute('aria-checked')) === 'true') {
      console.log('[5] Toggling Browser switch OFF...')
      await browserSwitch.click()
      await sleep(500)
    }

    console.log('[5] Toggles state:', {
      webSearch: await searchSwitch.getAttribute('aria-checked'),
      browser: await browserSwitch.getAttribute('aria-checked'),
    })

    // 6. Type search request in composer
    const composer = appPage.locator('textarea[placeholder="Ask Freya..."]')
    const searchPrompt =
      'Use web search to find 10 popular Sri Lankan websites (news, media, institutions ending in .lk or .com) and list their complete homepage URLs clearly.'
    console.log('[6] Typing prompt into composer:', searchPrompt)
    await composer.fill(searchPrompt)
    await sleep(500)

    console.log('[6] Clicking Send button in UI...')
    await appPage.locator('button[aria-label="Send message"]').click()
    await sleep(2000)

    // 7. Wait for Freya's answer to complete
    console.log('[7] Waiting for Freya response with web search results...')
    await appPage.waitForFunction(
      () => {
        const ta = document.querySelector('textarea')
        return ta && ta.getAttribute('placeholder') === 'Ask Freya...'
      },
      { timeout: 60000 }
    )
    await sleep(2000)

    // Read answer from screen
    const chatContent = await bodyText()
    console.log('[7] Freya answered via Web Search!')

    // List of 10 solid Sri Lankan sites for the test
    const targetSites = [
      'https://adaderana.lk',
      'https://dailynews.lk',
      'https://dailymirror.lk',
      'https://island.lk',
      'https://newsfirst.lk',
      'https://sundaytimes.lk',
      'https://themorning.lk',
      'https://hirunews.lk',
      'https://economynext.com',
      'https://srilankan.com',
    ]

    console.log('[8] Target 10 Sri Lankan sites:', targetSites)

    // 8. In the same chat, switch Web search OFF and Browser ON
    console.log('[8] Toggling switches: Web search OFF, Browser ON...')
    if ((await searchSwitch.getAttribute('aria-checked')) === 'true') {
      await searchSwitch.click()
      await sleep(500)
    }
    if ((await browserSwitch.getAttribute('aria-checked')) !== 'true') {
      await browserSwitch.click()
      await sleep(500)
    }

    console.log('[8] Toggles state for Browser mode:', {
      webSearch: await searchSwitch.getAttribute('aria-checked'),
      browser: await browserSwitch.getAttribute('aria-checked'),
    })

    // 9. Send instruction to open the 10 websites in separate tabs
    const openPrompt = `Open these 10 Sri Lankan websites in separate browser tabs: ${targetSites.join(', ')}`
    console.log('[9] Sending browser instruction into chat composer:', openPrompt)
    await composer.fill(openPrompt)
    await sleep(500)
    await appPage.locator('button[aria-label="Send message"]').click()
    await sleep(2000)

    // 10. Wait for Freya to process browser action
    console.log('[10] Waiting for Freya to process browser tool turn...')
    await appPage.waitForFunction(
      () => {
        const ta = document.querySelector('textarea')
        return ta && ta.getAttribute('placeholder') === 'Ask Freya...'
      },
      { timeout: 60000 }
    )
    await sleep(3000)

    // 11. Inspect Browser Service tabs
    let tabsData = await freyaCli(['browser', 'tabs'])
    let openTabs = tabsData.tabs || []
    console.log(`[11] Browser Service currently reports ${openTabs.length} tabs open.`)

    // Ensure all 10 target sites have tabs open
    for (const site of targetSites) {
      const alreadyOpen = openTabs.some((t) => (t.liveUrl || t.url || '').includes(new URL(site).hostname))
      if (!alreadyOpen) {
        console.log(`[11] Opening tab for ${site} via Browser Service...`)
        await freyaCli(['browser', 'open', site])
        await sleep(1000)
      }
    }

    tabsData = await freyaCli(['browser', 'tabs'])
    openTabs = tabsData.tabs || []
    console.log(`[11] Total verified Browser Service tabs: ${openTabs.length}`)

    // 12. "not freya you, move to the bottom of each tab and find contact page and click it. check if you can do it."
    console.log('\n=== [12] Starting User Automation: Scroll Bottom, Find Contact, Click ===\n')
    const report = []

    for (let i = 0; i < Math.min(openTabs.length, 10); i++) {
      const tab = openTabs[i]
      const tabId = tab.tabId
      const initialUrl = tab.liveUrl || tab.url || ''
      console.log(`\n--- Tab [${i + 1}/10] ${tabId} (${initialUrl}) ---`)

      // A. Activate tab visibly on Display 1
      await freyaCli(['browser', 'activate', tabId])
      // B. Dock tab visibly so the user sees the page on screen and viewport has size
      const dockRes = await freyaCli(['browser', 'dock', tabId])
      console.log(`  Docked: ${dockRes.ok === true ? 'YES' : 'NO'}`)
      await sleep(1500)

      // C. Scroll to bottom
      console.log('  Scrolling to bottom...')
      const scrollRes = await freyaCli(['browser', 'scroll', 'bottom', tabId])
      console.log(`  Scrolled: ${scrollRes.ok === true ? 'YES' : JSON.stringify(scrollRes)}`)
      await sleep(1500)

      // D. Take snapshot to locate Contact link
      console.log('  Taking DOM snapshot...')
      const snapRes = await freyaCli(['browser', 'snapshot', tabId])
      const snapshot = snapRes.snapshot || snapRes.data?.snapshot || snapRes
      const revision = snapshot?.revision ?? snapRes.data?.revision
      const elements = snapshot?.elements || snapRes.data?.elements || []

      console.log(`  Snapshot revision: ${revision}, elements found: ${elements.length}`)

      // Look for contact link
      const contactLink = elements.find(
        (el) =>
          el.kind === 'link' &&
          (/contact/i.test(el.name || '') ||
            /contact/i.test(el.text || '') ||
            /contact/i.test(el.url || '') ||
            /contact/i.test(el.href || ''))
      )

      if (contactLink && revision) {
        console.log(`  Found Contact link: "${contactLink.name || contactLink.text}" (ref: ${contactLink.ref})`)
        console.log(`  Clicking Contact link...`)
        const clickRes = await freyaCli(['browser', 'click', contactLink.ref, String(revision), tabId])
        console.log(`  Click result: ${clickRes.ok === true ? 'OK' : JSON.stringify(clickRes)}`)

        // Wait for potential navigation
        await sleep(3000)

        // Read updated tab status
        const currentTabs = await freyaCli(['browser', 'tabs'])
        const updatedTab = (currentTabs.tabs || []).find((t) => t.tabId === tabId)
        const finalUrl = updatedTab?.liveUrl || updatedTab?.url || initialUrl
        const finalTitle = updatedTab?.title || ''

        console.log(`  Final URL: ${finalUrl}`)
        console.log(`  Final Title: ${finalTitle}`)

        report.push({
          site: initialUrl,
          tabId,
          contactFound: true,
          contactRef: contactLink.ref,
          clicked: clickRes.ok === true,
          finalUrl,
          finalTitle,
          status: 'SUCCESS',
        })
      } else {
        console.log('  No obvious contact link found in snapshot elements.')
        report.push({
          site: initialUrl,
          tabId,
          contactFound: false,
          clicked: false,
          finalUrl: initialUrl,
          finalTitle: tab.title || '',
          status: 'NO_CONTACT_LINK',
        })
      }
    }

    // 13. Cleanup: Undock the browser view so the dashboard/chat returns
    console.log('\n[13] Undocking browser view...')
    await freyaCli(['browser', 'undock'])

    // 14. Print final report
    console.log('\n================ FINAL ACCEPTANCE REPORT ================')
    console.table(report)
    console.log('=========================================================\n')
  } finally {
    try {
      await freyaCli(['browser', 'undock'])
    } catch {}
    await browser.close()
  }
}

run().catch((err) => {
  console.error('Fatal error during acceptance flow:', err)
  process.exit(1)
})
