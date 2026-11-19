# Providers

PixelBridge calls providers with your own key. **One key is enough:** a Google Gemini API key
(`GEMINI_API_KEY`, created in Google AI Studio) covers image generation, image editing and video
generation. 3D models are built locally in Blender and need no key.

| Capability                          | Provider                                    | Key              |
| ----------------------------------- | ------------------------------------------- | ---------------- |
| Images: generate, edit, turnarounds | Gemini API (default) or OpenAI (optional)   | `GEMINI_API_KEY` |
| Video                               | Gemini API                                  | `GEMINI_API_KEY` |
| 3D models                           | Local Blender                               | none             |
| Image-to-3D reconstruction          | not offered (no single-key provider has it) | —                |

`get_status` reports what is configured. Tools only offer what a configured provider supports;
for example, `generate_3d_from_image` is not listed when only the Gemini API is configured.

## Gemini API (default)

- Key: `GEMINI_API_KEY` (`GOOGLE_API_KEY` is accepted as an alias). Paid tier required: the
  image and video models have no free tier.
- Endpoint: `POST https://generativelanguage.googleapis.com/v1beta/interactions` (Interactions
  API) with headers `x-goog-api-key` and `Api-Revision` (`providers.gemini.apiRevision`, default
  `2026-05-20`). The key is only ever sent to `generativelanguage.googleapis.com`.

### Images

- Default model `gemini-nano-banana-2.1` (Nano Banana 2.1). Also priced:
  `gemini-3.1-flash-image`, `gemini-3.1-flash-lite-image`, `gemini-3-pro-image`.
  (Imagen has been shut down by Google.)
- PixelBridge's `size` (`WxH`) is mapped to the nearest supported aspect ratio
  (1:1, 1:4, 1:8, 2:3, 3:2, 3:4, 4:1, 4:3, 4:5, 5:4, 8:1, 9:16, 16:9, 21:9) and a size tier
  (1K/2K/4K). The tier is chosen from the requested long side, with 25% headroom; `quality: high`
  means at least 2K. Example: `1024x1536` → 2:3 at 1K = 848×1264 px.
- Edits: up to 14 reference images (Nano Banana 2.1: up to 10 objects + 4 characters). Edits are
  prompt-driven; masks are not supported.
- Not supported: transparent backgrounds, webp output, more than one image per call.
- Thinking is billed; PixelBridge sets `thinking_level: "minimal"` by default
  (`providers.gemini.imageThinkingLevel`).
- Image interactions are sent with `store: false`, so Google does not keep them for later turns.
- All generated images carry Google's SynthID watermark.

| Model                         | 1K      | 2K      | 4K     |
| ----------------------------- | ------- | ------- | ------ |
| `gemini-nano-banana-2.1`      | $0.0336 | $0.0504 | $0.113 |
| `gemini-3.1-flash-image`      | $0.067  | $0.101  | $0.151 |
| `gemini-3.1-flash-lite-image` | $0.0336 | —       | —      |
| `gemini-3-pro-image`          | $0.134  | $0.134  | $0.24  |

Estimates add prompt and reference-image input tokens (~1,120 tokens per image) and a
1,000-token thinking allowance, so they slightly overstate. A three-view character turnaround with
Nano Banana 2.1 at 1K is estimated at $0.13 (about $0.10 of that is image output).

### Video

- Default model `gemini-omni-1.2-flash` (Gemini Omni Flash), the model Google recommends for
  video. (Veo 3.1 preview models were shut down on 2026-10-22.)
- 3–15 s, whole seconds (default 8 s, `providers.gemini.defaultVideoSeconds`); resolution
  `360p`, `720p` (default), `1080p`, `4k` (the last two are upscaled); aspect `16:9` (default) or
  `9:16`; up to 6 reference images, which give character consistency and image-to-video.
- Native audio is included.
- Jobs are submitted with `background: true` and polled with `GET /interactions/{id}`. Job
  state is stored in the project database, so a server restart does not lose a paid job. Google
  keeps stored interactions for 55 days on the paid tier.
- If the API rejects background mode for the model (Google's docs do not confirm that Omni
  supports it), PixelBridge retries once synchronously. A rejected request is not billed.
  `generate_video` then blocks until the video is ready (up to
  `providers.gemini.videoSyncTimeoutMs`, default 15 minutes).
- Cancelling sends `POST /interactions/{id}/cancel`. Google does not document whether a
  cancelled generation is billed, so the reservation stays counted.

Pricing is $12 per 1M output video tokens. The approximate cost per second:

| Resolution | Tokens/s | ≈ $/s  | 8 s clip |
| ---------- | -------- | ------ | -------- |
| 360p       | 1,931    | $0.023 | $0.19    |
| 720p       | 5,792    | $0.070 | $0.56    |
| 1080p      | 8,688    | $0.104 | $0.83    |
| 4k         | 17,376   | $0.209 | $1.67    |

With the default approval threshold ($0.25), every 720p or higher video asks for approval first;
360p clips up to about 9 s do not.

### Actual cost

Each response's `usage` block is converted with the published per-token rates. If the response
does not break output tokens down by modality, all output is priced at the media rate, which gives
an upper bound.

## OpenAI (optional, images only)

If `OPENAI_API_KEY` is also set, OpenAI is available as a second image provider (`provider:
"openai"`); Gemini stays the default. OpenAI supports transparent backgrounds and masks, which
Gemini does not. It has no video. Default model `gpt-image-2`; prices are in
`src/providers/openai-pricing.ts`. Set `providers.openai.enabled: false` to ignore the key.

## Mock

`PIXELBRIDGE_MOCK=1` or `providers.mock.enabled`. It produces placeholder PNGs and placeholder
job files, and charges `providers.mock.costPerCallUsd` (default $0.01) to the ledger, so budget
behaviour is realistic. Outputs are tagged `mock: true`. The mock also supports a `3d` job kind
for testing.

## Prices change

Prices were transcribed from Google's and OpenAI's pricing pages on 2026-11-19
(`src/providers/gemini-pricing.ts`, `src/providers/openai-pricing.ts`). Models without a known
price are refused (`PRICE_UNKNOWN`) rather than guessed. Check your Google Cloud billing for
amounts actually charged, and set a budget alert there too.
