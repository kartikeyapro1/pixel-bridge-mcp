# PixelBridge

A local-first MCP server and CLI that lets AI coding agents (Claude Code, Cursor and other MCP
clients) produce game assets: reference images, videos and Blender 3D models. Generation runs
under spending limits, and every file is cached, versioned, recorded with how it was made, and
checked against the target engine before you import it.

```
"Make an original chibi cat character for my Roblox game: reference views, a Blender model,
 previews, and a glb I can import."

  generate_character_turnaround  →  references/pip-front.png, pip-side.png, pip-back.png
  build_blender_model            →  blender/pip-spec-v001.json, pip-v001.blend (+ reference planes)
  render_model_previews          →  renders/v001/front.png … (returned to the agent as images)
  build_blender_model (revised)  →  pip-v002.blend   (agent compared renders with references)
  export_3d_asset                →  exports/pip-v002.glb  + Roblox pre-import report
```

> **Status: 0.1.0, pre-release.** Repository is private. Tested on Windows 11 with Node 24 and
> Blender 5.3. Image and video providers are tested against their HTTP APIs with mocks; no live
> paid generation has been run yet. See [Known limitations](#known-limitations).

## Why

Asking an agent to "call an image API" or "run Blender" is easy, and many MCP servers already do
that. The harder part is letting an agent run the pipeline **unattended**:

- **It must not spend money unpredictably.** Each paid call is quoted first. Calls above a
  threshold need explicit approval, and a project budget is enforced in a transaction, so
  concurrent agents cannot overspend it. Identical requests are served from cache.
- **It must be reproducible.** Every file is registered with its prompt, model, parameters,
  references, hash, cost and parent version. Blender models are JSON specs, not opaque scripts.
- **It must be safe.** No tool executes agent-supplied code. All reads and writes are confined to
  the project directory (symlink escapes are checked). Credentials never appear in output.
- **It must fit the target engine.** Exports are re-imported in a clean Blender scene and checked
  against a Roblox profile (triangle cap, size in studs, materials, UVs, rig).

See [docs/product-assessment.md](docs/product-assessment.md) for the competitive landscape and
[docs/decisions.md](docs/decisions.md) for the design decisions.

## What works today

| Capability                                                                                                                                    | Status                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Blender: build model from spec, reference planes, previews (Workbench/EEVEE/Cycles), inspect, export glb/gltf/fbx/obj, re-import verification | Working, tested against Blender 5.3                                        |
| Roblox pre-import validation                                                                                                                  | Working (conservative, configurable limits)                                |
| Asset registry, manifests, versioning, request cache                                                                                          | Working                                                                    |
| Budget ledger, approvals, concurrency limits (cross-process)                                                                                  | Working, tested with 8 concurrent processes                                |
| OpenAI images: generate, edit / multi-reference, character turnarounds                                                                        | Implemented; tested with mocked HTTP; **not yet run with a live key**      |
| Video (fal.ai queue): submit, poll, download, cancel, restart-safe jobs                                                                       | Implemented; tested with mocked HTTP; **no built-in prices**; not run live |
| Image-to-3D (fal.ai queue)                                                                                                                    | Same job system as video; output schema detection is heuristic             |
| MCP server (18 tools, stdio) and CLI                                                                                                          | Working                                                                    |

## Requirements

- Node.js ≥ 22.15 (uses the built-in `node:sqlite`)
- Blender ≥ 4.2 for 3D tools (verified on 5.3.0; 4.2–5.2 accepted but untested)
- Optional: `OPENAI_API_KEY` for images, `FAL_KEY` for video / image-to-3D

## Install

The package is not yet published to npm. From a clone:

```bash
git clone <repo-url> pixelbridge && cd pixelbridge
npm ci
npm run build
```

## Connect to Claude Code

Add the server to the project you want assets in. `.mcp.json` in that project:

```json
{
  "mcpServers": {
    "pixelbridge": {
      "command": "node",
      "args": ["/absolute/path/to/pixelbridge/dist/mcp-entry.js"],
      "env": {
        "PIXELBRIDGE_PROJECT_ROOT": "/absolute/path/to/your/game",
        "OPENAI_API_KEY": "${OPENAI_API_KEY}",
        "FAL_KEY": "${FAL_KEY}"
      }
    }
  }
}
```

Or with the CLI:

```bash
claude mcp add pixelbridge --scope project \
  -e PIXELBRIDGE_PROJECT_ROOT="$PWD" -e OPENAI_API_KEY="$OPENAI_API_KEY" \
  -- node /absolute/path/to/pixelbridge/dist/mcp-entry.js
```

Keep keys in your shell environment, not in committed files. Then, in your project:

```bash
node /path/to/pixelbridge/dist/cli.js init     # writes pixelbridge.config.json
echo ".pixelbridge/" >> .gitignore              # local database, temp files, thumbnails
```

Ask the agent to call `get_status` first; it reports what is configured and what is missing.

**Try it without any API key:** set `PIXELBRIDGE_MOCK=1` (or `providers.mock.enabled: true`).
The mock provider produces placeholder PNGs and fake job outputs at a fake $0.01 per call, so the
whole pipeline, including budgets and Blender, can be exercised offline. Mock outputs are
labelled `mock: true` in metadata.

## MCP tools

| Tool                                 | Purpose                                                                         | Cost  |
| ------------------------------------ | ------------------------------------------------------------------------------- | ----- |
| `get_status`                         | Providers, capabilities, Blender detection, budget, missing setup               | free  |
| `get_budget`                         | Spend summary and recent ledger entries                                         | free  |
| `generate_image`                     | Text-to-image                                                                   | paid  |
| `edit_image`                         | Edit / reference-conditioned generation (up to 16 images, optional mask)        | paid  |
| `generate_character_turnaround`      | Front view, then side/back/¾ conditioned on the front; quoted as one total      | paid  |
| `list_assets`, `get_asset`           | Registry queries; `get_asset` can return the image                              | free  |
| `generate_video`                     | Async text/image-to-video job                                                   | paid  |
| `generate_3d_from_image`             | Async image-to-3D job                                                           | paid  |
| `get_job`, `list_jobs`, `cancel_job` | Poll, download, cancel (state survives restarts)                                | free  |
| `get_model_spec_guide`               | Schema and conventions for model specs                                          | free  |
| `build_blender_model`                | Spec → new `.blend` version (+ optional reference planes), stats, Roblox report | local |
| `render_model_previews`              | Renders + reference thumbnails returned as images                               | local |
| `inspect_3d_asset`                   | Triangles, materials, bounds, UVs, non-manifold edges, armatures                | local |
| `validate_3d_asset`                  | Engine profile check (Roblox)                                                   | local |
| `export_3d_asset`                    | glb/gltf/fbx/obj export, verified by re-import                                  | local |

Every paid tool accepts `dryRun` (quote only), `bypassCache`, and `confirmCostUsd`.

### The approval protocol

```
agent → generate_character_turnaround {...}
      ← error APPROVAL_REQUIRED: estimated $0.52 (3 views, high quality, 1024x1536),
        hint: "Show the user this estimate ... call again with confirmCostUsd: 0.52"
agent → (asks the user) → generate_character_turnaround {..., confirmCostUsd: 0.52}
```

The threshold relies on the agent asking a human. The **hard guarantees** are
`budget.projectLimitUsd`, `budget.maxCostPerCallUsd`, `budget.maxGenerationsPerDay` and
`budget.maxInFlight`, which no tool argument can override.

## CLI

The CLI uses the same services as the MCP server.

```bash
pixelbridge status
pixelbridge image "isometric wooden crate, game prop" -c crate --quality low --dry-run
pixelbridge image "isometric wooden crate, game prop" -c crate --quality low --yes
pixelbridge turnaround "an original orange chibi cat" -c pip --style "soft cartoon" --yes
pixelbridge build examples/specs/cartoon-cat.json -c pip --ref front=ast_… --ref side=ast_…
pixelbridge render ast_… --views front,side,three_quarter
pixelbridge export ast_… --formats glb,fbx
pixelbridge validate assets/characters/pip/exports/pip-v001.glb
pixelbridge assets -c pip | pixelbridge budget | pixelbridge jobs
```

(`pixelbridge` = `node dist/cli.js` until the package is published.) Paid commands print an
`APPROVAL_REQUIRED` error with the estimate unless `--yes` is passed. Exit code 3 means approval
needed.

## Project layout produced

```
your-game/
├── pixelbridge.config.json
├── .pixelbridge/                 # SQLite registry/ledger/jobs, temp files, thumbnails (gitignore)
└── assets/
    ├── characters/pip/
    │   ├── manifest.json         # every asset: path, sha256, prompt, model, cost, lineage
    │   ├── references/           # generated images
    │   ├── blender/              # pip-spec-v001.json, pip-v001.blend, v002, …
    │   ├── renders/v001/         # front.png, side.png, three_quarter.png
    │   └── exports/              # pip-v002.glb, pip-v002.fbx
    ├── props/ environments/ textures/ ui/
    └── videos/<collection>/videos/
```

Filenames are deterministic, never overwritten (`-2`, `-3` … on collision), and written
atomically (temp file + rename).

## Configuration

`pixelbridge.config.json` in the project root. Every field is optional. Key settings:

```json
{
  "budget": {
    "projectLimitUsd": 5,
    "providerLimitsUsd": { "fal": 3 },
    "approvalThresholdUsd": 0.25,
    "maxCostPerCallUsd": 2,
    "maxGenerationsPerDay": 100,
    "maxInFlight": 3
  },
  "providers": {
    "openai": { "defaultModel": "gpt-image-2" },
    "fal": {
      "defaultVideoModel": "fal-ai/kling-video/v2.5-turbo/pro/image-to-video",
      "models": {
        "fal-ai/kling-video/v2.5-turbo/pro/image-to-video": {
          "kind": "video",
          "pricing": { "perSecondUsd": 0.07 },
          "fields": { "prompt": "prompt", "image": "image_url", "duration": "duration" },
          "allowedDurations": [5, 10]
        }
      }
    }
  },
  "pipeline": { "maxModelVersions": 12 },
  "roblox": { "maxTrianglesPerMesh": 20000, "maxTextureSize": 1024 }
}
```

The fal price above is an example. **Check the current price on the model's fal.ai page before
using it.** See [docs/providers.md](docs/providers.md) and
[examples/pixelbridge.config.example.json](examples/pixelbridge.config.example.json).

| Environment variable       | Purpose                                               |
| -------------------------- | ----------------------------------------------------- |
| `OPENAI_API_KEY`           | Enables the OpenAI image provider                     |
| `FAL_KEY`                  | Enables the fal.ai video / 3D provider                |
| `BLENDER_PATH`             | Explicit Blender executable (otherwise auto-detected) |
| `PIXELBRIDGE_PROJECT_ROOT` | Project directory (default: current directory)        |
| `PIXELBRIDGE_MOCK=1`       | Enable offline mock providers                         |

## Costs

You pay providers directly with your own keys; PixelBridge has no service of its own. Built-in
OpenAI estimates come from OpenAI's published per-image table (transcribed 2026-11-19). For
example, `gpt-image-2` medium 1024×1024 costs about $0.053, and a three-view turnaround at medium
1024×1536 costs about $0.15 including reference inputs. Actual cost is computed from the usage
tokens OpenAI returns. Models without a published table get an extrapolated, labelled upper-bound
estimate. Unknown models are refused. For fal you supply verified prices.

Local limits cannot cap provider billing in every failure mode (for example, a request that timed
out but was processed is counted as "unknown" and still billed). **Also set spending limits in your
provider dashboards.**

## Security model

- **No code execution tools.** Blender runs only the bundled script with
  `--factory-startup --disable-autoexec`, which disables user add-ons and scripts embedded in
  `.blend` files. Models are data (validated JSON). This is a trust boundary, not a sandbox:
  Blender runs with your user's permissions.
- **Filesystem confinement.** Agent-supplied paths must resolve inside the project root after
  symlinks are resolved. Inputs are type-checked by magic bytes and size-capped.
- **Credentials** are read from the environment only, sent only to their provider (the fal API key
  only to the configured queue host, never to returned URLs or the CDN), and redacted from logs,
  errors and tool output.
- **Local transport only** (stdio). There is no network listener.
- **Nothing is published.** No tool uploads to Roblox or anywhere else.

Details: [docs/security.md](docs/security.md). Report vulnerabilities via [SECURITY.md](SECURITY.md).

## Roblox

`validate_3d_asset` and every export include a report with:

- per-mesh triangle cap (default 20,000)
- size in studs (0.28 m/stud)
- part-size limit
- material count per mesh
- UV presence
- non-manifold geometry
- armature presence

Static models import as meshes. PixelBridge does not build R15 rigs. Import into Studio yourself
via the 3D Importer; see [docs/roblox.md](docs/roblox.md).

## Known limitations

- Primitive-based modelling suits blockouts, props and stylised low-poly characters. It cannot
  reproduce detailed sculpted characters. For those, use `generate_3d_from_image` and clean up
  the result in Blender.
- Turnaround views are visual references, not measured orthographic drawings. Consistency between
  views is not guaranteed.
- Generated video is a motion reference, not skeletal animation.
- Live calls to OpenAI and fal have not been made from this repository yet; request/response
  handling is verified against the documented API shapes only.
- fal model input schemas differ; each model needs a field mapping in config. Output file
  detection is heuristic.
- Workbench previews render colours darker than the material hex values; use `engine: "eevee"`
  for closer colour.
- Each Blender operation starts a new Blender process (~2.5 s overhead).
- The Roblox limits are conservative defaults from developer guidance, not an official spec check.

## Troubleshooting

| Symptom                                  | Fix                                                                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `PROVIDER_NOT_CONFIGURED`                | The key is not in the **MCP server's** environment. Put it in the `env` block of `.mcp.json` or export it before starting the client. |
| `BLENDER_NOT_FOUND`                      | Set `BLENDER_PATH` or `blender.path` to the executable (`blender.exe` on Windows).                                                    |
| `PRICE_UNKNOWN`                          | Add a verified price for that model to config (see docs/providers.md).                                                                |
| `APPROVAL_REQUIRED`                      | Expected for expensive calls; approve and pass `confirmCostUsd`.                                                                      |
| `BUDGET_EXCEEDED` with nothing generated | Check `get_budget` for "unknown" entries (timeouts). Raise `projectLimitUsd` after checking the provider dashboard.                   |
| `REFINEMENT_LIMIT`                       | The agent hit `pipeline.maxModelVersions`; review the renders before raising it.                                                      |
| Server shows no tools                    | Run `node dist/mcp-entry.js` in a terminal; startup errors are printed to stderr.                                                     |

## Development

```bash
npm run check        # typecheck, lint, format check, tests, build
npm test             # unit + MCP tests; Blender tests run if Blender is found
PIXELBRIDGE_SKIP_BLENDER=1 npm test
```

Blender integration tests are **skipped, not passed**, when Blender is unavailable, and the
reason is printed. CI never calls paid APIs. See [CONTRIBUTING.md](CONTRIBUTING.md) and
[docs/architecture.md](docs/architecture.md).

## License

Apache-2.0. `blender/pixelbridge_bpy.py` is GPL-3.0-or-later because it runs inside Blender (see
[NOTICE](NOTICE)). Generated assets are subject to the terms of the provider that generated them.
