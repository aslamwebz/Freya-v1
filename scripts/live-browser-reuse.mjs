import { chromium } from 'playwright-core'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve, join } from 'node:path'
import { lookup } from 'node:dns/promises'
import { existsSync } from 'node:fs'

const ROOT = resolve(import.meta.dirname, '..')
const profile = resolve(ROOT, '.kilo/live-test')
const CDP = process.env.FREYA_TEST_CDP ?? 'http://127.0.0.1:9234'
const mode = process.argv.includes('--local') ? 'local' : 'status'
const results = []
const record = (name, ok, details = '') => { results.push({ name, ok, details }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (details ? ': ' + details : '')) }
const execFileAsync = promisify(execFile)
async function command(args) {
  let stdout
  try {
    ({ stdout } = await execFileAsync(process.execPath, [join(ROOT, 'bin/freya.mjs'), '--json', ...args], {
      cwd: ROOT, env: { ...process.env, FREYA_USER_DATA: profile }, encoding: 'utf8', timeout: 12000
    }))
  } catch (e) {
    throw new Error(String(e.stderr || e.stdout || e.message).trim().slice(0, 650), { cause: e })
  }
  if (!stdout.trim()) throw new Error('CLI returned no response; inspect browser tabs')
  try { return JSON.parse(stdout) } catch { throw new Error('Non-JSON response: ' + stdout.slice(0, 300)) }
}
function obj(response) { return response?.result ?? response?.data ?? response }
function output(response) { return JSON.stringify(response).slice(0, 1100) }
let browser, server
try {
  if (!existsSync(join(profile, 'control.token'))) throw new Error('Isolated profile control token is missing')
  browser = await chromium.connectOverCDP(CDP, { timeout: 9000 })
  const pages = browser.contexts().flatMap(context => context.pages())
  const page = pages.find(p => p.url().includes('/dist/index.html'))
  record('Attach to existing visible Freya renderer', Boolean(page), page?.url() ?? 'no Freya renderer')
  if (!page) throw new Error('No Freya renderer: do not open another Electron instance')
  const status = await command(['browser', 'status'])
  record('Real Browser Service available', obj(status).available === true, output(status))
  const before = await command(['browser', 'tabs'])
  const initialTabs = obj(before).tabs ?? []
  record('Read actual Browser Service tabs', Array.isArray(initialTabs), String(initialTabs.length) + ' existing tabs')
  if (mode === 'local') {
    server = createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      if (req.url?.startsWith('/contact')) {
        res.end('<!doctype html><title>Local Contact Verified</title><h1>Contact Us</h1><p id="verification">Freya browser navigation accepted</p>')
      } else {
        res.end('<!doctype html><title>Local Freya Browser Fixture</title><h1>Local acceptance fixture</h1><div style="height:1800px">Scroll this page</div><footer><a href="/contact" id="contact">Contact Us</a></footer>')
      }
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const url = 'http://127.0.0.1:' + server.address().port + '/'
    let opened
    try { opened = await command(['browser','open',url]); record('Open local fixture through Freya control plane', true, output(opened)) }
    catch(e) { record('Open local fixture through Freya control plane', false, e.message) }
    if (opened) {
      const newTabs = obj(await command(['browser','tabs'])).tabs ?? []
      const tab = newTabs.find(t => (t.liveUrl ?? t.url ?? '').startsWith(url))
      record('Fixture is a real Browser Service tab', Boolean(tab), tab?.tabId ?? 'not in tab list')
      if (tab) {
        const id = tab.tabId
        try { const dock = await command(['browser','dock',id]); record('Dock tab to give viewport size', true, output(dock)) } catch(e) { record('Dock tab to give viewport size', false, e.message) }
        await new Promise(r => setTimeout(r, 600))
        try { const sc = await command(['browser','scroll','bottom',id]); const s = output(sc); record('Real Browser Service scroll to bottom', !/surface-unavailable|viewport-unavailable|"ok":false/.test(s), s) } catch(e) { record('Real Browser Service scroll to bottom', false, e.message) }
        try {
          const snap = await command(['browser','snapshot',id]); const s = output(snap)
          const snapshot = obj(snap).snapshot ?? obj(snap).data?.snapshot
          const contact = snapshot?.elements?.find(e => e.kind === 'link' && /contact/i.test(e.name ?? ''))
          const revision = snapshot?.revision
          record('Snapshot provides Contact link ref + revision', Boolean(contact?.ref && Number.isInteger(revision)), s.slice(0,700))
          if (contact?.ref && Number.isInteger(revision)) {
            try { const click = await command(['browser','click',contact.ref,String(revision),id]); record('Click real browser element', !/"ok":false/.test(output(click)), output(click)) }
            catch(e) { record('Click real browser element',false,e.message) }
            let current
            for (let attempt = 0; attempt < 8; attempt++) {
              const after = obj(await command(['browser','tabs'])).tabs ?? []
              current = after.find(t=>t.tabId===id)
              if (/\/contact(?:[?#]|$)/.test(current?.liveUrl ?? current?.url ?? '')) break
              await new Promise(r => setTimeout(r, 200))
            }
            record('Contact navigation verified in Browser Service', /\/contact(?:[?#]|$)/.test(current?.liveUrl ?? current?.url ?? ''), current?.liveUrl ?? current?.url ?? 'no URL')
          }
        } catch(e) { record('Snapshot provides element refs + revision',false,e.message) }
      }
    }
  }
  try { const dns = await lookup('example.com'); record('External DNS ready for ten-site test', true, dns.address) }
  catch (e) { record('External DNS ready for ten-site test', false, e.code ?? e.message) }
} catch(e) { record('Harness setup', false, e.message) }
finally {
  // Never leave a short-lived localhost fixture covering the Freya dashboard.
  // The browser-control API owns docking; CDP must not manipulate the embedded view.
  if (mode === 'local' && server) {
    try { await command(['browser', 'undock']); console.log('CLEANUP browser dock released') }
    catch (error) { console.error('CLEANUP FAILED to undock: ' + error.message); process.exitCode = 1 }
  }
  if (server) await new Promise(r => server.close(r))
  if (browser) await browser.close().catch(()=>{})
}
console.log('SUMMARY ' + JSON.stringify({ mode, pass: results.filter(x=>x.ok).length, fail:results.filter(x=>!x.ok).length }))
process.exitCode = process.exitCode || (results.some(x=>!x.ok) ? 1 : 0)
