import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { PixelBridgeError } from '../../src/core/errors.js';
import { createServer } from '../../src/mcp/server.js';
import { MockImageProvider } from '../../src/providers/mock.js';
import { makeBridge, type TestBridge } from '../helpers.js';

type TextResult = { content: { type: string; text?: string; data?: string }[]; isError?: boolean };

async function connect(t: TestBridge) {
  const server = createServer(t.pb);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientT);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as TextResult;
    const text = r.content.find((c) => c.type === 'text')?.text ?? '{}';
    return { raw: r, isError: !!r.isError, json: JSON.parse(text) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  return { client, call, close: () => client.close() };
}

describe('MCP server', () => {
  let t: TestBridge;
  afterEach(() => t?.done());

  it('registers the expected tools with descriptions and schemas', async () => {
    t = makeBridge();
    const { client, close } = await connect(t);
    const { tools } = await client.listTools();
    const names = tools.map((x) => x.name).sort();
    expect(names).toEqual(
      [
        'build_blender_model',
        'cancel_job',
        'edit_image',
        'export_3d_asset',
        'generate_3d_from_image',
        'generate_character_turnaround',
        'generate_image',
        'generate_video',
        'get_asset',
        'get_budget',
        'get_job',
        'get_model_spec_guide',
        'get_status',
        'inspect_3d_asset',
        'list_assets',
        'list_jobs',
        'render_model_previews',
        'validate_3d_asset',
      ].sort(),
    );
    for (const tool of tools) {
      expect(tool.description?.length ?? 0).toBeGreaterThan(30);
      expect(tool.inputSchema.type).toBe('object');
    }
    const gen = tools.find((x) => x.name === 'generate_image')!;
    expect(gen.annotations?.openWorldHint).toBe(true);
    expect(Object.keys(gen.inputSchema.properties ?? {})).toContain('confirmCostUsd');
    await close();
  });

  it('get_status reports providers and budget', async () => {
    t = makeBridge();
    const { call, close } = await connect(t);
    const r = await call('get_status');
    expect(r.isError).toBe(false);
    expect(r.json.imageProviders[0].id).toBe('mock');
    expect(r.json.budget.projectLimitUsd).toBe(5);
    await close();
  });

  it('generates an image and lists it', async () => {
    t = makeBridge();
    const { call, close } = await connect(t);
    const gen = await call('generate_image', { prompt: 'a cat', collection: 'pip' });
    expect(gen.isError).toBe(false);
    expect(gen.json.status).toBe('generated');
    const id = gen.json.assets[0].id as string;
    const list = await call('list_assets', { collection: 'pip' });
    expect(list.json.assets.map((a: { id: string }) => a.id)).toEqual([id]);
    const meta = await call('get_asset', { assetId: id });
    expect(meta.json.prompt).toBe('a cat');
    await close();
  });

  it('returns structured, actionable errors', async () => {
    t = makeBridge({
      config: {
        providers: { mock: { enabled: true, costPerCallUsd: 1 } },
        budget: { approvalThresholdUsd: 0.25 },
      },
    });
    const { call, close } = await connect(t);
    const r = await call('generate_image', { prompt: 'x', collection: 'c' });
    expect(r.isError).toBe(true);
    expect(r.json.error.code).toBe('APPROVAL_REQUIRED');
    expect(r.json.error.hint).toMatch(/confirmCostUsd/);
    const missing = await call('get_asset', { assetId: 'ast_0000000000000000' });
    expect(missing.json.error.code).toBe('NOT_FOUND');
    await close();
  });

  it('rejects invalid input via schema validation', async () => {
    t = makeBridge();
    const { client, close } = await connect(t);
    const r = (await client.callTool({ name: 'generate_image', arguments: { prompt: 'x' } })) as TextResult;
    expect(r.isError).toBe(true);
    const r2 = (await client.callTool({
      name: 'generate_image',
      arguments: { prompt: 'x', collection: 'c', size: '1024x1024; rm -rf' },
    })) as TextResult;
    expect(r2.isError).toBe(true);
    await close();
  });

  it('blocks path traversal through tool arguments', async () => {
    t = makeBridge();
    const { call, close } = await connect(t);
    const r = await call('edit_image', {
      prompt: 'x',
      collection: 'c',
      images: ['../../../../Windows/win.ini'],
    });
    expect(r.json.error.code).toBe('PATH_OUTSIDE_PROJECT');
    const v = await call('inspect_3d_asset', { target: '/etc/passwd' });
    expect(v.json.error.code).toBe('PATH_OUTSIDE_PROJECT');
    await close();
  });

  it('never leaks credentials in error output', async () => {
    const secret = 'sk-live-supersecretvalue123456';
    const leaky = new MockImageProvider(0.01);
    leaky.generate = async () => {
      throw new PixelBridgeError('PROVIDER_AUTH', `bad key ${secret}`, {
        details: { authorization: `Bearer ${secret}` },
      });
    };
    t = makeBridge({ imageProviders: [leaky] });
    const { call, close } = await connect(t);
    const r = await call('generate_image', { prompt: 'x', collection: 'c' });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.raw)).not.toContain(secret);
    await close();
  });

  it('runs the async video job flow', async () => {
    t = makeBridge({ pollsUntilDone: 1 });
    const { call, close } = await connect(t);
    const sub = await call('generate_video', { prompt: 'walk cycle', collection: 'pip' });
    expect(sub.json.status).toBe('submitted');
    const job = await call('get_job', { jobId: sub.json.job.id });
    expect(job.json.job.status).toBe('downloaded');
    expect(job.json.assets[0].kind).toBe('video');
    const jobs = await call('list_jobs');
    expect(jobs.json.jobs).toHaveLength(1);
    await close();
  });
});
