import { app, BrowserWindow, type WebContentsView } from 'electron'
import { createServer } from 'node:http'
import { strict as assert } from 'node:assert'
import { ElectronFreyaWindowFactory } from './browser/freyaWindow'

let videoFixture = Buffer.alloc(0)
const imageFixture = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV5kAAAAASUVORK5CYII=', 'base64')
const pdfFixture = Buffer.from('%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj\n4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n5 0 obj<</Length 39>>stream\nBT /F1 16 Tf 20 100 Td (Dock PDF) Tj ET\nendstream endobj\ntrailer<</Root 1 0 R>>\n%%EOF')
const server = createServer((request, response) => {
  if (request.url === '/asset.png') { response.setHeader('Content-Type', 'image/png'); response.end(imageFixture); return }
  if (request.url === '/asset.webm') { response.setHeader('Content-Type', 'video/webm'); response.end(videoFixture); return }
  if (request.url === '/file.pdf') { response.setHeader('Content-Type', 'application/pdf'); response.end(pdfFixture); return }
  response.setHeader('Content-Type', 'text/html')
  response.end(`<title>${request.url}</title><h1>Dock fixture ${request.url}</h1><input id="draft" value="initial"><a id="next" href="/clicked">Next</a><a id="blank" href="/new-tab" target="_blank">New tab</a><img src="/asset.png"><video controls muted src="/asset.webm"></video>`)
})
async function main() {
  await app.whenReady()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const host = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  await host.loadURL('data:text/html,<h1>Freya chat remains here</h1>')
  const videoBytes = await host.webContents.executeJavaScript(`(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 80; canvas.height = 60;
    const ctx = canvas.getContext('2d'); const stream = canvas.captureStream(10);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
    const chunks = []; recorder.ondataavailable = event => chunks.push(event.data);
    const ended = new Promise(resolve => recorder.onstop = resolve); recorder.start();
    for (let i=0;i<8;i++) { ctx.fillStyle = i % 2 ? 'orange' : 'navy'; ctx.fillRect(0,0,80,60); await new Promise(resolve => setTimeout(resolve,100)); }
    recorder.stop(); await ended; stream.getTracks().forEach(track => track.stop());
    return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()));
  })()`)
  videoFixture = Buffer.from(videoBytes as number[])
  const opened: string[] = []
  const factory = new ElectronFreyaWindowFactory({ onOpenUrl: (url) => opened.push(url), hostWindow: () => host, allowPrivateHosts: true, allowedHosts: ['127.0.0.1'], settleMs: 100 })
  const first = await factory.create('dock-one', 'freya-public-dock-one')
  const second = await factory.create('dock-two', 'freya-public-dock-two')
  assert.equal((await first.navigate(`http://127.0.0.1:${port}/first`)).ok, true)
  assert.equal((await second.navigate(`http://127.0.0.1:${port}/second`)).ok, true)
  assert.equal(BrowserWindow.getAllWindows().length, 1, 'no separate browser windows')
  assert.equal(factory.dock('dock-one', { x: 600, y: 100, width: 580, height: 600 }), true)
  assert.equal(host.contentView.children.length, 1)
  const firstView = host.contentView.children[0] as WebContentsView
  await firstView.webContents.executeJavaScript("document.getElementById('draft').value = 'retained draft'")
  assert.equal(factory.dock('dock-two', { x: 500, y: 100, width: 680, height: 600 }), true)
  const secondView = host.contentView.children[0] as WebContentsView
  assert.notEqual(firstView.webContents.id, secondView.webContents.id)
  factory.dock('dock-one', { x: 600, y: 100, width: 580, height: 600 })
  assert.equal(await firstView.webContents.executeJavaScript("document.getElementById('draft').value"), 'retained draft')
  factory.dock(null, null)
  assert.equal(host.contentView.children.length, 0)
  factory.dock('dock-one', { x: 600, y: 100, width: 580, height: 600 })
  assert.equal(await firstView.webContents.executeJavaScript("document.getElementById('draft').value"), 'retained draft')
  assert.equal((await first.navigate(`http://127.0.0.1:${port}/next`)).ok, true)
  const read = await first.read()
  assert.equal(read.ok, true)
  assert.equal(first.currentUrl(), `http://127.0.0.1:${port}/next`)
  await firstView.webContents.executeJavaScript("document.getElementById('next').click()")
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(first.currentUrl(), `http://127.0.0.1:${port}/clicked`)
  await firstView.webContents.executeJavaScript("document.getElementById('blank').click()")
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.deepEqual(opened, [`http://127.0.0.1:${port}/new-tab`], 'native new-tab links reach dock handoff')
  assert.equal(await firstView.webContents.executeJavaScript("document.querySelector('img').naturalWidth"), 1, 'HTTP image renders')
  const videoState = await firstView.webContents.executeJavaScript(`new Promise(resolve => { const video = document.querySelector('video'); const report = () => resolve({ width: video.videoWidth, error: video.error?.code ?? null, ready: video.readyState }); video.onloadedmetadata = report; video.onerror = report; setTimeout(report, 3000); video.load() })`)
  assert.equal(videoState.width, 80, `HTTP video metadata loads: ${JSON.stringify(videoState)}`)

  const firstContents = firstView.webContents
  await first.close()
  assert.equal(host.contentView.children.length, 0)
  assert.equal(firstContents.isDestroyed(), true)
  await second.close()
  host.destroy()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  console.log('PASS docked native browser: two isolated tabs, retained page state, resize, hide/reopen, native links/new tabs, HTTP image/video, read, close, no pop-outs')
  app.exit(0)
}
void main().catch((error: unknown) => { console.error(error instanceof Error ? error.stack : 'Smoke failed'); server.close(); app.exit(1) })
