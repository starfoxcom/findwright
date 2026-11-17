// What a model turn costs, from Anthropic's published per-token prices (USD per million tokens,
// first-party API rates). Cache writes cost 1.25 times the input price for the 5-minute cache and
// 2 times for the 1-hour cache; cache reads have their own price per model.

const PRICES = {
  "claude-fable-5-2": { input: 8, output: 40, read: 0.2 },
  "claude-mythos-5-2": { input: 8, output: 40, read: 0.2 },
  "claude-fable-5-1": { input: 10, output: 50, read: 0.25 },
  "claude-mythos-5-1": { input: 10, output: 50, read: 0.25 },
  "claude-fable-5": { input: 10, output: 50, read: 1 },
  "claude-mythos-5": { input: 10, output: 50, read: 1 },
  "claude-opus-5-5": { input: 4, output: 20, read: 0.2 },
  "claude-opus-5": { input: 5, output: 25, read: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, read: 0.5 },
  "claude-opus-4-7": { input: 5, output: 25, read: 0.5 },
  "claude-opus-4-6": { input: 5, output: 25, read: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, read: 0.1 },
  "claude-sonnet-5": { input: 2, output: 10, read: 0.2 },
  "claude-sonnet-4-6": { input: 3, output: 15, read: 0.3 },
  // Claude Haiku 5.5 costs more once a prompt passes 100K tokens.
  "claude-haiku-5-5": {
    input: 0.1, output: 0.5, read: 0.01,
    long: { above: 100_000, input: 0.5, output: 2.5, read: 0.05 },
  },
  "claude-haiku-4-5": { input: 1, output: 5, read: 0.1 },
};

// Fast mode runs the same model at twice its standard price.
const FAST = 2;

/**
 * The price entry for a model id, or null for a model the table does not list. The id may carry
 * a dated snapshot ("-20261001") or a context note ("[1m]"); anything else must match exactly, so
 * a newer release is never priced at an older model's rate.
 */
export function priceOf(model) {
  const id = String(model ?? "").replace(/\[[^\]]*\]$/, "").replace(/-\d{8}$/, "");
  return Object.hasOwn(PRICES, id) ? PRICES[id] : null;
}

// No model call holds more than a 1M-token context and its output, so a count past this is not a
// real turn; capping it keeps every sum and price finite.
const MOST_TOKENS_IN_A_TURN = 10_000_000;
const amount = (value) => (Number.isFinite(value) && value > 0 ? Math.min(value, MOST_TOKENS_IN_A_TURN) : 0);

/** A turn's tokens by price class: `{ input, write5m, write1h, read, output }`, each capped. */
export function tokensOf(usage) {
  const writes = usage?.cache_creation ?? {};
  const write1h = amount(writes.ephemeral_1h_input_tokens);
  const write5m = writes.ephemeral_5m_input_tokens === undefined
    ? amount(amount(usage?.cache_creation_input_tokens) - write1h)
    : amount(writes.ephemeral_5m_input_tokens);
  return {
    input: amount(usage?.input_tokens),
    write5m,
    write1h,
    read: amount(usage?.cache_read_input_tokens),
    output: amount(usage?.output_tokens),
  };
}

export const promptSize = (t) => t.input + t.write5m + t.write1h + t.read;

/** What `tokens` cost on `model`, in dollars; null for a model with no known price. */
export function costOf(model, tokens, { fast = false } = {}) {
  const base = priceOf(model);
  if (!base) return null;
  const rate = base.long && promptSize(tokens) > base.long.above ? base.long : base;
  const perMillion = tokens.input * rate.input
    + tokens.write5m * rate.input * 1.25
    + tokens.write1h * rate.input * 2
    + tokens.read * rate.read
    + tokens.output * rate.output;
  return (perMillion / 1e6) * (fast ? FAST : 1);
}
