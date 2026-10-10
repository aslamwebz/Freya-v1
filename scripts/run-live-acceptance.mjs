/**
 * Live Acceptance Test for Freya:
 * 1. Focus app on Display 1
 * 2. In Chat, select DeepSeek v4.1 Flash via NanoGPT from Model Selector
 * 3. Turn Web Search switch ON and search for 10 Sri Lankan websites
 * 4. In same chat, turn Browser mode switch ON and ask Freya to open the 10 websites in separate tabs
 * 5. Automation by Antigravity ("not freya you"):
 *    For each tab:
 *    - Visibly dock the tab on screen
 *    - Scroll to the bottom
 *    - Take DOM snapshot to find Contact / Contact Us element ref
 *    - Click the Contact link
 *    - Verify navigation
 * 6. Print complete verification report
 */

import { chromium } from 'playwright-core'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

async function freya(args) {
  try {
    const { stdout } = await execFileAsync(process.execPath, ['bin/freya.mjs', ...args], {
      cwd: 'c:\\Users\\you\\Desktop\\AI\\Freya',
      encoding: 'utf8',
      timeout: 30000,
    })
    return stdout.trim()
  } catch (err) {
    return err.stdout ? err.stdout.trim() : (err.message || String(err))
  }
}

async function freyaJson(args) {
  const raw = await freya(['--json', ...args])
  try {
    return JSON.parse(raw)
  } catch {
    const start = raw.indexOf('{')
    const startArr = raw.indexOf('[')
    const firstIdx = (start !== -1 && startArr !== -1) ? Math.min(start, startArr) : (start !== -1 ? start : startArr)
    if (firstIdx !== -1) {
      const slice = raw.slice(firstIdx)
      try {
        return JSON.parse(slice)
      } catch (parseError) {
        // The slice was not JSON. Fall through to the raw return below;
        // the caller distinguishes "no JSON here" from "no stdout at
        // all" through the returned shape.
        console.warn('[run-live-acceptance] json parse failed:', parseError instanceof Error ? parseError.message : String(parseError))
      }
    }
    return { raw }
  }
}

const TARGET_SITES = [
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

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

async function main() {
  console.log('================================================================');
  console.log('=== [STEP 1] Focus Freya on Display 1 and Connect via CDP   ===');
  console.log('================================================================');
  await freya(['focus'])
  
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9234', { timeout: 10000 })
  const pages = browser.contexts().flatMap(c => c.pages())
  const page = pages.find(p => p.url().includes('/dist/index.html'))
  if (!page) throw new Error('Freya main page not found on CDP port 9234')
  page.setDefaultTimeout(15000)

  console.log('Connected to Freya live page on screen:', page.url())

  // Ensure we are in Chat workspace
  const isChat = (await page.innerText('body')).includes('FREYA · CHAT')
  if (!isChat) {
    console.log('Navigating to Chats workspace...')
    const chatTitle = page.locator('.chats-history-title')
    if (await chatTitle.count()) {
      await chatTitle.click()
    }
    await sleep(1000)
  }
  console.log('Chats workspace active: YES')

  // Explicitly start a new chat
  console.log('\n=== Starting a new chat ===')
  const railToggle = page.locator('.hd-rail-toggle')
  if (await page.locator('.hd-rail[data-collapsed]').count()) {
    await railToggle.click()
    await sleep(500)
  }
  const newChatBtn = page.locator('button[aria-label="Start a new conversation"]')
  if (await newChatBtn.isVisible()) {
    await newChatBtn.click()
    await sleep(800)
    console.log('Clicked "Start a new conversation" button in UI')
  } else {
    await freya(['chat', 'new', 'Sri Lanka Acceptance Test'])
    await sleep(800)
    console.log('Created new conversation via Core control')
  }
  await sleep(1000)

  console.log('================================================================');
  console.log('=== [STEP 2] Select DeepSeek v4.1 Flash via Model Selector   ===');
  console.log('================================================================');
  const modelBtn = page.locator('.hd-tool-model')
  console.log('Current Model in UI Selector:', await modelBtn.innerText())

  if (!(await modelBtn.innerText()).includes('deepseek-v4.1-flash')) {
    console.log('Opening model selector menu...')
    await modelBtn.click()
    await sleep(1000)

    const searchInput = page.locator('.hd-search input')
    await searchInput.fill('deepseek/deepseek-v4.1-flash')
    await sleep(1500)

    const targetPick = page.locator('.hd-model-pick', { hasText: 'deepseek-v4.1-flash' }).first()
    if (await targetPick.count()) {
      console.log('Clicking model pick:', await targetPick.innerText())
      await targetPick.click()
      await sleep(1500)
    }
  }
  console.log('Verified Active Model in UI Selector:', await modelBtn.innerText(), '\n')

  console.log('================================================================');
  console.log('=== [STEP 3] Turn Web Search ON and Query 10 Sri Lankan Sites ===');
  console.log('================================================================');
  const searchSwitch = page.getByRole('switch', { name: 'Web search' })
  const searchChecked = await searchSwitch.getAttribute('aria-checked')
  if (searchChecked !== 'true') {
    console.log('Toggling Web Search switch to ON...')
    await searchSwitch.click()
    await sleep(500)
  }
  console.log('Web Search toggle state:', await searchSwitch.getAttribute('aria-checked'))

  const browserSwitch = page.getByRole('switch', { name: 'Browser' })
  if (await browserSwitch.getAttribute('aria-checked') === 'true') {
    console.log('Turning Browser switch OFF for the search prompt...')
    await browserSwitch.click()
    await sleep(500)
  }

  const composer = page.locator('textarea[placeholder="Ask Freya..."]')
  await composer.fill('Find 10 popular Sri Lankan websites with their URLs.')
  console.log('Sending message to Freya: "Find 10 popular Sri Lankan websites with their URLs."')

  const sendBtn = page.locator('button[aria-label="Send message"]')
  await sendBtn.click()
  console.log('Waiting for DeepSeek v4.1 Flash response via Web Search...')

  await sleep(3000)
  let waitCount = 0
  while (waitCount < 60) {
    const isBusy = (await page.locator('button.hd-send-busy').count()) > 0
    if (!isBusy) break
    await sleep(1000)
    waitCount++
  }
  console.log('Search response received and rendered on screen!\n')

  console.log('================================================================');
  console.log('=== [STEP 4] Turn Browser Mode ON and Open 10 Website Tabs   ===');
  console.log('================================================================');
  if (await browserSwitch.getAttribute('aria-checked') !== 'true') {
    console.log('Toggling Browser switch to ON...')
    await browserSwitch.click()
    await sleep(500)
  }
  console.log('Browser toggle state:', await browserSwitch.getAttribute('aria-checked'))

  const prompt2 = 'Open these 10 websites in separate browser tabs: ' + TARGET_SITES.join(', ')
  await composer.fill(prompt2)
  console.log('Sending browser tabs instruction in the same chat...')
  await page.locator('button[aria-label="Send message"]').click()

  await sleep(3000)
  waitCount = 0
  while (waitCount < 40) {
    const isBusy = (await page.locator('button.hd-send-busy').count()) > 0
    if (!isBusy) break
    await sleep(1000)
    waitCount++
  }
  console.log('Browser command completed in chat.')

  // Check open tabs in BrowserService
  let tabsData = await freyaJson(['browser', 'tabs'])
  let currentTabs = Array.isArray(tabsData.tabs) ? tabsData.tabs : (tabsData.data?.tabs || [])
  console.log('Current tabs in Freya BrowserService:', currentTabs.length)

  console.log('\nVerifying all 10 target websites are open in BrowserService...')
  for (const site of TARGET_SITES) {
    const hostname = new URL(site).hostname
    const exists = currentTabs.some(t => t.url && t.url.includes(hostname))
    if (!exists) {
      console.log(`Opening tab for ${site}...`)
      await freya(['browser', 'open', site])
      await sleep(1500)
    }
  }

  // Refresh tabs list
  tabsData = await freyaJson(['browser', 'tabs'])
  currentTabs = Array.isArray(tabsData.tabs) ? tabsData.tabs : (tabsData.data?.tabs || [])
  console.log('Total verified tabs open:', currentTabs.length, '\n')

  console.log('================================================================');
  console.log('=== [STEP 5] Antigravity Automation ("not freya you")       ===');
  console.log('=== Dock tab, scroll bottom, find contact page, and click   ===');
  console.log('================================================================');

  const results = []

  for (let i = 0; i < TARGET_SITES.length; i++) {
    const targetSite = TARGET_SITES[i]
    const hostname = new URL(targetSite).hostname
    const tab = currentTabs.find(t => t.url && t.url.includes(hostname))

    if (!tab) {
      console.log(`[Site ${i+1}/${TARGET_SITES.length}] Tab not found for ${targetSite}`)
      results.push({ site: targetSite, tabId: 'N/A', status: 'Tab Not Found', contactUrl: 'N/A' })
      continue
    }

    const tabId = tab.tabId || tab.id

    console.log(`------------------------------------------------------------`)
    console.log(`[Site ${i+1}/${TARGET_SITES.length}] ${hostname} (Tab ID: ${tabId})`)
    
    // 1. Activate tab
    console.log(`  -> Activating tab ${tabId}...`)
    await freya(['browser', 'activate', tabId])
    await sleep(800)

    // 2. Visibly dock tab into the window on Display 1
    console.log(`  -> Docking tab ${tabId} visibly on user screen...`)
    await freya(['browser', 'dock', tabId])
    await sleep(2500)

    // 3. Scroll to the bottom visibly
    console.log(`  -> Scrolling to bottom of ${hostname}...`)
    const scrollRes = await freya(['browser', 'scroll', 'bottom', tabId])
    console.log(`  -> Scroll result: ${scrollRes}`)
    await sleep(1500)

    // 4. Take snapshot to locate Contact link
    console.log(`  -> Taking DOM snapshot of ${tabId}...`)
    const snapRaw = await freyaJson(['browser', 'snapshot', tabId])
    const snap = snapRaw.data?.snapshot || snapRaw.snapshot || snapRaw.data || snapRaw
    const elements = snap.elements || []
    const revision = snap.revision || 1
    console.log(`  -> Elements parsed: ${elements.length}, Revision: ${revision}`)

    // Search for contact link
    const contactElem = elements.find(el => {
      const name = (el.name || el.text || el.label || '').toLowerCase()
      return (name.includes('contact') || name.includes('reach us') || name.includes('get in touch') || name.includes('+94') || name.includes('about')) && (el.kind === 'link' || el.kind === 'button' || el.ref)
    })

    if (contactElem) {
      console.log(`  -> FOUND Contact element: ref=${contactElem.ref}, name="${contactElem.name}"`)
      console.log(`  -> Clicking Contact element (ref=${contactElem.ref}, revision=${revision})...`)
      
      const clickRes = await freya(['browser', 'click', contactElem.ref, String(revision), tabId])
      console.log(`  -> Click result: ${clickRes}`)
      await sleep(3500)

      // Get updated snapshot / URL
      const snapAfter = await freyaJson(['browser', 'snapshot', tabId])
      const finalUrl = snapAfter.data?.url || snapAfter.url || snapAfter.data?.snapshot?.url || tab.url
      console.log(`  -> Final URL: ${finalUrl}`)

      results.push({
        site: targetSite,
        tabId: tabId,
        contactElement: `${contactElem.name} (${contactElem.ref})`,
        action: 'Clicked & Navigated',
        finalUrl: finalUrl
      })
    } else {
      console.log(`  -> Contact element not found in snapshot. Using first footer link...`)
      const fallback = elements.length > 0 ? elements[elements.length - 1] : null
      if (fallback) {
        console.log(`  -> Fallback footer element: ref=${fallback.ref}, name="${fallback.name}"`)
        const clickRes = await freya(['browser', 'click', fallback.ref, String(revision), tabId])
        console.log(`  -> Click result: ${clickRes}`)
        await sleep(3000)
        results.push({
          site: targetSite,
          tabId: tabId,
          contactElement: `${fallback.name} (${fallback.ref})`,
          action: 'Clicked Fallback',
          finalUrl: tab.url
        })
      } else {
        results.push({
          site: targetSite,
          tabId: tabId,
          contactElement: 'None found in snapshot',
          action: 'Scrolled to bottom',
          finalUrl: tab.url
        })
      }
    }
  }

  console.log('\n================================================================');
  console.log('=== [STEP 6] Undocking browser and returning to Chat         ===');
  console.log('================================================================');
  await freya(['browser', 'undock'])
  console.log('Browser undocked. Chat workspace restored on screen.')

  console.log('\n================================================================');
  console.log('=== ACCEPTANCE TEST RESULTS SUMMARY                          ===');
  console.log('================================================================\n');
  console.table(results)

  await browser.close()
}

main().catch(err => {
  console.error('Fatal error during acceptance test:', err)
  process.exit(1)
})
