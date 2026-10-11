# Freya External Control Guide

Comprehensive manual for controlling and automating Freya from external tools, scripts, Playwright, and agent systems.

---

## Architecture Overview

Freya provides two complementary external control channels:

```
┌─────────────────────────────────────────────────────────────┐
│                       FREYA DESKTOP                         │
│                                                             │
│   ┌───────────────────────────┐ ┌─────────────────────────┐ │
│   │     Renderer (React UI)   │ │  Main Process & Core    │ │
│   │                           │ │                         │ │
│   │   - Screen & Workspace    │ │   - Guard & Governor    │ │
│   │   - Model Selector Dropdown││   - Mind Turn Loop      │ │
│   │   - Web Search & Browser  │ │   - Browser Service     │ │
│   │     Toggles               │ │   - Conversations       │ │
│   │   - Composer Input        │ │   - Named Pipe Control  │ │
│   └─────────────▲─────────────┘ └────────────▲────────────┘ │
└─────────────────┼────────────────────────────┼──────────────┘
                  │                            │
      CDP Port 9234 (HTTP / WS)     Windows Named Pipe
   (FreyaDebug.cmd / dev-kilo)  (\\.\pipe\freya-control-<pid>)
                  │                            │
          ┌───────┴──────┐              ┌──────┴──────┐
          │  Playwright  │              │  freya CLI  │
          │  Controller  │              │ / MCP Host  │
          └──────────────┘              └─────────────┘
```

1. **Visual UI Control (CDP on port 9234)**:
   - Enabled when launched via `FreyaDebug.cmd` or `scripts/dev-kilo.mjs`.
   - Used by Playwright to click real UI buttons, toggle intent switches, select models, and type in the composer.
2. **Authority & Service Control (Named Pipe)**:
   - Always enabled on any running Freya instance (`\\.\pipe\freya-control-<pid>`).
   - Used by `bin/freya.mjs` to focus windows, manage tabs, dock native views, scroll, take DOM snapshots, and click semantic refs.

---

## 1. Visual UI Control via Playwright (CDP)

### Prerequisites
Launch Freya with **`FreyaDebug.cmd`** (or `FreyaDebug.cmd --no-build`).

### Connecting with Playwright
```javascript
import { chromium } from 'playwright-core'

const browser = await chromium.connectOverCDP('http://127.0.0.1:9234')
const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('/dist/index.html'))
page.setDefaultTimeout(10000)
```

### Key UI Actions

#### A. Navigate from Dashboard to Chat
When Freya boots, it defaults to the Dashboard (`home`). To navigate to Chat:
```javascript
const chatTitle = page.locator('.chats-history-title')
await chatTitle.click()
await page.waitForTimeout(500)
```

#### B. Select a Model from the Model Selector (Without touching `.env`)
```javascript
const modelBtn = page.locator('.hd-tool-model')
await modelBtn.click()

// Search for the model
const searchInput = page.locator('.hd-search input')
await searchInput.fill('deepseek/deepseek-v4.1-flash')
await page.waitForTimeout(1000)

// Click the matching model pick
const modelPick = page.locator('.hd-model-pick', { hasText: 'deepseek-v4.1-flash' }).first()
await modelPick.click()
```

#### C. Toggle Intent Switches (Web Search & Browser Mode)
```javascript
const searchSwitch = page.getByRole('switch', { name: 'Web search' })
if (await searchSwitch.getAttribute('aria-checked') !== 'true') {
  await searchSwitch.click() // Turns ON Web Search
}

const browserSwitch = page.getByRole('switch', { name: 'Browser' })
if (await browserSwitch.getAttribute('aria-checked') !== 'true') {
  await browserSwitch.click() // Turns ON Browser Mode
}
```

#### D. Type and Submit a Message
```javascript
const composer = page.locator('textarea[placeholder="Ask Freya..."]')
await composer.fill('Find 10 popular Sri Lankan websites with their URLs.')

const sendBtn = page.locator('button[aria-label="Send message"]')
await sendBtn.click()

// Wait for response to finish generating
await page.waitForSelector('button.hd-send-busy', { state: 'detached', timeout: 60000 })
```

---

## 2. Service Control via Named Pipe (`bin/freya.mjs`)

The CLI client (`bin/freya.mjs`) uses `FREYA_USER_DATA` to discover the selected profile. For the default debug profile, set it to the absolute `.kilo/freya-debug-profile` directory. Discovery and authentication use that profile's `control.endpoint` and `control.token`.

### General Commands
```powershell
# Show status and health
node bin\freya.mjs status
node bin\freya.mjs health

# Bring Freya to foreground on screen
node bin\freya.mjs focus

# List conversation history
node bin\freya.mjs chats

# Create a new conversation
node bin\freya.mjs chat new "Sri Lanka Discovery"

# Send a turn via CLI
node bin\freya.mjs send <conversationId> "Find news" --search
node bin\freya.mjs send <conversationId> "Open websites" --browser
```

### Browser Service Commands
Freya contains a full embedded Browser Service. Tabs belong to Browser Service, not headless browsers.

```powershell
# Check browser service status and list open tabs
node bin\freya.mjs --json browser status
node bin\freya.mjs --json browser tabs

# Open a new tab
node bin\freya.mjs browser open https://adaderana.lk

# Activate an existing tab
node bin\freya.mjs browser activate <tabId>

# Dock the tab view into Freya's window on screen (required for visual viewport)
node bin\freya.mjs browser dock <tabId>

# Scroll the page (top, bottom, or pixel offset)
node bin\freya.mjs browser scroll bottom <tabId>
node bin\freya.mjs browser scroll 2500 <tabId>

# Take a semantic DOM snapshot (returns elements and revision number)
node bin\freya.mjs --json browser snapshot <tabId>

# Click an element by its semantic ref and revision
node bin\freya.mjs browser click r12 3 <tabId>

# Undock the browser view to return to the Chat surface
node bin\freya.mjs browser undock
```

---

## 3. End-to-End Acceptance Recipe: Finding & Clicking Contact Links

Here is the pattern used for live multi-tab user automation:

```javascript
import { execFileSync } from 'node:child_process'

function freya(args) {
  return execFileSync(process.execPath, ['bin/freya.mjs', ...args], { encoding: 'utf8' }).trim()
}

function freyaJson(args) {
  return JSON.parse(freya(['--json', ...args]))
}

// 1. Get all open tabs
const { tabs } = freyaJson(['browser', 'tabs'])

for (const tab of tabs) {
  const tabId = tab.tabId

  // 2. Activate and dock visibly on user screen
  freya(['browser', 'activate', tabId])
  freya(['browser', 'dock', tabId])

  // 3. Scroll to the bottom of the page
  freya(['browser', 'scroll', 'bottom', tabId])

  // 4. Take snapshot to locate Contact link
  const snap = freyaJson(['browser', 'snapshot', tabId])
  const elements = snap.data?.snapshot?.elements || []
  const revision = snap.data?.snapshot?.revision || 1

  // 5. Find Contact element
  const contact = elements.find(el => {
    const name = (el.name || '').toLowerCase()
    return name.includes('contact') && (el.kind === 'link' || el.kind === 'button')
  })

  // 6. Click Contact link
  if (contact) {
    freya(['browser', 'click', contact.ref, String(revision), tabId])
    console.log(`Clicked ${contact.name} (${contact.ref}) on tab ${tabId}`)
  }
}

// 7. Undock view when finished
freya(['browser', 'undock'])
```

---

## 4. MCP Server Integration

Freya provides a built-in Model Context Protocol (MCP) server:
```powershell
node bin\freya-mcp.mjs
```
Exposes the same authenticated methods (`freya_status`, `browser_open`, `browser_dock`, `browser_snapshot`, `browser_click`, etc.) to MCP-compatible AI agents.
