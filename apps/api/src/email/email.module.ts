import { Module } from '@nestjs/common';
import { EMAIL_SERVICE_TOKEN } from './email.service';
import { createEmailService } from './email-provider.factory';

@Module({
  providers: [
    {
      provide: EMAIL_SERVICE_TOKEN,
      useFactory: () => createEmailService(process.env),
    },
  ],
  exports: [EMAIL_SERVICE_TOKEN],
})
export class EmailModule {}
