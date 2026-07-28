import { Global, MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { RequestCorrelationMiddleware } from './request-correlation.middleware';

@Global()
@Module({})
export class CorrelationModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestCorrelationMiddleware).forRoutes('*');
  }
}
