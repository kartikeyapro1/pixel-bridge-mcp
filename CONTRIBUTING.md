# Contributing

Thanks for helping. PixelBridge values correctness, safety and honest behaviour over feature
count. A small, well-tested change is more welcome than a large one.

## Setup

```bash
npm ci
npm run build
npm run check      # typecheck, lint, format check, tests, build
```

Install Blender 4.2+ to run the integration tests (auto-detected, or set `BLENDER_PATH`). Without
Blender those tests are reported as **skipped**, which is fine for most changes outside
`blender/` and `src/services/model-service.ts`.

## Ground rules

- **No paid API calls in tests or CI.** Use the mock providers or the `fakeFetch` helper.
- **No new tools that execute arbitrary code** or touch paths outside the project root.
- **Never guess prices.** If a provider price is unknown, the code must refuse (`PRICE_UNKNOWN`).
- **Don't overstate capabilities** in tool descriptions or docs. If something is heuristic or
  unverified, say so.
- Keep business logic in `src/services/`; MCP and CLI layers stay thin.
- Add tests for behaviour changes, including failure paths.

## Good first contributions

- Field mappings and verified pricing notes for fal models you have used (docs/providers.md).
- New engine validation profiles (Godot, Unity) in the style of `src/blender/roblox.ts`.
- Additional example specs in `examples/specs/` (original designs only).
- Blender version compatibility fixes (tested on the version you fix).
- A provider adapter for a direct video API, behind `JobProvider`.

## Pull requests

- Branch from `main`; one topic per PR.
- Describe what you tested and how (include whether Blender tests ran).
- Update CHANGELOG.md under "Unreleased".
- Commits: imperative mood, explain _why_ in the body when not obvious.

## Licensing of contributions

Contributions are accepted under Apache-2.0, except changes to `blender/pixelbridge_bpy.py`,
which is GPL-3.0-or-later.
