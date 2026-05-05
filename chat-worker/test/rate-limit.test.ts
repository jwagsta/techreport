import { describe, it, expect, beforeEach } from "vitest";
import { checkAndIncrement } from "../src/rate-limit";
import { makeMockKV } from "./helpers/mock-kv";

describe("rate-limit", () => {
  let kv: ReturnType<typeof makeMockKV>;
  beforeEach(() => { kv = makeMockKV(); });

  it("allows requests under the per-minute limit", async () => {
    const r = await checkAndIncrement(kv, "1.2.3.4", { perMinute: 5, perDay: 100 });
    expect(r.ok).toBe(true);
  });

  it("blocks requests over the per-minute limit", async () => {
    for (let i = 0; i < 5; i++) await checkAndIncrement(kv, "1.2.3.4", { perMinute: 5, perDay: 100 });
    const r = await checkAndIncrement(kv, "1.2.3.4", { perMinute: 5, perDay: 100 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("per_minute");
  });

  it("blocks requests over the per-day limit", async () => {
    for (let i = 0; i < 10; i++) await checkAndIncrement(kv, "1.2.3.4", { perMinute: 1000, perDay: 10 });
    const r = await checkAndIncrement(kv, "1.2.3.4", { perMinute: 1000, perDay: 10 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("per_day");
  });

  it("isolates by IP", async () => {
    for (let i = 0; i < 5; i++) await checkAndIncrement(kv, "1.1.1.1", { perMinute: 5, perDay: 100 });
    const r = await checkAndIncrement(kv, "2.2.2.2", { perMinute: 5, perDay: 100 });
    expect(r.ok).toBe(true);
  });
});
