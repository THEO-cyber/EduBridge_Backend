import * as Joi from 'joi';

// Fails fast at boot instead of letting the app start with a missing/weak secret
// (see jwt.secret / jwt.refreshSecret in configuration.ts, which no longer have
// hardcoded fallbacks on purpose).
export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  // Presence-only: Prisma validates the actual connection string. Joi's .uri()
  // is stricter than Postgres and wrongly rejects valid Neon URLs (which include
  // params like ?sslmode=require&channel_binding=require).
  DATABASE_URL: Joi.string().required(),
  JWT_SECRET: Joi.string().min(32).required(),
  JWT_REFRESH_SECRET: Joi.string().min(32).required(),
}).unknown(true);
