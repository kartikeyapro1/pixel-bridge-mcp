# Providers

PixelBridge calls providers with your own keys. Each provider reports its capabilities through
`get_status`; tools only offer what the configured provider supports.

## OpenAI — images

- Key: `OPENAI_API_KEY`. Endpoints: `POST /v1/images/generations`, `POST /v1/images/edits`.
- Default model `gpt-image-2`. Also accepted: `gpt-image-2.5-sunburst`, `gpt-image-2.5-flare`,
  `gpt-image-2.6-*`, `gpt-image-1.5`, `gpt-image-1-mini`, `chatgpt-image-latest`.
  (`gpt-image-1` was retired by OpenAI on 2026-10-23.)
- Sizes: `1024x1024`, `1536x1024`, `1024x1536`, `auto`; `gpt-image-2*` also accepts custom
  `WxH` (multiples of 16, aspect 1:3–3:1, max 3840×2160).
- Transparent background: supported on 2.5 models, preview on `gpt-image-2`; needs png/webp.
- Edits: up to 16 images (first is edited, others are references) and an optional mask.
  `inputFidelity` is sent only to models that accept it.
- Some models require OpenAI organisation verification; a 403 maps to `PROVIDER_AUTH`.

### Pricing

Estimates use OpenAI's published approximate per-image prices (transcribed 2026-11-19,
`src/providers/openai-pricing.ts`), e.g. `gpt-image-2`:

| Quality | 1024×1024 | 1024×1536 / 1536×1024 |
| ------- | --------- | --------------------- |
| low     | $0.006    | $0.005                |
| medium  | $0.053    | $0.041                |
| high    | $0.211    | $0.165                |

- `quality: auto` / `size: auto` are estimated at the most expensive matching option.
- Custom sizes scale the square price by area.
- Edits add an assumed 1,600 input tokens per reference image.
- Models without a published table (2.5/2.6 families) are estimated at 2× `gpt-image-2` and
  labelled "extrapolated".
- **Actual** cost is computed from the `usage` tokens in each response × published per-token
  rates and is what the ledger keeps.

Override or add prices:

```json
{ "imagePricingOverrides": { "gpt-image-2.5-flare": { "medium:1024x1024": 0.06, "high:1024x1024": 0.25 } } }
```

## fal.ai — video and image-to-3D

- Key: `FAL_KEY`. Queue API: `POST https://queue.fal.run/{model}`, then the returned
  `status_url`, `response_url`, `cancel_url`.
- One adapter for all fal models. Because model input schemas differ, each model is configured:

```json
{
  "providers": {
    "fal": {
      "defaultVideoModel": "fal-ai/kling-video/v2.5-turbo/pro/image-to-video",
      "default3dModel": "<fal 3D endpoint id>",
      "models": {
        "fal-ai/kling-video/v2.5-turbo/pro/image-to-video": {
          "kind": "video",
          "pricing": { "perSecondUsd": 0.07 },
          "fields": { "prompt": "prompt", "image": "image_url", "duration": "duration" },
          "durationFormat": "string",
          "allowedDurations": [5, 10],
          "defaults": {}
        },
        "<fal 3D endpoint id>": {
          "kind": "3d",
          "pricing": { "perRequestUsd": 0.0 },
          "fields": { "prompt": "prompt", "image": "image_url" }
        }
      }
    }
  }
}
```

- **No prices ship with PixelBridge for fal.** Jobs for a model without `pricing` are refused
  with `PRICE_UNKNOWN`. Copy the price from the model's page on fal.ai and re-check it
  periodically. The figure above is an example only.
- `durationFormat`: `"string"` → `"5"`, `"number"` → `5`, `"seconds-suffix"` → `"5s"`.
- Images are sent inline as base64 data URIs.
- Outputs: every `{url: …}` in the result is collected; video jobs keep mp4/webm/mov (+ images as
  thumbnails), 3D jobs keep glb/gltf/obj/fbx/usdz/zip. If a model returns something else, the job
  fails with `PROVIDER_BAD_RESPONSE` rather than guessing.
- Cancellation: `200` (removed from queue) releases the reservation; `202` (already running)
  only requests cancellation, so the job may still be billed.
- Failed jobs keep their reservation as "unknown" because PixelBridge cannot confirm whether the
  provider billed them.

### Why not OpenAI for video?

OpenAI's Sora 2 Videos API was shut down on 2026-09-24. A provider adapter for another direct
API (for example Google's Gemini/Veo API) can be added behind the same `JobProvider` interface.

## Mock

`PIXELBRIDGE_MOCK=1` or `providers.mock.enabled`. Produces placeholder PNGs, placeholder job
files, and charges `providers.mock.costPerCallUsd` (default $0.01) to the ledger so budget
behaviour is realistic. Outputs are tagged `mock: true`.
