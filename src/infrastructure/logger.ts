export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

type LogContext = Record<string, string | number | boolean | undefined>;

const priorities: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
}

export function createLogger(level: LogLevel, output: (line: string) => void = console.log): Logger {
  const write = (severity: LogLevel, message: string, context: LogContext = {}): void => {
    if (priorities[severity] < priorities[level]) return;
    output(JSON.stringify({ timestamp: new Date().toISOString(), level: severity, message, ...context }));
  };

  return {
    debug: (message, context) => write('debug', message, context),
    info: (message, context) => write('info', message, context),
    warn: (message, context) => write('warn', message, context),
    error: (message, context) => write('error', message, context)
  };
}
