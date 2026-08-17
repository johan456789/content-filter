# ublock-rule-gen

Custom uBlock Origin filter list blocking annoyances.

## Filters

| File | What it blocks |
|------|----------------|
| `floating-annoyances.txt` | Sticky/floating widgets, share bars |
| `inline-promo.txt` | In-article promos, newsletter nudges |
| `inline-related-articles.txt` | In-article related-articles |
| `slippped-thru-ads.txt` | Ads that slipped through adblocker |

## Adding rules

Send a URL and which element to remove (or circle it on a screenshot). The agent will generate a robust `domain##selector` cosmetic filter and add it to the right file.

## Syntax reference

- [uBlock static filter syntax](https://github.com/gorhill/uBlock/wiki/Static-filter-syntax)
