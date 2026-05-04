# Mirror Bacteria Report — interactive site

A Tufte-leaning static website for the *Technical Report on Mirror Bacteria: Feasibility and Risks* (December 2024).

## Pipeline

```
Final Tech Report.docx
        │
        ▼
   parser/  ──pandoc──▶ parser/intermediates/report.html
        │                         │
        │                         ▼
        └─────────parse.py────────▶  data/
                                      ├── index.json
                                      ├── chapters/<id>.json
                                      ├── footnotes.json
                                      ├── references.json
                                      └── assets/*.png
                                            │
                                            ▼
                                       build.py
                                            │
                                            ▼
                                          site/
                                            ├── index.html
                                            ├── <chapter-id>/index.html
                                            ├── styles.css
                                            ├── app.js
                                            └── assets/*.png
```

## Build

```bash
# One-shot, end-to-end
make             # parses + builds

# Stages independently
make data        # docx → data/
make site        # data/ → site/
make serve       # http://localhost:8765
make clean       # wipe data/ and site/
```

## Layout

```
tr-website/
├── parser/                  # docx → data/  (one-shot, reproducible)
│   ├── parse.py             # the parser; schema documented inside
│   ├── README.md            # parser docs (block types, inline annotations)
│   ├── Makefile             # `make json` runs the full docx → JSON pipeline
│   ├── requirements.txt     # beautifulsoup4 + lxml
│   └── intermediates/       # pandoc output (gitignored)
├── data/                    # parser output  (gitignored — regenerate via `make data`)
├── build.py                 # data/ → site/
├── site-assets/             # source CSS + JS (copied into site/)
│   ├── styles.css
│   └── app.js
├── site/                    # built static site (gitignored — `make site` regenerates)
├── archive/                 # earlier experiments / superseded artifacts
├── Final Tech Report.docx   # source
└── Makefile                 # top-level pipeline
```

## Design treatment

The visual style is "scientific minimal" Tufte:

- Source Serif 4 body, Inter for sans elements (TOC, sidenotes, eyebrows)
- Pure white paper, IBM-blue accent, near-black ink
- Three-column desktop layout: thin TOC ▎ main reading ▎ sidenote margin
- Wide figures span main + margin; captions sit in the margin column
- Footnotes render as numbered sidenotes; hover for a peek, click for the drawer
- Internal links open a **right drawer** preview on desktop / **bottom sheet** on mobile, with a "Jump there ↗" button — clicking another link inside the drawer navigates the drawer rather than nesting

## Dependencies

- `python3` (3.11+)
- `pandoc` (for the docx → html step)
- Python: `beautifulsoup4`, `lxml` (pinned in `parser/requirements.txt`; the parser bootstraps its own venv)

The build step (`build.py`) has no third-party Python dependencies.
