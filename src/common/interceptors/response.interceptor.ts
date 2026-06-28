import {
  Injectable, NestInterceptor, ExecutionContext, CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  timestamp: string;
}

/**
 * Wraps every successful HTTP response in a standard envelope:
 *   { success: true, data: <original payload>, timestamp: "..." }
 *
 * Error responses are NOT touched — they are handled by AllExceptionsFilter
 * which already returns { statusCode, message, timestamp, path }.
 *
 * Raw response endpoints (using @Res() without passthrough) are automatically
 * skipped via the headersSent check — they send their own response directly.
 *
 * NOTE FOR FLUTTER CLIENTS: read response.data['data'] instead of
 * response.data directly after this interceptor is applied.
 */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, ApiResponse<T> | T> {
  intercept(ctx: ExecutionContext, next: CallHandler<T>): Observable<ApiResponse<T> | T> {
    return next.handle().pipe(
      map((data) => {
        const res = ctx.switchToHttp().getResponse();
        // Raw response already sent via @Res() + res.end() — don't re-wrap
        if (res.headersSent) return data;
        return {
          success: true,
          data,
          timestamp: new Date().toISOString(),
        };
      }),
    );
  }
}
