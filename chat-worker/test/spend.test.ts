import { describe, it, expect, beforeEach } from "vitest";
import { isOverCeiling, recordSpend, getDailySpend } from "../src/spend";
import { makeMockKV } from "./helpers/mock-kv";

describe("spend", () => {
  let kv: ReturnType<typeof makeMockKV>;
  beforeEach(() => { kv = makeMockKV(); });

  it("starts at zero and is not over the ceiling", async () => {
    expect(await isOverCeiling(kv, 5.0)).toBe(false);
    expect(await getDailySpend(kv)).toBe(0);
  });

  it("accumulates spend across calls", async () => {
    await recordSpend(kv, 0.5);
    await recordSpend(kv, 0.25);
    expect(await getDailySpend(kv)).toBeCloseTo(0.75, 5);
  });

  it("trips the ceiling after enough spend", async () => {
    await recordSpend(kv, 4.0);
    expect(await isOverCeiling(kv, 5.0)).toBe(false);
    await recordSpend(kv, 1.5);
    expect(await isOverCeiling(kv, 5.0)).toBe(true);
  });
});
