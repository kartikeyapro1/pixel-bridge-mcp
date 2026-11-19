# Releasing

Versioning follows [SemVer](https://semver.org). While < 1.0, minor versions may change tool
schemas; such changes are listed in CHANGELOG.md.

## Checklist

1. `main` is green in CI (Ubuntu + Windows, Node 22 and 24).
2. Run the Blender integration tests locally with a real Blender: `npm test` (check that the
   Blender tests ran, not skipped).
3. Optionally run a **budget-capped live smoke test** with real keys in a scratch project:
   `pixelbridge image "test" -c smoke --quality low --yes` (≈$0.006) and confirm the ledger's
   actual cost matches the provider dashboard.
4. Re-check transcribed prices in `src/providers/openai-pricing.ts`; update `PRICING_SOURCE_DATE`.
5. Update `version` in `package.json` and `VERSION` in `src/services/pixelbridge.ts`.
6. Move "Unreleased" entries in CHANGELOG.md under the new version with the date.
7. `npm run check` and `npm pack --dry-run`. Inspect the file list: no `.env`, no `assets/`,
   no `.pixelbridge/`.
8. Commit `release: vX.Y.Z`, tag `vX.Y.Z`, push the tag.
9. **Publishing to npm requires the maintainer's explicit approval**: `npm publish --access public`
   (with 2FA). The repository and package stay private until the maintainer decides otherwise.

## Before the first public release

- [ ] Live-verify the OpenAI adapter (generate + edit) with a low-quality request.
- [ ] Live-verify at least one fal video model and one fal 3D model; record working field mappings
      in docs/providers.md.
- [ ] Test Blender 4.2 LTS (declared minimum) or raise the minimum.
- [ ] Run the MCP server from a real Claude Code session end to end.
- [ ] Decide the public repository name and npm package name (`pixelbridge-mcp` is free on GitHub
      under the owner account at time of writing; check npm).
- [ ] Enable GitHub private vulnerability reporting.
