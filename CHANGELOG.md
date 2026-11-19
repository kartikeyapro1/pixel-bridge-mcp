# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow SemVer.

## [Unreleased]

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
  size-capped downloads and cancellation.
- Headless Blender integration from declarative model specs: build (with reference planes),
  render (Workbench/EEVEE/Cycles), inspect, export (glb/gltf/fbx/obj) with re-import
  verification, thumbnails.
- Roblox pre-import validation profile.
- Mock providers for offline use and tests.
- Example original character spec (`examples/specs/cartoon-cat.json`).
