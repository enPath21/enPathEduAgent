import pino from 'pino';

const isDev = process.env.NODE_ENV !== 'production';

const baseLogger = pino(
  isDev
    ? { transport: { target: 'pino-pretty', options: { colorize: true } }, level: 'debug' }
    : { level: 'info' },
);

export function createLogger(name: string) {
  return baseLogger.child({ module: name });
}
