#!/usr/bin/env tsx
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const URL = process.env.CHAT_URL;
const ORIGIN = process.env.ALLOWED_ORIGIN;
if (!URL || !ORIGIN) { console.error("set CHAT_URL and ALLOWED_ORIGIN"); process.exit(2); }

interface Case {
  name: string;
  question: string;
  expectIncludesAnyOf?: string[];
  expectExcludesAllOf?: string[];
  expectCitesAtLeast?: number;
}

const cases: Case[] = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "test", "regression.json"), "utf8"),
);

async function ask(q: string): Promise<string> {
  const res = await fetch(URL!, {
    method: "POST",
    headers: { "content-type": "application/json", "origin": ORIGIN! },
    body: JSON.stringify({
      chapterId: "abstract", chapterTitle: "Abstract",
      sectionId: null, sectionTitle: null,
      question: q, history: [], turnstileToken: "regression-bypass",
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "", out = "";
  let currentEvent = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const ev = buf.slice(0, idx); buf = buf.slice(idx + 2);
      const lines = ev.split("\n");
      currentEvent = "";
      let dataLine = "";
      for (const ln of lines) {
        if (ln.startsWith("event: ")) currentEvent = ln.slice(7).trim();
        else if (ln.startsWith("data: ")) dataLine = ln.slice(6);
      }
      if (!dataLine) continue;
      try {
        const p = JSON.parse(dataLine);
        if (currentEvent === "text" && typeof p.delta === "string") out += p.delta;
      } catch {}
    }
  }
  return out;
}

(async () => {
  let fails = 0;
  for (const c of cases) {
    const ans = await ask(c.question);
    const lower = ans.toLowerCase();
    const probs: string[] = [];
    if (c.expectIncludesAnyOf && !c.expectIncludesAnyOf.some(s => lower.includes(s.toLowerCase()))) {
      probs.push(`expected one of: ${c.expectIncludesAnyOf.join(" | ")}`);
    }
    if (c.expectExcludesAllOf && c.expectExcludesAllOf.some(s => lower.includes(s.toLowerCase()))) {
      probs.push(`unexpectedly contained: ${c.expectExcludesAllOf.join(", ")}`);
    }
    if (typeof c.expectCitesAtLeast === "number") {
      const cites = (ans.match(/\]\(\/[^)]+#[^)]+\)/g) || []).length;
      if (cites < c.expectCitesAtLeast) probs.push(`expected >=${c.expectCitesAtLeast} citations, got ${cites}`);
    }
    if (probs.length) {
      fails++;
      console.error(`FAIL  ${c.name}\n  ${probs.join("\n  ")}\n  --- answer ---\n  ${ans.slice(0, 400)}\n`);
    } else {
      console.log(`PASS  ${c.name}`);
    }
  }
  process.exit(fails === 0 ? 0 : 1);
})();
