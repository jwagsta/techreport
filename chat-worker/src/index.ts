import { handle } from "./handler";

export interface Env {
  RATE_KV: KVNamespace;
  ANTHROPIC_API_KEY: string;
  TURNSTILE_SECRET_KEY: string;
  ADMIN_TOKEN: string;
  SESSION_SIGNING_KEY: string;
  ALLOWED_ORIGIN: string;
  DAILY_USD_CEILING: string;
  DAILY_PER_IP_LIMIT: string;
  PER_MINUTE_PER_IP_LIMIT: string;
  MAX_OUTPUT_TOKENS: string;
  MAX_HISTORY_TURNS: string;
  TURNSTILE_SITE_KEY: string;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    return handle(req, env);
  },
};
