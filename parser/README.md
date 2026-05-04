# parser

Parses **Final Tech Report.docx** (the Mirror Bacteria technical report) into a
JSON shape that a website can render flexibly: full document, per-chapter lazy
loads, footnotes, references, and image assets.

## Layout

```
parser/
├── parse.py                # the parser
├── Makefile                # one-command `make json` pipeline
├── requirements.txt        # beautifulsoup4 + lxml (pinned)
├── intermediates/          # pandoc output (gitignored)
│   ├── report.html         # primary input to parse.py
│   ├── report.md           # markdown form (for human inspection)
│   ├── report.ast.json     # pandoc native AST (kept for reference)
│   └── media/media/*.png   # raw images extracted by pandoc
└── (writes to ../data/)    # parser output; consumed by build.py
    ├── report.json         # everything in one file (~1.2 MB)
    ├── index.json          # meta + authors + reviewers + TOC + asset list
    ├── chapters/*.json     # one file per top-level section
    ├── footnotes.json      # all footnotes
    ├── references.json     # bibliography, bucketed by chapter number
    └── assets/*.png        # images, referenced by `assets/<name>.png`
```

## How to (re)build

```bash
make json     # bootstraps the venv, runs pandoc if needed, runs parse.py
make html     # only the docx -> html step (pandoc)
make clean    # wipes intermediates/ and ../data/
```

The Makefile bootstraps `.venv/` from `requirements.txt` on first run.

## Schema (v1.0)

### `index.json`

```jsonc
{
  "schemaVersion": "1.0",
  "meta": {
    "title": "...",
    "publishDate": "December, 2024",
    "license": "CC BY-NC-SA 4.0",
    "doi": "10.1126/science.ads9158",
    "contact": "technical-report@mbdialogues.org"
  },
  "authors":   [{ "name": "...", "affiliation": "..." }],   // 24 entries
  "reviewers": [{ "name": "...", "affiliation": "..." }],   // 20 entries
  "toc": [
    {
      "id": "chapter-1-introduction",        // stable slug, suitable for routes
      "kind": "chapter",                     // chapter | frontmatter | backmatter | section
      "number": 1,                           // chapter number, or null
      "title": "Introduction",
      "subsections": [
        { "id": "...", "title": "...", "level": 2 | 3 }
      ]
    }
  ],
  "assets": ["image1.png", ...]
}
```

### `chapters/<id>.json` (and the `sections[]` of `report.json`)

```jsonc
{
  "id": "chapter-1-introduction",
  "kind": "chapter",
  "number": 1,
  "level": 1,
  "title": "Introduction",
  "title_html": "Introduction",
  "blocks": [ /* blocks that appear before the first H2/H3 */ ],
  "subsections": [
    {
      "id": "...",
      "level": 2,
      "title": "...",
      "title_html": "...",
      "blocks": [ /* see Block types below */ ],
      "subsections": [ /* level 3 if present */ ]
    }
  ]
}
```

If a chapter has only H3 headings (no H2s), they collapse into the `subsections`
array directly at level 3 — so the TOC always has one consistent shape.

### Block types (the `blocks[]` array)

| `type`        | Fields                                                                                               |
|---------------|-------------------------------------------------------------------------------------------------------|
| `paragraph`   | `html` — inline HTML (`<em>`, `<sup>`, `<a>`, etc.)                                                  |
| `heading`     | `level` (4–6 only; 1–3 are consumed by the section structure), `id`, `text`, `html`                  |
| `figure`      | `id`, `src` (e.g. `assets/image25.png`), `alt`, `width`, `height`, `caption: { id, title, title_html, body_html }` |
| `table`       | `html` — full `<table>` element preserved verbatim. May carry `kind: "affiliations"` for the byline footer table at the start of Chapter 1 (renderers should skip it). |
| `box`         | `id`, `label` ("Box 1.1"), `title`, `blocks: [...]` — parser lifts the docx's box-callout layout-tables (single-column tables whose first cell starts with `<h4 id="box-…">`) into a first-class block. |
| `list`        | `ordered` (bool), `start` (int), `items: [{ html }]`                                                 |
| `blockquote`  | `blocks: [...]` — recursive                                                                          |
| `image`       | `src` — bare image not in a figure-table                                                             |
| `hr`          | (no fields)                                                                                          |
| `raw`         | `html` — fallback for anything the parser doesn't classify (should be rare)                          |

### Inline annotations on `html`

The parser adds `data-*` attributes to inline `<a>` elements so frontends can
style them without re-parsing:

- `<a data-citation="paperpile" href="https://paperpile.com/c/...">(Smith, 2020)</a>`
- `<a data-footnote-ref="fn3" class="footnote-ref" href="#fn3">³</a>`
- `<a data-footnote-back="1" class="footnote-back" href="#fnref3">↩︎</a>` (in footnotes only)

### `footnotes.json`

```jsonc
[
  { "id": "1", "html": "<p>For instance, in 2019 the U.S. NSF awarded ...</p>" }
]
```

The `id` matches the `data-footnote-ref` value's `fnN` suffix, so resolving a
click is `footnotes.find(f => f.id === ref.split("fn")[1])`.

### `references.json`

```jsonc
{
  "1": [{ "html": "Abdulrashid, N., & Clark, D. P. (1987). ..." }],
  "2": [...],
  ...
  "8": [...]
}
```

Bucketed by chapter number (string keys for JSON consistency). 1,432 entries
total across 8 chapters.

## Counts (sanity check)

| | |
|--|--|
| Top-level sections | 16 (front + back matter + 8 chapters) |
| Authors            | 24 |
| Reviewers          | 20 |
| Footnotes          | 17 |
| Reference entries  | 1,432 |
| Figures            | 25 |
| Tables             | 26 (data tables, not counting figure-wrappers) |
| Image assets       | 26 |
| Total content blocks | 817 |

## Notes & known limitations

- **Figure detection**: a `<table>` is treated as a figure when it is single-
  column and its first row contains an `<img>`. The caption (an `<h5>` plus a
  body paragraph) is split out into the `caption` object. Anything else is left
  as a `table` block.
- **The "affiliations footer"** at the very start of Chapter 1 is a 1-column
  layout table without an image — it stays as `table`. Render it as styled text
  with a top border or similar.
- **Inline body citations are textual** in this report — the form `*Smith et
  al.*, 2020` rather than hyperlinks. Citations *inside footnotes* are
  hyperlinks (Paperpile) and get the `data-citation` attribute.
- **Tracked changes** are accepted at the pandoc step (`--track-changes=accept`).
  If you need to keep them, change that flag and re-run.
- **Schema is v1.0** — set in every output file. Bump if you change shapes.

## How a website would consume this

```js
// page load: get TOC + meta
const idx = await fetch("/data/index.json").then(r => r.json());

// render a chapter route /chapter/1:
const chap = await fetch(`/data/chapters/${idx.toc[i].id}.json`).then(r => r.json());

// resolve a footnote click on `<a data-footnote-ref="fn3">`:
const fn = footnotes.find(f => f.id === "3");

// render a paragraph block:
<div dangerouslySetInnerHTML={{ __html: block.html }} />

// render a figure block:
<figure>
  <img src={`/data/${block.src}`} alt={block.alt}
       style={{ width: block.width, height: block.height }} />
  <figcaption>
    <strong>{block.caption.title}</strong>
    <div dangerouslySetInnerHTML={{ __html: block.caption.body_html }} />
  </figcaption>
</figure>
```
