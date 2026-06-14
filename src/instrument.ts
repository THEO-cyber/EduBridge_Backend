import * as Sentry from '@sentry/nestjs';
import { nodeProfilingIntegration } from '@sentry/profiling-node';

// Sentry MUST be initialised before anything else so it can instrument
// all NestJS / Express internals. This file is the first import in main.ts.
Sentry.init({
  dsn: process.env.SENTRY_DSN,

  // Only run Sentry when DSN is configured (skipped in dev if not set)
  enabled: !!process.env.SENTRY_DSN,

  environment: process.env.NODE_ENV ?? 'development',
  release:     process.env.APP_VERSION ?? '1.0.0',

  integrations: [
    nodeProfilingIntegration(),
  ],

  // Capture 100% of transactions in dev, 10% in production
  tracesSampleRate:   process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
  profilesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
});
