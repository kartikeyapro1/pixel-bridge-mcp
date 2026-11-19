import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { describe, expect, it } from 'vitest';
import { cleanup, tempDir } from '../helpers.js';

const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist/mcp-entry.js');

/** Spawns the built server exactly as an MCP client would. */
describe.skipIf(!existsSync(entry))('stdio server (requires `npm run build`)', () => {
  it('starts, lists tools and answers get_status without writing logs to stdout', async () => {
    const dir = tempDir();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      cwd: dir,
      env: {
        PIXELBRIDGE_PROJECT_ROOT: dir,
        PIXELBRIDGE_MOCK: '1',
        // Isolated, empty credential store so the test never reads a real key.
        PIXELBRIDGE_CREDENTIALS_DIR: path.join(dir, 'no-credentials'),
        PATH: process.env.PATH ?? '',
        SystemRoot: process.env.SystemRoot ?? '',
      },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'stdio-test', version: '0.0.0' });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.length).toBe(18);
      const res = (await client.callTool({ name: 'get_status', arguments: {} })) as {
        content: { type: string; text: string }[];
      };
      const status = JSON.parse(res.content[0]!.text) as {
        projectRoot: string;
        imageProviders: { id: string }[];
      };
      expect(path.resolve(status.projectRoot)).toBe(path.resolve(dir));
      expect(status.imageProviders.map((p) => p.id)).toContain('mock');
    } finally {
      await client.close();
      cleanup(dir);
    }
  }, 60_000);
});
