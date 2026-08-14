# ublock-rule-gen

Turn "this element on this page annoys me" into a uBlock Origin rule stored in this repo's filter list.
**Input:** a URL, optionally + a screenshot (with or without an annotation circle) or a text description of the annoying element.
**Output:** a `domain##selector` uBlock cosmetic filter (plus variants), appended to the matching local filter file.

**The user never pastes HTML or element selectors.** If they do, that's the legacy flow — just make their selector robust and return a rule.

## Setup (first time only)

```bash
bun install          # in repo root
bunx playwright install chromium   # if browsers are not cached
```

## The workflow

### 1. Take screenshots (fixed viewports)

```bash
bun scripts/harvest.mjs screenshot <url> --viewport=desktop --out=tmp/
bun scripts/harvest.mjs screenshot <url> --viewport=mobile --out=tmp/
```

- Desktop = 1440×900, Mobile = 390×844, deviceScaleFactor 1 — **coordinates only map to these**.
- Always take **both** — the annoying element is often mobile-only (sticky bars, mobile menus).
- The script lazy-scrolls the page first so lazy-loaded content is present.
- It also saves the **full page HTML** (`tmp/<domain>-<viewport>.html`) — read this to understand the page before designing selectors.
- If the element might be below the fold, also take `--full` (full-page screenshot) for desktop.
- Upload the screenshots to the thread so the user can see them.

### 2. Locate the annoying element

Three paths, in order of preference:

**A. User already annotated a screenshot** (circled the element):
```bash
bun scripts/harvest.mjs diff tmp/<original>.png /path/to/annotated.png
```
The output `center` is the pixel point to use. **Warn the user first: don't resize/crop the screenshot, just draw on it and re-upload.**

**B. User gave a text description** ("the sticky nav at the top", "the share widget on the right"):
- Look at the screenshots you took, locate the region, estimate the center pixel of the element.
- Run `find` at that point, inspect the chain, and confirm the described element is there. If ambiguous, pick 2–3 candidates and ask the user (one round trip).

**C. Nothing provided**: ask the user to circle the element on one of the screenshots you uploaded (tell them not to resize/crop) — or describe it. Do not guess.

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

The rule goes into one of the category files (grouped by annoyance type):

- `floating-annoyances` — sticky/floating widgets, share/social bars
- `inline-promo` — in-article promos, newsletter nudges
- `inline-related-articles` — related-article cards
- `slippped-thru-ads` — ads that slipped through

Append the rule (the robust selector + `:style()` variant, see `prompts/robust-rule.md` §7) to the matching file. If no category fits, **ask the user for approval** before creating a new file (and adding its `!#include` to `main`).

Then commit with conventional commits using `type(domain)` scope:

```
feat(example.com): add floating share bar filter
fix(example.com): update share bar selector
```

- Add = `feat`, updating an existing selector = `fix`.
- If a commit touches multiple domains, use the primary domain; omit the scope only for list-level changes (e.g. `main` metadata).

Rationale (1–2 sentences on what you anchored on / avoided) goes in the commit body or the reply to the user.

## Constraints & failure handling

- **Login walls / consent dialogs / Cloudflare**: try dismissing common dialogs first; if the page is unusable headless, ask the user to paste the element's outerHTML (legacy flow) or use the user's real browser via the playwriter skill.
- **Don't ask the user to resize anything.** Screenshot ↔ coordinates mapping only works on harvest.mjs screenshots at the documented viewports.
- **The rule must be domain-scoped** (never `##sel` global, never `||` network filters — this is cosmetic filtering only).
- If the user asks for a selector without a rule (e.g. for scraping), still apply the same robustness methodology and output the selector(s) — CSS + XPath variants are welcome.
