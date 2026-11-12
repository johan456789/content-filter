// Render a saved page HTML from its real origin so relative URLs/CSS/images resolve.
// Usage: bun scripts/render-user-html.mjs <html-file> <page-url> --viewport=desktop|mobile --out=dir [--selector=#id]
import { chromium } from 'playwright'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'

const args = process.argv.slice(2)
const htmlFile = args[0]
const pageUrl = args[1]
const parsed = new URL(pageUrl)
const origin = parsed.origin
const viewport = args.find(a => a.startsWith('--viewport='))?.split('=')[1] || 'desktop'
const out = args.find(a => a.startsWith('--out='))?.split('=')[1] || 'tmp'
const checkSel = args.find(a => a.startsWith('--selector='))?.split('=')[1] || null

const VPS = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } }
const vp = VPS[viewport]
const slug = basename(htmlFile).replace(/\.html$/, '')
const pngPath = `${out}/${slug}-${viewport}.png`

const html = readFileSync(htmlFile, 'utf8')
mkdirSync(out, { recursive: true })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: vp, deviceScaleFactor: 1 })
await page.route(`${origin}${parsed.pathname}`, route => route.fulfill({ contentType: 'text/html', body: html }))
await page.goto(pageUrl, { waitUntil: 'load' })
await page.waitForTimeout(3000)

let check = null
if (checkSel) {
  check = await page.evaluate(sel => {
    const els = [...document.querySelectorAll(sel)]
    return els.map(el => {
      const r = el.getBoundingClientRect()
      return { sel, count: els.length, rect: { x: r.x, y: r.y, w: r.width, h: r.height }, display: getComputedStyle(el).display }
    })
  }, checkSel)
}

await page.screenshot({ path: pngPath })
writeFileSync(`${out}/${slug}-${viewport}-rendercheck.json`, JSON.stringify(check, null, 2))
console.log(JSON.stringify({ pngPath, check }, null, 2))
await browser.close()
