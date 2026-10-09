import type { Pool } from 'pg';
import { migrate } from './migrations.js';
import { seed } from './seed.js';
import { storageConfig, storagePool, StorageError } from './support.js';
import { assertRestrictedRole, verifyDatabase } from './verify.js';

async function main() {
  const command = process.argv[2];
  if (command !== 'migrate' && command !== 'seed' && command !== 'verify') {
    throw new StorageError('COMMAND', 'Use db:migrate, db:seed or db:verify.');
  }
  const config = storageConfig(process.env);
  const pools: Pool[] = [];
  try {
    const admin = storagePool(config.adminUrl);
    pools.push(admin);
    const client = await admin.connect();
    try { await assertRestrictedRole(client); } finally { client.release(); }
    let result: unknown;
    if (command === 'migrate') result = await migrate(admin, config.database);
    else if (command === 'seed') result = await seed(admin, config.database);
    else {
      const runtime = storagePool(config.runtimeUrl);
      pools.push(runtime);
      result = await verifyDatabase(admin, runtime, config.database);
    }
    process.stdout.write(`${JSON.stringify({ command, status: 'ok', result })}\n`);
  } finally { await Promise.all(pools.map((pool) => pool.end())); }
}

void main().catch((error: unknown) => {
  const safe = error instanceof StorageError ? error : new StorageError('DATABASE_OPERATION_FAILED',
    'Database operation failed. Check the privileged connection, PostgreSQL availability, schema state and role permissions; credentials and driver details are omitted.');
  process.stdout.write(`${JSON.stringify({ status: 'error', code: safe.code, message: safe.message })}\n`);
  process.exitCode = 1;
});
