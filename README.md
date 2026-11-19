# PixelBridge

An MCP server and CLI that lets AI coding agents generate **images and videos** with one Google
Gemini API key (app icons, UI art, illustrations, game assets, video clips), and build **3D models**
in a local copy of Blender. It runs on your machine,
stores everything in your project, and enforces spending limits so an agent cannot run up a bill.

```text
You:   "Make a pixel-art health potion icon and a 5-second clip of a slime bouncing."
Agent: generate_image  → assets/props/potion/references/potion-image.jpg      ($0.036)
       generate_video  → job submitted … get_job → assets/videos/slime/…mp4  (approval asked first)
```

- **One key.** A Gemini API key covers image generation, image editing and video. 3D work uses
  Blender on your machine and needs no key.
- **Use it in any project.** Save straight into your app's folders (`outputDir`, `fileName`) and get
  transparent PNGs for icons and sprites. Gemini can't output transparency, so the subject is cut out
  locally from a flat backdrop; a free `remove_background` tool does the same for any image.
- **Cost control.** Every paid call is estimated first. A project budget, a per-call ceiling and a
  daily limit are enforced locally, even across several agents running at once. Repeat requests are
  served from cache for free.
- **Keys stay out of files.** Store your key once in the operating system's credential store
  (Windows DPAPI, macOS Keychain, Linux Secret Service). The server reads it at startup.
- **Everything is recorded.** Each file is registered with its prompt, model, cost, hash and the
  assets it was derived from. A `manifest.json` per collection keeps that browsable.
- **3D without code execution.** Models are described as JSON (primitives, modifiers, materials)
  and built in headless Blender, then previewed, exported to glb/fbx/obj and checked against
  Roblox import limits. The agent never runs Python inside Blender.

> **Status: 0.3.0, pre-release.** Image generation is verified against the live Gemini API.
> Video generation is implemented and tested against Google's documented API, but not yet run
> live. Tested on Windows 11 with Node 24 and Blender 5.3.

## Quick start

**1. Install** (Node.js 22.15 or newer):

```bash
git clone https://github.com/kartikeyapro1/PixelBridge.git
cd PixelBridge
npm ci
npm run build
```

**2. Store your Gemini API key.** Create one at [Google AI Studio](https://aistudio.google.com).
Billing must be enabled, because the image and video models have no free tier. Then:

```bash
node dist/cli.js key set gemini      # paste the key; input is hidden
```

This encrypts the key in your OS credential store and checks it with a free request. To replace
it later, run the same command again. See [docs/credentials.md](docs/credentials.md).

**3. Connect your MCP client.** Add this server to your client's MCP configuration (most clients
use this `mcpServers` format; see [docs/getting-started.md](docs/getting-started.md) for
per-client steps):

```json
{
  "mcpServers": {
    "pixelbridge": {
      "command": "node",
      "args": ["/absolute/path/to/PixelBridge/dist/mcp-entry.js"]
    }
  }
}
```

The server works in the directory the client starts it in (your project). To pin a directory,
set `PIXELBRIDGE_PROJECT_ROOT` in the server's `env`.

**4. Ask your agent** to "call get_status", then to generate something. Files appear under
`assets/` in your project.

**No key yet?** Set `PIXELBRIDGE_MOCK=1` in the server's environment. The mock provider writes
placeholder images and charges a fake $0.01 per call, so you can try the whole workflow offline.

## What it costs

You pay Google directly. PixelBridge itself is free and runs no service. With the defaults:

| Asset                                | Model             | Typical cost           |
| ------------------------------------ | ----------------- | ---------------------- |
| Image (1K)                           | Nano Banana 2.1   | ~$0.036 (measured)     |
| Three-view character reference sheet | Nano Banana 2.1   | ~$0.11–0.13            |
| 8 s video, 360p / 720p / 1080p       | Gemini Omni Flash | ~$0.20 / $0.57 / $0.85 |
| Blender model, previews, exports     | local Blender     | free                   |

Calls estimated above **$0.25** need explicit approval. Spending stops at the project budget
(**$5** by default). Change both in `pixelbridge.config.json`
([docs/configuration.md](docs/configuration.md)). Local limits cannot cap your Google bill in every
failure case, so also set a budget alert in Google Cloud billing.

## Tools

| Tool                                    | What it does                                                                | Cost  |
| --------------------------------------- | --------------------------------------------------------------------------- | ----- |
| `get_status`                            | Providers, key source, Blender, budget, missing setup                       | free  |
| `get_budget`                            | Spending summary and recent ledger entries                                  | free  |
| `generate_image`                        | Text-to-image; optional transparent background, output folder and file name | paid  |
| `remove_background`                     | Make a flat background transparent, optionally crop to the subject          | free  |
| `edit_image`                            | Edit an image or generate from up to 14 reference images                    | paid  |
| `generate_character_turnaround`         | Front view, then side/back/¾ views conditioned on it                        | paid  |
| `generate_video`                        | 3–15 s video, 360p–4k, up to 6 reference images (async job)                 | paid  |
| `get_job`, `list_jobs`, `cancel_job`    | Track and download video jobs (survive restarts)                            | free  |
| `list_assets`, `get_asset`              | Browse generated files and their metadata                                   | free  |
| `get_model_spec_guide`                  | How to describe a 3D model as JSON                                          | free  |
| `build_blender_model`                   | Build a new model version in Blender from a JSON spec                       | local |
| `render_model_previews`                 | Render previews and return them (with references) as images                 | local |
| `inspect_3d_asset`, `validate_3d_asset` | Triangle counts, bounds, issues; Roblox checks                              | local |
| `export_3d_asset`                       | Export glb/gltf/fbx/obj, verified by re-import                              | local |

Full argument reference: [docs/tools.md](docs/tools.md) (generated from the code).

## Using it in an app project

Run your agent in the app's repository and ask for assets where the app expects them:

> Generate a flat, minimal dumbbell icon with a transparent background, trimmed, saved to
> `src/assets/icons` as `dumbbell`.

The agent calls `generate_image` with `background: "transparent"`, `trim: true`,
`outputDir: "src/assets/icons"` and `fileName: "dumbbell"`. The PNG lands at
`src/assets/icons/dumbbell.png`, and the flat-background original is kept under `assets/` for
reference. Paths are confined to the project, and existing files are never overwritten.

## Command line

The same features are available without an agent:

```bash
node dist/cli.js status
node dist/cli.js image "pixel-art health potion icon" -c potion
node dist/cli.js image "flat dumbbell icon" --transparent --trim --out src/assets/icons --name dumbbell
node dist/cli.js cutout photos/logo.jpg --out public --trim
node dist/cli.js video "a green slime bouncing" -c slime --duration 5 --resolution 360p --yes
node dist/cli.js job <jobId>
node dist/cli.js build examples/specs/cartoon-cat.json -c pip
node dist/cli.js export <blendAssetId> --formats glb,fbx
```

Paid commands print the estimate and stop if it is above the approval threshold; add `--yes` to
approve. See [docs/cli.md](docs/cli.md).

## What gets written

```text
your-project/
├── pixelbridge.config.json       optional settings
├── .pixelbridge/                 local database (registry, budget, jobs), temp files - add to .gitignore
└── assets/
    ├── characters/pip/
    │   ├── manifest.json         every asset: path, sha256, prompt, model, cost, lineage
    │   ├── references/           generated images
    │   ├── blender/              pip-spec-v001.json, pip-v001.blend, v002 …
    │   ├── renders/v001/         front.png, side.png, three_quarter.png
    │   └── exports/              pip-v002.glb
    └── videos/slime/videos/      slime-video.mp4
```

Files are never overwritten (`-2`, `-3` … are added on collision) and are written atomically.

## Limitations

- Gemini images: no masks, one image per call, JPEG output. Transparency is produced by a local
  cut-out from a flat background: very good for icons, sprites and objects, weaker on hair, smoke,
  glass or anything that blends into the backdrop. OpenAI (optional key) supports native transparency.
- Character reference views are visual references; their consistency is not guaranteed.
- Generated video is a motion reference, not game-ready animation.
- 3D models are built from primitives. That suits props, blockouts and stylised characters; it
  cannot reproduce detailed sculpted models. Image-to-3D reconstruction is not included.
- The Roblox checks are conservative pre-import checks, not a guarantee that Studio accepts the
  file.
- Approval above the threshold is enforced through a tool argument the agent supplies after asking
  you. The hard limits (budget, per-call ceiling, daily count) cannot be bypassed by the agent.

## Documentation

| Topic                             |                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------ |
| Setup for each MCP client         | [docs/getting-started.md](docs/getting-started.md)                                   |
| API key storage                   | [docs/credentials.md](docs/credentials.md)                                           |
| Configuration reference           | [docs/configuration.md](docs/configuration.md)                                       |
| Tool reference                    | [docs/tools.md](docs/tools.md)                                                       |
| CLI reference                     | [docs/cli.md](docs/cli.md)                                                           |
| Providers, models and prices      | [docs/providers.md](docs/providers.md)                                               |
| Describing 3D models              | [docs/model-spec.md](docs/model-spec.md)                                             |
| Roblox workflow                   | [docs/roblox.md](docs/roblox.md)                                                     |
| Security model                    | [docs/security.md](docs/security.md)                                                 |
| Troubleshooting                   | [docs/troubleshooting.md](docs/troubleshooting.md)                                   |
| Architecture and design decisions | [docs/architecture.md](docs/architecture.md), [docs/decisions.md](docs/decisions.md) |
| Related projects                  | [docs/related-projects.md](docs/related-projects.md)                                 |

## Development

```bash
npm run check        # typecheck, lint, format check, tests, build
npm test             # Blender integration tests run when Blender is installed
```

Tests never call paid APIs. See [CONTRIBUTING.md](CONTRIBUTING.md) and
[docs/releasing.md](docs/releasing.md).

## License

Apache-2.0, except `blender/pixelbridge_bpy.py` (GPL-3.0-or-later, because it runs inside
Blender); see [NOTICE](NOTICE). Generated content is subject to the terms of the provider that
produced it.
