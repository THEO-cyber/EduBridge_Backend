import { createLogger, format, transports } from 'winston';
import { utilities as nestWinstonModuleUtilities, WinstonModule } from 'nest-winston';

const isProd = process.env.NODE_ENV === 'production';

export const winstonLogger = createLogger({
  level: isProd ? 'info' : 'debug',
  format: isProd
    ? format.combine(
        format.timestamp(),
        format.errors({ stack: true }),
        format.json(),          // Structured JSON for log aggregators (Datadog, CloudWatch)
      )
    : format.combine(
        format.timestamp({ format: 'HH:mm:ss' }),
        format.errors({ stack: true }),
        nestWinstonModuleUtilities.format.nestLike('EduBridge', {
          colors: true,
          prettyPrint: true,
        }),
      ),
  transports: [
    new transports.Console(),
    // In production add file transport or send to log aggregator
    ...(isProd
      ? [
          new transports.File({ filename: 'logs/error.log', level: 'error', maxsize: 10_485_760, maxFiles: 5 }),
          new transports.File({ filename: 'logs/combined.log',              maxsize: 10_485_760, maxFiles: 10 }),
        ]
      : []),
  ],
});

export const WinstonLoggerModule = WinstonModule.forRoot({
  instance: winstonLogger,
});
