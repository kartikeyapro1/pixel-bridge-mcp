/**
 * OpenAI image pricing, transcribed from developers.openai.com (pricing page and
 * image-generation guide) on 2026-11-19. Prices change: users can override any entry
 * via `imagePricingOverrides` in pixelbridge.config.json.
 */

export const PRICING_SOURCE_DATE = '2026-11-19';

/** Approximate output cost per image, keyed "quality:WxH". */
export const PER_IMAGE_USD: Record<string, Record<string, number>> = {
  'gpt-image-2': {
    'low:1024x1024': 0.006,
    'low:1024x1536': 0.005,
    'low:1536x1024': 0.005,
    'medium:1024x1024': 0.053,
    'medium:1024x1536': 0.041,
    'medium:1536x1024': 0.041,
    'high:1024x1024': 0.211,
    'high:1024x1536': 0.165,
    'high:1536x1024': 0.165,
  },
  'gpt-image-1.5': {
    'low:1024x1024': 0.009,
    'low:1024x1536': 0.013,
    'low:1536x1024': 0.013,
    'medium:1024x1024': 0.034,
    'medium:1024x1536': 0.05,
    'medium:1536x1024': 0.05,
    'high:1024x1024': 0.133,
    'high:1024x1536': 0.2,
    'high:1536x1024': 0.2,
  },
  'gpt-image-1-mini': {
    'low:1024x1024': 0.005,
    'low:1024x1536': 0.006,
    'low:1536x1024': 0.006,
    'medium:1024x1024': 0.011,
    'medium:1024x1536': 0.015,
    'medium:1536x1024': 0.015,
    'high:1024x1024': 0.036,
    'high:1024x1536': 0.052,
    'high:1536x1024': 0.052,
  },
};

/** Per-1M-token rates used to compute actual cost from the response `usage` block. */
export const TOKEN_RATES_PER_M: Record<string, { imageIn: number; imageOut: number; textIn: number }> = {
  'gpt-image-2.6-sunburst': { imageIn: 8, imageOut: 30, textIn: 5 },
  'gpt-image-2.6-flare': { imageIn: 8, imageOut: 30, textIn: 5 },
  'gpt-image-2.5-sunburst': { imageIn: 8, imageOut: 30, textIn: 5 },
  'gpt-image-2.5-flare': { imageIn: 8, imageOut: 30, textIn: 5 },
  'gpt-image-2': { imageIn: 8, imageOut: 30, textIn: 5 },
  'gpt-image-1.5': { imageIn: 8, imageOut: 32, textIn: 5 },
  'gpt-image-1-mini': { imageIn: 2.5, imageOut: 8, textIn: 2 },
  'chatgpt-image-latest': { imageIn: 8, imageOut: 32, textIn: 5 },
};

/**
 * Models with token rates but no published per-image table. Their estimates are
 * extrapolated from gpt-image-2 (same per-token rates) with a safety multiplier,
 * because output token counts per size are not published.
 */
export const EXTRAPOLATE_FROM: Record<string, { base: string; multiplier: number }> = {
  'gpt-image-2.6-sunburst': { base: 'gpt-image-2', multiplier: 2 },
  'gpt-image-2.6-flare': { base: 'gpt-image-2', multiplier: 2 },
  'gpt-image-2.5-sunburst': { base: 'gpt-image-2', multiplier: 2 },
  'gpt-image-2.5-flare': { base: 'gpt-image-2', multiplier: 2 },
  'chatgpt-image-latest': { base: 'gpt-image-1.5', multiplier: 1.5 },
};

/** Model families that accept `input_fidelity` on edits. gpt-image-2 must omit it. */
export const INPUT_FIDELITY_MODELS = new Set(['gpt-image-1.5', 'gpt-image-1-mini', 'chatgpt-image-latest']);

/** Models documented as accepting arbitrary WxH sizes (multiples of 16, ≤3840x2160). */
export const CUSTOM_SIZE_PREFIXES = ['gpt-image-2'];

/** Assumed tokens per input reference image when estimating edits (not published; conservative). */
export const ASSUMED_INPUT_IMAGE_TOKENS = 1600;

/** Normalise model snapshot names (e.g. gpt-image-2-2026-04-21 → gpt-image-2). */
export function baseModel(model: string): string {
  return model.replace(/-\d{4}-\d{2}-\d{2}$/, '');
}
