import { describe, it, expect } from "vitest";
import worker from "../src/index";

describe("worker smoke", () => {
  it("/healthz returns ok", async () => {
    const env = {} as any;
    const res = await worker.fetch(new Request("https://w/healthz"), env, {} as any);
    expect(res.status).toBe(200);
    const j = await res.json() as any;
    expect(j.ok).toBe(true);
  });
});
