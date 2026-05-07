import type { Env } from "./index";
import { preflight, corsHeaders } from "./cors";
import { checkAndIncrement } from "./rate-limit";
import { isOverCeiling, recordSpend } from "./spend";
import { verifyTurnstile } from "./turnstile";
import { signSession, verifySession } from "./session";
import { buildSystemBlocks, buildUserMessage } from "./system-prompt";
import { streamAnthropic } from "./claude";
import { computeCostUsd } from "./pricing";
import { REPORT_CORPUS, PRIVATE_FAQ } from "./corpus-data";

interface ChatRequest {
  chapterId: string;
  chapterTitle: string;
  sectionId: string | null;
  sectionTitle: string | null;
  question: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  turnstileToken?: string;
}

const MODEL = "claude-sonnet-4-6";

function jsonError(status: number, error: string, extras: Record<string, unknown> = {}, origin = "", allowed = ""): Response {
  return new Response(JSON.stringify({ error, ...extras }), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders(origin, allowed) },
  });
}

export async function handle(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const origin = req.headers.get("origin") ?? "";

  const pre = preflight(req, env.ALLOWED_ORIGIN);
  if (pre) return pre;

  if (url.pathname === "/healthz") {
    return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
  }

  if (url.pathname === "/admin/status") {
    const tok = url.searchParams.get("token");
    if (tok !== env.ADMIN_TOKEN) return new Response("forbidden", { status: 403 });
    const day = new Date().toISOString().slice(0, 10);
    const spend = parseFloat((await env.RATE_KV.get(`spend:${day}`)) ?? "0");
    return new Response(JSON.stringify({ day, spendUsd: spend, ceilingUsd: parseFloat(env.DAILY_USD_CEILING) }), {
      headers: { "content-type": "application/json" },
    });
  }

  if (url.pathname !== "/chat") return new Response("not found", { status: 404 });
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (origin !== env.ALLOWED_ORIGIN) return jsonError(403, "forbidden_origin", {}, origin, env.ALLOWED_ORIGIN);

  let body: ChatRequest;
  try { body = await req.json(); }
  catch { return jsonError(400, "bad_request", {}, origin, env.ALLOWED_ORIGIN); }
  if (!body.question || typeof body.question !== "string" || body.question.length > 4000) {
    return jsonError(400, "bad_request", {}, origin, env.ALLOWED_ORIGIN);
  }

  const ip = req.headers.get("cf-connecting-ip") ?? "0.0.0.0";

  // Daily $ ceiling first — this is the hard cap.
  if (await isOverCeiling(env.RATE_KV, parseFloat(env.DAILY_USD_CEILING))) {
    const reset = new Date(); reset.setUTCHours(24, 0, 0, 0);
    return jsonError(503, "daily_limit", { resetAt: reset.toISOString() }, origin, env.ALLOWED_ORIGIN);
  }

  // Per-IP rate limit.
  const rl = await checkAndIncrement(env.RATE_KV, ip, {
    perMinute: parseInt(env.PER_MINUTE_PER_IP_LIMIT, 10),
    perDay: parseInt(env.DAILY_PER_IP_LIMIT, 10),
  });
  if (!rl.ok) {
    return jsonError(429, "rate_limited", { reason: rl.reason, retryAfterSec: rl.retryAfterSec }, origin, env.ALLOWED_ORIGIN);
  }

  // Turnstile / session. Staging-only bypass for the behavioral regression suite.
  const isStagingBypass = body.turnstileToken === "regression-bypass" &&
                          env.ALLOWED_ORIGIN.includes("staging");
  const sessionToken = req.headers.get("x-session-token");
  let session = sessionToken ? await verifySession(sessionToken, env.SESSION_SIGNING_KEY) : null;
  if (!session && !isStagingBypass) {
    if (!body.turnstileToken) return jsonError(403, "turnstile_required", {}, origin, env.ALLOWED_ORIGIN);
    const ok = await verifyTurnstile(body.turnstileToken, env.TURNSTILE_SECRET_KEY, ip);
    if (!ok) return jsonError(403, "turnstile_failed", {}, origin, env.ALLOWED_ORIGIN);
  }
  // Issue/refresh session token (24h) so subsequent calls skip Turnstile.
  const newSession = await signSession({ ip }, env.SESSION_SIGNING_KEY, 60 * 60 * 24);

  // Cap history to MAX_HISTORY_TURNS turns (a turn = user + assistant pair).
  const maxTurns = parseInt(env.MAX_HISTORY_TURNS, 10);
  const history = (body.history ?? []).slice(-maxTurns * 2);

  // Build messages.
  const userMsg = buildUserMessage(
    { chapterTitle: body.chapterTitle, sectionTitle: body.sectionTitle },
    body.question,
  );
  const messages = [...history, { role: "user" as const, content: userMsg }];

  // Stream from Anthropic, pipe to client.
  const sysBlocks = buildSystemBlocks(REPORT_CORPUS, PRIVATE_FAQ);
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (event: string, data: unknown) => {
        controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      send("session", { token: newSession });
      try {
        const usage = await streamAnthropic({
          apiKey: env.ANTHROPIC_API_KEY,
          model: MODEL,
          maxTokens: parseInt(env.MAX_OUTPUT_TOKENS, 10),
          system: sysBlocks,
          messages,
          onText: (t) => send("text", { delta: t }),
        });
        const cost = computeCostUsd(usage);
        await recordSpend(env.RATE_KV, cost);
        send("done", { usage, cost });
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        const errCode = msg.startsWith("Anthropic 429") ? "upstream_rate_limited"
                      : msg.startsWith("Anthropic 401") ? "upstream_auth"
                      : msg.startsWith("Anthropic 402") ? "upstream_billing"
                      : "upstream_error";
        send("error", { error: errCode });
        console.error("anthropic stream error:", msg);
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "connection": "keep-alive",
      ...corsHeaders(origin, env.ALLOWED_ORIGIN),
    },
  });
}
