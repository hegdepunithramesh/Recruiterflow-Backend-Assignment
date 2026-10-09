// Only known transport/availability failures are transient. SQL/data bugs remain 500.
export function isDatabaseUnavailable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code: unknown = 'code' in error ? error.code : undefined;
  if (typeof code === 'string' && (/^08[0-9A-Z]{3}$/.test(code) ||
    ['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
      '57P01', '57P02', '57P03', '53300', '57014', '55P03'].includes(code))) return true;
  return error instanceof Error && [
    'timeout exceeded when trying to connect', 'Connection terminated unexpectedly',
    'Connection terminated', 'Connection terminated due to connection timeout', 'Query read timeout',
  ].includes(error.message);
}
