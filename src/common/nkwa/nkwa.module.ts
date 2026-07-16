import { Global, Module } from '@nestjs/common';
import { NkwaService } from './nkwa.service';

@Global()
@Module({
  providers: [NkwaService],
  exports: [NkwaService],
})
export class NkwaModule {}
