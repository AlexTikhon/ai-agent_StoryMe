import {
  BadGatewayException,
  ConflictException,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { DomainError } from './domain/engine';
import { NarrationRejectedError } from './narrator/narrator';

/** Same response for a missing session and one owned by someone else. */
export const sessionNotFound = () =>
  new NotFoundException({ code: 'SESSION_NOT_FOUND', message: 'Session not found' });

export const sessionNotCompleted = () =>
  new ConflictException({
    code: 'SESSION_NOT_COMPLETED',
    message: 'The story has not ended yet',
  });

export const revisionConflict = () =>
  new ConflictException({
    code: 'REVISION_CONFLICT',
    message: 'The session has moved on; reload it and choose again',
  });

export const idempotencyKeyReused = () =>
  new ConflictException({
    code: 'IDEMPOTENCY_KEY_REUSED',
    message: 'This idempotency key was already used for a different command',
  });

export const sessionBusy = () =>
  new ServiceUnavailableException({
    code: 'SESSION_BUSY',
    message: 'The session is busy; retry shortly',
  });

export const sessionLimitReached = () =>
  new ConflictException({
    code: 'SESSION_LIMIT_REACHED',
    message: 'You have reached the maximum number of stories',
  });

export const unknownScenario = () =>
  new UnprocessableEntityException({
    code: 'UNKNOWN_SCENARIO',
    message: 'The scenario is not available',
  });

export const sessionStateInvalid = () =>
  new InternalServerErrorException({
    code: 'SESSION_STATE_INVALID',
    message: 'The session state is invalid',
  });

export const scenarioVersionUnavailable = () =>
  new InternalServerErrorException({
    code: 'SCENARIO_VERSION_UNAVAILABLE',
    message: 'The scenario version for this session is unavailable',
  });

/**
 * Maps domain and narration failures to stable public errors. Rules that
 * depend on hidden state (missing knowledge, items, flags) are all reported as
 * the same generic CHOICE_UNAVAILABLE so locked branches are not revealed.
 */
export function toHttpError(error: unknown): HttpException | undefined {
  if (error instanceof NarrationRejectedError) {
    return new BadGatewayException({
      code:
        error.reason === 'NARRATION_PROVIDER_FAILED'
          ? 'NARRATION_PROVIDER_FAILED'
          : 'NARRATION_INVALID',
      message: 'The scene could not be narrated',
    });
  }
  if (error instanceof DomainError) {
    switch (error.code) {
      case 'UNKNOWN_CHOICE':
        return new UnprocessableEntityException({
          code: 'UNKNOWN_CHOICE',
          message: 'That choice does not exist in the current scene',
        });
      case 'SESSION_TERMINAL':
        return new ConflictException({
          code: 'SESSION_TERMINAL',
          message: 'The story has already ended',
        });
      case 'KNOWLEDGE_NOT_LEARNED':
      case 'ITEM_NOT_HELD':
      case 'ITEM_ALREADY_CONSUMED':
      case 'PREREQUISITE_NOT_MET':
      case 'CHOICE_UNAVAILABLE':
        return new ConflictException({
          code: 'CHOICE_UNAVAILABLE',
          message: 'That choice is not available right now',
        });
      default:
        return new InternalServerErrorException({
          code: 'SESSION_STATE_INVALID',
          message: 'The session state is invalid',
        });
    }
  }
  return undefined;
}

/** PostgreSQL lock_timeout (55P03) / statement timeout, or an expired Prisma transaction. */
export function isLockOrTransactionTimeout(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message} ${JSON.stringify(error)}` : '';
  return /55P03|lock timeout|57014|P2028/i.test(text);
}
