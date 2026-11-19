#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { CONFIG_FILE, resolveProjectRoot, STARTER_CONFIG } from './core/config.js';
import { isPixelBridgeError, PixelBridgeError } from './core/errors.js';
import { redactValue } from './core/redact.js';
import { runMcpServer } from './mcp/run.js';
import { checkKeyShape, defaultSecretStore, resolveSecret, type SecretName } from './core/credentials.js';
import { parseConfig } from './core/config.js';
import { testGeminiKey } from './providers/gemini.js';
import { createInterface } from 'node:readline';
import { assetSummary, PixelBridge, VERSION } from './services/pixelbridge.js';
import type { TurnaroundView } from './services/prompts.js';
import type { ExportFormat, RenderView } from './blender/spec.js';

const HELP = `pixelbridge ${VERSION} — local asset pipeline for AI coding agents

Usage: pixelbridge <command> [options]      (global: --project <dir>, --json)

Setup
  key set gemini|openai        Store an API key in the OS credential store (prompted, hidden)
  key status | key test gemini | key delete gemini|openai
  init                         Write ${CONFIG_FILE} and create the assets directory
  status                       Providers, Blender, budget and missing setup
  serve                        Run the MCP server over stdio (same as pixelbridge-mcp)

Generation (billable; prints an estimate, add --yes to approve)
  image <prompt> -c <collection> [--quality low|medium|high] [--size WxH] [--transparent [--trim]]
        [--out <dir>] [--name <file>] [--model m] [--dry-run] [--yes]
  turnaround <description> -c <collection> [--style s] [--views front,side,back] [--dry-run] [--yes]
  video <prompt> -c <collection> [--image ref]... [--duration 3-15] [--resolution 720p] [--aspect 16:9]
        [--out <dir>] [--name <file>] [--dry-run] [--yes]
  cutout <image> [--out <dir>] [--name <file>] [--trim] [--tolerance 40]   remove a flat background (free)
  jobs | job <jobId> | cancel <jobId>

Blender (local, free)
  build <spec.json> -c <collection> [--ref front=<asset|path>] [--note text]
  render <blendAssetId> [--views front,side,three_quarter] [--resolution 512] [--engine workbench]
  export <blendAssetId> [--formats glb,fbx,obj]
  inspect <asset|path>  |  validate <asset|path>

Registry
  assets [-c collection] [--category c] [--kind k]  |  asset <assetId>  |  budget  |  cache-clear
`;

function out(value: unknown, json: boolean): void {
  const safe = redactValue(value);
  console.log(json ? JSON.stringify(safe) : JSON.stringify(safe, null, 2));
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      project: { type: 'string' },
      json: { type: 'boolean' },
      collection: { type: 'string', short: 'c' },
      category: { type: 'string' },
      kind: { type: 'string' },
      quality: { type: 'string' },
      size: { type: 'string' },
      model: { type: 'string' },
      provider: { type: 'string' },
      style: { type: 'string' },
      views: { type: 'string' },
      image: { type: 'string', multiple: true },
      aspect: { type: 'string' },
      duration: { type: 'string' },
      ref: { type: 'string', multiple: true },
      note: { type: 'string' },
      resolution: { type: 'string' },
      engine: { type: 'string' },
      formats: { type: 'string' },
      out: { type: 'string' },
      name: { type: 'string' },
      transparent: { type: 'boolean' },
      trim: { type: 'boolean' },
      tolerance: { type: 'string' },
      'dry-run': { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  const [cmd, ...rest] = positionals;
  if (values.version) return (console.log(VERSION), 0);
  if (!cmd || values.help || cmd === 'help') return (console.log(HELP), 0);
  const json = !!values.json;
  const projectRoot = resolveProjectRoot(values.project);

  if (cmd === 'serve') {
    await runMcpServer({ projectRoot });
    return -1; // keep running
  }
  if (cmd === 'key') {
    return keyCommand(rest, json);
  }
  if (cmd === 'init') {
    const file = path.join(projectRoot, CONFIG_FILE);
    if (existsSync(file)) {
      console.log(`${CONFIG_FILE} already exists; leaving it unchanged.`);
    } else {
      writeFileSync(file, JSON.stringify(STARTER_CONFIG, null, 2) + '\n');
      console.log(`Wrote ${file}`);
    }
    const pb = new PixelBridge({ projectRoot });
    pb.ensureDirs();
    pb.close();
    const gi = path.join(projectRoot, '.gitignore');
    const hasIgnore = existsSync(gi) && readFileSync(gi, 'utf8').includes('.pixelbridge');
    if (!hasIgnore)
      console.log('Tip: add ".pixelbridge/" to .gitignore (local database, temp files and thumbnails).');
    return 0;
  }

  const pb = new PixelBridge({ projectRoot });
  const need = (v: string | undefined, what: string): string => {
    if (!v) throw new PixelBridgeError('INVALID_INPUT', `Missing ${what}. See: pixelbridge --help`);
    return v;
  };
  // In the CLI the human at the terminal approves with --yes; the estimate is the confirmed amount.
  const confirm = async (quote: () => number): Promise<number | undefined> =>
    values.yes ? quote() : undefined;
  // With --out, the collection defaults to the output folder's name.
  const collectionOrOut = () =>
    values.collection ??
    (values.out ? path.basename(path.resolve(values.out)) : need(undefined, '--collection'));
  const list = (s: string | undefined) =>
    s
      ? s
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean)
      : undefined;

  try {
    switch (cmd) {
      case 'status':
      case 'doctor':
        out(await pb.status(), json);
        return 0;
      case 'budget':
        out({ summary: pb.ctx.budget.summary(), recent: pb.ctx.budget.recent(20) }, json);
        return 0;
      case 'assets':
        out(
          pb.ctx.registry
            .list({
              ...(values.collection ? { collection: values.collection } : {}),
              ...(values.category ? { category: values.category } : {}),
              ...(values.kind ? { kind: values.kind } : {}),
              limit: 200,
            })
            .map(assetSummary),
          json,
        );
        return 0;
      case 'asset':
        out(pb.ctx.registry.get(need(rest[0], 'asset id')), json);
        return 0;
      case 'cache-clear':
        out({ removed: pb.ctx.registry.cacheClear() }, json);
        return 0;
      case 'image': {
        const req = {
          prompt: need(rest.join(' '), 'prompt'),
          collection: collectionOrOut(),
          ...(values.transparent ? { background: 'transparent' as const } : {}),
          ...(values.trim ? { trim: true } : {}),
          ...(values.out ? { outputDir: values.out } : {}),
          ...(values.name ? { fileName: values.name } : {}),
          ...(values.quality ? { quality: values.quality as 'low' | 'medium' | 'high' } : {}),
          ...(values.size ? { size: values.size } : {}),
          ...(values.model ? { model: values.model } : {}),
          ...(values.provider ? { provider: values.provider } : {}),
          dryRun: !!values['dry-run'],
        };
        const confirmCostUsd = await confirm(() => pb.images.quote(req, 'generate').estimatedUsd);
        const r = await pb.images.generate({
          ...req,
          ...(confirmCostUsd !== undefined ? { confirmCostUsd } : {}),
        });
        out({ ...r, assets: r.assets.map(assetSummary) }, json);
        return 0;
      }
      case 'turnaround': {
        const base = {
          collection: need(values.collection, '--collection'),
          description: need(rest.join(' '), 'description'),
          ...(values.style ? { style: values.style } : {}),
          ...(values.views ? { views: list(values.views) as TurnaroundView[] } : {}),
          ...(values.model ? { model: values.model } : {}),
          ...(values.provider ? { provider: values.provider } : {}),
          ...(values.quality ? { quality: values.quality as 'low' | 'medium' | 'high' } : {}),
        };
        const quote = await pb.images.turnaround({ ...base, dryRun: true });
        if (values['dry-run']) return (out(quote, json), 0);
        const r = await pb.images.turnaround({
          ...base,
          ...(values.yes ? { confirmCostUsd: quote.totalEstimateUsd } : {}),
        });
        out(r, json);
        return r.status === 'generated' ? 0 : 1;
      }
      case 'video': {
        const req = {
          kind: 'video' as const,
          prompt: need(rest.join(' '), 'prompt'),
          collection: collectionOrOut(),
          ...(values.out ? { outputDir: values.out } : {}),
          ...(values.name ? { fileName: values.name } : {}),
          ...(values.image?.length ? { images: values.image } : {}),
          ...(values.duration ? { durationSeconds: Number(values.duration) } : {}),
          ...(values.resolution ? { resolution: values.resolution } : {}),
          ...(values.aspect ? { aspectRatio: values.aspect } : {}),
          ...(values.model ? { model: values.model } : {}),
          ...(values.provider ? { provider: values.provider } : {}),
        };
        const quote = await pb.jobs.submit({ ...req, dryRun: true });
        if (values['dry-run'] || quote.status === 'cached') return (out(quote, json), 0);
        out(
          await pb.jobs.submit({
            ...req,
            ...(values.yes ? { confirmCostUsd: quote.estimate.estimatedUsd } : {}),
          }),
          json,
        );
        return 0;
      }
      case 'cutout': {
        const res = await pb.images.removeBackground({
          image: need(rest[0], 'image (asset id or path)'),
          ...(values.out ? { outputDir: values.out } : {}),
          ...(values.name ? { fileName: values.name } : {}),
          ...(values.trim ? { trim: true } : {}),
          ...(values.tolerance ? { tolerance: Number(values.tolerance) } : {}),
          ...(values.collection ? { collection: values.collection } : {}),
        });
        out({ ...res, asset: assetSummary(res.asset) }, json);
        return 0;
      }
      case 'jobs':
        out(pb.jobs.list({ limit: 50 }), json);
        return 0;
      case 'job':
        out(await pb.jobs.refresh(need(rest[0], 'job id')), json);
        return 0;
      case 'cancel':
        out(await pb.jobs.cancel(need(rest[0], 'job id')), json);
        return 0;
      case 'build': {
        const specPath = need(rest[0], 'spec file');
        const spec = JSON.parse(readFileSync(path.resolve(specPath), 'utf8')) as unknown;
        const references = (values.ref ?? []).map((r) => {
          const [view, image] = r.split('=');
          if (!image || !['front', 'side', 'back'].includes(view ?? '')) {
            throw new PixelBridgeError(
              'INVALID_INPUT',
              `--ref must look like front=<asset|path>, got "${r}"`,
            );
          }
          return { view: view as 'front' | 'side' | 'back', image };
        });
        const r = await pb.models.build({
          collection: need(values.collection, '--collection'),
          spec,
          references,
          ...(values.category ? { category: values.category as 'characters' } : {}),
          ...(values.note ? { note: values.note } : {}),
        });
        out(
          {
            version: r.version,
            blend: assetSummary(r.blend),
            totals: r.stats.totals,
            validation: r.validation,
            warnings: r.warnings,
            durationMs: r.durationMs,
          },
          json,
        );
        return 0;
      }
      case 'render': {
        const r = await pb.models.render({
          blendAssetId: need(rest[0], 'blend asset id'),
          ...(values.views ? { views: list(values.views) as RenderView[] } : {}),
          ...(values.resolution ? { resolution: Number(values.resolution) } : {}),
          ...(values.engine ? { engine: values.engine as 'workbench' } : {}),
        });
        out({ renders: r.renders.map(assetSummary), durationMs: r.durationMs, warnings: r.warnings }, json);
        return 0;
      }
      case 'export': {
        const r = await pb.models.export({
          blendAssetId: need(rest[0], 'blend asset id'),
          ...(values.formats ? { formats: list(values.formats) as ExportFormat[] } : {}),
        });
        out(
          r.exports.map((x) => ({
            format: x.format,
            asset: assetSummary(x.asset),
            totals: x.stats.totals,
            validation: x.validation,
          })),
          json,
        );
        return r.exports.every((x) => x.validation.ok) ? 0 : 1;
      }
      case 'inspect':
        out(await pb.models.inspect(need(rest[0], 'target')), json);
        return 0;
      case 'validate': {
        const r = await pb.models.validate(need(rest[0], 'target'));
        out({ totals: r.stats.totals, report: r.report }, json);
        return r.report.ok ? 0 : 1;
      }
      default:
        console.error(`Unknown command "${cmd}".\n\n${HELP}`);
        return 2;
    }
  } finally {
    pb.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exitCode = code;
  },
  (e: unknown) => {
    if (isPixelBridgeError(e)) {
      console.error(JSON.stringify(redactValue({ error: e.toJSON() }), null, 2));
      process.exitCode = e.code === 'APPROVAL_REQUIRED' ? 3 : 1;
    } else {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    }
  },
);

// ---- key management -----------------------------------------------------------

/** Read a secret without echoing it (TTY), or from piped stdin. */
async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8').trim();
  }
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const rlAny = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    let muted = false;
    rlAny._writeToOutput = (str: string) => {
      if (!muted) rlAny.output.write(str);
    };
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer.trim());
    });
    muted = true;
  });
}

async function keyCommand(args: string[], json: boolean): Promise<number> {
  const KEY_NAMES: Record<string, SecretName> = { gemini: 'GEMINI_API_KEY', openai: 'OPENAI_API_KEY' };
  const [action, providerArg] = args;
  const store = defaultSecretStore();
  const provider = providerArg ?? 'gemini';
  const name = KEY_NAMES[provider];
  if (action !== 'status' && !name) {
    throw new PixelBridgeError('INVALID_INPUT', `Unknown provider "${provider}". Use gemini or openai.`);
  }
  if (!store && action !== 'status') {
    throw new PixelBridgeError('CONFIG_INVALID', 'No OS credential store is available on this system.', {
      hint: 'Set the key as an environment variable for the MCP server instead (e.g. GEMINI_API_KEY).',
    });
  }
  switch (action) {
    case 'set': {
      const value = await readSecret(`Paste your ${provider} API key (input hidden): `);
      checkKeyShape(value);
      store!.set(name!, value);
      const result: Record<string, unknown> = {
        stored: name,
        store: store!.name,
        location: store!.location(),
      };
      if (provider === 'gemini') {
        const t = await testGeminiKey(parseConfig({}).providers.gemini, value);
        result.keyCheck = t.ok ? `valid (${t.models} models visible)` : `failed: ${t.error}`;
      }
      if (process.env[name!]) {
        result.note = `${name} is also set as an environment variable, which takes precedence. Remove it to use the stored key.`;
      }
      out(result, json);
      return 0;
    }
    case 'status': {
      const status: Record<string, unknown> = {
        store: store ? `${store.name} (${store.location()})` : 'none',
      };
      for (const [p, n] of Object.entries(KEY_NAMES)) {
        const aliases = p === 'gemini' ? ['GEMINI_API_KEY', 'GOOGLE_API_KEY'] : [n];
        status[p] = resolveSecret(aliases, process.env, store, n).source;
      }
      out(status, json);
      return 0;
    }
    case 'test': {
      if (provider !== 'gemini')
        throw new PixelBridgeError('INVALID_INPUT', 'Only the gemini key can be tested.');
      const { value, source } = resolveSecret(
        ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
        process.env,
        store,
        name!,
      );
      if (!value)
        throw new PixelBridgeError(
          'PROVIDER_NOT_CONFIGURED',
          'No Gemini key found. Run: pixelbridge key set gemini',
        );
      const t = await testGeminiKey(parseConfig({}).providers.gemini, value);
      out({ source, ...(t.ok ? { valid: true, models: t.models } : { valid: false, error: t.error }) }, json);
      return t.ok ? 0 : 1;
    }
    case 'delete':
      out({ deleted: store!.delete(name!), name }, json);
      return 0;
    default:
      throw new PixelBridgeError(
        'INVALID_INPUT',
        'Usage: pixelbridge key set|status|test|delete [gemini|openai]',
      );
  }
}
