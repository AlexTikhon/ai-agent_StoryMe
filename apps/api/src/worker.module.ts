import { DynamicModule, Module } from '@nestjs/common';
import { AppModule } from './app.module';

/** Separate non-HTTP composition root. Keeping this wrapper explicit prevents
 * API bootstrap code from being mistaken for the worker entrypoint. */
@Module({})
export class WorkerModule {
  static register(): DynamicModule {
    return {
      module: WorkerModule,
      imports: [AppModule.register({ enableGenerationWorker: true })],
    };
  }
}
