import {
  Injectable, NestInterceptor, ExecutionContext, CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { httpRequestsTotal, httpRequestDurationMs } from '../metrics/metrics.controller';

@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<any> {
    const req = ctx.switchToHttp().getRequest();
    const start = Date.now();

    return next.handle().pipe(
      tap({
        next: () => {
          const res   = ctx.switchToHttp().getResponse();
          const route = req.route?.path ?? req.url;
          const label = { method: req.method, route, status: String(res.statusCode) };
          httpRequestsTotal.inc(label);
          httpRequestDurationMs.observe(label, Date.now() - start);
        },
        error: (err) => {
          const status = err?.status ?? 500;
          const route  = req.route?.path ?? req.url;
          const label  = { method: req.method, route, status: String(status) };
          httpRequestsTotal.inc(label);
          httpRequestDurationMs.observe(label, Date.now() - start);
        },
      }),
    );
  }
}
