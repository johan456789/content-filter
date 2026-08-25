# ublock-rule-gen

Turn "this element on this page annoys me" into a uBlock Origin rule stored in this repo's filter list.
**Input:** a URL, plus usually **screenshots sent by the user** (often with an annotation circle drawn on them) and/or a text description of the annoying element.
**Output:** a `domain##selector` uBlock cosmetic filter appended to the matching local filter file. Emit one rule by default — add a `:style(...)` variant or fallback only when you can name a concrete reason (inline `display` style, JS re-injection, etc.). See `prompts/robust-rule.md` §7.

**The user never pastes HTML or element selectors.** If they do, that's the legacy flow — just make their selector robust and return a rule.

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

1. Navigate to the page and scroll so the target element is visible in the viewport
2. Take a **before** screenshot cropped to the relevant area (viewport only, not full-page)
3. Hide the element with JavaScript: `document.querySelector('<selector>').style.display = 'none'`
4. Take an **after** screenshot from the same scroll position, same crop
5. Upload both to the thread

This gives the user a clear visual confirmation the filter works.

## Constraints & failure handling

- **Login walls / consent dialogs / Cloudflare / anti-bot blocks (e.g. Akamai 403)**: try dismissing common dialogs first; if the page is still unusable headless, escalate in this order — (1) `playwright-cli` with `--headed` to bypass headless fingerprinting, (2) ask the user to paste the element's outerHTML (legacy flow), (3) the playwriter skill as a last resort. If the target element is mobile-only and not served on desktop, also pass `--device='Pixel 7'` (or similar) to get the mobile UA and viewport.
- **CAPTCHA challenges**: if the browser hits a CAPTCHA (e.g. Akamai tile-match) while taking screenshots or inspecting a page, **stop immediately and report it** — do not attempt to solve, click through, or otherwise circumvent the CAPTCHA. Note what was completed before the block and ask the user how to proceed.
- **Don't ask the user to resize anything.** Screenshot ↔ coordinates mapping only works on harvest.mjs screenshots at the documented viewports.
- **The rule must be domain-scoped** (never `##sel` global, never `||` network filters — this is cosmetic filtering only).
- If the user asks for a selector without a rule (e.g. for scraping), still apply the same robustness methodology and output the selector(s) — CSS + XPath variants are welcome.
