import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import * as Sentry from '@sentry/nestjs';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let errors: any = undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      } else if (typeof exceptionResponse === 'object') {
        const resp = exceptionResponse as any;
        message = resp.message || message;
        if (Array.isArray(resp.message)) {
          errors = resp.message;
          message = 'Validation failed';
        }
      }
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      status = HttpStatus.CONFLICT;
      switch (exception.code) {
        case 'P2002':
          message = `Duplicate entry: ${(exception.meta?.target as string[])?.join(', ')} already exists`;
          break;
        case 'P2025':
          status = HttpStatus.NOT_FOUND;
          message = 'Record not found';
          break;
        case 'P2003':
          status = HttpStatus.BAD_REQUEST;
          message = 'Foreign key constraint violation';
          break;
        default:
          // Don't expose the raw Prisma error code to clients.
          status = HttpStatus.INTERNAL_SERVER_ERROR;
          message = 'A database error occurred';
      }
    } else if (exception instanceof Prisma.PrismaClientValidationError) {
      status = HttpStatus.BAD_REQUEST;
      message = 'Invalid data provided';
    } else if (exception instanceof Error) {
      // Keep the real message for logs only (see below); never send it to the
      // client, where it could leak internals (hosts, stack details, library
      // internals). The client-facing message is sanitized for any 5xx.
      message = exception.message;
    }

    // Never surface internal error text on a 5xx — respond with a safe,
    // friendly message while the real detail goes to the logs + Sentry.
    const clientMessage =
      status >= 500
        ? 'Something went wrong on our end. Please try again in a moment.'
        : message;

    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} → ${status}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
      // Report all 5xx errors to Sentry with request context
      Sentry.withScope((scope) => {
        scope.setTag('http.method', request.method);
        scope.setTag('http.url', request.url);
        scope.setTag('http.status', String(status));
        scope.setExtra('correlationId', (request.headers as any)['x-correlation-id']);
        scope.setExtra('body', request.body);
        Sentry.captureException(exception);
      });
    } else {
      this.logger.warn(`${request.method} ${request.url} → ${status}: ${message}`);
    }

    response.status(status).json({
      statusCode: status,
      message: clientMessage,
      ...(errors && { errors }),
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }
}
