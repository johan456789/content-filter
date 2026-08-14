# Robust uBlock cosmetic filter design

You are given:
- (a) the target element's **ancestor chain** (JSON dump from `scripts/harvest.mjs find`),
- (b) the **full page HTML** (saved by `harvest.mjs screenshot` as `*.html`),
- (c) the user's goal (hide/remove an annoying element, optionally with a description or circled screenshot).

Produce the most robust uBlock Origin cosmetic filter. "Robust" = survives site JS (Alpine/Vue/React class churn), layout refactors, and re-renders.

## 1. Pick the right target element

- Choose the **smallest ancestor** whose removal/hiding kills the annoyance without hiding unrelated content.
- If the annoyance is a child inside a wrapper (e.g. an ad label inside a card), prefer hiding the wrapper via `:has()` — **only if every match of the wrapper selector is genuinely junk**.
- Anchor on the element's **static identity**, not its position in the DOM tree.

## 2. Anchoring priority (strongest first)

1. **`#id`** — if stable and unique on the page.
2. **Stable attributes**: `x-data`, `data-*`, `aria-*`, `role`, `name`, `type`, `href`.
3. **Static class combinations** — classes present in the raw HTML and never toggled by JS (e.g. Alpine `x-data` component markers, semantic class names).
4. **Tag + relationship to a stable anchor** (e.g. `nav[class*="topic-menu"]` scoped under a stable parent) — only as last resort.

## 3. What to AVOID

- **Classes toggled by JS/Alpine `:class` bindings**: `hidden`, `block`, `opacity-*`, `shadow-lg`, `top-*`, `w-11/12`, anything appearing/disappearing on scroll or hover. These are in the ancestor dump's class list but are NOT safe anchors — verify against the saved HTML (they may not even appear in raw HTML).
- **Pure layout chains**: `> div > div > div.w-full.max-w-screen-lg` — any CSS refactor silently breaks them.
- **`:nth-child()`** against client-side re-rendered DOM (indexes shift).
- **Versioned/random suffixes** in ids/classes (`-2a3f9b`).
- **Overbroad bare tags** (`##div`) unless verified to match exactly the junk.

## 4. CSS syntax details

- Escape `:` `\` `/` `.` when needed in selectors.
- When class lists are noisy, prefer **attribute-contains**: `[class*="topic-menu"][class*="mobile"]` over escaped forms like `.topic-menu\.mobile`.
- Quote attribute values: `[class*="topic-menu"]`.
- **uBlock procedural pseudos** (not plain CSS — never validate these in the browser directly):
  - `:style(display: none !important;)` — inject CSS to hide instead of removing.
  - `:has(selector)` — hide an element that contains a matching descendant (uBlock supports it; Chrome CSS also does).
  - `:has-text(text)` — uBlock-only text match (NOT valid CSS, cannot be validated in browser).
- `:has()` arg needs to be a full selector (e.g. `div.card:has(> span.ad-badge)`).

## 5. uBlock rule format

- `domain##selector` — domain-scoped cosmetic filter. Keep the domain from the URL.
- Plain `##selector` removes the element (display:none) — usually sufficient.
- Add `:style(display: none !important;)` when the site re-adds the element on scroll/route change or inline styles would override.
- For uBlock-specific pseudos, wrap the domain+selector as `domain##sel:style(...)` / `domain##sel:has(...)`.

## 6. Validation rules (MANDATORY)

- After designing the selector, **always run** `bun scripts/harvest.mjs validate <url> 'domain##sel'` on the live page.
- Expect **≥1 match**, ideally 1–3; more than that usually means too broad → scope it.
- Verify the matched elements' classes/ids match the intended target (check the `matches` array in the output).
- For `:has-text()`/`:style()` (unvalidatable in browser), validate the underlying CSS selector part and reason about the pseudo manually.
- Iterate until the match count and matched elements are correct. **Never ship an unvalidated rule.**

## 7. Output format (final answer to user)

```
domain##robust-selector
domain##robust-selector:style(display: none !important;)
```

Plus one fallback (attribute-based or `:has()` variant) and 1–2 sentence rationale: what you anchored on and what you deliberately avoided (dynamic classes, layout chain).
