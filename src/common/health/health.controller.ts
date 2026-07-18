import { Controller, Get, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../cache/cache.service';
import { EmailService } from '../email/email.service';
import { FirebasePushService } from '../firebase/firebase-push.service';
import { Public } from '../decorators/public.decorator';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { RolesGuard } from '../guards/roles.guard';
import { Roles } from '../decorators/roles.decorator';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prismaService: PrismaService,
    private readonly cacheService: CacheService,
    private readonly emailService: EmailService,
    private readonly pushService: FirebasePushService,
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

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @ApiBearerAuth('JWT-auth')
  @Get('integrations')
  @ApiOperation({
    summary: 'Integration configuration status (Admin only). Booleans only — never exposes any credential value.',
  })
  async integrations() {
    const cacheConnected = await this.cacheService.ping();
    return {
      timestamp: new Date().toISOString(),
      // Push notifications will only reach devices when Firebase is configured.
      push: {
        provider: 'firebase',
        configured: this.pushService.isReady,
      },
      // Emails (approval/rejection, reminders, verification) only send when SMTP
      // credentials are present; otherwise send() logs and no-ops.
      email: {
        configured: this.emailService.isConfigured,
      },
      cache: {
        configured: process.env.REDIS_AVAILABLE === 'true',
        connected: cacheConnected,
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
