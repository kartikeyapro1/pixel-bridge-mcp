# Product assessment (Phase 0)

Written 2026-11-19, before implementation, and revised after the first working build.
Sources were current vendor documentation and public repositories; links at the end.

## Verdict

PixelBridge is worth building **as a focused tool, not as a "multimodal platform"**. The
individual capabilities (call an image API, drive Blender, call an image-to-3D API) are already
commoditised as MCP servers. What is not well served is the part that matters when an _agent_
runs a creative pipeline unattended:

1. **It must not spend money unpredictably.** Agents retry, loop and run concurrently.
2. **Results must be reproducible and attributable.** Which prompt, model and references produced
   this file, at what cost, and what came before it?
3. **It must be safe to leave running.** No arbitrary code execution path, no writes outside the
   project, no credential leakage.
4. **Output must be checked against the target engine**, not just "a file was written".

PixelBridge's differentiation is that pipeline discipline: budgets with cross-process
reservations, request caching, a provenance registry, declarative and versioned Blender models,
and engine pre-import validation. The generation calls themselves are thin adapters.

## Answers to the brief's questions

| #   | Question                            | Answer                                                                                                                                                                                                                                                                                                                                                     |
| --- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Meaningful problem?                 | Yes, but narrower than the brief: the gap is safe, reproducible orchestration, not access to generators.                                                                                                                                                                                                                                                   |
| 2   | Target user                         | Solo and small-team game developers (Roblox first) already using AI coding agents, cost-sensitive and comfortable with a CLI.                                                                                                                                                                                                                              |
| 3   | Will developers install it?         | Only if setup takes minutes and there is a free path. The Blender path (spec → model → renders → export → validation) needs no API key; the mock provider lets people try everything offline.                                                                                                                                                              |
| 4   | Competitors                         | ahujasid/blender-mcp (live Blender over a socket, arbitrary Python execution, Rodin/Hunyuan/Meshy/Tripo hooks); RFingAdam/mcp-blender (200+ tools); sandraschi/blender-mcp; VAST-AI tripo-mcp; Meshy's MCP; theisegoria/game-asset-mcp (game-ready asset pipeline with provenance); many OpenAI-image MCP wrappers; Roblox's own Studio MCP for scripting. |
| 5   | Commoditised                        | Text-to-image wrappers, Blender remote control, image-to-3D API calls.                                                                                                                                                                                                                                                                                     |
| 6   | Differentiation                     | Spend safety (approval protocol, transactional budget ledger, cache, "unknown outcome" accounting); declarative, versioned model specs instead of arbitrary Python; provenance registry and manifests; engine validation; the agent itself as the visual judge in the refinement loop.                                                                     |
| 7   | Game dev or general?                | Keep the core engine-agnostic, but design and market for game asset pipelines. "General creative MCP" has no clear user.                                                                                                                                                                                                                                   |
| 8   | MCP as primary interface?           | Yes for agents. Not sufficient alone.                                                                                                                                                                                                                                                                                                                      |
| 9   | CLI?                                | Yes, built on the same services. It is needed for scripting, CI, debugging and humans approving spend (`--yes`).                                                                                                                                                                                                                                           |
| 10  | TypeScript + Python?                | Yes. TypeScript for the MCP SDK and `npx` distribution; Python only where unavoidable (inside Blender).                                                                                                                                                                                                                                                    |
| 11  | Blender in core or adapter?         | A service behind a process boundary with a JSON protocol. It lives in this repo for now and can become a separate package without API changes.                                                                                                                                                                                                             |
| 12  | Video in V1?                        | Architecture yes, priority low. OpenAI shut down the Sora 2 Videos API on 2026-09-24; video is the least useful modality for game assets (it is not skeletal animation); prices vary widely by model. Shipped on the Gemini API (Omni Flash) as a restart-safe async job, under the same single key as images.                                             |
| 13  | Image-to-3D via providers?          | Not in V1. No single-key provider offers it, and the maintainer chose one key over more capability. The job system supports it if a provider is added later.                                                                                                                                                                                               |
| 14  | Unnecessary complexity in the brief | A separate vision-model API for render comparison (the calling agent already sees images); eight parallel specialist agents for a codebase this size; many providers before one is proven; Unity/Unreal adapters in V1.                                                                                                                                    |
| 15  | What impresses engineers            | Correctness under concurrency, explicit trust boundaries, honest cost accounting, tests that run real Blender, small dependency surface. Not tool count.                                                                                                                                                                                                   |
| 16  | What makes people use it            | Free first run, cannot accidentally spend $50, files land in the repo with provenance, clear errors that tell the agent what to do next.                                                                                                                                                                                                                   |
| 17  | Major risks                         | See below.                                                                                                                                                                                                                                                                                                                                                 |
| 18  | Deliberately not building           | Hosted service, live-socket arbitrary Python execution, rigging/animation, a GUI, own models, automatic publishing to Roblox.                                                                                                                                                                                                                              |

## Risks

- **Provider churn.** In the two months before this was written, OpenAI retired `gpt-image-1`
  (2026-10-23) and shut down the Sora 2 Videos API (2026-09-24); Google shut down Veo 3.1 preview
  models (2026-10-22) and Imagen. Adapters must be small and
  prices must be data, not code.
- **Pricing drift.** Built-in Gemini and OpenAI prices are a dated transcription; unknown models
  are refused. Estimates are labelled as estimates.
- **Quality ceiling of primitive modelling.** Declarative primitives produce stylised, chunky
  characters (see `examples/specs/cartoon-cat.json`). That suits blockouts, props and low-poly
  styles. It will not reproduce detailed sculpted characters, and the docs say so.
- **Platform competition.** Engine vendors and model providers are adding native asset generation
  (Roblox has announced in-platform 3D generation). PixelBridge's value has to be the
  provider-neutral, auditable pipeline, not any single generator.
- **Blender API churn.** The bundled script is verified on Blender 5.3; older 4.x versions are
  accepted but untested.
- **MCP SDK churn.** The v2 TypeScript SDK is recent; the protocol surface used here is small.
- **Content rights.** Generated assets carry the provider's terms. PixelBridge records which
  provider and model produced each file so users can check.

## Sources

- OpenAI image API reference and pricing: developers.openai.com/api/reference (images), /api/docs/pricing, /api/docs/guides/image-generation
- OpenAI Videos API reference (shutdown notice): developers.openai.com/api/reference/resources/videos
- Gemini API (Interactions, image generation, Omni video, pricing): aistudio.google.com/docs
- MCP TypeScript SDK v2: ts.sdk.modelcontextprotocol.io/v2
- Blender MCP projects: github.com/ahujasid/blender-mcp, github.com/sandraschi/blender-mcp, github.com/VAST-AI-Research/tripo-mcp
- Roblox mesh limits: Roblox developer forum threads on the 3D Importer (per-mesh triangle cap)
