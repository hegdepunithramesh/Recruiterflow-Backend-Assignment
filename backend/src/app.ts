import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import express from 'express';
import type { DatabaseLifecycle } from './db.js';
import { AppError, errorHandler } from './errors.js';
import type { LogEntry, Logger } from './logger.js';
import { registerMatchingRoutes } from './modules/matching/routes.js';
import type { MatchingService } from './modules/matching/service.js';

type HttpLog = Extract<LogEntry, { event: 'http_request' }>;

export function createApp(database: Pick<DatabaseLifecycle, 'checkReady'>, logger: Logger, matching?: MatchingService) {
  const app = express();
  app.disable('x-powered-by');

  app.use((request, response, next) => {
    const requestId = randomUUID();
    const started = performance.now();
    response.setHeader('X-Request-Id', requestId);
    response.setHeader('Cache-Control', 'no-store');
    response.locals.safeRoute = 'unmatched';
    response.locals.outcomeCode = 'OK';
    response.on('finish', () => {
      logger({
        event: 'http_request', requestId,
        method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(request.method)
          ? request.method : 'OTHER',
        route: response.locals.safeRoute as HttpLog['route'],
        status: response.statusCode,
        code: response.locals.outcomeCode as HttpLog['code'],
        durationMs: Math.round((performance.now() - started) * 100) / 100,
      });
    });
    next();
  });

  app.get('/health', (_request, response) => {
    response.locals.safeRoute = '/health';
    response.json({ status: 'ok' });
  });

  app.get('/ready', async (_request, response) => {
    response.locals.safeRoute = '/ready';
    try { await database.checkReady(); }
    catch { throw new AppError('DATABASE_NOT_READY'); }
    response.json({ status: 'ready' });
  });

  if (matching) registerMatchingRoutes(app, matching);
  app.use((_request, _response, next) => { next(new AppError('ROUTE_NOT_FOUND')); });
  app.use(errorHandler);
  return app;
}
