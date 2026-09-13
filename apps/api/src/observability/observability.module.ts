import { Controller, Get, Header, Module } from '@nestjs/common';
import { operationalMetrics } from './operational-metrics';

@Controller('metrics')
class MetricsController {
  @Get()
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  metrics(): string {
    return operationalMetrics.render();
  }
}

@Module({ controllers: [MetricsController] })
export class ObservabilityModule {}
