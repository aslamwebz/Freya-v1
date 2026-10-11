import { chromium } from 'playwright-core'
const b = await chromium.connectOverCDP('http://127.0.0.1:9234', { timeout: 8000 })
const p = b.contexts().flatMap(c => c.pages()).find(x => x.url().includes('/dist/index.html'))
p.setDefaultTimeout(6000)

const state = await p.evaluate(() => {
  const saved = document.querySelector('section[aria-label="Saved conversations"]')
  const all = saved ? [...saved.querySelectorAll('button')].map(b => (b.getAttribute('aria-label') || '').slice(0, 70)) : []
  const conv = document.querySelector('section[aria-label="Conversation"]')
  const text = conv ? (conv.innerText || '') : ''
  return {
    savedButtons: all.slice(0, 14),
    savedCount: all.length,
    conversationFirstLine: text.split('\n').filter(Boolean)[0] ?? '',
    hasChatsNav: !!document.querySelector('button[aria-label="Open Chats"]'),
    // The sidebar can be collapsed, which hides the list without emptying it.
    sidebarHidden: !!document.querySelector('button[aria-label="Show the conversation list"]'),
  }
})
console.log('saved conversation buttons:', state.savedCount)
state.savedButtons.forEach(x => console.log('  ·', x))
console.log('\nconversation section first line:', JSON.stringify(state.conversationFirstLine))
console.log('sidebar hidden (needs unhide):', state.sidebarHidden)
await b.close()