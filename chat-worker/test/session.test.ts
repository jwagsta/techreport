import { describe, it, expect } from "vitest";
import { signSession, verifySession } from "../src/session";

describe("session", () => {
  const key = "test-secret-key-32-bytes-long-enough";

  it("round-trips a session token", async () => {
    const tok = await signSession({ ip: "1.1.1.1" }, key, 60);
    const v = await verifySession(tok, key);
    expect(v?.ip).toBe("1.1.1.1");
  });

  it("rejects an expired token", async () => {
    const tok = await signSession({ ip: "1.1.1.1" }, key, -1);
    expect(await verifySession(tok, key)).toBeNull();
  });

  it("rejects a tampered token", async () => {
    const tok = await signSession({ ip: "1.1.1.1" }, key, 60);
    const parts = tok.split(".");
    const tampered = parts[0] + "." + btoa(JSON.stringify({ ip: "9.9.9.9", exp: Date.now() + 60_000 })) + "." + parts[2];
    expect(await verifySession(tampered, key)).toBeNull();
  });

  it("rejects with the wrong key", async () => {
    const tok = await signSession({ ip: "1.1.1.1" }, key, 60);
    expect(await verifySession(tok, "different-key-32-bytes-long-enough!")).toBeNull();
  });
});
