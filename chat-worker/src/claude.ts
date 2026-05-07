import type { SystemBlock } from "./system-prompt";
import type { Usage } from "./pricing";

export interface StreamArgs {
  apiKey: string;
  model: string;
  maxTokens: number;
  system: SystemBlock[];
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  onText: (chunk: string) => void;
}

export async function streamAnthropic(args: StreamArgs): Promise<Usage> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": args.apiKey,
      "anthropic-version": "2023-06-01",
      // Required to honor `cache_control.ttl: "1h"` on system blocks.
      "anthropic-beta": "extended-cache-ttl-2025-04-11",
    },
    body: JSON.stringify({
      model: args.model,
      max_tokens: args.maxTokens,
      system: args.system,
      messages: args.messages,
      stream: true,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Anthropic ${res.status}: ${text.slice(0, 200)}`);
  }
  if (!res.body) throw new Error("Anthropic returned empty body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const usage: Usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const event = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLine = event.split("\n").find(l => l.startsWith("data: "));
      if (!dataLine) continue;
      const json = dataLine.slice(6);
      let evt: any;
      try { evt = JSON.parse(json); } catch { continue; }
      switch (evt.type) {
        case "message_start":
          if (evt.message?.usage) {
            const u = evt.message.usage;
            usage.input_tokens = u.input_tokens ?? 0;
            usage.cache_creation_input_tokens = u.cache_creation_input_tokens ?? 0;
            usage.cache_read_input_tokens = u.cache_read_input_tokens ?? 0;
          }
          break;
        case "content_block_delta":
          if (evt.delta?.type === "text_delta") args.onText(evt.delta.text);
          break;
        case "message_delta":
          if (evt.usage?.output_tokens != null) usage.output_tokens = evt.usage.output_tokens;
          break;
      }
    }
  }
  return usage;
}
