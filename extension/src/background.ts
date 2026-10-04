import { BridgeClient, type BridgeState } from './bridgeClient'

/**
 * The service worker: the extension's only long-lived process.
 *
 * It owns the bridge client and nothing else. Every action a page could observe is
 * performed by the host through `chrome.scripting`, and every authority question is
 * answered by the host. This file only routes.
 */

const client = new BridgeClient()

void client.load().then(() => client.connect())

chrome.tabs.onRemoved.addListener((tabId) => {
  client.sendEvent('tab.removed', { tabId })
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (typeof changeInfo.url === 'string') {
    client.sendEvent('page.navigated', { tabId, url: changeInfo.url })
  } else if (changeInfo.status === 'complete') {
    client.sendEvent('tab.updated', { tabId })
  }
})

async function currentTab(): Promise<{ tabId: number | null; url: string | null }> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  const tab = tabs[0]
  if (tab === undefined || tab.id === undefined) return { tabId: null, url: null }
  return { tabId: tab.id, url: tab.url ?? null }
}

async function handle(message: Record<string, unknown>): Promise<unknown> {
  switch (message.type) {
    case 'status':
      return client.state()
    case 'connect':
      await client.connect()
      return client.state()
    case 'pair': {
      const code = typeof message.code === 'string' ? message.code : ''
      const result = await client.pair(code)
      return { ...client.state(), pairOk: result.ok, pairCode: result.code }
    }
    case 'share': {
      const { tabId, url } = await currentTab()
      if (tabId === null || url === null) {
        return { ...client.state(), error: 'no-active-tab' }
      }
      const result = await client.command('page.share', { tabId, url })
      if (result.ok) {
        const value = result.result as { tabId?: number; origin?: string } | null
        client.applyControl(client.state().control, value?.tabId ?? tabId, value?.origin ?? null)
      }
      return { ...client.state(), lastCode: result.ok ? null : result.code, lastReason: result.reason }
    }
    case 'unshare': {
      await client.command('page.unshare', {})
      client.applyControl(client.state().control, null, null)
      return client.state()
    }
    case 'control-enable': {
      const result = await client.command('control.request', {})
      if (result.ok) client.applyControl(true, client.state().sharedTabId, client.state().sharedOrigin)
      return { ...client.state(), lastCode: result.ok ? null : result.code, lastReason: result.reason }
    }
    case 'control-revoke': {
      await client.command('control.revoke', {})
      client.applyControl(false, client.state().sharedTabId, client.state().sharedOrigin)
      return client.state()
    }
    case 'stop': {
      await client.stop()
      return client.state()
    }
    default:
      return client.state()
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const record = typeof message === 'object' && message !== null ? (message as Record<string, unknown>) : {}
  void handle(record).then((response) => sendResponse(response))
  return true
})

client.subscribe((state: BridgeState) => {
  // Broadcast status so an open popup updates without polling.
  void chrome.runtime.sendMessage({ type: 'bridge-state', state }).catch(() => undefined)
})
