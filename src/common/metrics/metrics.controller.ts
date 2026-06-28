import { Controller, Get, Res } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Response } from 'express';
import * as client from 'prom-client';
import { Public } from '../decorators/public.decorator';

// Collect all default Node.js metrics (event loop lag, memory, GC, etc.)
client.collectDefaultMetrics({ prefix: 'edubridge_' });

// ── Custom business metrics ──────────────────────────────────────────────────

export const httpRequestsTotal = new client.Counter({
  name: 'edubridge_http_requests_total',
  help: 'Total HTTP requests received',
  labelNames: ['method', 'route', 'status'],
});

export const httpRequestDurationMs = new client.Histogram({
  name: 'edubridge_http_request_duration_ms',
  help: 'HTTP request duration in milliseconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [10, 50, 100, 200, 500, 1000, 2000, 5000],
});

export const activeEnrollments = new client.Gauge({
  name: 'edubridge_active_enrollments',
  help: 'Current number of active course enrollments',
});

export const videoProcessingJobs = new client.Gauge({
  name: 'edubridge_video_processing_jobs',
  help: 'Current number of video processing jobs in queue',
  labelNames: ['status'],
});

export const emailJobsTotal = new client.Counter({
  name: 'edubridge_email_jobs_total',
  help: 'Total email jobs dispatched',
  labelNames: ['status'],
});

@ApiTags('Health')
@Controller('metrics')
export class MetricsController {
  @Public()
  @Get()
  @ApiOperation({ summary: 'Prometheus metrics endpoint' })
  async getMetrics(@Res() res: Response) {
    res.set('Content-Type', client.register.contentType);
    res.end(await client.register.metrics());
  }
}
