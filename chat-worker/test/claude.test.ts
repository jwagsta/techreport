import { describe, it, expect, vi } from "vitest";
import { streamAnthropic } from "../src/claude";

function sseChunk(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

describe("claude streaming", () => {
  it("forwards content_block_delta events to the consumer and returns final usage", async () => {
    // Build a fake streaming HTTP response.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode(sseChunk("message_start", { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } })));
        controller.enqueue(enc.encode(sseChunk("content_block_delta", { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } })));
        controller.enqueue(enc.encode(sseChunk("content_block_delta", { type: "content_block_delta", delta: { type: "text_delta", text: " world." } })));
        controller.enqueue(enc.encode(sseChunk("message_delta", { type: "message_delta", usage: { output_tokens: 4 } })));
        controller.enqueue(enc.encode(sseChunk("message_stop", { type: "message_stop" })));
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })));

    const chunks: string[] = [];
    const usage = await streamAnthropic({
      apiKey: "k",
      model: "claude-sonnet-4-6",
      maxTokens: 100,
      system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "hi" }],
      onText: (t) => chunks.push(t),
    });

    expect(chunks.join("")).toBe("Hello world.");
    expect(usage).toMatchObject({ input_tokens: 10, output_tokens: 4 });
  });

  it("throws on non-200 from Anthropic", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("err", { status: 500 })));
    await expect(streamAnthropic({
      apiKey: "k", model: "claude-sonnet-4-6", maxTokens: 10,
      system: [], messages: [{ role: "user", content: "hi" }],
      onText: () => {},
    })).rejects.toThrow();
  });
});
