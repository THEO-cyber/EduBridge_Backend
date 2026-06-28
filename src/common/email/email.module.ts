import { Module, Global, Logger } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { EmailService } from './email.service';
import { EmailQueueProcessor, EMAIL_QUEUE } from './email.queue.processor';

const redisAvailable = process.env.REDIS_AVAILABLE === 'true';

if (!redisAvailable) {
  new Logger('EmailModule').warn(
    'Redis unavailable — email will be sent directly (no queue, no retry persistence)',
  );
}

@Global()
@Module({
  imports: [
    BullModule.registerQueue({ name: EMAIL_QUEUE }),
  ],
  providers: [
    EmailService,
    ...(redisAvailable ? [EmailQueueProcessor] : []),
  ],
  exports: [EmailService],
})
export class EmailModule {}
