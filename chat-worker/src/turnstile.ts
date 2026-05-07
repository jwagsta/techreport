const ENDPOINT = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export async function verifyTurnstile(token: string, secret: string, ip: string): Promise<boolean> {
  try {
    const body = new URLSearchParams({ secret, response: token, remoteip: ip });
    const res = await fetch(ENDPOINT, { method: "POST", body });
    if (!res.ok) return false;
    const j = (await res.json()) as { success: boolean };
    return j.success === true;
  } catch {
    return false;
  }
}
