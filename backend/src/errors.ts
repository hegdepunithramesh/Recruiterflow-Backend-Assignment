import type { ErrorRequestHandler } from 'express';

type ErrorCode = 'ROUTE_NOT_FOUND' | 'DATABASE_NOT_READY' | 'INTERNAL_ERROR';

const errors: Record<ErrorCode, { status: number; message: string }> = {
  ROUTE_NOT_FOUND: { status: 404, message: 'Route not found.' },
  DATABASE_NOT_READY: { status: 503, message: 'Database is not ready.' },
  INTERNAL_ERROR: { status: 500, message: 'An unexpected error occurred.' },
};

export class AppError extends Error {
  constructor(readonly code: ErrorCode) {
    super(errors[code].message);
    this.name = 'AppError';
  }
}

export const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, next) => {
  if (response.headersSent) { response.destroy(); return; }
  const code = error instanceof AppError ? error.code : 'INTERNAL_ERROR';
  const { status, message } = errors[code];
  response.locals.outcomeCode = code;
  response.status(status).json({
    error: { code, message, requestId: response.getHeader('X-Request-Id') },
  });
  // Keep Express's four-argument error-handler signature without forwarding private errors.
  void next;
};
