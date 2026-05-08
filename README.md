# Mirror Bacteria Report — interactive site

A Tufte-leaning static website for the *Technical Report on Mirror Bacteria: Feasibility and Risks* (December 2024).

Deployed: <https://jwagsta.github.io/techreport/>

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
                                      ├── abstracts.json          (fetched by tools/fetch_abstracts.py)
                                      ├── headshots/              (fetched & cached)
                                      ├── headshot-{cache,candidates,selections}.json
                                      ├── reviewer-headshot-candidates.json
                                      ├── report.json             (single-file dump)
                                      └── assets/*.png
                                            │
                                            ├──build.py──▶ site/
                                            │              ├── index.html
                                            │              ├── <chapter-id>/index.html
                                            │              ├── styles.css, app.js, chat.js, chat.css,
                                            │              │   search.js, favicon.svg
                                            │              ├── search-index.json
                                            │              ├── headshots/*.{jpg,webp}
                                            │              ├── assets/*.png
                                            │              └── admin/         (dev builds only)
                                            │
                                            └──chat-worker/scripts/build-corpus.ts──▶
                                                  chat-worker/src/corpus-data.ts
                                                  (bundled into the Worker at deploy time)
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

### Build env vars

`build.py` reads four environment variables:

| Var | Effect |
|---|---|
| `BUILD_PROD=1` | Production build: skip `/admin/*` tools and admin-only JSON. |
| `BASE_PATH=/foo` | Prefix for absolute URLs when the site is served from a sub-directory (e.g. `/techreport` on GitHub Pages project sites). |
| `CHAT_API_URL` | Worker `/chat` endpoint. If empty, the Ask AI widget silently disables itself. |
| `TURNSTILE_SITE_KEY` | Cloudflare Turnstile site key for the chat widget. |

## Deployment

GitHub Pages auto-deploys on every push to `main` via `.github/workflows/deploy.yml`.
The workflow runs `python3 build.py` with:

```
BUILD_PROD=1
BASE_PATH=/techreport
CHAT_API_URL=${{ secrets.CHAT_API_URL }}
TURNSTILE_SITE_KEY=${{ secrets.TURNSTILE_SITE_KEY }}
```

and uploads `site/` to Pages. The chat Worker is deployed separately from a
dev machine via `make chat-deploy` (see [Chat assistant](#chat-assistant-ask-ai)).

## Layout

```
techreport/
├── parser/                  # docx → data/  (one-shot, reproducible)
│   ├── parse.py             # the parser; schema documented inside
│   ├── README.md            # parser docs (block types, inline annotations)
│   ├── Makefile             # `make json` runs the full docx → JSON pipeline
│   ├── requirements.txt     # beautifulsoup4 + lxml
│   └── intermediates/       # pandoc output (gitignored)
├── data/                    # parser output (committed; regenerate via `make data`)
├── tools/
│   └── fetch_abstracts.py   # populates data/abstracts.json from DOIs/URLs in references
├── build.py                 # data/ → site/
├── site-assets/             # source CSS + JS (copied into site/ by build.py)
│   ├── styles.css
│   ├── app.js               # main page interactions (drawer previews, etc.)
│   ├── search.js            # in-browser search overlay (⌘K)
│   ├── chat.js              # Ask AI chat widget
│   ├── chat.css
│   ├── favicon.svg
│   ├── admin-headshots.html # dev-only: pick author headshots
│   └── admin-duotone.html   # dev-only: tune duotone treatment
├── chat-worker/             # Cloudflare Worker that powers Ask AI
│   ├── src/                 # Worker source + bundled report corpus
│   ├── scripts/             # corpus + FAQ build scripts
│   └── README.md            # worker docs (deploy, secrets, endpoints)
├── docs/superpowers/        # historical design specs / planning notes
├── site/                    # built static site (gitignored — `make site` regenerates)
├── .github/workflows/       # GitHub Actions (Pages deploy)
├── Final Tech Report.docx   # source (gitignored)
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
- ⌘K opens an in-browser **search overlay** (token + prefix index built at build time, served as `search-index.json`)
- An **Ask AI** chat widget bottom-right streams answers from the chat-worker, with citation links back into the report

## Dependencies

- `python3` (3.11+)
- `pandoc` (for the docx → html step)
- Python: `beautifulsoup4`, `lxml` (pinned in `parser/requirements.txt`; the parser bootstraps its own venv); `pillow` is required for the headshot pipeline (installed in CI; install locally if you regenerate headshots)
- Node 18+ and `wrangler` for the chat Worker (`chat-worker/`)

The build step (`build.py`) itself has no third-party Python dependencies.

## Chat assistant ("Ask AI")

The site has an optional Claude-powered chat widget. It's served by a separate
Cloudflare Worker (`chat-worker/`, see its README for details) and is enabled
at build time by setting `CHAT_API_URL` and `TURNSTILE_SITE_KEY` env vars when
running `make site`.

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
make chat-dev          # run worker locally on :8787
make chat-deploy       # deploy the Worker to Cloudflare

# Site (existing flow), now with chat enabled:
BUILD_PROD=1 \
BASE_PATH=/techreport \
CHAT_API_URL="https://ask-mirror-report.<your-account>.workers.dev/chat" \
TURNSTILE_SITE_KEY="<turnstile-site-key>" \
make site
```

If `CHAT_API_URL` is unset at build time, the widget is silently disabled.
On GitHub Pages, the deploy workflow injects these from repo secrets — see
[Deployment](#deployment).

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

## Internal docs

`docs/superpowers/` contains historical planning specs (e.g. the original
"Ask the report" chat design and the unified-chapter-TOC redesign). Treat
those as design history, not current-state documentation — this README and
the per-component READMEs (`parser/`, `chat-worker/`) are authoritative.
