import { describe, it, expect } from "vitest";
import worker from "../src/index";

describe("worker smoke", () => {
  it("responds to a request", async () => {
    const env = {} as any;
    const ctx = {} as any;
    const res = await worker.fetch(new Request("http://localhost/"), env, ctx);
    expect(res.status).toBe(501);
  });
});
