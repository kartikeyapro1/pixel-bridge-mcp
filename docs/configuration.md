# Configuration

Settings live in `pixelbridge.config.json` in the project root (`pixelbridge init` writes a
starter file). Every field is optional. Unknown fields are ignored, and invalid values stop the
server with a message naming the field. API keys never go in this file (see
[credentials.md](credentials.md)).

## Example

```json
{
  "budget": { "projectLimitUsd": 10, "approvalThresholdUsd": 0.5 },
  "providers": {
    "gemini": { "defaultVideoSeconds": 5 },
    "openai": { "enabled": false }
  },
  "pipeline": { "maxModelVersions": 8 }
}
```

## Reference

### General

| Key                | Default              | Description                                                                           |
| ------------------ | -------------------- | ------------------------------------------------------------------------------------- |
| `projectId`        | folder name          | Identifier recorded in manifests.                                                     |
| `assetsDir`        | `"assets"`           | Where generated files go, relative to the project root. Must stay inside the project. |
| `logLevel`         | `"info"`             | `debug`, `info`, `warn` or `error`. Logs go to stderr.                                |
| `maxDownloadBytes` | `524288000` (500 MB) | Largest provider output that will be downloaded.                                      |

### `budget`

| Key                     | Default | Description                                                                                                 |
| ----------------------- | ------- | ----------------------------------------------------------------------------------------------------------- |
| `projectLimitUsd`       | `5`     | Hard cap on recorded spend for this project (actual cost where known, estimates otherwise).                 |
| `providerLimitsUsd`     | `{}`    | Per-provider hard caps, e.g. `{ "gemini": 3 }`.                                                             |
| `approvalThresholdUsd`  | `0.25`  | Calls estimated above this need `confirmCostUsd` (MCP) or `--yes` (CLI).                                    |
| `maxCostPerCallUsd`     | `2`     | No single call may be estimated above this. It cannot be overridden from a tool call.                       |
| `maxGenerationsPerDay`  | `100`   | Paid calls per rolling 24 hours.                                                                            |
| `maxInFlight`           | `3`     | Paid requests (and running video jobs) at once, across all processes.                                       |
| `reservationTtlMinutes` | `30`    | A reservation still open after this long counts as "outcome unknown" and keeps counting against the budget. |

Spending is tracked in `.pixelbridge/pixelbridge.db`. Raising a limit takes effect on the next
server start. Use `get_budget` / `pixelbridge budget` to see the ledger.

### `providers.gemini`

| Key                      | Default                    | Description                                                                      |
| ------------------------ | -------------------------- | -------------------------------------------------------------------------------- |
| `enabled`                | `true`                     | Ignore the Gemini key if `false`.                                                |
| `imageModel`             | `"gemini-nano-banana-2.1"` | Default image model. Priced models: see [providers.md](providers.md).            |
| `videoModel`             | `"gemini-omni-1.2-flash"`  | Default video model.                                                             |
| `defaultVideoSeconds`    | `8`                        | Video length when none is requested (3-15).                                      |
| `imageThinkingLevel`     | `"minimal"`                | `minimal`, `medium` or `high`. Thinking tokens are billed.                       |
| `storeImageInteractions` | `false`                    | Whether Google keeps image requests server-side.                                 |
| `timeoutMs`              | `240000`                   | Per-request timeout.                                                             |
| `videoSyncTimeoutMs`     | `900000`                   | Only used if background video jobs are rejected and the call runs synchronously. |
| `maxRetries`             | `2`                        | Retries on rate limits and server errors (never after a timed-out paid request). |
| `apiRevision`            | `"2026-05-20"`             | `Api-Revision` header sent to the Interactions API.                              |
| `baseUrl`                | Google endpoint            | Must point at `generativelanguage.googleapis.com` (checked at startup).          |

### `providers.openai` (optional image provider)

| Key                                  | Default         | Description                                                                   |
| ------------------------------------ | --------------- | ----------------------------------------------------------------------------- |
| `enabled`                            | `true`          | Used only if an OpenAI key is available. Gemini stays the default either way. |
| `defaultModel`                       | `"gpt-image-2"` |                                                                               |
| `moderation`                         | (unset)         | `auto` or `low`.                                                              |
| `timeoutMs`, `maxRetries`, `baseUrl` |                 | As for Gemini.                                                                |

`imagePricingOverrides` sets per-image prices for OpenAI models, keyed by model and then
`"quality:WxH"`, e.g. `{ "gpt-image-2": { "medium:1024x1024": 0.05 } }`.

### `providers.mock`

| Key              | Default | Description                                                         |
| ---------------- | ------- | ------------------------------------------------------------------- |
| `enabled`        | `false` | Offline placeholder provider. `PIXELBRIDGE_MOCK=1` also enables it. |
| `costPerCallUsd` | `0.01`  | Fake cost recorded per call.                                        |

### `blender`

| Key         | Default     | Description                                    |
| ----------- | ----------- | ---------------------------------------------- |
| `path`      | auto-detect | Blender executable. `BLENDER_PATH` also works. |
| `timeoutMs` | `300000`    | Per-operation timeout.                         |

### `pipeline`

| Key                | Default | Description                                                                                    |
| ------------------ | ------- | ---------------------------------------------------------------------------------------------- |
| `maxModelVersions` | `12`    | Model versions per collection before builds are refused, which stops endless refinement loops. |

### `roblox`

| Key                   | Default | Description                                 |
| --------------------- | ------- | ------------------------------------------- |
| `maxTrianglesPerMesh` | `20000` | Per-mesh triangle limit used by validation. |
| `maxPartSizeStuds`    | `2048`  | Largest allowed dimension.                  |
| `metersPerStud`       | `0.28`  | Conversion used to report sizes in studs.   |
| `maxTextureSize`      | `1024`  | Reserved; textures are not checked yet.     |

## Environment variables

| Variable                            | Purpose                                        |
| ----------------------------------- | ---------------------------------------------- |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | Gemini key (overrides the stored key)          |
| `OPENAI_API_KEY`                    | OpenAI key (overrides the stored key)          |
| `PIXELBRIDGE_PROJECT_ROOT`          | Project directory (default: current directory) |
| `PIXELBRIDGE_MOCK=1`                | Enable the mock provider                       |
| `PIXELBRIDGE_CREDENTIALS_DIR`       | Windows only: where encrypted keys are stored  |
| `BLENDER_PATH`                      | Blender executable                             |
