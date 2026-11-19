# Command-line reference

`pixelbridge` (`node dist/cli.js`) uses the same services as the MCP server. It acts on the
current directory, or on `--project <dir>`. Add `--json` for single-line JSON output.

## Setup

| Command                                 | Description                                                                  |
| --------------------------------------- | ---------------------------------------------------------------------------- |
| `pixelbridge init`                      | Write `pixelbridge.config.json` (if missing) and create the assets directory |
| `pixelbridge status`                    | Providers, key sources, Blender, budget and missing setup                    |
| `pixelbridge serve`                     | Run the MCP server on stdio (same as `dist/mcp-entry.js`)                    |
| `pixelbridge key set gemini\|openai`    | Store a key in the OS credential store (hidden prompt or stdin)              |
| `pixelbridge key status`                | Where each key comes from                                                    |
| `pixelbridge key test gemini`           | Free validity check                                                          |
| `pixelbridge key delete gemini\|openai` | Remove a stored key                                                          |

## Generation (paid)

| Command                                                  | Options                                                                                                                                                        |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pixelbridge image "<prompt>" -c <collection>`           | `--quality low\|medium\|high`, `--size WxH`, `--model`, `--provider`, `--dry-run`, `--yes`                                                                     |
| `pixelbridge turnaround "<description>" -c <collection>` | `--style`, `--views front,side,back,three_quarter`, `--quality`, `--dry-run`, `--yes`                                                                          |
| `pixelbridge video "<prompt>" -c <collection>`           | `--image <asset\|path>` (repeatable, up to 6), `--duration 3-15`, `--resolution 360p\|720p\|1080p\|4k`, `--aspect 16:9\|9:16`, `--model`, `--dry-run`, `--yes` |
| `pixelbridge jobs`                                       | List recent video jobs                                                                                                                                         |
| `pixelbridge job <jobId>`                                | Poll a job; downloads the result when ready                                                                                                                    |
| `pixelbridge cancel <jobId>`                             | Request cancellation                                                                                                                                           |

`--dry-run` prints the estimate and does nothing else. Without `--yes`, a call estimated above the
approval threshold stops with `APPROVAL_REQUIRED` (exit code 3) and prints the estimate. With
`--yes` you approve that estimate. The hard limits still apply.

## Blender (local, free)

| Command                                         | Options                                                                                                  |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `pixelbridge build <spec.json> -c <collection>` | `--ref front=<asset\|path>` (also `side=`, `back=`), `--category`, `--note`                              |
| `pixelbridge render <blendAssetId>`             | `--views front,side,back,three_quarter,top`, `--resolution 64-2048`, `--engine workbench\|eevee\|cycles` |
| `pixelbridge export <blendAssetId>`             | `--formats glb,gltf,fbx,obj` (exit code 1 if Roblox validation fails)                                    |
| `pixelbridge inspect <asset\|path>`             | Scene statistics                                                                                         |
| `pixelbridge validate <asset\|path>`            | Roblox pre-import report (exit code 1 on failure)                                                        |

## Registry

| Command                       | Description                                         |
| ----------------------------- | --------------------------------------------------- |
| `pixelbridge assets`          | `-c <collection>`, `--category`, `--kind`           |
| `pixelbridge asset <assetId>` | Full metadata                                       |
| `pixelbridge budget`          | Spending summary and recent ledger entries          |
| `pixelbridge cache-clear`     | Forget cached request fingerprints (files are kept) |

## Exit codes

| Code | Meaning                                                                 |
| ---- | ----------------------------------------------------------------------- |
| 0    | Success                                                                 |
| 1    | Error, or a validation report that failed                               |
| 2    | Unknown command                                                         |
| 3    | Approval required (re-run with `--yes` to approve the printed estimate) |

Errors are printed as JSON on stderr, with `code`, `message` and usually a `hint`.
