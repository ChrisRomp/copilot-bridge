export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const LEVEL_LABELS: Record<LogLevel, string> = { debug: 'DBG', info: 'INF', warn: 'WRN', error: 'ERR' };

let minLevel: LogLevel = 'debug';

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

function fmt(level: LogLevel, tag: string, msg: string): string {
  const ts = new Date().toISOString().slice(11, 23); // HH:mm:ss.SSS
  return `${ts} [${LEVEL_LABELS[level]}] [${tag}] ${msg}`;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel];
}

export function createLogger(tag: string) {
  return {
    debug(msg: string, ...args: unknown[]) {
      if (shouldLog('debug')) console.log(fmt('debug', tag, msg), ...args);
    },
    info(msg: string, ...args: unknown[]) {
      if (shouldLog('info')) console.log(fmt('info', tag, msg), ...args);
    },
    warn(msg: string, ...args: unknown[]) {
      if (shouldLog('warn')) console.warn(fmt('warn', tag, msg), ...args);
    },
    error(msg: string, ...args: unknown[]) {
      if (shouldLog('error')) console.error(fmt('error', tag, msg), ...args);
    },
  };
}
