import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PixelBridgeConfig } from '../core/config.js';
import { PixelBridgeError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import type { ProjectPaths } from '../core/paths.js';

/**
 * Runs Blender headlessly, one process per operation:
 *
 *   blender --background --factory-startup --disable-autoexec \
 *           --python blender/pixelbridge_bpy.py -- request.json response.json
 *
 * --factory-startup ignores user preferences, add-ons and startup scripts;
 * --disable-autoexec stops Python embedded in .blend files from running.
 * The script interprets a fixed set of declarative operations; there is no
 * "run arbitrary Python" tool. This is a trust boundary, not a sandbox: Blender
 * still runs with the user's OS privileges.
 */

export const BLENDER_SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'blender',
  'pixelbridge_bpy.py',
);

export interface BlenderInfo {
  found: boolean;
  path: string | null;
  version: string | null;
  source: 'config' | 'path' | 'standard-location' | null;
  supported: boolean;
  message: string;
}

/** Oldest Blender version the bundled script is tested against. */
export const MIN_BLENDER = [4, 2] as const;

type ExecFn = (
  file: string,
  args: string[],
  opts: { timeout: number; windowsHide: boolean; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }>;

const defaultExec: ExecFn = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(file, args, { ...opts, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
      const err = error as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
      resolve({
        stdout: String(stdout),
        stderr: String(stderr),
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        timedOut: !!err?.killed,
      });
    });
  });

export class BlenderService {
  private cached: BlenderInfo | null = null;

  constructor(
    private readonly cfg: PixelBridgeConfig['blender'],
    private readonly paths: ProjectPaths,
    private readonly logger: Logger,
    private readonly exec: ExecFn = defaultExec,
  ) {}

  candidates(): { path: string; source: BlenderInfo['source'] }[] {
    const out: { path: string; source: BlenderInfo['source'] }[] = [];
    if (this.cfg.path) out.push({ path: this.cfg.path, source: 'config' });
    const exe = process.platform === 'win32' ? 'blender.exe' : 'blender';
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
      if (dir) out.push({ path: path.join(dir, exe), source: 'path' });
    }
    if (process.platform === 'win32') {
      for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
        const root = base ? path.join(base, 'Blender Foundation') : null;
        if (root && existsSync(root)) {
          const dirs = readdirSync(root).sort(compareVersionDirs);
          for (const d of dirs)
            out.push({ path: path.join(root, d, 'blender.exe'), source: 'standard-location' });
        }
      }
      const steam = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Blender\\blender.exe';
      out.push({ path: steam, source: 'standard-location' });
    } else if (process.platform === 'darwin') {
      out.push({ path: '/Applications/Blender.app/Contents/MacOS/Blender', source: 'standard-location' });
    } else {
      for (const p of [
        '/usr/bin/blender',
        '/usr/local/bin/blender',
        '/snap/bin/blender',
        '/opt/blender/blender',
      ]) {
        out.push({ path: p, source: 'standard-location' });
      }
    }
    return out;
  }

  async detect(force = false): Promise<BlenderInfo> {
    if (this.cached && !force) return this.cached;
    for (const c of this.candidates()) {
      if (!existsSync(c.path)) {
        if (c.source === 'config') {
          return (this.cached = {
            found: false,
            path: c.path,
            version: null,
            source: 'config',
            supported: false,
            message: `Configured Blender path does not exist: ${c.path}`,
          });
        }
        continue;
      }
      const res = await this.exec(c.path, ['--version'], {
        timeout: 30_000,
        windowsHide: true,
        maxBuffer: 1 << 20,
      });
      const m = /Blender\s+(\d+)\.(\d+)(?:\.(\d+))?/.exec(res.stdout);
      if (!m) continue;
      const version = `${m[1]}.${m[2]}.${m[3] ?? '0'}`;
      const major = Number(m[1]);
      const minor = Number(m[2]);
      const supported = major > MIN_BLENDER[0] || (major === MIN_BLENDER[0] && minor >= MIN_BLENDER[1]);
      return (this.cached = {
        found: true,
        path: c.path,
        version,
        source: c.source,
        supported,
        message: supported
          ? `Blender ${version} found.`
          : `Blender ${version} found, but ${MIN_BLENDER.join('.')}+ is required.`,
      });
    }
    return (this.cached = {
      found: false,
      path: null,
      version: null,
      source: null,
      supported: false,
      message:
        'Blender not found. Install Blender 4.2+ or set BLENDER_PATH / blender.path in pixelbridge.config.json.',
    });
  }

  /** Run one bundled-script operation. Request/response go through temp JSON files. */
  async run<T = Record<string, unknown>>(
    op: string,
    request: Record<string, unknown>,
  ): Promise<{ result: T; warnings: string[]; durationMs: number }> {
    const info = await this.detect();
    if (!info.found || !info.path) throw new PixelBridgeError('BLENDER_NOT_FOUND', info.message);
    if (!info.supported) throw new PixelBridgeError('BLENDER_NOT_FOUND', info.message);
    if (!existsSync(BLENDER_SCRIPT)) {
      throw new PixelBridgeError('INTERNAL', `Bundled Blender script missing at ${BLENDER_SCRIPT}.`);
    }
    const tmpDir = this.paths.resolve(path.join('.pixelbridge', 'tmp'), 'temp directory');
    mkdirSync(tmpDir, { recursive: true });
    const id = randomUUID();
    const reqFile = path.join(tmpDir, `${id}-req.json`);
    const resFile = path.join(tmpDir, `${id}-res.json`);
    writeFileSync(reqFile, JSON.stringify({ op, ...request }));
    const started = Date.now();
    try {
      const res = await this.exec(
        info.path,
        [
          '--background',
          '--factory-startup',
          '--disable-autoexec',
          '--python',
          BLENDER_SCRIPT,
          '--',
          reqFile,
          resFile,
        ],
        { timeout: this.cfg.timeoutMs, windowsHide: true, maxBuffer: 16 << 20 },
      );
      const durationMs = Date.now() - started;
      if (res.timedOut) {
        throw new PixelBridgeError(
          'BLENDER_TIMEOUT',
          `Blender "${op}" exceeded ${Math.round(this.cfg.timeoutMs / 1000)}s.`,
          {
            hint: 'Reduce render resolution/subdivision, or raise blender.timeoutMs.',
          },
        );
      }
      if (!existsSync(resFile)) {
        const tail = (res.stderr || res.stdout).split(/\r?\n/).filter(Boolean).slice(-8).join('\n');
        throw new PixelBridgeError(
          'BLENDER_FAILED',
          `Blender exited (code ${res.code}) without a result for "${op}".`,
          {
            details: { output: tail },
          },
        );
      }
      const parsed = JSON.parse(readFileSync(resFile, 'utf8')) as
        | { ok: true; result: T; warnings?: string[] }
        | { ok: false; error: { code: string; message: string } };
      if (!parsed.ok) {
        throw new PixelBridgeError(
          parsed.error.code === 'INVALID_SPEC' ? 'INVALID_INPUT' : 'BLENDER_FAILED',
          `Blender ${op}: ${parsed.error.message}`,
          { details: { blenderCode: parsed.error.code } },
        );
      }
      this.logger.debug('blender op complete', { op, durationMs });
      return { result: parsed.result, warnings: parsed.warnings ?? [], durationMs };
    } finally {
      rmSync(reqFile, { force: true });
      rmSync(resFile, { force: true });
    }
  }
}

function compareVersionDirs(a: string, b: string): number {
  const va = (/(\d+)\.(\d+)/.exec(a) ?? []).slice(1).map(Number);
  const vb = (/(\d+)\.(\d+)/.exec(b) ?? []).slice(1).map(Number);
  return (vb[0] ?? 0) - (va[0] ?? 0) || (vb[1] ?? 0) - (va[1] ?? 0);
}
