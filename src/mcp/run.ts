import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { redact } from '../core/redact.js';
import { PixelBridge } from '../services/pixelbridge.js';
import { createServer } from './server.js';

/** Start the stdio MCP server for the project in PIXELBRIDGE_PROJECT_ROOT (or cwd). */
export async function runMcpServer(opts: { projectRoot?: string } = {}): Promise<void> {
  const pb = new PixelBridge(opts.projectRoot ? { projectRoot: opts.projectRoot } : {});
  pb.ctx.logger.info('pixelbridge-mcp starting', { projectRoot: pb.ctx.projectRoot });
  const handle = serveStdio(() => createServer(pb), {
    onerror: (e) => pb.ctx.logger.error('mcp transport error', { error: redact(e.message) }),
  });
  const shutdown = async () => {
    await handle.close().catch(() => {});
    pb.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}
