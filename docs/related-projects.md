# Related projects

PixelBridge overlaps with several existing open-source projects. If one of them fits your needs
better, use it. This comparison was written on 2026-11-19 from the projects' public
documentation; check each project for its current state.

| Project                                                                               | Focus                                                                                                                                                                                                       | Compared with PixelBridge                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [mcp-for-blender](https://github.com/ahujasid/mcp-for-blender) (formerly blender-mcp) | Live control of a running Blender through an add-on; the agent can run Python in Blender; Poly Haven, Sketchfab and AI 3D generators                                                                        | Far broader Blender control and a large user base. PixelBridge runs Blender headlessly from JSON specs instead, without code execution, and adds image/video generation and budgets.                                                                                        |
| [Meshwire](https://github.com/RFingAdam/meshwire)                                     | 200+ Blender tools tested on several Blender versions; AI 3D backends; a render → vision-score → refine loop; Python execution behind an explicit opt-in                                                    | More complete Blender coverage, including its own refinement loop. PixelBridge is narrower: game-asset pipeline, Roblox checks, spend control.                                                                                                                              |
| [Game Development Studio](https://github.com/theisegoria/game-development-studio)     | Local CLI + MCP for game asset production: paid providers (Tripo, Leonardo), spend ceilings with client-side approval prompts, durable jobs, content-addressed asset packages, capture and visual debugging | The closest in spirit, and more rigorous on approvals: paid MCP tools require a human-configured ceiling and a client-side confirmation prompt. PixelBridge differs in using one Gemini key for images and video, building 3D models from specs, and validating for Roblox. |
| [gemini-mcp](https://github.com/chrischall/gemini-mcp) and other Gemini media servers | Gemini image, video and music generation over MCP, with cost reporting and idempotency                                                                                                                      | Similar single-key media generation. PixelBridge adds budgets and approvals, an asset registry, video jobs that survive restarts, and the Blender pipeline.                                                                                                                 |
| Roblox Studio's built-in MCP server                                                   | Studio automation, including AI mesh generation inside Studio                                                                                                                                               | Runs inside Studio. PixelBridge prepares and checks files before import and never touches Studio or publishes.                                                                                                                                                              |

## Where PixelBridge is different

- 3D models are described as versioned JSON specs and built in a fresh headless Blender process,
  so no tool executes code supplied by the agent.
- Exported files are re-imported in a clean scene and checked against Roblox import limits.
- One provider key for images and video, with published prices built in and a local ledger that
  enforces budgets across concurrent processes.

## Known gap

Approval above the threshold relies on the agent asking you and then passing `confirmCostUsd`.
Game Development Studio uses MCP elicitation (a confirmation prompt shown by the client), which
the agent cannot fill in on its own. Adopting that approach is on the roadmap. The hard
limits in PixelBridge (budget, per-call ceiling, daily count, concurrency) already cannot be
bypassed from a tool call.
