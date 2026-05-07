// Minimal HS256-style signed token: base64url(header).base64url(payload).base64url(hmac).
// Avoids pulling in a JWT lib for ~30 lines of code.

const enc = new TextEncoder();

function b64url(bytes: Uint8Array | string): string {
  const b = typeof bytes === "string" ? enc.encode(bytes) : bytes;
  let s = btoa(String.fromCharCode(...b));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

async function hmac(key: string, data: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    "raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]
  );
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(data));
  return new Uint8Array(sig);
}

export interface SessionPayload { ip: string; exp: number; }

export async function signSession(
  data: { ip: string },
  key: string,
  ttlSec: number,
): Promise<string> {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload: SessionPayload = { ip: data.ip, exp: Date.now() + ttlSec * 1000 };
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(await hmac(key, `${header}.${body}`));
  return `${header}.${body}.${sig}`;
}

export async function verifySession(token: string, key: string): Promise<SessionPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, b, s] = parts as [string, string, string];
  const expected = b64url(await hmac(key, `${h}.${b}`));
  if (expected !== s) return null;
  let payload: SessionPayload;
  try { payload = JSON.parse(new TextDecoder().decode(b64urlDecode(b))); }
  catch { return null; }
  if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
  return payload;
}
