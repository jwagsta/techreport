import { describe, it, expect } from "vitest";
import { REPORT_CORPUS, PRIVATE_FAQ } from "../src/corpus-data";

describe("corpus-data", () => {
  it("contains the report title", () => {
    expect(REPORT_CORPUS).toContain("Technical Report on Mirror Bacteria");
  });
  it("contains chapter slug markers", () => {
    expect(REPORT_CORPUS).toMatch(/slug: chapter-/);
  });
  it("contains section anchor markers", () => {
    expect(REPORT_CORPUS).toMatch(/anchor: /);
  });
  it("FAQ is non-empty", () => {
    expect(PRIVATE_FAQ.length).toBeGreaterThan(0);
  });
});
