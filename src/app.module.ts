import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { BullModule } from '@nestjs/bullmq';
import { ServeStaticModule } from '@nestjs/serve-static';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { WinstonModule } from 'nest-winston';
import { join } from 'path';

import { PrismaModule } from './common/prisma/prisma.module';
import { EmailModule } from './common/email/email.module';
import { createRedisConnection } from './common/redis/redis-connection.factory';
import { FirebaseModule } from './common/firebase/firebase.module';
import { CacheModule } from './common/cache/cache.module';
import { HealthModule } from './common/health/health.module';
import { CorrelationIdMiddleware } from './common/middleware/correlation-id.middleware';
import { winstonLogger } from './common/logger/winston.logger';
import { configuration } from './config/configuration';

import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { CoursesModule } from './modules/courses/courses.module';
import { LessonsModule } from './modules/lessons/lessons.module';
import { EnrollmentsModule } from './modules/enrollments/enrollments.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { PayoutsModule } from './modules/payouts/payouts.module';
import { LiveSessionsModule } from './modules/live-sessions/live-sessions.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { ChatModule } from './modules/chat/chat.module';
import { AdminModule } from './modules/admin/admin.module';
import { VideoProcessingModule } from './modules/video-processing/video-processing.module';
import { SearchModule } from './modules/search/search.module';
import { ReviewsModule } from './modules/reviews/reviews.module';
import { CertificatesModule } from './modules/certificates/certificates.module';
import { CouponsModule } from './modules/coupons/coupons.module';
import { WishlistModule } from './modules/wishlist/wishlist.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { DiscussionsModule } from './modules/discussions/discussions.module';
import { SchedulerModule } from './modules/scheduler/scheduler.module';
import { QuizzesModule } from './modules/quizzes/quizzes.module';
import { AnnouncementsModule } from './modules/announcements/announcements.module';
import { NotesModule } from './modules/notes/notes.module';
import { ReportsModule } from './modules/reports/reports.module';
import { ApplicationsModule } from './modules/applications/applications.module';
import { EmailPreferencesModule } from './modules/email-preferences/email-preferences.module';

@Module({
  imports: [
    // ── Config ────────────────────────────────────────────────────────────────
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      envFilePath: ['.env.local', '.env'],
    }),

    // ── Structured logging ─────────────────────────────────────────────────────
    WinstonModule.forRoot({ instance: winstonLogger }),

    // ── Rate limiting (global via APP_GUARD below) ─────────────────────────────
    ThrottlerModule.forRoot([
      { name: 'short',  ttl: 1_000,  limit: 10  }, // burst protection
      { name: 'medium', ttl: 60_000, limit: 200  }, // per-minute
    ]),

    // ── Scheduling, events, static ────────────────────────────────────────────
    ScheduleModule.forRoot(),
    EventEmitterModule.forRoot(),

    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'uploads'),
      serveRoot: '/uploads',
    }),

    // ── Redis / BullMQ ────────────────────────────────────────────────────────
    // createRedisConnection() returns a real ioredis connection when Redis is
    // available, or an ioredis-mock (in-memory) in development — zero errors.
    BullModule.forRootAsync({
      useFactory: async () => {
        const connection = await createRedisConnection();
        return {
          connection,
          defaultJobOptions: { removeOnComplete: 20, removeOnFail: 10 },
        };
      },
    }),

    // ── Core infrastructure ────────────────────────────────────────────────────
    PrismaModule,
    EmailModule,
    FirebaseModule,
    CacheModule,
    HealthModule,

    // ── Feature modules ───────────────────────────────────────────────────────
    AuthModule,
    UsersModule,
    CoursesModule,
    LessonsModule,
    EnrollmentsModule,
    PaymentsModule,
    PayoutsModule,
    LiveSessionsModule,
    NotificationsModule,
    ChatModule,
    AdminModule,
    VideoProcessingModule,
    SearchModule,
    ReviewsModule,
    CertificatesModule,
    CouponsModule,
    WishlistModule,
    AnalyticsModule,
    DiscussionsModule,
    SchedulerModule,
    QuizzesModule,
    AnnouncementsModule,
    NotesModule,
    ReportsModule,
    ApplicationsModule,
    EmailPreferencesModule,
  ],

  providers: [
    // Global rate limiting on every route
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Apply correlation ID to all routes
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
