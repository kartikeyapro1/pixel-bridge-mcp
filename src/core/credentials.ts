import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PixelBridgeError } from './errors.js';

/**
 * API keys stored in the operating system's protected credential store, so they
 * never need to live in config files, shell profiles or plaintext environment
 * variables:
 *
 *  - Windows: DPAPI (CurrentUser). The encrypted blob lives in
 *    %APPDATA%\PixelBridge\credentials and only the same Windows account can decrypt it.
 *  - macOS:   the login Keychain (`security` CLI).
 *  - Linux:   the Secret Service / GNOME Keyring (`secret-tool`, from libsecret).
 *
 * Secret values are passed to helper processes on stdin, never as arguments, except
 * on macOS where `security` only accepts the value as an argument (briefly visible to
 * other processes of the same user).
 */

export const SECRET_NAMES = ['GEMINI_API_KEY', 'OPENAI_API_KEY'] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

export interface SecretStore {
  readonly name: string;
  available(): boolean;
  get(name: SecretName): string | null;
  set(name: SecretName, value: string): void;
  delete(name: SecretName): boolean;
  location(): string;
}

const SERVICE = 'pixelbridge';

// DPAPI via .NET directly (no PowerShell modules needed). CurrentUser scope with a
// fixed entropy value; data travels on stdin/stdout only.
const DPAPI_PRELUDE =
  "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; " +
  "$ent=[Text.Encoding]::UTF8.GetBytes('pixelbridge-credential-v1'); " +
  '$in=[Console]::In.ReadToEnd().Trim(); ';
const DPAPI_PROTECT =
  DPAPI_PRELUDE +
  '$p=[Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($in),$ent,' +
  '[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($p))';
const DPAPI_UNPROTECT =
  DPAPI_PRELUDE +
  '$u=[Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($in),$ent,' +
  '[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($u))';

function run(cmd: string, args: string[], input?: string): { ok: boolean; stdout: string; stderr: string } {
  // Drop PSModulePath: when launched from PowerShell 7, Windows PowerShell 5.1 would
  // otherwise inherit 7's module path and fail to load its own modules.
  const env = { ...process.env };
  delete env.PSModulePath;
  const r = spawnSync(cmd, args, {
    input,
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
  });
  return { ok: r.status === 0 && !r.error, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export class WindowsDpapiStore implements SecretStore {
  readonly name = 'windows-dpapi';
  constructor(private readonly dir = defaultWindowsDir()) {}

  private file(name: SecretName): string {
    return path.join(this.dir, `${name}.dpapi`);
  }

  location(): string {
    return this.dir;
  }

  available(): boolean {
    return process.platform === 'win32';
  }

  get(name: SecretName): string | null {
    const file = this.file(name);
    if (!existsSync(file)) return null;
    const blob = readFileSync(file, 'utf8').trim();
    const r = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', DPAPI_UNPROTECT], blob);
    if (!r.ok) {
      throw new PixelBridgeError('CONFIG_INVALID', `Could not decrypt the stored ${name}.`, {
        hint: 'It may have been saved by another Windows account. Run "pixelbridge key set" again.',
      });
    }
    return r.stdout.trim() || null;
  }

  set(name: SecretName, value: string): void {
    const r = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', DPAPI_PROTECT], value);
    const blob = r.stdout.trim();
    if (!r.ok || !/^[A-Za-z0-9+/=]+$/.test(blob)) {
      throw new PixelBridgeError('INTERNAL', 'Windows DPAPI encryption failed.', {
        details: { stderr: r.stderr.slice(0, 300) },
      });
    }
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.file(name), blob + '\n', { mode: 0o600 });
  }

  delete(name: SecretName): boolean {
    const file = this.file(name);
    if (!existsSync(file)) return false;
    rmSync(file);
    return true;
  }
}

export class MacKeychainStore implements SecretStore {
  readonly name = 'macos-keychain';
  location(): string {
    return `login keychain, service "${SERVICE}"`;
  }
  available(): boolean {
    return process.platform === 'darwin' && run('security', ['help']).stderr !== undefined;
  }
  get(name: SecretName): string | null {
    const r = run('security', ['find-generic-password', '-s', SERVICE, '-a', name, '-w']);
    return r.ok ? r.stdout.trim() || null : null;
  }
  set(name: SecretName, value: string): void {
    const r = run('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', name, '-w', value]);
    if (!r.ok) throw new PixelBridgeError('INTERNAL', `Keychain write failed: ${r.stderr.slice(0, 200)}`);
  }
  delete(name: SecretName): boolean {
    return run('security', ['delete-generic-password', '-s', SERVICE, '-a', name]).ok;
  }
}

export class LinuxSecretToolStore implements SecretStore {
  readonly name = 'linux-secret-service';
  location(): string {
    return `Secret Service, service "${SERVICE}"`;
  }
  available(): boolean {
    return process.platform === 'linux' && run('secret-tool', ['--version']).ok;
  }
  get(name: SecretName): string | null {
    const r = run('secret-tool', ['lookup', 'service', SERVICE, 'account', name]);
    return r.ok ? r.stdout.trim() || null : null;
  }
  set(name: SecretName, value: string): void {
    const r = run(
      'secret-tool',
      ['store', `--label=PixelBridge ${name}`, 'service', SERVICE, 'account', name],
      value,
    );
    if (!r.ok) throw new PixelBridgeError('INTERNAL', `secret-tool failed: ${r.stderr.slice(0, 200)}`);
  }
  delete(name: SecretName): boolean {
    return run('secret-tool', ['clear', 'service', SERVICE, 'account', name]).ok;
  }
}

function defaultWindowsDir(): string {
  if (process.env.PIXELBRIDGE_CREDENTIALS_DIR) return process.env.PIXELBRIDGE_CREDENTIALS_DIR;
  const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'PixelBridge', 'credentials');
}

/** The protected store for this OS, or null if none is available. */
export function defaultSecretStore(): SecretStore | null {
  for (const s of [new WindowsDpapiStore(), new MacKeychainStore(), new LinuxSecretToolStore()]) {
    try {
      if (s.available()) return s;
    } catch {
      /* not available */
    }
  }
  return null;
}

export type SecretSource = 'environment' | 'os-store' | 'missing';

/** Environment variables win (explicit per-process override); then the OS store. */
export function resolveSecret(
  names: string[],
  env: NodeJS.ProcessEnv,
  store: SecretStore | null,
  storeName: SecretName,
): { value: string | undefined; source: SecretSource } {
  for (const n of names) {
    const v = env[n];
    if (v) return { value: v, source: 'environment' };
  }
  if (store) {
    try {
      const v = store.get(storeName);
      if (v) return { value: v, source: 'os-store' };
    } catch {
      /* unreadable store entry: treat as missing; `pixelbridge key status` explains */
    }
  }
  return { value: undefined, source: 'missing' };
}

/** Basic sanity check before storing; real validation is `pixelbridge key test`. */
export function checkKeyShape(value: string): void {
  if (!value || /\s/.test(value) || value.length < 20 || value.length > 300) {
    throw new PixelBridgeError(
      'INVALID_INPUT',
      'That does not look like an API key (expected 20-300 characters, no spaces).',
    );
  }
}
