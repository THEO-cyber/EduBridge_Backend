import * as Joi from 'joi';

// Fails fast at boot instead of letting the app start with a missing/weak secret
// (see jwt.secret / jwt.refreshSecret in configuration.ts, which no longer have
// hardcoded fallbacks on purpose).
export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  DATABASE_URL: Joi.string().uri().required(),
  JWT_SECRET: Joi.string().min(32).required(),
  JWT_REFRESH_SECRET: Joi.string().min(32).required(),
}).unknown(true);
