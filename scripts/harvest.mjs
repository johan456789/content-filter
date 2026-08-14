#!/usr/bin/env bun
import { chromium } from 'playwright'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
}

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const [, , cmd, ...rest] = process.argv
const flags = {}
const positionals = []
for (const a of rest) {
  if (a.startsWith('--')) {
    const eq = a.indexOf('=')
    if (eq === -1) flags[a.slice(2)] = true
    else flags[a.slice(2, eq)] = a.slice(eq + 1)
  } else positionals.push(a)
}

const json = (obj) => console.log(JSON.stringify(obj, null, 2))

async function launch() {
  return chromium.launch({ headless: true })
}

async function openPage(url, viewportName, opts = {}) {
  const vp = VIEWPORTS[viewportName]
  if (!vp) throw new Error(`Unknown viewport: ${viewportName}. Valid: ${Object.keys(VIEWPORTS).join(', ')}`)
  const browser = await launch()
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height, deviceScaleFactor: 1 },
    userAgent: UA,
  })
  const page = await ctx.newPage()
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {})
  await page.evaluate(async () => {
    const step = window.innerHeight
    for (let y = 0; y < document.body.scrollHeight; y += step) {
      window.scrollTo(0, y)
      await new Promise((r) => setTimeout(r, 60))
    }
    window.scrollTo(0, 0)
    await new Promise((r) => setTimeout(r, 400))
  }).catch(() => {})
  return { browser, ctx, page, vp }
}

function urlDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').replace(/\./g, '_') } catch { return 'site' }
}

async function cmdScreenshot() {
  const url = positionals[0]
  const viewportName = flags.viewport || 'desktop'
  const outDir = flags.out || 'tmp'
  const full = !!flags.full
  if (!url) throw new Error('Usage: screenshot <url> [--viewport=desktop|mobile] [--full] [--out=dir]')
  mkdirSync(outDir, { recursive: true })
  const { browser, page, vp } = await openPage(url, viewportName)
  const base = `${urlDomain(url)}-${viewportName}${full ? '-full' : ''}`
  const pngPath = path.join(outDir, `${base}.png`)
  await page.screenshot({ path: pngPath, fullPage: full })
  const htmlPath = path.join(outDir, `${base}.html`)
  writeFileSync(htmlPath, await page.content())
  const title = await page.title().catch(() => '')
  await browser.close()
  json({ screenshot: pngPath, html: htmlPath, viewport: vp, title, url })
}

async function cmdFind() {
  const url = positionals[0]
  const x = Number(positionals[1])
  const y = Number(positionals[2])
  const viewportName = flags.viewport || 'desktop'
  const scrollTo = flags.scroll ? Number(flags.scroll) : 0
  if (!url || Number.isNaN(x) || Number.isNaN(y)) throw new Error('Usage: find <url> <x> <y> [--viewport=desktop|mobile] [--scroll=pixels]')
  const { browser, page, vp } = await openPage(url, viewportName)
  if (scrollTo) await page.evaluate((s) => window.scrollTo(0, s), scrollTo)
  const res = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y)
    if (!el) return { found: false, reason: 'no element at point' }
    const chain = []
    let cur = el
    let depth = 0
    while (cur && cur.nodeType === 1 && cur.tagName.toLowerCase() !== 'html' && depth < 12) {
      const rect = cur.getBoundingClientRect()
      const attrs = {}
      for (const a of cur.attributes) {
        if (a.name.startsWith('on')) continue
        attrs[a.name] = a.value
      }
      const st = getComputedStyle(cur)
      chain.push({
        depth,
        tag: cur.tagName.toLowerCase(),
        id: cur.id || '',
        classes: Array.from(cur.classList),
        attrs,
        rectPage: {
          x: Math.round(rect.x + window.scrollX),
          y: Math.round(rect.y + window.scrollY),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        },
        visible: !!(cur.offsetWidth || cur.offsetHeight || cur.getClientRects().length),
        display: st.display,
        position: st.position,
        text: (cur.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
        childCount: cur.children.length,
      })
      cur = cur.parentElement
      depth++
    }
    return { found: true, point: { x, y }, chain }
  }, { x, y })
  await browser.close()
  json(res)
}

async function cmdDiff() {
  const orig = positionals[0]
  const annotated = positionals[1]
  const threshold = flags.threshold ? Number(flags.threshold) : 40
  if (!orig || !annotated) throw new Error('Usage: diff <original.png> <annotated.png> [--threshold=40]')
  const aData = 'data:image/png;base64,' + readFileSync(orig).toString('base64')
  const bData = 'data:image/png;base64,' + readFileSync(annotated).toString('base64')
  const browser = await launch()
  const page = await browser.newPage()
  const res = await page.evaluate(async ({ a, b, threshold }) => {
    const load = (src) => new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = reject
      img.src = src
    })
    const ia = await load(a)
    const ib = await load(b)
    if (ia.width !== ib.width || ia.height !== ib.height) {
      return { error: 'dimensions differ', a: { w: ia.width, h: ia.height }, b: { w: ib.width, h: ib.height } }
    }
    const cv = document.createElement('canvas')
    cv.width = ia.width; cv.height = ia.height
    const ctx = cv.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(ia, 0, 0)
    const da = ctx.getImageData(0, 0, cv.width, cv.height).data
    ctx.drawImage(ib, 0, 0)
    const db = ctx.getImageData(0, 0, cv.width, cv.height).data
    let minX = cv.width, minY = cv.height, maxX = -1, maxY = -1, changed = 0
    for (let i = 0; i < da.length; i += 4) {
      const d = Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2])
      if (d > threshold) {
        changed++
        const p = i / 4
        const px = p % cv.width
        const py = Math.floor(p / cv.width)
        if (px < minX) minX = px
        if (px > maxX) maxX = px
        if (py < minY) minY = py
        if (py > maxY) maxY = py
      }
    }
    const total = cv.width * cv.height
    if (maxX === -1) return { changed, total, bbox: null, center: null }
    return {
      changed,
      total,
      bbox: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
      center: { x: Math.round((minX + maxX) / 2), y: Math.round((minY + maxY) / 2) },
    }
  }, { a: aData, b: bData, threshold })
  await browser.close()
  if (res.error) {
    json({ error: res.error, detail: res })
  } else {
    const pct = res.changed / res.total
    json({
      ...res,
      changedPercent: Number((pct * 100).toFixed(3)),
      warning: pct > 0.1 ? 'large diff area — image may have been resized/cropped; coords may be unreliable' : null,
    })
  }
}

function parseRule(rule) {
  let r = rule.trim()
  let domain = ''
  const idx = r.indexOf('##')
  if (idx !== -1) {
    domain = r.slice(0, idx)
    r = r.slice(idx + 2)
  }
  const procedural = []
  r = r.replace(/:(?:style|has-text|text|matches-path|upward|watch-attr|remove)\([^)]*\)/gi, (m) => {
    procedural.push(m)
    return ''
  })
  return { domain, selector: r.trim(), procedural }
}

async function cmdValidate() {
  const url = positionals[0]
  const rule = positionals[1]
  const viewportName = flags.viewport || 'desktop'
  if (!url || !rule) throw new Error('Usage: validate <url> <rule-or-selector> [--viewport=desktop|mobile]')
  const parsed = rule.includes('##') ? parseRule(rule) : { domain: '', selector: rule, procedural: [] }
  const { browser, page } = await openPage(url, viewportName)
  const res = await page.evaluate((sel) => {
    if (!sel) return { error: 'empty selector after stripping procedural pseudos' }
    let nodes
    try { nodes = document.querySelectorAll(sel) } catch (e) { return { error: `invalid selector: ${e.message}` } }
    return {
      count: nodes.length,
      matches: Array.from(nodes).slice(0, 10).map((n) => {
        const r = n.getBoundingClientRect()
        return {
          tag: n.tagName.toLowerCase(),
          id: n.id || '',
          classes: Array.from(n.classList),
          visible: !!(n.offsetWidth || n.offsetHeight || n.getClientRects().length),
          rectPage: {
            x: Math.round(r.x + window.scrollX),
            y: Math.round(r.y + window.scrollY),
            w: Math.round(r.width),
            h: Math.round(r.height),
          },
        }
      }),
    }
  }, parsed.selector)
  await browser.close()
  json({
    rule,
    domain: parsed.domain,
    selector: parsed.selector,
    strippedProcedural: parsed.procedural,
    ...res,
  })
}

async function main() {
  try {
    if (!cmd || cmd === 'help' || cmd === '--help') {
      console.log(`harvest.mjs — DOM harvesting for uBlock rule generation

Usage:
  screenshot <url> [--viewport=desktop|mobile] [--full] [--out=dir]
      Screenshot the page at a fixed viewport (default desktop 1440x900, mobile 390x844).
      Also saves full page HTML next to the PNG. --full captures full-page screenshot.

  find <url> <x> <y> [--viewport=desktop|mobile] [--scroll=pixels]
      Dump the ancestor chain of the element at pixel (x,y), deepest first.
      Coordinates are CSS pixels in the screenshot's viewport. Use --scroll to match
      full-page screenshot coordinates (scroll = floor(y / viewportH) * viewportH).

  diff <original.png> <annotated.png> [--threshold=40]
      Find the bounding box of pixels changed between two screenshots (user annotation).
      Returns bbox + center in image pixel coordinates.

  validate <url> <rule-or-selector> [--viewport=desktop|mobile]
      Count matches of a CSS selector (or full uBlock rule like domain##sel:style(...))
      on the live page; strips uBlock procedural pseudos before querying.`)
      return
    }
    switch (cmd) {
      case 'screenshot': await cmdScreenshot(); break
      case 'find': await cmdFind(); break
      case 'diff': await cmdDiff(); break
      case 'validate': await cmdValidate(); break
      default: throw new Error(`Unknown command: ${cmd}`)
    }
  } catch (e) {
    json({ error: e.message })
    process.exit(1)
  }
}

main()
