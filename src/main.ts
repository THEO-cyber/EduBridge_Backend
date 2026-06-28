import './instrument'; // Sentry MUST be first import
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';

// AppModule is NOT statically imported here — it is dynamically imported inside
// bootstrap() AFTER the Redis probe sets REDIS_AVAILABLE.  This ensures that
// VideoProcessingModule's module-level code runs with the correct env var value.
import { AllExceptionsFilter } from './common/filters/http-exception.filter';
import { CorrelationIdMiddleware } from './common/middleware/correlation-id.middleware';
import { TimeoutInterceptor } from './common/interceptors/timeout.interceptor';
import { MetricsInterceptor } from './common/interceptors/metrics.interceptor';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { probeRedis } from './common/redis/redis-connection.factory';

async function bootstrap() {
  console.log('[BOOT] Step 1: probing Redis...');
  const redisHost = process.env.REDIS_HOST ?? 'localhost';
  const redisPort = parseInt(process.env.REDIS_PORT ?? '6379', 10);
  const redisAvailable = await probeRedis(redisHost, redisPort, 1500);
  process.env.REDIS_AVAILABLE = redisAvailable ? 'true' : 'false';
  console.log('[BOOT] Step 2: creating NestJS app...');

  // Dynamic import: evaluated NOW so VideoProcessingModule reads REDIS_AVAILABLE correctly
  const { AppModule } = await import('./app.module');

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    rawBody:    true,
  });
  console.log('[BOOT] Step 3: app created, wiring logger...');

  // ── Structured logging (Winston) ────────────────────────────────────────────
  const logger = app.get(WINSTON_MODULE_NEST_PROVIDER);
  app.useLogger(logger);
  console.log('[BOOT] Step 4: logger wired');

  const configService = app.get(ConfigService);
  const port    = configService.get<number>('port', 3000);
  const nodeEnv = configService.get<string>('nodeEnv', 'development');
  const isProd  = nodeEnv === 'production';

  if (redisAvailable) {
    logger.log(`Redis detected at ${redisHost}:${redisPort} ✓`, 'Bootstrap');
  } else {
    logger.warn(
      `Redis not available at ${redisHost}:${redisPort} — video processing queue paused`,
      'Bootstrap',
    );
  }

  // ── Correlation IDs ─────────────────────────────────────────────────────────
  app.use(new CorrelationIdMiddleware().use.bind(new CorrelationIdMiddleware()));

  // ── Security ────────────────────────────────────────────────────────────────
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: isProd ? undefined : false,
    }),
  );
  app.use(compression());
  app.use(cookieParser());
  app.useBodyParser('json',       { limit: '10mb' });
  app.useBodyParser('urlencoded', { extended: true, limit: '10mb' });

  // ── CORS ────────────────────────────────────────────────────────────────────
  const allowedOrigins = (configService.get<string>('frontendUrl') ?? 'http://localhost:3000')
    .split(',').map((o) => o.trim()).filter(Boolean);

  app.enableCors({
    origin: (origin, cb) => {
      // No origin = server-to-server / curl — always allow
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      cb(new Error(`Origin ${origin} not allowed by CORS policy`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-stripe-signature', 'x-correlation-id'],
  });

  // ── Global prefix & pipes ────────────────────────────────────────────────────
  app.setGlobalPrefix('api/v1');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: false,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      stopAtFirstError: false,
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(
    new MetricsInterceptor(),
    new ResponseInterceptor(),
    new TimeoutInterceptor(30_000),
  );

  // ── Swagger ──────────────────────────────────────────────────────────────────
  const swaggerEnabled = !isProd || process.env.SWAGGER_ENABLED === 'true';
  if (swaggerEnabled) {
    const doc = new DocumentBuilder()
      .setTitle('EduBridge API')
      .setDescription('Production-grade educational platform — video, live sessions, payments, chat, push notifications')
      .setVersion('1.0')
      .setContact('EduBridge Support', '', 'support@edubridge.com')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT', in: 'header' }, 'JWT-auth')
      .addTag('Auth',              'Register, login, email verify, password reset, Google OAuth')
      .addTag('Users',             'Profiles, instructor details, student settings')
      .addTag('Courses',           'Course CRUD, publishing workflow, instructor dashboard')
      .addTag('Lessons',           'Sections, lessons, reordering')
      .addTag('Enrollments',       'Enrollments, progress tracking, completion')
      .addTag('Search',            'Full-text search, filters, suggestions, featured')
      .addTag('Video Processing',  'Upload, transcode to HLS, stream, CDN delivery')
      .addTag('Live Sessions',     '1-on-1 video sessions via LiveKit')
      .addTag('Payments',          'Stripe payments, refunds, free enrollment, history')
      .addTag('Payouts',           'Instructor earnings and payout management')
      .addTag('Reviews',           'Course reviews with rating aggregation')
      .addTag('Wishlist',          'Save courses for later')
      .addTag('Coupons',           'Discount codes — admin management and user validation')
      .addTag('Certificates',      'PDF certificates with public verification')
      .addTag('Discussions',       'Course Q&A and discussion threads')
      .addTag('Analytics',         'Platform, instructor, course, student analytics')
      .addTag('Chat',              'Real-time direct and group messaging')
      .addTag('Notifications',     'In-app + FCM push notifications, device tokens')
      .addTag('Admin',             'User management, course moderation, categories')
      .addTag('Health',            'Liveness, readiness, and health probes')
      .build();

    SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, doc), {
      swaggerOptions: { persistAuthorization: true, docExpansion: 'none', filter: true },
    });
  }

  // ── Graceful shutdown ────────────────────────────────────────────────────────
  app.enableShutdownHooks();

  console.log('[BOOT] Step 5: about to listen on port', port);
  await app.listen(port, '0.0.0.0');
  console.log('[BOOT] Step 6: listening!');

  logger.log(`🚀 EduBridge API  → http://localhost:${port}/api/v1`,  'Bootstrap');
  if (swaggerEnabled) logger.log(`📚 Swagger docs   → http://localhost:${port}/api/docs`, 'Bootstrap');
  logger.log(`🌍 Environment    → ${nodeEnv}`, 'Bootstrap');
}

process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
  process.exit(1);
});

bootstrap().catch((err) => {
  console.error('BOOTSTRAP FAILED:', err);
  process.exit(1);
});
