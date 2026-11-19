import { redact } from './redact.js';

/**
 * Logs go to stderr only: stdout is reserved for the MCP stdio protocol.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(level: LogLevel = 'info', sink: (line: string) => void = defaultSink): Logger {
  const min = ORDER[level];
  const emit = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[lvl] < min) return;
    const record = { ts: new Date().toISOString(), level: lvl, msg, ...fields };
    sink(redact(JSON.stringify(record)));
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
  };
}

function defaultSink(line: string): void {
  process.stderr.write(line + '\n');
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
