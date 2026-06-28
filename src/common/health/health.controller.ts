import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../cache/cache.service';
import { Public } from '../decorators/public.decorator';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prismaService: PrismaService,
    private readonly cacheService: CacheService,
  ) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Health check — returns status of all services' })
  async healthCheck() {
    const [dbOk, redisOk] = await Promise.all([
      this.prismaService.healthCheck(),
      this.cacheService.ping(),
    ]);

    const mem = process.memoryUsage();
    return {
      status: dbOk ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      uptime: Math.round(process.uptime()),
      environment: process.env.NODE_ENV,
      version: process.env.APP_VERSION ?? '1.0.0',
      services: {
        database: dbOk  ? 'connected'    : 'disconnected',
        cache:    redisOk ? 'connected'  : 'unavailable',
      },
      memory: {
        heapUsedMb:  Math.round((mem.heapUsed  / 1024 / 1024) * 10) / 10,
        heapTotalMb: Math.round((mem.heapTotal / 1024 / 1024) * 10) / 10,
        rssMb:       Math.round((mem.rss       / 1024 / 1024) * 10) / 10,
      },
    };
  }

  @Public()
  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe — 503 if DB is unreachable' })
  async readiness() {
    const dbOk = await this.prismaService.healthCheck();
    if (!dbOk) {
      throw new ServiceUnavailableException('Database is not ready');
    }
    return { status: 'ready' };
  }

  @Public()
  @Get('live')
  @ApiOperation({ summary: 'Liveness probe — always 200 while process is running' })
  liveness() {
    return { status: 'alive', timestamp: new Date().toISOString() };
  }
}
