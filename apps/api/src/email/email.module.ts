import { Module } from '@nestjs/common';
import { ConsoleEmailService } from './console-email.service';
import { EMAIL_SERVICE_TOKEN } from './email.service';

@Module({
  providers: [
    ConsoleEmailService,
    { provide: EMAIL_SERVICE_TOKEN, useExisting: ConsoleEmailService },
  ],
  exports: [EMAIL_SERVICE_TOKEN, ConsoleEmailService],
})
export class EmailModule {}
