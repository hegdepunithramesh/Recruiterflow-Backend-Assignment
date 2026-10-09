import type { ErrorRequestHandler } from 'express';

export type ErrorCode = 'ROUTE_NOT_FOUND' | 'DATABASE_NOT_READY' | 'INTERNAL_ERROR'
  | 'INVALID_ID' | 'INVALID_QUERY' | 'JOB_NOT_FOUND' | 'CANDIDATE_NOT_FOUND' | 'DATABASE_UNAVAILABLE';

const errors: Record<ErrorCode, { status: number; message: string }> = {
  INVALID_ID: { status: 400, message: 'id must be a positive integer between 1 and 2147483647 without leading zeros.' },
  INVALID_QUERY: { status: 400, message: 'Query parameters are not supported.' },
  JOB_NOT_FOUND: { status: 404, message: 'Job not found.' },
  CANDIDATE_NOT_FOUND: { status: 404, message: 'Candidate not found.' },
  DATABASE_UNAVAILABLE: { status: 503, message: 'Matching is temporarily unavailable. Please try again later.' },
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
