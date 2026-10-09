import { loadDetective, runDetectiveAnswers, verifyDetective } from './commands.js';
import { detectiveConfig, DetectiveError, detectivePool } from './support.js';

async function main() {
  const command = process.argv[2];
  if (command !== 'load' && command !== 'verify' && command !== 'answers') {
    throw new DetectiveError('COMMAND', 'Use detective:load, detective:verify or detective:answers.');
  }
  const pool = detectivePool(detectiveConfig(process.env));
  try {
    const result = command === 'load' ? await loadDetective(pool)
      : command === 'verify' ? await verifyDetective(pool) : await runDetectiveAnswers(pool);
    process.stdout.write(`${JSON.stringify({ command, status: 'ok', result })}\n`);
  } finally { await pool.end(); }
}

void main().catch((error: unknown) => {
  const safe = error instanceof DetectiveError ? error : new DetectiveError('DATABASE_OPERATION_FAILED',
    'Detective operation failed. Check the separate owner connection, server and fixture state; credentials and driver details are omitted.');
  process.stdout.write(`${JSON.stringify({ status: 'error', code: safe.code, message: safe.message })}\n`);
  process.exitCode = 1;
});
