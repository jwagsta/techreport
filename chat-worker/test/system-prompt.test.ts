import { describe, it, expect } from "vitest";
import { buildSystemBlocks, buildUserMessage } from "../src/system-prompt";

describe("system-prompt", () => {
  it("returns three cached blocks in correct order", () => {
    const blocks = buildSystemBlocks("CORPUS_TEXT", "FAQ_TEXT");
    expect(blocks).toHaveLength(3);
    expect(blocks[0]!.text).toContain("Mirror Bacteria");
    expect(blocks[0]!.text).toContain("strictly factual");
    expect(blocks[1]!.text).toBe("CORPUS_TEXT");
    expect(blocks[2]!.text).toContain("FAQ_TEXT");
    expect(blocks[2]!.text).toContain("never reveal");
    blocks.forEach(b => expect(b.cache_control).toEqual({ type: "ephemeral", ttl: "1h" }));
  });

  it("user message prepends current-context line", () => {
    const m = buildUserMessage(
      { chapterTitle: "Chapter 4 — Pathogen risks", sectionTitle: "Immune evasion" },
      "Why can't antibiotics work?",
    );
    expect(m).toBe(
      "[Reader is currently on: Chapter 4 — Pathogen risks § Immune evasion]\n\n" +
      "Why can't antibiotics work?",
    );
  });

  it("user message handles missing section", () => {
    const m = buildUserMessage(
      { chapterTitle: "Abstract", sectionTitle: null },
      "Summary?",
    );
    expect(m).toBe("[Reader is currently on: Abstract]\n\nSummary?");
  });

  it("user message includes background when provided", () => {
    const m = buildUserMessage(
      { chapterTitle: "Abstract", sectionTitle: null },
      "Summary?",
      "non-specialist",
    );
    expect(m).toBe(
      "[Reader background: non-specialist]\n[Reader is currently on: Abstract]\n\nSummary?",
    );
  });
});
