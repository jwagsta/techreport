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

## Chat assistant ("Ask AI")

The site has an optional Claude-powered chat widget. It's served by a separate
Cloudflare Worker (`chat-worker/`) and is enabled at build time by setting
`CHAT_API_URL` and `TURNSTILE_SITE_KEY` env vars when running `make site`.

### One-time setup

1. Install Worker deps: `cd chat-worker && npm install`.
2. Create the KV namespace: `wrangler kv:namespace create RATE_KV` (and `--preview`),
   paste the ids into `chat-worker/wrangler.toml`.
3. Set Worker secrets:
   ```bash
   wrangler secret put ANTHROPIC_API_KEY
   wrangler secret put TURNSTILE_SECRET_KEY
   wrangler secret put ADMIN_TOKEN
   wrangler secret put SESSION_SIGNING_KEY
   ```
4. Set `ALLOWED_ORIGIN` and `TURNSTILE_SITE_KEY` in `wrangler.toml`'s `[vars]`.
5. Replace `chat-worker/private/technical-faq.md` with the real authors' FAQ
   (this file is bundled into the Worker but never sent to the browser).

### Deploy

```bash
make chat-corpus       # rebuild bundled report from data/
make chat-deploy       # deploy the Worker

# Site (existing flow), now with chat enabled:
CHAT_API_URL="https://ask-mirror-report.<your-account>.workers.dev/chat" \
TURNSTILE_SITE_KEY="<turnstile-site-key>" \
make site
```

If `CHAT_API_URL` is unset at build time, the widget is silently disabled.

### Tuning limits

Edit `[vars]` in `chat-worker/wrangler.toml`:

- `DAILY_USD_CEILING` — hard $ cap per UTC day
- `DAILY_PER_IP_LIMIT` — requests per IP per UTC day
- `PER_MINUTE_PER_IP_LIMIT` — requests per IP per minute
- `MAX_OUTPUT_TOKENS` — Claude output token cap per question
- `MAX_HISTORY_TURNS` — kept turns of conversation history

Run `wrangler deploy` after changing these.

### Monitoring

```bash
wrangler tail --name ask-mirror-report                       # live logs
curl "https://<worker-url>/admin/status?token=$ADMIN_TOKEN"  # today's spend
```
