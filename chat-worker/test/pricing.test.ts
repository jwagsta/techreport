import { describe, it, expect } from "vitest";
import { computeCostUsd } from "../src/pricing";

describe("pricing", () => {
  it("computes cost from a usage object", () => {
    // Sonnet 4.6: $3/M input uncached, $0.30/M input cached read,
    // $3.75/M cache write (1.25x), $15/M output.
    const cost = computeCostUsd({
      input_tokens: 1000,
      cache_creation_input_tokens: 1000,
      cache_read_input_tokens: 1000,
      output_tokens: 1000,
    });
    // 1000*3/1e6 + 1000*3.75/1e6 + 1000*0.30/1e6 + 1000*15/1e6
    // = 0.003 + 0.00375 + 0.0003 + 0.015 = 0.02205
    expect(cost).toBeCloseTo(0.02205, 5);
  });

  it("handles missing cache fields", () => {
    const cost = computeCostUsd({ input_tokens: 1000, output_tokens: 1000 });
    expect(cost).toBeCloseTo(0.018, 5); // 0.003 + 0.015
  });
});
