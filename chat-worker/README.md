# chat-worker

Cloudflare Worker that powers the "Ask AI" chat widget on the Mirror Bacteria report site.
Proxies questions to Anthropic Claude Sonnet 4.6 with prompt caching, enforces
per-IP rate limits and a daily USD ceiling, and verifies Cloudflare Turnstile.

## Local development

```bash
npm install
npm run build:corpus     # regenerate src/corpus-data.ts from ../data/
npm test                 # vitest
npm run dev              # wrangler dev (uses .dev.vars for secrets)
```

`.dev.vars` (gitignored) for local secrets:

```
ANTHROPIC_API_KEY=sk-ant-...
TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA   # always-passes test key
ADMIN_TOKEN=local-admin
SESSION_SIGNING_KEY=any-32-byte-string-for-local-dev-only!
```

## Deploy

1. `wrangler kv:namespace create RATE_KV` — copy the id into `wrangler.toml`.
2. `wrangler kv:namespace create RATE_KV --preview` — copy preview_id too.
3. Set production secrets:
   ```bash
   wrangler secret put ANTHROPIC_API_KEY
   wrangler secret put TURNSTILE_SECRET_KEY
   wrangler secret put ADMIN_TOKEN
   wrangler secret put SESSION_SIGNING_KEY     # 32+ random bytes
   ```
4. Update `[vars]` in `wrangler.toml`:
   - `ALLOWED_ORIGIN` to the production site origin (e.g. `https://mirrorbacteria.org`)
   - `TURNSTILE_SITE_KEY` to the real Turnstile site key
5. `npm run build:corpus` whenever `../data/` changes.
6. `npm run deploy`.

## Endpoints

- `POST /chat` — main chat endpoint. SSE response.
- `GET /healthz` — health check.
- `GET /admin/status?token=<ADMIN_TOKEN>` — today's spend and ceiling.

## Tuning

All limits are env vars in `wrangler.toml`:

- `DAILY_USD_CEILING` — hard $ cap per UTC day (default `5.00`)
- `DAILY_PER_IP_LIMIT` — requests per IP per UTC day (default `100`)
- `PER_MINUTE_PER_IP_LIMIT` — requests per IP per minute (default `15`)
- `MAX_OUTPUT_TOKENS` — per-question Claude output cap (default `8000`)
- `MAX_HISTORY_TURNS` — kept turns of conversation history (default `20`)
