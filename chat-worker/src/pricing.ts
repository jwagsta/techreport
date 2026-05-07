// Anthropic Sonnet 4.6 pricing (USD per 1M tokens).
// Update if pricing changes. Source: https://www.anthropic.com/pricing
const PRICE = {
  inputUncached: 3.0,
  cacheWrite: 3.75,    // 1.25x input
  cacheRead: 0.30,     // 0.10x input
  output: 15.0,
} as const;

export interface Usage {
  input_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens: number;
}

export function computeCostUsd(u: Usage): number {
  const m = 1_000_000;
  return (
    (u.input_tokens * PRICE.inputUncached) / m +
    ((u.cache_creation_input_tokens ?? 0) * PRICE.cacheWrite) / m +
    ((u.cache_read_input_tokens ?? 0) * PRICE.cacheRead) / m +
    (u.output_tokens * PRICE.output) / m
  );
}
