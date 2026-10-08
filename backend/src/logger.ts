type Diagnostic = 'configuration' | 'database_target' | 'database_unavailable' | 'listener' | 'internal';

// Closed fields keep arbitrary URLs, driver messages and error objects out of logs.
export type LogEntry =
  | { event: 'http_request'; requestId: string; method: string;
      route: '/health' | '/ready' | 'unmatched'; status: number; durationMs: number;
      code: 'OK' | 'ROUTE_NOT_FOUND' | 'DATABASE_NOT_READY' | 'INTERNAL_ERROR' }
  | { event: 'startup_failed'; category: Diagnostic; invalidFields?: string[] }
  | { event: 'database_pool_error' | 'database_close_failed'; category: 'database_unavailable' }
  | { event: 'server_listening'; port: number }
  | { event: 'shutdown_started' | 'shutdown_complete' | 'shutdown_failed' };

export type Logger = (entry: LogEntry) => void;

export function createLogger(write: (line: string) => void = (line) => {
  process.stdout.write(line);
}): Logger {
  return (entry) => { write(`${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`); };
}
