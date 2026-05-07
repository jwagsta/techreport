import { describe, it, expect, vi, beforeEach } from "vitest";
import { verifyTurnstile } from "../src/turnstile";

describe("turnstile", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("returns true on a successful verification", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ success: true }))));
    expect(await verifyTurnstile("token", "secret", "1.1.1.1")).toBe(true);
  });

  it("returns false on a failed verification", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ success: false }))));
    expect(await verifyTurnstile("token", "secret", "1.1.1.1")).toBe(false);
  });

  it("returns false on network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("net"); }));
    expect(await verifyTurnstile("token", "secret", "1.1.1.1")).toBe(false);
  });
});
