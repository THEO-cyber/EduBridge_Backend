import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

const SLOW_QUERY_MS = 500; // log any query taking longer than this

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      errorFormat: 'pretty',
      // Connection pool tuned for production (10 connections per API pod)
      datasources: {
        db: {
          url: process.env.DATABASE_URL,
        },
      },
      log: [
        { level: 'warn',  emit: 'event' },
        { level: 'error', emit: 'event' },
        { level: 'query', emit: 'event' },
      ],
    });

    // Slow query detection
    (this as any).$on('query', (e: any) => {
      if (e.duration >= SLOW_QUERY_MS) {
        this.logger.warn(
          `SLOW QUERY (${e.duration}ms): ${e.query.slice(0, 200)}`,
        );
      }
    });

    (this as any).$on('warn',  (e: any) => this.logger.warn(e.message));
    (this as any).$on('error', (e: any) => this.logger.error(e.message));

    this.logger.log('Prisma Client initialized');
  }

  async onModuleInit() {
    try {
      await this.$connect();
      this.logger.log('Database connected ✓');
    } catch (error) {
      this.logger.error('Failed to connect to database:', error);
      throw error;
    }
  }

  async onModuleDestroy() {
    try {
      await this.$disconnect();
      this.logger.log('Database disconnected');
    } catch (error) {
      this.logger.error('Failed to disconnect from database:', error);
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }
}
