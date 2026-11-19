# API keys

PixelBridge looks for each key in this order, and uses the first one it finds:

1. **Environment variable** of the server process (`GEMINI_API_KEY`, or the alias `GOOGLE_API_KEY`;
   `OPENAI_API_KEY`). Use this for CI and containers, or to override the stored key for one session.
2. **The OS credential store**, written by `pixelbridge key set`. This is the recommended setup on
   a workstation.

Keys are never read from `pixelbridge.config.json` and never written to project files, logs or tool
output.

## Commands

```bash
pixelbridge key set gemini      # prompt (hidden), store, then verify with a free request
pixelbridge key set openai      # optional second image provider
pixelbridge key status          # where each key comes from: environment | os-store | missing
pixelbridge key test gemini     # free check that the key works (lists models)
pixelbridge key delete gemini
```

`key set` also accepts the key on stdin, which is useful in scripts:

```powershell
# PowerShell: read from a secure prompt without echo or history
$k = Read-Host -AsSecureString; [Net.NetworkCredential]::new('', $k).Password | pixelbridge key set gemini
```

Avoid `echo <key> | …` in an interactive shell, because the key ends up in your shell history.

## Where it is stored

| OS      | Store                                                     | Location                                                                                                       |
| ------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Windows | DPAPI, CurrentUser scope                                  | `%APPDATA%\PixelBridge\credentials\GEMINI_API_KEY.dpapi` (encrypted; only your Windows account can decrypt it) |
| macOS   | Login Keychain                                            | service `pixelbridge`, account `GEMINI_API_KEY`                                                                |
| Linux   | Secret Service (GNOME Keyring, KWallet) via `secret-tool` | service `pixelbridge`, account `GEMINI_API_KEY`                                                                |

On Linux, install `secret-tool` (package `libsecret-tools` on Debian/Ubuntu). Without a credential
store, use an environment variable.

On Windows, `PIXELBRIDGE_CREDENTIALS_DIR` moves the encrypted files elsewhere.

## Rotating a key

1. Create a new key in Google AI Studio.
2. `pixelbridge key set gemini` and paste the new key.
3. Delete the old key in AI Studio.
4. Restart your MCP client, or reconnect the server, so it reads the new key.

If a key is ever exposed (pasted into a chat, committed, shared in a screenshot), rotate it
immediately.

## Why not an environment variable or config file?

A user-level environment variable is stored in plain text and is passed to every program you start,
including build scripts and dependencies. A key in a config file is easy to commit by accident. The
OS store encrypts the key at rest and hands it only to the process that asks for it.

Limits: any program running as your user account can also ask the OS store for the key. That is
the same trust boundary as your other saved credentials. On macOS, the `security` tool receives
the key as a command-line argument while it is being saved, so it is briefly visible to other
processes of your user. On Windows and Linux it is passed on stdin.

## Checking what the server uses

`get_status` (MCP) and `pixelbridge status` include:

```json
"credentials": { "gemini": "os-store", "openai": "missing" }
```

They show only where a key came from, never its value.
