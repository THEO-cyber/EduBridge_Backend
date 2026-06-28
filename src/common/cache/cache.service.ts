import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, RedisClientType } from 'redis';

@Injectable()
export class CacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);
  private client?: RedisClientType;
  private connected = false;

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit() {
    try {
      const host = this.configService.get<string>('redis.host') ?? 'localhost';
      const port = this.configService.get<number>('redis.port') ?? 6379;
      const password = this.configService.get<string>('redis.password');

      this.client = createClient({
        socket: {
          host,
          port,
          connectTimeout: 3_000,
          reconnectStrategy: (retries: number) => {
            if (retries > 3) return false; // give up after 3 retries
            return Math.min(retries * 500, 3_000);
          },
        },
        ...(password ? { password } : {}),
      }) as unknown as RedisClientType;

      this.client.on('error', () => {}); // suppress unhandled error events

      await Promise.race([
        this.client.connect(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Redis connect timeout')), 3_000),
        ),
      ]);
      this.connected = true;
      this.logger.log('Redis cache connected ✓');
    } catch (err: any) {
      this.logger.warn(`Redis cache unavailable — caching disabled: ${err.message}`);
      this.connected = false;
    }
  }

  async onModuleDestroy() {
    if (this.connected && this.client) {
      await this.client.quit();
    }
  }

  // ── Core operations ────────────────────────────────────────────────────────

  async get<T>(key: string): Promise<T | null> {
    if (!this.connected || !this.client) return null;
    try {
      const val = await this.client.get(key);
      return val ? (JSON.parse(val) as T) : null;
    } catch {
      return null;
    }
  }

  async set(key: string, value: unknown, ttlSeconds = 300): Promise<void> {
    if (!this.connected || !this.client) return;
    try {
      await this.client.setEx(key, ttlSeconds, JSON.stringify(value));
    } catch {}
  }

  async del(key: string): Promise<void> {
    if (!this.connected || !this.client) return;
    try { await this.client.del(key); } catch {}
  }

  async delPattern(pattern: string): Promise<void> {
    if (!this.connected || !this.client) return;
    try {
      const keys = await this.client.keys(pattern);
      if (keys.length > 0) {
        await this.client.del(keys);
      }
    } catch {}
  }

  async ping(): Promise<boolean> {
    if (!this.connected || !this.client) return false;
    try {
      return (await this.client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  // ── Cache-aside helper ────────────────────────────────────────────────────

  async getOrSet<T>(key: string, factory: () => Promise<T>, ttlSeconds = 300): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;

    const value = await factory();
    await this.set(key, value, ttlSeconds);
    return value;
  }

  // ── Named cache keys ──────────────────────────────────────────────────────

  static keys = {
    course:          (id: string)    => `course:${id}`,
    courseList:      (page: number)  => `courses:list:${page}`,
    searchResults:   (q: string)     => `search:${Buffer.from(q).toString('base64').slice(0, 40)}`,
    featuredCourses: ()              => 'courses:featured',
    categories:      ()              => 'categories:all',
    instructors:     ()              => 'users:instructors',
    userProfile:     (id: string)    => `user:profile:${id}`,
  };
}
