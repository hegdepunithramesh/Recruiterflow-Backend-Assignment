import type { Express } from 'express';
import { matchingControllers } from './controller.js';
import type { MatchingService } from './service.js';

export function registerMatchingRoutes(app: Express, service: MatchingService): void {
  const controllers = matchingControllers(service);
  app.get('/jobs/:id/matches', (_request, response, next) => {
    response.locals.safeRoute = '/jobs/:id/matches';
    next();
  }, controllers.job);
  app.get('/candidates/:id/matches', (_request, response, next) => {
    response.locals.safeRoute = '/candidates/:id/matches';
    next();
  }, controllers.candidate);
}
