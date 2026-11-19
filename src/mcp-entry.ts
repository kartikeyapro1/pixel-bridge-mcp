#!/usr/bin/env node
import { runMcpServer } from './mcp/run.js';

runMcpServer().catch((e: unknown) => {
  console.error(`pixelbridge-mcp failed to start: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
