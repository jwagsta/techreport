import { describe, it, expect } from "vitest";
import { REPORT_CORPUS, PRIVATE_FAQ } from "../src/corpus-data";

describe("corpus-data", () => {
  it("contains the report title", () => {
    expect(REPORT_CORPUS).toContain("Technical Report on Mirror Bacteria");
  });
  it("contains chapter URL markers", () => {
    expect(REPORT_CORPUS).toMatch(/url: \/chapter-/);
  });
  it("contains section URL markers with anchors", () => {
    expect(REPORT_CORPUS).toMatch(/url: \/chapter-[\w-]+\/#/);
  });
  it("includes a URL manifest at the top", () => {
    expect(REPORT_CORPUS).toContain("URL MANIFEST");
    expect(REPORT_CORPUS).toContain("Do not invent paths");
  });
  it("FAQ is non-empty", () => {
    expect(PRIVATE_FAQ.length).toBeGreaterThan(0);
  });
});
