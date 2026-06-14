/**
 * Redis connection factory.
 *
 * In production (NODE_ENV=production) it always uses the real Redis connection.
 * In development/test it probes port 6379 first; if Redis is not reachable it
 * falls back to ioredis-mock (fully in-memory) so the app can run without a
 * Redis server installed locally.
 */
import { Logger } from '@nestjs/common';
import * as net from 'net';

const logger = new Logger('RedisConnectionFactory');

export function probeRedis(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, timeoutMs);
    socket.on('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.on('error',   () => { clearTimeout(timer); resolve(false); });
  });
}

export type RedisConnection =
  | { host: string; port: number; password?: string; tls?: object; maxRetriesPerRequest: null; enableReadyCheck: boolean }
  | InstanceType<typeof import('ioredis-mock')>;

export async function createRedisConnection(): Promise<RedisConnection> {
  const host     = process.env.REDIS_HOST || 'localhost';
  const port     = parseInt(process.env.REDIS_PORT || '6379', 10);
  const password = process.env.REDIS_PASSWORD || undefined;
  const isProd   = process.env.NODE_ENV === 'production';

  if (isProd) {
    // In production always use real Redis — never fall back silently
    logger.log(`Using Redis at ${host}:${port}`);
    return {
      host,
      port,
      password,
      tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    };
  }

  const available = await probeRedis(host, port);

  if (available) {
    logger.log(`Redis detected at ${host}:${port} — using real connection`);
    return {
      host,
      port,
      password,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    };
  }

  logger.warn(
    `Redis not reachable at ${host}:${port} — falling back to ioredis-mock (in-memory). ` +
    `Video processing queues will work but state will NOT persist across restarts. ` +
    `Start Redis for full functionality.`,
  );

  // Dynamic import so the module isn't bundled in production builds
  const IORedisMock = (await import('ioredis-mock')).default ?? (await import('ioredis-mock'));
  return new IORedisMock() as any;
}
