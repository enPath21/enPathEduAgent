import { Redis } from 'ioredis';
import { ENV } from './env';
import { createLogger } from './logger';

const log = createLogger('redis');

let _redis: Redis | null = null;

export function getRedis(): Redis {
  if (_redis) return _redis;
  _redis = new Redis(ENV.REDIS_URL, {
    maxRetriesPerRequest: null, // required by BullMQ
    tls: ENV.REDIS_URL.startsWith('rediss://') ? {} : undefined,
  });
  _redis.on('connect', () => log.info('Redis connected'));
  _redis.on('error', (err) => log.warn({ err }, 'Redis error'));
  return _redis;
}
