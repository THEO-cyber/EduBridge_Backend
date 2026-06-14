import { Module, Global } from '@nestjs/common';
import { FirebasePushService } from './firebase-push.service';

@Global()
@Module({
  providers: [FirebasePushService],
  exports: [FirebasePushService],
})
export class FirebaseModule {}
