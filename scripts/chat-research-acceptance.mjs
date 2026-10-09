import { chromium } from 'playwright-core'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
/* global document, window */

// UI automation operates Freya only. Actual retrieval uses its guarded tools.
const browser = await chromium.connectOverCDP(process.env.FREYA_TEST_CDP ?? 'http://127.0.0.1:9235')
const evidence = 'artifacts/live-visible/chat-evolution'
const restored = process.argv.includes('--restored')
try {
  const page = browser.contexts().flatMap(context => context.pages()).find(page => page.url().includes('Freya-chat-evolution/dist/index.html'))
  if (!page) throw new Error('Approved feature renderer is not running')
  page.setDefaultTimeout(15000)
  await mkdir(evidence, { recursive: true })
  await page.waitForSelector('.hd-dashboard')
  await page.getByRole('button', { name: 'Home', exact: true }).click()
  await page.getByRole('button', { name: 'Open Chats', exact: true }).click()
  async function state() { return page.evaluate(() => window.freyaHost.coreConversation()) }
  async function waitForState(accept, timeoutMs = 180000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const current = await state()
      if (accept(current)) return current
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    throw new Error('Core did not reach the required terminal conversation state')
  }
  async function send(text) {
    await page.getByRole('textbox', { name: 'Ask Freya', exact: true }).fill(text)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    const current = await waitForState(current => {
      const outcome = current.conversations.find(item => item.conversationId === current.activeConversationId)?.lastTurnOutcome
      const user = current.messages.filter(message => message.role === 'user' && message.content === text).at(-1)
      const answer = user && current.messages.find(message => message.role === 'assistant' && message.turnId === user.turnId)
      return user && current.activeTurn === null && outcome && outcome !== 'pending'
        && (answer || outcome !== 'completed')
    })
    assert.equal(current.conversations.find(item => item.conversationId === current.activeConversationId)?.lastTurnOutcome, 'completed')
    assert.equal(current.messages.filter(message => message.role === 'user').at(-1)?.content, text)
    return current.messages.filter(message => message.role === 'assistant').at(-1)
  }
  if (!restored) {
    const continuing = process.argv.includes('--continue')
    if (!continuing) {
      await page.getByRole('button', { name: 'Start a new conversation', exact: true }).click()
      await page.waitForFunction(() => document.querySelector('.chats-history-item[aria-current="true"]')?.textContent?.trim() === 'New conversation')
      const title = `Research acceptance ${Date.now()}`
      await page.locator('.chats-history-item[aria-current="true"]').locator('..').getByRole('button', { name: /^Rename / }).click()
      await page.getByRole('textbox', { name: 'Conversation title', exact: true }).fill(title)
      await page.getByRole('button', { name: 'Save title', exact: true }).click()
      await page.getByRole('button', { name: title, exact: true }).waitFor()
    }
    if (continuing) await waitForState(current => current.conversations.find(item => item.conversationId === current.activeConversationId)?.lastTurnOutcome === 'completed')
    const search = continuing ? (await state()).messages.find(message => message.role === 'assistant')
      : await send('Search the web for HTTP caching documentation. Give a concise answer using the returned source snippets and numbered [n] citations. Do not use your browser.')
    assert.ok(search.sources?.length >= 2, 'Real search did not return at least two typed sources')
    assert.ok(search.steps?.some(step => step.tool === 'web_search' && step.executed && step.outcome === 'ok'))
    assert.equal(new Set(search.sources.map(source => source.rank)).size, search.sources.length)
    const source = search.sources.find(source => source.rank === 2)
    assert.ok(source)
    const beforeFollowUp = (await state()).messages.filter(message => message.role === 'assistant')
    const followUp = beforeFollowUp.length >= 2 ? beforeFollowUp[1]
      : await send('Summarise source 2 using only its stored snippet. Keep citation [2]. Do not use web search. Do not use your browser.')
    assert.deepEqual(followUp.sources, [source])
    assert.ok((followUp.steps ?? []).every(step => !step.executed), 'A stored-source follow-up executed an unsolicited tool')
    if ((await state()).messages.filter(message => message.role === 'assistant').length < 3) {
      await send('Do not use web search. Do not use your browser. Format only these supplied example values as a short sentence: A=2, B=4, C=3.')
    }
  }
  const current = await state()
  assert.equal(current.cognition.available, true)
  assert.equal(current.persistence.mode, 'encrypted')
  const assistants = current.messages.filter(message => message.role === 'assistant')
  assert.equal(assistants.length, 3)
  assert.ok(assistants[0].sources?.length >= 2)
  assert.deepEqual(assistants[1].sources, [assistants[0].sources.find(source => source.rank === 2)])
  assert.ok((assistants[1].steps ?? []).every(step => !step.executed))
  assert.ok((assistants[2].steps ?? []).every(step => !step.executed))
  assert.equal(assistants[2].sources, undefined)
  const followUpView = page.locator('.chats-turn[data-role="assistant"] .f-assistant').nth(1)
  await followUpView.getByRole('button', { name: /^Source 2:/ }).first().waitFor()
  assert.equal(await followUpView.locator('.f-assistant-source-card').count(), 1)
  assert.equal(await followUpView.locator('.f-assistant-source-snippet').textContent(), assistants[1].sources[0].snippet)
  await followUpView.locator('.f-assistant-source-card').scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${evidence}/chat-research-follow-up.png` })
  const durable = { conversationId: current.activeConversationId, messages: current.messages.map(({ messageId, role, sources, steps }) => ({ messageId, role, ...(sources ? { sources } : {}), ...(steps ? { steps } : {}) })) }
  const checks = ['Real guarded web search stored typed sources', 'Unique citation ranks across returned sources', 'Same-thread source 2 retained with original snippet and retrieval time', 'Follow-up citation and source preview rendered', 'No tools executed for stored-source follow-up or explicitly declined lookup']
  if (restored) {
    assert.deepEqual(durable, JSON.parse(await readFile(`${evidence}/research-restart-expected.json`, 'utf8')))
    checks.push('Selected research conversation, source data and tool records retained after full restart')
  } else await writeFile(`${evidence}/research-restart-expected.json`, JSON.stringify(durable, null, 2))
  await writeFile(`${evidence}/phase3.json`, JSON.stringify({ checks, persistence: current.persistence.mode, renderer: page.url(), sourceCount: assistants[0].sources.length }, null, 2))
  console.log(JSON.stringify({ checks, sourceCount: assistants[0].sources.length }, null, 2))
} finally { await browser.close() }
