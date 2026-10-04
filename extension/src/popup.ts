/**
 * The popup: a minimal, functional control surface.
 *
 * It shows whether the extension is paired, what is shared, whether control is on, and
 * the last result — and it lets the owner share, allow, revoke or stop. It holds no
 * authority of its own: every button sends an intent to the host and renders what came
 * back.
 */

interface PopupState {
  readonly status?: string
  readonly sharedTabId?: number | null
  readonly sharedOrigin?: string | null
  readonly control?: boolean
  readonly lastAction?: string
  readonly lastCode?: string | null
  readonly lastReason?: string
  readonly pairOk?: boolean
  readonly pairCode?: string | null
  readonly error?: string
}

const statusEl = document.getElementById('status')
const sharedEl = document.getElementById('shared')
const controlEl = document.getElementById('control')
const lastEl = document.getElementById('last')
const originEl = document.getElementById('origin')
const pairCode = document.getElementById('pair-code') as HTMLInputElement | null

function render(state: PopupState): void {
  if (statusEl !== null) statusEl.textContent = state.status ?? 'disconnected'
  if (sharedEl !== null) sharedEl.textContent = state.sharedTabId == null ? 'no' : `tab ${String(state.sharedTabId)}`
  if (controlEl !== null) controlEl.textContent = state.control === true ? 'on' : 'off'
  if (originEl !== null) originEl.textContent = state.sharedOrigin ?? ''
  if (lastEl !== null) {
    const code = state.lastCode ?? ''
    const reason = state.lastReason ?? ''
    lastEl.textContent = `${state.lastAction ?? 'idle'} ${code} ${reason}`.trim()
  }
  if (state.pairOk === false && state.pairCode !== null && state.pairCode !== undefined) {
    if (lastEl !== null) lastEl.textContent = `pairing failed: ${state.pairCode}`
  }
  if (state.error === 'no-active-tab' && lastEl !== null) {
    lastEl.textContent = 'no active tab to share'
  }
}

async function send(message: Record<string, unknown>): Promise<void> {
  const state = (await chrome.runtime.sendMessage(message)) as PopupState
  render(state)
}

function bind(id: string, message: Record<string, unknown>): void {
  const element = document.getElementById(id)
  element?.addEventListener('click', () => {
    void send(message)
  })
}

bind('pair', { type: 'pair', code: pairCode?.value ?? '' })
bind('share', { type: 'share' })
bind('unshare', { type: 'unshare' })
bind('allow', { type: 'control-enable' })
bind('revoke', { type: 'control-revoke' })
bind('stop', { type: 'stop' })

chrome.runtime.onMessage.addListener((message) => {
  const record = typeof message === 'object' && message !== null ? (message as Record<string, unknown>) : {}
  if (record.type === 'bridge-state' && typeof record.state === 'object' && record.state !== null) {
    render(record.state as PopupState)
  }
})

void send({ type: 'status' })
