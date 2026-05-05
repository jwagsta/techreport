export function corsHeaders(origin: string, allowed: string): Record<string, string> {
  const allow = origin === allowed ? origin : "";
  return {
    "access-control-allow-origin": allow,
    "access-control-allow-methods": "POST, GET, OPTIONS",
    "access-control-allow-headers": "content-type, x-session-token",
    "access-control-max-age": "86400",
    "vary": "origin",
  };
}

export function preflight(req: Request, allowed: string): Response | null {
  if (req.method !== "OPTIONS") return null;
  return new Response(null, { status: 204, headers: corsHeaders(req.headers.get("origin") ?? "", allowed) });
}
