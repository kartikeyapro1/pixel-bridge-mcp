# Security model

PixelBridge runs locally, as your user, launched by an MCP client. The MCP client and the model
driving it are treated as **semi-trusted**: they may make mistakes or be steered by prompt
injection (for example, text inside a generated or downloaded file). The design goal is that such
a client cannot, through PixelBridge:

- execute arbitrary code,
- read or write files outside the project directory,
- exfiltrate API keys,
- spend beyond the configured limits,
- publish anything.

## Controls

| Threat                           | Control                                                                                                                                                                                                                                         | Tested in                                                             |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Arbitrary code execution         | No tool accepts code. Blender models are declarative JSON validated by zod and re-validated in Python. Blender runs with `--factory-startup` (no user add-ons/startup scripts) and `--disable-autoexec` (no Python embedded in `.blend` files). | `tests/unit/spec-roblox.test.ts`, `tests/integration/blender.test.ts` |
| Path traversal / absolute paths  | `ProjectPaths.resolve` rejects anything outside the project root.                                                                                                                                                                               | `tests/unit/paths.test.ts`, `tests/mcp/server.test.ts`                |
| Symlink / junction escapes       | Real path of the deepest existing ancestor must be inside the real project root.                                                                                                                                                                | `tests/unit/paths.test.ts`                                            |
| Malicious input files            | Images verified by magic bytes, 50 MB cap; 3D inputs limited to known extensions.                                                                                                                                                               | `tests/unit/image-service.test.ts`                                    |
| Credential leakage               | Keys only from environment; redaction of known keys, `sk-…`, `Bearer`/`Key` headers and secret query parameters in logs, errors and tool output; secret-named JSON keys are dropped.                                                            | `tests/unit/redact-hash.test.ts`, `tests/mcp/server.test.ts`          |
| Keys at rest                     | Stored in the OS credential store (Windows DPAPI CurrentUser, macOS Keychain, Linux Secret Service), never in project files or config. Passed to helper processes on stdin (as an argument on macOS).                                           | `tests/unit/credentials.test.ts`                                      |
| Key sent to the wrong host       | The Gemini key is only sent to `generativelanguage.googleapis.com` (base URL is checked at startup; file URIs returned by the API are host-checked before download); the OpenAI key only to the OpenAI API. Downloads must be HTTPS.            | `tests/unit/gemini.test.ts`                                           |
| Overspending / race conditions   | Reservation ledger in SQLite under `BEGIN IMMEDIATE`; per-call ceiling, project and provider caps, daily count, in-flight cap.                                                                                                                  | `tests/unit/budget.test.ts` (8-process race)                          |
| Retry storms / duplicate billing | Bounded retries with backoff; paid POSTs never retried after timeouts; request cache.                                                                                                                                                           | `tests/unit/openai-image.test.ts`                                     |
| Oversized downloads              | Size cap (`maxDownloadBytes`), truncation detection.                                                                                                                                                                                            | `tests/unit/gemini.test.ts`                                           |
| Publishing                       | No tool uploads or publishes. Roblox import is manual.                                                                                                                                                                                          | by construction                                                       |
| Network exposure                 | stdio transport only; no listening socket.                                                                                                                                                                                                      | by construction                                                       |

## Not covered

- **Blender is not sandboxed.** It runs with your OS permissions. The protections above limit
  what PixelBridge asks Blender to do; they do not contain a Blender vulnerability triggered by a
  crafted input file. Only inspect 3D files you trust, or run PixelBridge in a VM/container.
- **Local limits are not provider billing caps.** A request that timed out may still be billed.
  Configure limits in provider dashboards too.
- **The MCP client's own tools.** If your agent has shell access, it can do anything your user can;
  PixelBridge does not change that.
- **Generated content.** Providers apply their own moderation; PixelBridge does not.
- **Local database.** `.pixelbridge/pixelbridge.db` contains prompts and metadata (no keys).
  Treat it like any project file.

## Reporting

See [SECURITY.md](../SECURITY.md).
