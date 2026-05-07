import { describe, it, expect, vi, beforeEach } from "vitest";
import { handle } from "../src/handler";
import { makeMockKV } from "./helpers/mock-kv";

function env(overrides: Partial<any> = {}) {
  return {
    RATE_KV: makeMockKV(),
    ANTHROPIC_API_KEY: "test-key",
    TURNSTILE_SECRET_KEY: "test-secret",
    ADMIN_TOKEN: "admin-tok",
    SESSION_SIGNING_KEY: "session-key-32-bytes-long-enough!",
    ALLOWED_ORIGIN: "https://mirrorbacteria.org",
    DAILY_USD_CEILING: "5.00",
    DAILY_PER_IP_LIMIT: "100",
    PER_MINUTE_PER_IP_LIMIT: "15",
    MAX_OUTPUT_TOKENS: "8000",
    MAX_HISTORY_TURNS: "20",
    TURNSTILE_SITE_KEY: "test-site-key",
    ...overrides,
  };
}

function req(body: any, headers: Record<string, string> = {}): Request {
  return new Request("https://w/chat", {
    method: "POST",
    headers: { "content-type": "application/json", "origin": "https://mirrorbacteria.org", "cf-connecting-ip": "1.1.1.1", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  // Default: Turnstile passes, Anthropic streams "ok".
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("turnstile")) return new Response(JSON.stringify({ success: true }));
    if (url.includes("anthropic")) {
      const enc = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 10 } } })}\n\n`));
          c.enqueue(enc.encode(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "ok" } })}\n\n`));
          c.enqueue(enc.encode(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 1 } })}\n\n`));
          c.enqueue(enc.encode(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`));
          c.close();
        },
      });
      return new Response(body, { status: 200 });
    }
    throw new Error("unexpected url " + url);
  }));
});

describe("/chat handler", () => {
  it("rejects non-POST", async () => {
    const r = await handle(new Request("https://w/chat", { method: "GET" }), env() as any);
    expect(r.status).toBe(405);
  });

  it("rejects missing turnstile token on first message", async () => {
    const r = await handle(req({ chapterId: "abstract", chapterTitle: "Abstract", sectionId: null, sectionTitle: null, question: "hi", history: [] }), env() as any);
    expect(r.status).toBe(403);
  });

  it("succeeds with valid turnstile token and streams body", async () => {
    const r = await handle(req({
      chapterId: "abstract", chapterTitle: "Abstract", sectionId: null, sectionTitle: null,
      question: "hi", history: [], turnstileToken: "tok",
    }), env() as any);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    const text = await r.text();
    expect(text).toContain("ok");
  });

  it("returns 429 when rate-limited", async () => {
    const e = env();
    // Pre-fill the per-minute counter.
    const now = new Date().toISOString().slice(0, 16);
    for (let i = 0; i < 16; i++) await e.RATE_KV.put(`rl:min:1.1.1.1:${now}`, String(i + 1), { expirationTtl: 70 });
    const r = await handle(req({
      chapterId: "abstract", chapterTitle: "Abstract", sectionId: null, sectionTitle: null,
      question: "hi", history: [], turnstileToken: "tok",
    }), e as any);
    expect(r.status).toBe(429);
  });

  it("returns 503 when daily ceiling exceeded", async () => {
    const e = env();
    const day = new Date().toISOString().slice(0, 10);
    await e.RATE_KV.put(`spend:${day}`, "999.00", { expirationTtl: 86400 });
    const r = await handle(req({
      chapterId: "abstract", chapterTitle: "Abstract", sectionId: null, sectionTitle: null,
      question: "hi", history: [], turnstileToken: "tok",
    }), e as any);
    expect(r.status).toBe(503);
  });
});
