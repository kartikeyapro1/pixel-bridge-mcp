# Architecture

```
 MCP client (Claude Code, Cursor, …)         Human / scripts / CI
          │ stdio (JSON-RPC)                          │
          ▼                                           ▼
   src/mcp/server.ts  (17-18 tools)             src/cli.ts
          └──────────────┬───────────────────────────┘
                         ▼
               src/services/  (use cases)
   ImageService · JobService · ModelService · PixelBridge (facade/status)
          │                 │                     │
          ▼                 ▼                     ▼
   src/providers/      src/core/            BlenderService ──spawn──► blender --background
   Gemini (img+video)  registry (assets,                           --factory-startup
   OpenAIImage, Mock   cache, manifests)                           --disable-autoexec
   Mock                budget (ledger)                             --python blender/pixelbridge_bpy.py
                       db (node:sqlite)                            -- req.json res.json
                       paths (confinement)
                       http (retry/timeout/redaction)
                         │
                         ▼
          <project>/.pixelbridge/pixelbridge.db   <project>/assets/<category>/<collection>/…
```

## Layers

| Layer                        | Responsibility                                                                | Must not                          |
| ---------------------------- | ----------------------------------------------------------------------------- | --------------------------------- |
| `mcp/`, `cli.ts`             | Argument schemas, output formatting, error mapping                            | Contain business logic            |
| `services/`                  | Use cases: quote → cache → approve → reserve → call → store → settle          | Know about MCP or argv            |
| `providers/`                 | One external API each; capability discovery, validation, estimate, HTTP calls | Touch the filesystem or ledger    |
| `core/`                      | Storage, paths, budget, HTTP primitives, redaction                            | Depend on services/providers      |
| `blender/pixelbridge_bpy.py` | Interpret JSON ops inside Blender                                             | Execute anything from the request |

## Paid request lifecycle

1. Resolve inputs (asset ids or confined paths), hash them.
2. Provider `validate()`: parameters this model supports.
3. Provider `estimate()`: labelled estimate; unknown price → `PRICE_UNKNOWN`.
4. Fingerprint (provider, model, operation, canonical params, reference content hashes) →
   cache lookup. A hit re-verifies file hashes before reuse.
5. `dryRun` → return the quote.
6. `checkApproval()`: threshold and per-call ceiling.
7. `reserve()` in `BEGIN IMMEDIATE`: project/provider caps, daily count, in-flight count.
8. Provider call. Generation POSTs are retried only on explicit 429/5xx responses or when the
   connection was refused before sending.
9. Write files (exclusive create + temp + rename), register assets, update manifest, store cache.
10. `settle()` with actual cost if the provider reported usage; on error `release()` (certainly not
    billed) or `markUnknown()`.

## Async jobs

`jobs` rows store the provider's resume state (status/result/cancel URLs; never credentials).
`get_job` polls; on completion it downloads outputs (size-capped, HTTPS-only, credentials only
to the provider's own API host), registers them and settles the ledger. A failed download leaves the job `completed`,
so the next `get_job` retries it. Submitted jobs count as committed spend and no longer occupy
the in-flight slot used for images. The number of running jobs is limited separately.

## Blender protocol

One process per operation; ops: `probe`, `build`, `render`, `inspect`, `export`, `inspect_file`,
`thumbnail`. See [blender/README.md](../blender/README.md). The TypeScript side validates specs
with zod (`src/blender/spec.ts`); the Python side re-validates the same limits.

Model versions: `build` always creates a new spec + `.blend` with `parentId` linking to the
previous version. Renders are stored per version (`renders/v003/`), exports per version.

## Adding a provider

Implement `ImageProvider` or `JobProvider` (`src/providers/types.ts`):

- `capabilities()` / `describeModels()`: report only what actually works.
- `validate()`: reject unsupported parameters before spending.
- `estimate()`: return a basis string; throw `PRICE_UNKNOWN` rather than guess.
- HTTP via `core/http.ts` with `idempotent: false` for paid calls.
- Classify errors so `details.billed === false` only when the provider certainly did not charge.

Register it in `src/services/context.ts`, add mocked-HTTP tests like
`tests/unit/gemini.test.ts`, and document pricing in `docs/providers.md`.

## Adding an engine profile

Profiles are pure functions over `SceneStats` (see `src/blender/roblox.ts`). Add the function,
expose it in `ModelService.validate` and the `validate_3d_asset` enum, and test it with synthetic
stats.
