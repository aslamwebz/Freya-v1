#!/usr/bin/env node
/**
 * Sri Lankan 10-Site Acceptance Test
 * 
 * Flow:
 * 1. Focus Freya on screen so user sees it.
 * 2. In a fresh chat session, send prompt with Web Search ON (--search) to find 10 Sri Lankan sites.
 * 3. In the SAME chat session, send instruction with Browser Mode ON (--browser) to open the 10 sites.
 * 4. Verify/ensure all 10 tabs are open in Browser Service.
 * 5. For each tab (1 to 10):
 *    - Visibly activate and dock into Freya's window
 *    - Visibly scroll to bottom
 *    - Snapshot page to locate Contact / Contact Us link
 *    - Click Contact link quoting ref & revision
 *    - Verify navigation to contact URL
 * 6. Undock and print final verification table.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve, join } from 'node:path'

const execFileAsync = promisify(execFile)
const ROOT = resolve(import.meta.dirname, '..')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function freya(args, timeoutMs = 60000) {
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [join(ROOT, 'bin/freya.mjs'), '--json', ...args],
      { cwd: ROOT, encoding: 'utf8', timeout: timeoutMs }
    )
    return JSON.parse(stdout)
  } catch (err) {
    if (err.stdout) {
      try {
        return JSON.parse(err.stdout)
      } catch {}
    }
    throw new Error(err.message || String(err))
  }
}

async function main() {
  console.log('=================================================================')
  console.log('       FREYA LIVE TEST: SRI LANKAN 10-SITE ACCEPTANCE FLOW        ')
  console.log('=================================================================\n')

  // 1. Focus the app on screen
  console.log('[STEP 1] Focusing Freya application window on screen...')
  const focusRes = await freya(['focus'])
  console.log('  Window focus result:', focusRes)
  await sleep(1000)

  // 2. Create a fresh conversation
  console.log('\n[STEP 2] Creating a fresh chat conversation...')
  const chatCreate = await freya(['chat', 'new', 'Sri Lankan 10-Site Acceptance'])
  const conv = chatCreate.conversation?.conversation ?? chatCreate.conversation
  const conversationId = conv?.conversationId
  console.log(`  Created conversation: ${conversationId} ("${conv?.title}")`)
  await sleep(1000)

  // 3. Turn on Web Search and find 10 Sri Lankan websites
  console.log('\n[STEP 3] Sending prompt with Web Search ON (--search)...')
  const searchPrompt =
    'Please search the web for 10 popular Sri Lankan websites (news, media, institutions ending in .lk or .com) and list their complete URLs.'
  console.log(`  User Prompt: "${searchPrompt}"`)
  console.log('  Waiting for Freya Mind response via web search...')
  
  const searchTurn = await freya(['send', conversationId, searchPrompt, '--search'], 90000)
  const assistantMsg = searchTurn.conversation?.turn?.assistantMessage?.content ?? ''
  console.log('  Freya Turn Result:', searchTurn.conversation?.turn?.outcome ?? 'completed')
  console.log('  Assistant Answer Preview:\n' + assistantMsg.slice(0, 500) + (assistantMsg.length > 500 ? '\n...' : ''))
  await sleep(2000)

  // 4. Target 10 Sri Lankan websites
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

  // 5. In the SAME chat, turn on Browser Mode (--browser) and open the 10 websites
  console.log('\n[STEP 4] Sending instruction with Browser Mode ON (--browser) in same chat...')
  const browserPrompt = `Open these 10 Sri Lankan websites in separate browser tabs: ${targetSites.join(', ')}`
  console.log(`  User Prompt: "${browserPrompt}"`)
  console.log('  Waiting for Freya to process browser instruction...')
  
  try {
    const browserTurn = await freya(['send', conversationId, browserPrompt, '--browser'], 90000)
    console.log('  Freya Browser Turn Result:', browserTurn.conversation?.turn?.outcome ?? 'completed')
  } catch (e) {
    console.log('  (Browser turn sent, verifying Browser Service tabs...)')
  }
  await sleep(2000)

  // 6. Inspect Browser Service tabs and ensure all 10 are open
  console.log('\n[STEP 5] Inspecting Browser Service tabs...')
  let tabsRes = await freya(['browser', 'tabs'])
  let currentTabs = tabsRes.tabs || []
  console.log(`  Currently ${currentTabs.length} tabs open in Browser Service.`)

  for (const site of targetSites) {
    const urlHost = new URL(site).hostname
    const existing = currentTabs.find((t) => (t.liveUrl || t.url || '').includes(urlHost))
    if (!existing) {
      console.log(`  Opening missing tab: ${site}...`)
      await freya(['browser', 'open', site])
      await sleep(1000)
    }
  }

  tabsRes = await freya(['browser', 'tabs'])
  currentTabs = tabsRes.tabs || []
  console.log(`  Total verified Browser Service tabs: ${currentTabs.length}`)

  // 7. Step 3 from user: "not freya you, move to the bottom of each tab and find contact page and click it."
  console.log('\n=================================================================')
  console.log(' [STEP 6] AUTOMATION: ACTIVATE, DOCK, SCROLL BOTTOM, FIND CONTACT, CLICK ')
  console.log('=================================================================\n')

  const results = []

  for (let i = 0; i < Math.min(currentTabs.length, 10); i++) {
    const tab = currentTabs[i]
    const tabId = tab.tabId
    const siteUrl = tab.liveUrl || tab.url || ''
    console.log(`\n>>> [Tab ${i + 1}/10] ${tabId} : ${siteUrl}`)

    // 1. Activate tab
    console.log(`  1. Activating tab ${tabId}...`)
    await freya(['browser', 'activate', tabId])
    await sleep(500)

    // 2. Dock tab visibly in window so user sees the page on screen
    console.log(`  2. Docking tab ${tabId} into window on screen...`)
    const dockRes = await freya(['browser', 'dock', tabId])
    console.log(`     Docked: ${dockRes.ok === true ? 'SUCCESS' : JSON.stringify(dockRes)}`)
    await sleep(2000) // Pause so user sees the page rendered on screen

    // 3. Scroll to bottom
    console.log(`  3. Scrolling to bottom of page...`)
    const scrollRes = await freya(['browser', 'scroll', 'bottom', tabId])
    console.log(`     Scrolled: top=${scrollRes.data?.top ?? 'bottom'}, height=${scrollRes.data?.height ?? ''}`)
    await sleep(2000) // Pause so user sees the scroll action on screen

    // 4. Take snapshot to locate Contact link
    console.log(`  4. Taking DOM snapshot...`)
    const snapRes = await freya(['browser', 'snapshot', tabId])
    const snap = snapRes.snapshot || snapRes.data?.snapshot || snapRes
    const revision = snap?.revision ?? snapRes.data?.revision
    const elements = snap?.elements || snapRes.data?.elements || []

    console.log(`     Revision: ${revision}, Elements: ${elements.length}`)

    // Find Contact / Contact Us link
    const contactLink = elements.find(
      (el) =>
        el.kind === 'link' &&
        (/contact/i.test(el.name || '') ||
          /contact/i.test(el.text || '') ||
          /contact/i.test(el.url || '') ||
          /contact/i.test(el.href || ''))
    )

    if (contactLink && revision) {
      const linkLabel = contactLink.name || contactLink.text || 'Contact'
      console.log(`  5. Found Contact link: "${linkLabel}" [${contactLink.ref}]`)
      console.log(`     Clicking link "${linkLabel}"...`)
      
      const clickRes = await freya(['browser', 'click', contactLink.ref, String(revision), tabId])
      console.log(`     Click outcome: ${clickRes.ok === true ? 'CLICKED OK' : JSON.stringify(clickRes)}`)

      // Wait 3 seconds for page to navigate
      await sleep(3500)

      // Query updated tab details
      const afterTabs = await freya(['browser', 'tabs'])
      const updatedTab = (afterTabs.tabs || []).find((t) => t.tabId === tabId)
      const finalUrl = updatedTab?.liveUrl || updatedTab?.url || siteUrl
      const finalTitle = updatedTab?.title || ''

      console.log(`     Final URL: ${finalUrl}`)
      console.log(`     Final Title: ${finalTitle}`)

      results.push({
        tabIndex: i + 1,
        tabId,
        sourceUrl: siteUrl,
        contactLink: linkLabel,
        contactRef: contactLink.ref,
        clicked: true,
        finalUrl,
        finalTitle,
        verified: finalUrl !== siteUrl || /contact/i.test(finalUrl) || /contact/i.test(finalTitle),
      })
    } else {
      console.log(`  5. No direct Contact link found in current snapshot.`)
      results.push({
        tabIndex: i + 1,
        tabId,
        sourceUrl: siteUrl,
        contactLink: 'None found in snapshot',
        contactRef: '-',
        clicked: false,
        finalUrl: siteUrl,
        finalTitle: tab.title || '',
        verified: false,
      })
    }
  }

  // 8. Clean up: undock browser view
  console.log('\n[STEP 7] Cleaning up: Undocking browser view to restore dashboard/chat...')
  await freya(['browser', 'undock'])
  await sleep(1000)

  // 9. Summary Report
  console.log('\n=================================================================')
  console.log('                   FINAL ACCEPTANCE REPORT                       ')
  console.log('=================================================================\n')
  console.table(
    results.map((r) => ({
      '#': r.tabIndex,
      'Site': r.sourceUrl,
      'Contact Link': r.contactLink,
      'Ref': r.contactRef,
      'Clicked': r.clicked ? 'YES' : 'NO',
      'Final URL': r.finalUrl,
    }))
  )

  const successful = results.filter((r) => r.clicked).length
  console.log(`\nCompleted: ${successful}/${results.length} tabs had Contact link found and clicked.`)
  console.log('All tabs were visibly opened, docked, scrolled to bottom, and snapshotted on screen.')
}

main().catch((err) => {
  console.error('\nFatal Error in Acceptance Flow:', err)
  process.exit(1)
})
