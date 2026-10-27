# ublock-rule-gen

Turn "this element on this page annoys me" into a uBlock Origin rule stored in this repo's filter list.
**Input:** a URL, plus usually **screenshots sent by the user** (often with an annotation circle drawn on them) and/or a text description of the annoying element.
**Output:** a `domain##selector` uBlock cosmetic filter appended to the matching local filter file. Emit one rule by default — add a `:style(...)` variant or fallback only when you can name a concrete reason (inline `display` style, JS re-injection, etc.). See `prompts/robust-rule.md` §7.

**The user rarely pastes element selectors.** If they do, that's the legacy flow — just make their selector robust and return a rule. If they send an HTML file of the page, follow step 1b and render from that HTML.

## Setup (first time only)

```bash
bun install          # in repo root
bunx playwright install chromium   # if browsers are not cached
```

## The workflow

### 1. Take canonical screenshots (fixed viewports)

```bash
bun scripts/harvest.mjs screenshot <url> --viewport=desktop --out=tmp/
bun scripts/harvest.mjs screenshot <url> --viewport=mobile --out=tmp/
```

- Desktop = 1440×900, Mobile = 390×844, deviceScaleFactor 1 — **coordinates only map to these**.
- Always take **both** — the annoying element is often mobile-only (sticky bars, mobile menus).
- The script lazy-scrolls the page first so lazy-loaded content is present.
- It also saves the **full page HTML** (`tmp/<domain>-<viewport>.html`) — read this to understand the page before designing selectors.
- If the element might be below the fold, also take `--full` (full-page screenshot) for desktop.

**Why this step even when the user already sent a screenshot:** the user's screenshot is likely at a different size/scale (a phone capture, an arbitrary browser window). It tells you *which element* to block; this canonical screenshot gives you *exact coordinates* that `find` can consume. Do **not** upload these for the user to annotate — the user annotates their own copy. These are only used internally for coordinate mapping and for the before/after in step 7.

### 1b. User-provided HTML: render from that HTML, not the live page

When the user sends a saved page (`.html` attachment, or HTML pasted as a message), the HTML is
the page **they** saw. Use it as the render source for screenshots:

1. Save it as-is to `tmp/<domain>-user.html` (do not edit it).
2. Render it with Playwright, served from the page's real origin so relative URLs, CSS and
   images resolve. Use `page.route(<origin>/__render__, ...)` to fulfil the document with the
   file's contents, then `page.goto` that URL. Do the same at the viewport the user's page was
   captured at (desktop 1440×900 unless the HTML shows otherwise), and take the mobile
   canonical as well when the element may be mobile-only.
3. Confirm the target is present in the render (`querySelectorAll(<selector>).length`) before
   relying on it. If it is absent, say so; do not guess.
4. Use these renders as the **before** and **after** pairs (step 7). Keep the user's HTML
   and the renders in the dataset item as provenance (note it in `note.txt`).
5. Still run `validate` (step 5) on the live URL. The rule must match the live page, not just
   the snapshot. If the live page does not show the element, say so in the reply.

Caveats to note in `note.txt`:
- A saved page is a DOM snapshot taken after the site's scripts ran. Re-running those scripts
  in the render can duplicate `document.write` ad markup, so repeated elements in the render may
  be artifacts. Compare against the user's view before blaming the rule.
- Headless renders can differ from the user's browser: consent or push prompts may appear or
  not, and ad slots may load differently. Record what you saw.

### 2. Locate the annoying element

Three paths, in order of preference:

**A. User sent an annotated screenshot directly** (they circled/described the element themselves — no agent screenshot precedes it):
1. **Read the annotated screenshot with vision** — use the `eyes` subagent (or your own vision) to understand *which element* is targeted: its role, where it sits on the page (e.g. "sticky top nav", "share widget bottom-right"), and any text/visual cues.
2. Take the canonical desktop/mobile screenshots from step 1, then **locate the same element on the agent's screenshot** (vision again, or match by the description you extracted). Estimate its center pixel **in the canonical viewport**.
3. Run `find` at that point (step 3) to confirm. **Warn the user:** coordinate mapping only works at the documented viewports, so don't resize/crop their screenshot. If their annotated image happens to be at an exact harvest viewport size, you may instead skip step 2.2 and run `bun scripts/harvest.mjs diff tmp/<original>.png /path/to/annotated.png` to get the pixel point directly.

**B. User gave a text description** ("the sticky nav at the top", "the share widget on the right"):
- Look at the canonical screenshots, locate the region, estimate the center pixel of the element.
- Run `find` at that point, inspect the chain, and confirm the described element is there. If ambiguous, pick 2–3 candidates and ask the user (one round trip).

**C. Nothing provided**: ask the user to send a screenshot with the element circled (tell them not to resize/crop) — or describe it. Do not guess.

### 3. Dump the ancestor chain

```bash
bun scripts/harvest.mjs find <url> <x> <y> --viewport=desktop|mobile
```

- Coordinates are CSS pixels **in the screenshot's viewport** (top-left origin, scroll at top).
- For full-page screenshot coordinates: `--scroll=$(( (y / viewportH) * viewportH ))` and pass the y relative to that viewport.
- The output is a JSON ancestor chain, deepest (the element under the point) first — each entry has tag/id/classes/attrs/rect/visibility/text.
- Read the chain together with the saved HTML to decide which ancestor to hide.

### 4. Design the selector

Read **`prompts/robust-rule.md`** and follow it exactly — anchoring priority, what to avoid (JS-toggled classes, layout chains, nth-child), CSS escaping, uBlock pseudos (`:style`, `:has`).

Key reminders:
- Cross-check the ancestor's classes against the **raw HTML** — Alpine/JS-injected classes (like `opacity-100`, `block`, `top-16`) are NOT safe anchors even though they appear in the live DOM.
- Check the HTML for **similar elements elsewhere** on the page (menus in every section, repeated cards) — scope the selector if so.
- Pick the smallest ancestor that kills the annoyance without collateral.

### 5. Validate (MANDATORY — never skip)

```bash
bun scripts/harvest.mjs validate <url> 'domain##selector'
```

- Expect ≥1 match, ideally 1–3; too many = too broad, too few/none = wrong.
- Check the `matches` array — the matched elements must be the intended target.
- For `:has-text()`/`:style()` rules (can't validate in browser), validate the CSS selector part and reason about the pseudo manually.
- Iterate until correct.

### 6. Deliver — append to the local filter list

The rule goes into one of the category files in `filters/` (grouped by annoyance type):

- `filters/floating-annoyances.txt` — sticky/floating widgets, share/social bars
- `filters/inline-promo.txt` — in-article promos, newsletter nudges
- `filters/inline-related-articles.txt` — related-article cards
- `filters/slippped-thru-ads.txt` — ads that slipped through

Append the rule (the robust selector + `:style()` variant, see `prompts/robust-rule.md` §7) to the matching file. If no category fits, **ask the user for approval** before creating a new file (and adding its `!#include` to `filters/main.txt`).

Then commit with conventional commits using `type(domain)` scope:

```
feat(example.com): add floating share bar filter
fix(example.com): update share bar selector
```

- Add = `feat`, updating an existing selector = `fix`.
- If a commit touches multiple domains, use the primary domain; omit the scope only for list-level changes (e.g. `main` metadata).

Rationale (1–2 sentences on what you anchored on / avoided) goes in the commit body or the reply to the user.

### 7. Show before/after screenshots (MANDATORY)

After committing, take **cropped** before/after screenshots showing the element:

0. If the user provided HTML, render the before/after from that HTML (step 1b), not the live page.
   Otherwise use the live page.
1. Navigate to the page and scroll so the target element is visible in the viewport
2. Take a **before** screenshot cropped to the relevant area (viewport only, not full-page)
3. Hide the element with JavaScript: `document.querySelector('<selector>').style.display = 'none'`
4. Take an **after** screenshot from the same scroll position, same crop
5. **Actually upload both to the thread** — saving the files locally is not sending them.
   In kimaki: `kimaki upload-to-discord <before.png> <after.png>` (absolute paths, before first).
   Confirm the command printed `{"uploaded":[...]}` before telling the user the screenshots
   are attached, and send them in the same turn as the candidate rule — never wait to be asked.

This gives the user a clear visual confirmation the filter works.

### 8. Wait for user approval before merge and push (MANDATORY)

After step 7, **stop and wait**. Do **not** move `main` (merge) or push to the
remote until the user explicitly approves the rule in the thread (e.g. "looks good",
"ship it", "approve"). Until then:

- Keep the commit local to your workspace.
- Do not write the dataset item's `label.txt` yet (the label is only finalized at close).
- If the user turns the candidate down — including partial feedback that names a missed
  element — close it as `rejected-N/` immediately (see *Review dataset*) and do not merge
  or push.

Only after explicit approval: move `main` to your commit (merge), push, and write the
dataset item's `label.txt` (`dataset/<epoch>-<slug>/label.txt`) as `approve`. If the
session ships nothing, write that same file as `deny`. Nothing outside the item folder
is a label: there is no repo-root `label.txt`, and `scripts/dataset-lint.mjs` only reads
`label.txt` inside `dataset/<epoch>-<slug>/` and its `rejected-N/` subfolders.

## Version control (jj)

- Local `deploy: …` commits are GitHub Pages deploy commits. When `jj` abandons one during a fetch, that is expected. Do not warn about it or offer to restore it.

This repo is a **colocated jj + git** repo. Use `jj` for everything; treat `git` as read-only.

- **No staging.** Every `jj` command snapshots the working copy into `@` — saving a file puts it in `@` immediately.
- **Commit:** `jj describe -m "type(scope): ..."` (see step 6 for the format), then `jj new` to start the next change.
- **Inspect:** `jj status`, `jj diff`, `jj log`.
- **Remotes:** `jj git fetch` to update; `jj bookmark set <name> -r @` then `jj git push -b <name>` to publish.
- **Recover:** `jj undo` (last op), or `jj op log` + `jj op restore <op-id>` (any earlier state). Nothing is lost.
- **Never run raw mutating git** (`git commit`, `git rebase`, `git switch`, `git reset`, `git checkout`) — it desyncs jj. `jj git ...` and `gh` are fine.
- **Never run interactive commands** (they hang agents): `jj resolve`, `jj diffedit`, `jj arrange`, bare `jj split`, `jj squash -i`. Resolve conflicts by editing the marked files directly.
- Always pass `-m` to commands that take a message, and `--no-pager` to commands that print.
- Don't rewrite published history.

## Workspaces (parallel agents)

**Always do task work in a named jj workspace — never in `default`.** The main checkout is coordination-only. Every agent edits in its own workspace so parallel agents never clobber each other.

Create a colocated workspace (so `git`/`gh` work inside it):

```bash
bun scripts/agent-workspace.mjs create <name>     # → ../ublock-rule-gen-<name>
bun scripts/agent-workspace.mjs list
bun scripts/agent-workspace.mjs remove <name>
```

Then run the agent with that directory as its cwd. In kimaki:

```bash
kimaki send --cwd /home/han/Developer/ublock-rule-gen-<name> --prompt '...' --agent build
```

Never use `kimaki send --worktree` for this repo — it creates a plain git worktree with no `.jj`, so jj won't work inside it.

If you were launched in `default`, do **not** edit files there. Create a workspace with the helper and do all edits under its absolute path, or ask the user to relaunch you with `--cwd <path>`.

Rules inside a workspace:
- Work only on your own `@` and its descendants. Never rebase, squash, abandon, or edit a commit that another workspace has checked out — it makes that workspace go stale.
- On "stale working copy", run `jj workspace update-stale`.
- `jj workspace list` shows every workspace's `@`; `jj log -r 'conflicts() | divergent()'` spots trouble.
- Publish with your own bookmark: `jj bookmark set agent/<name> -r @` then `jj git push -b agent/<name>`.
- **Clean up after merge.** Once the change is merged to `main` and pushed, remove the
  workspace: `bun scripts/agent-workspace.mjs remove <name>`. Copy the session dataset
  into the main checkout first (see *Review dataset*). Removal deletes the checkout
  directory; commits, bookmarks and the dataset copy stay.

## Constraints & failure handling

- **Login walls / consent dialogs / Cloudflare / anti-bot blocks (e.g. Akamai 403)**: try dismissing common dialogs first; if the page is still unusable headless, escalate in this order — (1) `playwright-cli` with `--headed` to bypass headless fingerprinting, (2) ask the user to paste the element's outerHTML (legacy flow), (3) the playwriter skill as a last resort. If the target element is mobile-only and not served on desktop, also pass `--device='Pixel 7'` (or similar) to get the mobile UA and viewport.
- **CAPTCHA challenges**: if the browser hits a CAPTCHA (e.g. Akamai tile-match) while taking screenshots or inspecting a page, **stop immediately and report it** — do not attempt to solve, click through, or otherwise circumvent the CAPTCHA. Note what was completed before the block and ask the user how to proceed.
- **Don't ask the user to resize anything.** Screenshot ↔ coordinates mapping only works on harvest.mjs screenshots at the documented viewports.
- **The rule must be domain-scoped** (never `##sel` global, never `||` network filters — this is cosmetic filtering only).
- If the user asks for a selector without a rule (e.g. for scraping), still apply the same robustness methodology and output the selector(s) — CSS + XPath variants are welcome.

## Review dataset (build as you go)

Every working session must also capture the review dataset — nothing reconstructed later.

A dataset item is **one candidate rule set plus the before/after pair captured for it,
with its own label**. A session that iterates produces one item per iteration: the
accepted candidate at the session root, every turned-down candidate in `rejected-N/`.
An iteration that is not labelled as a reject is a lost datapoint.

For the session, create `dataset/<epoch>-<slug>/` (epoch = UTC epoch seconds at session
start, so folders sort chronologically, e.g. `dataset/1760935542-storm-threads-bar/`).

### Layout

```
dataset/<epoch>-<slug>/
├── input-annotation-1.png          user's file, unmodified and uncropped
├── output-1-before-<name>.png      pair of the accepted candidate
├── output-2-after-<name>.png
├── rule.txt                        accepted rule set, verbatim as shipped
├── label.txt                       approve | deny
├── note.txt                        optional: gaps, caveats, provenance
├── rejected-1/                     one folder per candidate the user turned down
│   ├── rule.txt                    the candidate exactly as it was posted
│   ├── label.txt                   deny
│   ├── note.txt                    the user's reject reason, quoted
│   ├── output-1-before-<name>.png
│   └── output-2-after-<name>.png
└── rejected-2/                     numbered in order of rejection
    └── ...
```

- `input-annotation-N.<ext>` — the user's annotated screenshot(s), the exact files they
  sent, unmodified and uncropped
- `output-N-before-<name>.png` / `output-N-after-<name>.png` — the session's own harvest
  before/after pairs (keep the harvest's pair name; before keeps its odd number so
  `before` sorts before `after`). Non-pair screenshots are not dataset items
- `rule.txt` — the `domain##selector` set, one rule per line, as shipped
- `label.txt` — `approve` or `deny`, decided at close: `approve` = the user approved
  and the rule was merged to main and pushed, `deny` = the user turned it down. Do not
  guess from message keywords; the user's decision in the thread is the label.
  **Never merge or push before the user explicitly approves** (see step 8).

### Rejected candidates

- **Close the iteration the moment the user turns a candidate down** — before amending the
  commit, rewriting `rule.txt`, or designing the next selector. Feedback that names a
  missing element ("you missed the scroll-to-top button") is a rejection, not a
  continuation: `rejected-N/` is written first, then the next candidate is designed.
- `rejected-N/` holds the candidate verbatim, `label.txt: deny`, a `note.txt` quoting the
  user's reason, and that candidate's own before/after pair. N increments per rejection;
  never merge two rejections into one folder.
- **Copy, don't move.** The rejected pair is copied into `rejected-N/`; the accepted pair
  keeps its `output-N` numbering at the root (1→2, 3→4). A duplicate PNG is cheaper than a
  lost datapoint.
- **Never re-label or rewrite a `rejected-N/` folder later.** A candidate that was
  rejected and then fixed is two items, not one.
- **Capture the pair in the state where the element is visible** — scrolled, if the widget
  only renders after scrolling. A pair that silently misses the element the user later
  names is evidence the candidate was incomplete; keep it anyway.
- **Never rebuild a rejected item from memory.** If the rule text was already lost to an
  amend, recover it from the old commit (`git show <commit>:filters/<file>.txt` — read-only
  git is fine) and record the source commit in `note.txt`.
- When the session ships nothing, the item's root `label.txt` is `deny` and the item folder
  holds the last candidate; earlier ones sit in `rejected-1…N-1/`.

Rules: images come only from the live session captures and user uploads — never
re-navigate, re-capture or back-fill items. If a capture is missing, write
`label.txt` with the label and note the gap in a `note.txt` instead of inventing data.

**Lint before cleanup.** Run the linter on the session folder before copying it out:

```bash
bun scripts/dataset-lint.mjs dataset/<epoch>-<slug>/    # or no path: every folder
bun scripts/dataset-lint.mjs dataset/<epoch>-<slug>/ --fix   # repair pair names
bun scripts/dataset-lint.mjs --session <ses_id>              # judge for a missed reject
```

It checks pair numbering and sort order, `rule.txt`, `label.txt`, annotation presence,
`rejected-N/` completeness, and flags one session split across folders. `--fix` only
renames pair files; everything else needs a human decision. `--session` lists that
session's pushback-looking user turns plus every rule line it posted — compare them with
`rule.txt` to spot an iteration that was turned down and never closed as `rejected-N/`.
Fix all errors before copying the folder into the main checkout.

**Move the dataset out before cleanup.** `dataset/` is gitignored, so merging the
branch does not carry it out of a workspace. Before removing a workspace, copy the
session folder into the main checkout's `dataset/` and verify it landed there:

```bash
cp -a dataset/<epoch>-<slug> /path/to/ublock-rule-gen/dataset/
ls /path/to/ublock-rule-gen/dataset/<epoch>-<slug>/
```

The main-checkout copy is the one that persists; a workspace copy is disposable.
Never remove a workspace while its dataset exists only inside it.
