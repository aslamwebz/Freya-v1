import { chromium } from 'playwright-core'

async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9234')
  const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('/dist/index.html'))
  if (!page) throw new Error('Freya page not found')

  const bodyText = await page.innerText('body')
  console.log('=== FULL BODY TEXT ===')
  console.log(bodyText)

  await browser.close()
}

main().catch(console.error)
