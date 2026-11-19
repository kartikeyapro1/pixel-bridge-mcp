# Architecture decision record

Short entries. Each records the decision, the alternatives considered, and why.

## ADR-1: One TypeScript package, services shared by MCP and CLI

**Decision.** A single npm package with layers: `core` (config, paths, storage, budget, HTTP),
`providers` (adapters), `services` (use cases), and two thin front ends (`mcp/`, `cli.ts`).

**Alternatives.** A monorepo with separate packages per provider and engine; a Python server.

**Why.** A monorepo adds release overhead with one maintainer and no external consumers yet.
TypeScript has the reference MCP SDK and `npx` distribution. The layer boundaries are kept strict
so packages can be split later.

## ADR-2: MCP TypeScript SDK v2

**Decision.** `@modelcontextprotocol/server` 2.4.0 with zod 4 and `serveStdio`.

**Why.** v2 is the stable line implementing the 2026-07-28 spec and the SDK's recommendation for
new servers. `serveStdio` also serves 2025-era clients.

## ADR-3: Blender runs headless from a declarative spec; no arbitrary Python

**Decision.** Each Blender operation is a separate `blender --background --factory-startup
--disable-autoexec` process running the bundled `blender/pixelbridge_bpy.py`, which interprets
a fixed set of JSON operations. Models are described as a validated _spec_ (primitives,
transforms, modifiers, materials). Every build saves a new spec and `.blend` version.

**Alternatives.** A live Blender add-on listening on a socket (blender-mcp style) that accepts
Python from the agent.

**Why.** Arbitrary Python execution is the main security problem of existing Blender MCPs and is
redundant: an agent that is trusted with arbitrary code already has a shell. A spec is diffable,
reproducible, cheap to version and easy for an agent to edit in a refine loop. Headless runs are
testable in CI. Cost: about 2.5 s of Blender startup per operation, and no live viewport.

## ADR-4: The calling agent is the visual judge

**Decision.** `render_model_previews` returns renders and downscaled reference images as MCP image
content. The agent compares them and edits the spec. Iteration is capped per collection
(`pipeline.maxModelVersions`).

**Alternatives.** Call a separate vision model from the server.

**Why.** The agent is already a vision-capable model with the task context. A second model adds
cost, another API key and another place to hide failure. The cap gives a hard stop.

## ADR-5: Project state in SQLite (`node:sqlite`)

**Decision.** Registry, budget ledger, cache and jobs live in `.pixelbridge/pixelbridge.db`
(WAL mode). Budget checks run inside `BEGIN IMMEDIATE`.

**Alternatives.** JSON files with lock files; `better-sqlite3`; an external database.

**Why.** Concurrent agents (or two Claude Code sessions) must not both pass a budget check. SQLite
gives cross-process locking with no native build step (`node:sqlite` ships with Node ≥22.15).
Human-readable `manifest.json` files are regenerated per collection for browsing and git diffs.

## ADR-6: Conservative spend accounting

**Decision.** Reserve the estimate before every paid call; settle with actual cost when the
provider reports usage; release only when the provider certainly did not bill (an HTTP error
response); otherwise mark the reservation "unknown" and keep counting it. Generation POSTs are
never retried after a timeout. Calls above `approvalThresholdUsd` need `confirmCostUsd`; calls
above `maxCostPerCallUsd` are refused outright. Unknown prices are refused, not guessed.

**Why.** Over-counting is recoverable (raise the limit); under-counting is not.

## ADR-7: OpenAI for images, fal.ai queue for video and image-to-3D

**Decision.** Images: OpenAI Images API (default `gpt-image-2`, which has a published price
table). Video and 3D: one adapter for fal.ai's queue API, with per-model field mappings and
prices in configuration.

**Why.** OpenAI's Videos API was shut down on 2026-09-24. fal hosts many video and 3D models
behind one submit/status/result/cancel lifecycle, so one adapter covers them. Model input schemas
differ, so field names are configuration rather than code.

**Limitation.** Neither real provider has been exercised with live keys in this repository
(no approved spend yet). Both are covered by HTTP-level tests against recorded API shapes.

## ADR-8: Licensing

**Decision.** Apache-2.0 for the project; `blender/pixelbridge_bpy.py` is GPL-3.0-or-later.

**Why.** Apache-2.0 adds an explicit patent grant and matches the MCP SDK. The Blender script
imports `bpy` and runs inside Blender, so it follows Blender's GPL licensing. It is executed as a
separate process and communicates through JSON files, so the GPL does not extend to the
TypeScript code. Runtime dependencies (MCP SDK: Apache-2.0, zod: MIT) are compatible.
