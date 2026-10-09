import { chromium } from 'playwright-core'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
/* global document, window */

// Real provider/Core path; UI automation operates Freya controls only.
const browser = await chromium.connectOverCDP(process.env.FREYA_TEST_CDP ?? 'http://127.0.0.1:9235')
const evidence = 'artifacts/live-visible/chat-evolution'
try {
  const page = browser.contexts().flatMap(context => context.pages()).find(page => page.url().includes('Freya-chat-evolution/dist/index.html'))
  if (!page) throw new Error('Feature renderer not running')
  page.setDefaultTimeout(15000)
  await mkdir(evidence, { recursive: true })
  await page.waitForSelector('.hd-dashboard')
  await page.getByRole('button', { name: 'Home', exact: true }).click()
  await page.getByRole('button', { name: 'Open Chats', exact: true }).click()
  const existing = process.argv.includes('--existing') || process.argv.includes('--restored')
  if (!existing) {
    await page.getByRole('button', { name: 'Start a new conversation', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.chats-history-item[aria-current="true"]')?.textContent?.trim() === 'New conversation')
    const prompt = 'Format only these supplied example values: A=2, B=4, C=3. Use a Markdown heading "Sample values", a fenced JSON code block, and a Markdown table. Base the answer only on these supplied literals.'
    await page.getByRole('textbox', { name: 'Ask Freya', exact: true }).fill(prompt)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await page.locator('.chats-user-text').filter({ hasText: 'supplied example values' }).waitFor()
    await page.waitForFunction(() => !document.querySelector('button.hd-send-busy'), null, { timeout: 180000 })
  }
  const state = await page.evaluate(() => window.freyaHost.coreConversation())
  let answer = state.messages.find(message => message.role === 'assistant')
  assert.ok(answer, 'Core did not store an assistant answer')
  assert.equal(state.conversations.find(item => item.conversationId === state.activeConversationId).lastTurnOutcome, 'completed')
  const rendered = page.locator('.chats-turn[data-role="assistant"] .f-assistant')
  assert.ok(await rendered.count() > 0)
  await rendered.first().getByRole('heading', { name: 'Sample values', exact: true }).waitFor()
  assert.ok(await rendered.first().getByRole('table').count() > 0)
  assert.ok(await rendered.first().locator('.chats-code pre code').count() > 0)
  if (existing) answer = state.messages.filter(message => message.role === 'assistant').at(-1)
  if (!(answer.charts?.length > 0)) {
    assert.ok(!existing, 'Selected stored conversation has no chart; existing verification cannot send a replacement turn')
    // A provider may answer in prose without requesting a tool. Ask explicitly,
    // through the same UI/Core turn path; never inject a chart or forged record.
    await page.getByRole('textbox', { name: 'Ask Freya', exact: true }).fill('Execute make_chart now using title Sample values, kind bar, unit count. Supply points as the JSON-encoded string [{"label":"A","value":2},{"label":"B","value":4},{"label":"C","value":3}]. Your next response should be the single FREYA_TOOL_CALL envelope required by your tool instructions. After the real tool result arrives, give a short completion note.')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('button.hd-send-busy'), null, { timeout: 180000 })
    const followUp = await page.evaluate(() => window.freyaHost.coreConversation())
    answer = followUp.messages.filter(message => message.role === 'assistant').at(-1)
  }
  assert.ok((answer.charts?.length ?? 0) > 0, 'Provider did not return a typed chart')
  assert.ok((answer.steps?.length ?? 0) > 0, 'Core did not return typed tool steps')
  assert.deepEqual(answer.charts[0].points, [{ label: 'A', value: 2 }, { label: 'B', value: 4 }, { label: 'C', value: 3 }])
  const chartMessage = rendered.last()
  assert.equal(await chartMessage.locator('.f-chart-bar').count(), 3)
  if (!(await chartMessage.locator('.f-assistant-steps').evaluate(element => element.open))) {
    await chartMessage.getByText('What Freya did for this answer', { exact: true }).click()
  }
  for (const step of answer.steps) {
    assert.ok((await chartMessage.locator('.f-assistant-steps').textContent()).includes(step.tool.replace(/_/g, ' ')))
  }
  await page.getByRole('button', { name: 'Copy answer', exact: true }).last().click()
  await page.waitForFunction(() => [...document.querySelectorAll('button[aria-label="Copy answer"]')].some(button => button.textContent === 'Copied'))
  await rendered.first().getByRole('button', { name: 'Copy', exact: true }).click()
  await rendered.first().getByRole('button', { name: 'Copied', exact: true }).waitFor()
  await page.screenshot({ path: `${evidence}/chat-rendering.png` })
  await chartMessage.locator('.f-chart').scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${evidence}/chat-rendering-chart.png` })
  const finalState = await page.evaluate(() => window.freyaHost.coreConversation())
  const durable = { conversationId: finalState.activeConversationId, messageIds: finalState.messages.map(message => message.messageId), charts: answer.charts, steps: answer.steps }
  const checks = ['Real provider answer stored by Core', 'Heading, code block and table rendered', 'Typed chart rendered', 'Execution panel uses actual Core tool steps', 'Answer and code copy confirm success']
  if (process.argv.includes('--restored')) {
    assert.deepEqual(durable, JSON.parse(await readFile(`${evidence}/rendering-restart-expected.json`, 'utf8')))
    checks.push('Selected transcript, typed chart and tool records retained after full restart')
  } else await writeFile(`${evidence}/rendering-restart-expected.json`, JSON.stringify(durable, null, 2))
  await writeFile(`${evidence}/phase2.json`, JSON.stringify({ checks, renderer: page.url(), persistence: finalState.persistence.mode, toolSteps: answer.steps.map(step => ({ tool: step.tool, outcome: step.outcome, executed: step.executed })), chartCount: answer.charts.length }, null, 2))
  console.log(JSON.stringify({ checks, chartCount: answer.charts.length, toolCount: answer.steps.length }, null, 2))
} finally { await browser.close() }
