#!/usr/bin/env bun
/**
 * Lint review-dataset folders against the conventions in AGENTS.md
 * ("Review dataset" section).
 *
 *   bun scripts/dataset-lint.mjs                 # lint every folder in dataset/
 *   bun scripts/dataset-lint.mjs dataset/x/      # lint specific folders
 *   bun scripts/dataset-lint.mjs --fix           # rename pair files into place
 *   bun scripts/dataset-lint.mjs --strict        # warnings fail too
 *   bun scripts/dataset-lint.mjs --json          # machine-readable report
 *   bun scripts/dataset-lint.mjs --session ses_… # surface user turns worth judging
 *
 * Exit 0 = clean (or warnings only), 1 = violations, 2 = bad usage.
 *
 * The mechanical checks are complete here. Detecting a *missed reject* is not:
 * --session only lists user turns that read like pushback, plus every distinct
 * rule line the session posted, so an agent can judge whether an iteration was
 * turned down and needs a rejected-N/ folder.
 */
import { readdir, readFile, rename } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

const REPO_ROOT = path.resolve(import.meta.dir, '..')
const DATASET_DIR = path.join(REPO_ROOT, 'dataset')

const flags = {}
const positionals = []
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--session') {
    flags.session = argv[++i]
    continue
  }
  if (a.startsWith('--')) {
    const eq = a.indexOf('=')
    if (eq === -1) flags[a.slice(2)] = true
    else flags[a.slice(2, eq)] = a.slice(eq + 1)
  } else positionals.push(a)
}

const IMAGE = /\.(png|jpe?g|webp)$/i
const OUTPUT = /^output-(\d+)-(.+)\.(png|jpe?g|webp)$/i
const RULE_LINE = /^[a-z0-9*._-]+(\.[a-z0-9-]+)+##\S/i
const REJECT_DIR = /^rejected-(\d+)$/

const REJECT_TALK =
  /(missed|forgot|still (there|shows|visible|present|see)|not hidden|didn'?t work|doesn'?t work|wrong (element|selector)|too broad|too narrow|not the right|you (forgot|skipped)|why is it still|left over|remaining|what about the|are you sure|nope|nah|revert|undo)/i

function parseOutputFile(file) {
  const m = file.match(OUTPUT)
  if (!m) return null
  const idx = Number(m[1])
  const bare = m[2]
  if (bare.startsWith('before-')) return { kind: 'before', idx, name: bare.slice(7) }
  if (bare.startsWith('after-')) return { kind: 'after', idx, name: bare.slice(6) }
  if (bare.endsWith('-before')) return { kind: 'before', idx, name: bare.slice(0, -7) }
  if (bare.endsWith('-after')) return { kind: 'after', idx, name: bare.slice(0, -6) }
  return null
}

/** Canonical pair plan: before odd, after even, ordered by original index then element name. */
function pairPlan(files) {
  const groups = new Map()
  const unrecognised = []
  for (const file of files) {
    if (!OUTPUT.test(file)) {
      if (IMAGE.test(file) && !file.startsWith('input-annotation')) unrecognised.push(file)
      continue
    }
    const parsed = parseOutputFile(file)
    if (!parsed) {
      unrecognised.push(file)
      continue
    }
    const key = parsed.name
    if (!groups.has(key)) groups.set(key, { idx: parsed.idx, name: parsed.name })
    else groups.get(key).idx = Math.min(groups.get(key).idx, parsed.idx)
    groups.get(key)[parsed.kind] = file
  }
  const order = [...groups.values()].sort((a, b) => a.idx - b.idx || a.name.localeCompare(b.name))
  const plan = []
  let next = 1
  for (const g of order) {
    if (g.before) {
      plan.push({ from: g.before, to: `output-${next}-before-${g.name}${path.extname(g.before)}` })
      next += 1
    }
    if (g.after) {
      plan.push({ from: g.after, to: `output-${next}-after-${g.name}${path.extname(g.after)}` })
      next += 1
    }
  }
  return { plan, order, unrecognised }
}

async function lintPairScope(dir, label, errors, warnings, fixes) {
  const files = await readdir(dir)
  const { plan, order, unrecognised } = pairPlan(files)
  for (const f of unrecognised) {
    errors.push(`${label}: unrecognised file "${f}" (expected output-N-before|after-<name>.png)`)
  }
  if (!plan.length) warnings.push(`${label}: no before/after pair`)
  for (const g of order) {
    if (!g.before) errors.push(`${label}: "${g.after}" has no before`)
    if (!g.after) errors.push(`${label}: "${g.before}" has no after`)
  }
  for (const p of plan) {
    if (p.from !== p.to) {
      errors.push(`${label}: "${p.from}" should be "${p.to}"`)
      fixes.push({ dir, from: p.from, to: p.to })
    }
  }
  return files
}

async function lintFolder(dir) {
  const folder = path.basename(dir)
  const errors = []
  const warnings = []
  const fixes = []

  const rulesPath = path.join(dir, 'rule.txt')
  if (!existsSync(rulesPath)) {
    errors.push('root: missing rule.txt')
  } else {
    const lines = (await readFile(rulesPath, 'utf8'))
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('!'))
    if (!lines.length) errors.push('root: rule.txt is empty')
    for (const l of lines) {
      if (!RULE_LINE.test(l)) errors.push(`root: rule.txt line is not a domain-scoped cosmetic rule: "${l}"`)
    }
  }

  const labelPath = path.join(dir, 'label.txt')
  if (!existsSync(labelPath)) {
    errors.push('root: missing label.txt')
  } else {
    const v = (await readFile(labelPath, 'utf8')).trim()
    if (v !== 'approve' && v !== 'deny') errors.push(`root: label.txt must be "approve" or "deny", got "${v}"`)
  }

  const files = await lintPairScope(dir, 'root', errors, warnings, fixes)
  if (!files.some((f) => f.startsWith('input-annotation'))) {
    warnings.push('root: no input-annotation file (note it in note.txt if intentional)')
  }

  const rejects = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const m = entry.name.match(REJECT_DIR)
    if (!m) {
      warnings.push(`unexpected directory "${entry.name}" (expected rejected-N/)`)
      continue
    }
    rejects.push({ name: entry.name, n: Number(m[1]) })
  }
  rejects.sort((a, b) => a.n - b.n)

  for (const [i, r] of rejects.entries()) {
    if (r.n !== i + 1) errors.push(`${r.name}: rejected folders must be numbered 1..N in order (got ${r.n} at position ${i + 1})`)
    const rdir = path.join(dir, r.name)
    if (!existsSync(path.join(rdir, 'rule.txt'))) errors.push(`${r.name}: missing rule.txt`)
    if (!existsSync(path.join(rdir, 'note.txt'))) errors.push(`${r.name}: missing note.txt`)
    const lp = path.join(rdir, 'label.txt')
    if (!existsSync(lp)) {
      errors.push(`${r.name}: missing label.txt`)
    } else {
      const v = (await readFile(lp, 'utf8')).trim()
      if (v !== 'deny') errors.push(`${r.name}: label.txt must be "deny", got "${v}"`)
    }
    await lintPairScope(rdir, r.name, errors, warnings, fixes)
  }

  return { folder, dir, errors, warnings, fixes, rejects: rejects.length }
}

async function applyFixes(fixes) {
  const byDir = new Map()
  for (const f of fixes) {
    if (!byDir.has(f.dir)) byDir.set(f.dir, [])
    byDir.get(f.dir).push(f)
  }
  for (const [dir, list] of byDir) {
    // two-phase so renames cannot collide with each other
    const temps = list.map((f, i) => ({ ...f, tmp: path.join(dir, `__lint-tmp-${i}${path.extname(f.from)}`) }))
    for (const t of temps) await rename(path.join(dir, t.from), t.tmp)
    for (const t of temps) await rename(t.tmp, path.join(dir, t.to))
  }
}

/** Same annotation bytes in two folders = one session split across folders. */
async function findSplits(root) {
  const seen = new Map()
  const walk = async (dir) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) await walk(p)
      else if (e.name.startsWith('input-annotation')) {
        const h = createHash('sha1').update(await readFile(p)).digest('hex')
        if (!seen.has(h)) seen.set(h, [])
        seen.get(h).push(p)
      }
    }
  }
  if (existsSync(root)) await walk(root)
  return [...seen.values()].filter((ps) => new Set(ps.map((p) => path.dirname(p))).size > 1)
}

function sessionReport(id) {
  const file = path.join(os.homedir(), '.kimaki', 'transcripts', `${id}.md`)
  if (!existsSync(file)) return `transcript not found: ${file}`
  const text = readFileSync(file, 'utf8')
  const blocks = [...text.matchAll(/^## (user|assistant) (.*)$/gm)]
  const rules = new Set()
  const suspects = []
  blocks.forEach((m, i) => {
    const body = text.slice(m.index + m[0].length, i + 1 < blocks.length ? blocks[i + 1].index : text.length)
    for (const r of body.matchAll(/^[ \t]{0,6}([a-z0-9][a-z0-9*._-]*\.[a-z]{2,}##\S.*)$/gim)) rules.add(r[1].trim())
    if (m[1] !== 'user') return
    const flat = body.replace(/\s+/g, ' ').trim()
    if (flat && REJECT_TALK.test(flat)) suspects.push(`${m[2]}  ${flat.slice(0, 220)}`)
  })
  const out = [`session ${id}`, `transcript: ${file}`, '', 'user turns worth judging (a hint, not proof of a reject):']
  out.push(...(suspects.length ? suspects.map((s) => `  - ${s}`) : ['  (none matched)']))
  out.push('', 'distinct rule lines posted this session (compare with rule.txt):')
  out.push(...([...rules].length ? [...rules].map((r) => `  ${r}`) : ['  (none)']))
  return out.join('\n')
}

/** A container (dataset/ or any dir without rule.txt) expands to its session folders. */
async function expandTargets(paths) {
  const out = []
  for (const p of paths) {
    if (!existsSync(p)) {
      out.push(p)
      continue
    }
    if (existsSync(path.join(p, 'rule.txt'))) {
      out.push(p)
      continue
    }
    const kids = (await readdir(p, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && /^\d{9,}-/.test(e.name))
      .map((e) => path.join(p, e.name))
    if (kids.length) out.push(...kids)
    else out.push(p)
  }
  return out
}

if (flags.session) console.log(sessionReport(String(flags.session)) + '\n')

const requested = positionals.length
  ? positionals.map((p) => path.resolve(p))
  : existsSync(DATASET_DIR)
    ? [DATASET_DIR]
    : []

const targets = await expandTargets(requested)

if (!targets.length) {
  if (flags.session) process.exit(0)
  console.error('no dataset folders found (expected dataset/*/)')
  process.exit(2)
}

const missing = targets.filter((t) => !existsSync(t))
if (missing.length === targets.length) {
  for (const m of missing) console.error(`not found: ${m}`)
  process.exit(2)
}

let results = []
for (const t of targets) {
  if (!existsSync(t)) {
    console.error(`skip: ${t} does not exist`)
    continue
  }
  results.push(await lintFolder(t))
}

if (flags.fix) {
  const fixes = results.flatMap((r) => r.fixes)
  if (fixes.length) {
    await applyFixes(fixes)
    console.log(`renamed ${fixes.length} file(s) into canonical pair names\n`)
    results = []
    for (const t of targets) if (existsSync(t)) results.push(await lintFolder(t))
  }
}

const splits = await findSplits(DATASET_DIR)

if (flags.json) {
  console.log(JSON.stringify({ results: results.map(({ dir, ...r }) => r), splits }, null, 2))
} else {
  for (const r of results) {
    const status = r.errors.length ? 'FAIL' : r.warnings.length ? 'warn' : 'ok'
    console.log(`${status.padEnd(4)} ${r.folder}${r.rejects ? `  (rejected: ${r.rejects})` : ''}`)
    for (const e of r.errors) console.log(`       error: ${e}`)
    for (const w of r.warnings) console.log(`       warn:  ${w}`)
  }
  for (const group of splits) {
    console.log(`\nsplit session? same annotation bytes in ${group.length} files:`)
    for (const p of group) console.log(`  ${path.relative(REPO_ROOT, p)}`)
  }
}

const errors = results.reduce((n, r) => n + r.errors.length, 0)
const warnings = results.reduce((n, r) => n + r.warnings.length, 0)
if (!flags.json) {
  console.log(`\n${results.length} folder(s), ${errors} error(s), ${warnings} warning(s)`)
  if (errors || (flags.strict && warnings)) console.log('see AGENTS.md > Review dataset for the layout')
}
process.exit(errors || (flags.strict && warnings) ? 1 : 0)
