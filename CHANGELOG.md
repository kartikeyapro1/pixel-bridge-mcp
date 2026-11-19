# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow SemVer.

## [Unreleased]

## [0.3.0] - 2026-11-19

### Added

- `outputDir` and `fileName` on `generate_image`, `edit_image` and `generate_video` (CLI: `--out`,
  `--name`) to save straight into an app's folders. Paths stay confined to the project; files are
  never overwritten.
- Transparent backgrounds with providers that cannot output them (Gemini): generated on a flat
  backdrop and cut out locally into a PNG, with optional `trim`.
- `remove_background` tool and `pixelbridge cutout` command: free, local background removal for any
  PNG or JPEG in the project.
- Manifests record each asset's `projectPath`.

### Changed

- Explicit file names keep their case (`DumbbellIcon.png`); generated default names are unchanged.
- New runtime dependencies: `jpeg-js` (BSD-3-Clause) and `pngjs` (MIT), both pure JavaScript.

## [0.2.0] - 2026-11-19

### Added

- `pixelbridge key set|status|test|delete`: API keys stored in the OS credential store (Windows
  DPAPI, macOS Keychain, Linux Secret Service) and read by the server at startup.
- Documentation: getting started, credentials, configuration, CLI and generated tool reference,
  troubleshooting, related projects.
- `get_status` reports where each key came from (never its value).

### Fixed

- Gemini image requests: the API accepts only `image/jpeg` for `response_format.mime_type`; the
  format is now left to the API and detected from the returned bytes. Verified against the live API.

### Changed

- One API key: the Gemini API (`GEMINI_API_KEY`) is now the default provider for images (Nano
  Banana 2.1) and video (Gemini Omni Flash), with built-in published prices.
- `generate_video` takes `images` (up to 6), `resolution` and `aspectRatio`; `extraInput` was removed.
- `generate_3d_from_image` is only offered when a configured provider supports image-to-3D.

### Removed

- fal.ai provider and `FAL_KEY`; per-model fal configuration.

## [0.1.0] - 2026-11-19

First private pre-release.

### Added

- MCP server (stdio, MCP TypeScript SDK v2) with 18 tools and a CLI sharing the same services.
- Asset registry in SQLite with per-collection `manifest.json`, content hashes, lineage and
  collision-safe atomic file writes.
- Budget ledger with cross-process reservations, approval threshold, per-call ceiling, project and
  provider caps, daily and in-flight limits, and "unknown outcome" accounting.
- Request fingerprint cache for images and jobs.
- OpenAI image provider: generate, edit with up to 16 references and mask, published-price
  estimates, usage-based actual cost.
- Character turnaround generation (front, then side/back/three-quarter conditioned on the front).
- fal.ai queue provider for video and image-to-3D with restart-safe persistent jobs, polling,
  size-capped downloads and cancellation (removed in Unreleased).
- Headless Blender integration from declarative model specs: build (with reference planes),
  render (Workbench/EEVEE/Cycles), inspect, export (glb/gltf/fbx/obj) with re-import
  verification, thumbnails.
- Roblox pre-import validation profile.
- Mock providers for offline use and tests.
- Example original character spec (`examples/specs/cartoon-cat.json`).
