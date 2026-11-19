# Getting started

This takes about five minutes. You need Node.js 22.15+ and, for images and video, a Gemini API key.
Blender 4.2+ is optional and only needed for the 3D tools.

## 1. Install

```bash
git clone https://github.com/<you>/pixelbridge-mcp.git
cd pixelbridge-mcp
npm ci
npm run build
```

`dist/mcp-entry.js` is the MCP server and `dist/cli.js` is the command-line tool. The rest of
this guide writes `pixelbridge` for `node /path/to/pixelbridge-mcp/dist/cli.js`. Run `npm link`
in the repository if you want an actual `pixelbridge` command on your PATH.

## 2. Get a Gemini API key

1. Open [Google AI Studio](https://aistudio.google.com) and create an API key.
2. Enable billing on the key's Google Cloud project. The image and video models used here have no
   free tier, so requests fail without billing.
3. Optional but recommended: set a budget alert in Google Cloud billing.

## 3. Store the key

```bash
pixelbridge key set gemini
```

Paste the key when prompted (input is hidden). PixelBridge encrypts it in your OS credential store
and confirms it with a free request:

```json
{ "stored": "GEMINI_API_KEY", "store": "windows-dpapi", "keyCheck": "valid (65 models visible)" }
```

Details and alternatives (environment variables, CI): [credentials.md](credentials.md).

## 4. Connect an MCP client

PixelBridge is a standard stdio MCP server. Every client needs the same three things:

| Setting        | Value                                                     |
| -------------- | --------------------------------------------------------- |
| command        | `node`                                                    |
| args           | `["/absolute/path/to/pixelbridge-mcp/dist/mcp-entry.js"]` |
| env (optional) | `PIXELBRIDGE_PROJECT_ROOT` to pin the project directory   |

### Clients that use an `mcpServers` JSON file

Most desktop and IDE clients read a JSON file with this shape (the file name and location depend
on the client; a project-level file is usually `.mcp.json`, `.cursor/mcp.json` or similar):

```json
{
  "mcpServers": {
    "pixelbridge": {
      "command": "node",
      "args": ["/absolute/path/to/pixelbridge-mcp/dist/mcp-entry.js"]
    }
  }
}
```

### VS Code (built-in MCP support)

`.vscode/mcp.json` in your project:

```json
{
  "servers": {
    "pixelbridge": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/pixelbridge-mcp/dist/mcp-entry.js"]
    }
  }
}
```

### Clients with a command-line `mcp add`

Use the client's add command with the same command and args, for example:

```bash
<client> mcp add pixelbridge -- node /absolute/path/to/pixelbridge-mcp/dist/mcp-entry.js
```

Copies of these snippets are in [`examples/mcp-clients/`](../examples/mcp-clients).

**Which project does it write to?** By default, the directory the client starts the server in
(normally the open project). If your client starts servers elsewhere, set
`PIXELBRIDGE_PROJECT_ROOT` in the server's `env`.

Restart the client after adding the server. If the tools don't appear, see
[troubleshooting.md](troubleshooting.md).

## 5. First run

In your project:

```bash
pixelbridge init                     # optional: writes pixelbridge.config.json
echo ".pixelbridge/" >> .gitignore   # local database and temp files
```

Then ask your agent:

> Call PixelBridge get_status and tell me what is configured.

`setup` in the result lists anything still missing. Then try:

> Generate a pixel-art health potion icon in the "props" category.

The image appears under `assets/props/…/references/`, and `get_budget` shows what it cost.

## 6. Optional: Blender

Install Blender 4.2 or newer (verified on 5.3). PixelBridge finds it in standard install
locations or on PATH. Otherwise set `blender.path` in `pixelbridge.config.json` or `BLENDER_PATH`.
Then try:

> Read the PixelBridge model spec guide, build a low-poly wooden crate in "props", render previews,
> and export a glb.

## Trying it without a key

Add `"env": { "PIXELBRIDGE_MOCK": "1" }` to the server entry. The mock provider writes placeholder
images and fake video files and charges a fake $0.01 per call, so budgets, caching and the Blender
pipeline can all be exercised offline. Mock outputs are tagged `mock: true`.
