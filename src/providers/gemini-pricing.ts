/**
 * Gemini API pricing, transcribed from aistudio.google.com/docs/pricing (paid tier,
 * standard) on 2026-11-19. Override via `providers.gemini.pricingOverrides`.
 */

export const GEMINI_PRICING_SOURCE_DATE = '2026-11-19';

export type ImageTier = '0.5K' | '1K' | '2K' | '4K';

export interface GeminiImageModelPricing {
  /** Output price per image by size tier. */
  perImage: Partial<Record<ImageTier, number>>;
  /** Input (text/image) per 1M tokens. */
  inputPerM: number;
  /** Text + thinking output per 1M tokens. */
  textOutPerM: number;
  /** Image output per 1M tokens. */
  imageOutPerM: number;
  tiers: ImageTier[];
  maxReferenceImages: number;
}

export const GEMINI_IMAGE_PRICING: Record<string, GeminiImageModelPricing> = {
  'gemini-nano-banana-2.1': {
    perImage: { '1K': 0.0336, '2K': 0.0504, '4K': 0.113 },
    inputPerM: 1.5,
    textOutPerM: 7.5,
    imageOutPerM: 30,
    tiers: ['1K', '2K', '4K'],
    maxReferenceImages: 14,
  },
  'gemini-3.1-flash-image': {
    perImage: { '0.5K': 0.045, '1K': 0.067, '2K': 0.101, '4K': 0.151 },
    inputPerM: 0.5,
    textOutPerM: 3,
    imageOutPerM: 60,
    tiers: ['0.5K', '1K', '2K', '4K'],
    maxReferenceImages: 14,
  },
  'gemini-3.1-flash-lite-image': {
    perImage: { '1K': 0.0336 },
    inputPerM: 0.25,
    textOutPerM: 1.5,
    imageOutPerM: 30,
    tiers: ['1K'],
    maxReferenceImages: 4,
  },
  'gemini-3-pro-image': {
    perImage: { '1K': 0.134, '2K': 0.134, '4K': 0.24 },
    inputPerM: 2,
    textOutPerM: 12,
    imageOutPerM: 120,
    tiers: ['1K', '2K', '4K'],
    maxReferenceImages: 14,
  },
};

/** Aspect ratios accepted by the Nano Banana 2.x / 3.1 Flash image models. */
export const GEMINI_ASPECT_RATIOS = [
  '1:1',
  '1:4',
  '1:8',
  '2:3',
  '3:2',
  '3:4',
  '4:1',
  '4:3',
  '4:5',
  '5:4',
  '8:1',
  '9:16',
  '16:9',
  '21:9',
] as const;

/** Long-side pixel length of each tier (from the 1:1 row of the published table). */
export const TIER_LONG_SIDE: Record<ImageTier, number> = { '0.5K': 512, '1K': 1376, '2K': 2752, '4K': 5504 };

/** Approximate input tokens per reference image (published 1K image token count). */
export const INPUT_TOKENS_PER_IMAGE = 1120;
/** Allowance for thinking/text output tokens on image calls (thinking runs at "minimal"). */
export const IMAGE_THINKING_ALLOWANCE_TOKENS = 1000;

export interface GeminiVideoModelPricing {
  inputPerM: number;
  textOutPerM: number;
  videoOutPerM: number;
  /** Output video tokens per second, by resolution. */
  tokensPerSecond: Record<VideoResolution, number>;
  minSeconds: number;
  maxSeconds: number;
  maxReferenceImages: number;
}

export type VideoResolution = '360p' | '720p' | '1080p' | '4k';

export const GEMINI_VIDEO_PRICING: Record<string, GeminiVideoModelPricing> = {
  'gemini-omni-1.2-flash': {
    inputPerM: 1.5,
    textOutPerM: 9,
    videoOutPerM: 12,
    tokensPerSecond: { '360p': 1931, '720p': 5792, '1080p': 8688, '4k': 17376 },
    minSeconds: 3,
    maxSeconds: 15,
    maxReferenceImages: 6,
  },
};

/** Allowance for thinking/text output tokens on video calls. */
export const VIDEO_THINKING_ALLOWANCE_TOKENS = 2000;
