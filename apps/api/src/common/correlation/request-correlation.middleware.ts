import { Injectable, Logger, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import {
  REQUEST_ID_HEADER,
  correlationFields,
  resolveRequestId,
  runWithCorrelation,
} from './correlation-context';

function safePath(request: Request): string {
  const path = request.path || '/';
  return path.slice(0, 256).replace(/[^a-zA-Z0-9/_:.\-]/g, '_');
}

@Injectable()
export class RequestCorrelationMiddleware implements NestMiddleware {
  private readonly logger = new Logger(RequestCorrelationMiddleware.name);

  use(request: Request, response: Response, next: NextFunction): void {
    const requestId = resolveRequestId(request.get(REQUEST_ID_HEADER));
    const method = request.method.toUpperCase();
    const path = safePath(request);
    const startedAt = Date.now();

    response.setHeader(REQUEST_ID_HEADER, requestId);
    runWithCorrelation({ requestId }, () => {
      const fields = correlationFields();
      this.logger.log(`request_started method=${method} path=${path} ${fields}`);
      response.once('finish', () => {
        this.logger.log(
          `request_completed method=${method} path=${path} statusCode=${response.statusCode} durationMs=${Date.now() - startedAt} ${fields}`,
        );
      });
      next();
    });
  }
}
