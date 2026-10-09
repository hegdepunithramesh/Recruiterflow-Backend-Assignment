import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import { assertTarget, storageConfig, storagePool } from '../../src/storage/support.js';
import { verifyDatabase } from '../../src/storage/verify.js';

interface Message { event: string; port?: number; applicationName?: string; total?: number; idle?: number; waiting?: number }
interface Response { status: number; body: { matches?: { id: number; score: number }[]; error?: { code: string } } }

function http(port: number, pathname: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path: pathname, agent: false }, response => {
      let body = '';
      response.setEncoding('utf8').on('data', (chunk: string) => { body += chunk; });
      response.on('end', () => {
        try { resolve({ status: response.statusCode ?? 0, body: JSON.parse(body) as Response['body'] }); }
        catch { reject(new Error('Invalid HTTP JSON.')); }
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error('HTTP test timeout.')));
    req.on('error', reject);
    req.end();
  });
}

async function childService(t: TestContext) {
  const child = fork('tests/fixtures/shutdown-child.ts', [], {
    execArgv: ['--import','tsx'], stdio: ['ignore','pipe','pipe','ipc'],
  });
  const messages: Message[] = [];
  let stdout = '', stderr = '';
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  child.on('message', (message: Message) => { messages.push(message); });
  const closed = new Promise<number | null>(resolve => child.once('close', code => resolve(code)));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await closed; });
  async function wait(event: string) {
    for (let attempts = 0; attempts < 500; attempts++) {
      const message = messages.find(item => item.event === event);
      if (message) return message;
      assert.equal(child.exitCode, null, 'Child exited before '+event);
      await delay(20);
    }
    throw new Error('Timed out awaiting '+event);
  }
  const ready = await wait('listening');
  assert.ok(ready.port && ready.applicationName);
  return { child, closed, wait, port: ready.port, name: ready.applicationName, output: () => ({ stdout,stderr }) };
}

function signal(child: ChildProcess, value: 'SIGINT' | 'SIGTERM') {
  if (process.platform === 'win32') child.send(value);
  else child.kill(value);
}

async function activeBackend(admin: Pool, name: string, blocked: boolean) {
  for (let attempts = 0; attempts < 200; attempts++) {
    const rows = await admin.query<{ pid: number }>(`SELECT pid FROM pg_stat_activity
      WHERE datname = current_database() AND application_name = $1 AND state = 'active'
      AND ($2::BOOLEAN IS FALSE OR wait_event_type = 'Lock')`, [name,blocked]);
    if (rows.rows[0]) return rows.rows[0].pid;
    await delay(10);
  }
  throw new Error('Real PostgreSQL work was not observed.');
}

void test('Phase 09 shutdown during real PostgreSQL work on the disposable database', { timeout: 60000 }, async t => {
  const config = storageConfig(process.env, true);
  const admin = storagePool(config.adminUrl), runtime = storagePool(config.runtimeUrl);
  t.after(async () => { await Promise.all([admin.end(),runtime.end()]); });
  const guard = await admin.connect();
  try { await assertTarget(guard,config.database,true); } finally { guard.release(); }
  // Requires the existing exact test fixture; this suite never migrates, seeds or edits data.
  await verifyDatabase(admin,runtime,config.database);

  for (const stop of ['SIGINT','SIGTERM'] as const) {
    await t.test(`${stop} drains an active matching SELECT, refuses new connections and closes the real pool`, async t => {
      const service = await childService(t), lock = await admin.connect();
      let locked = false;
      t.after(async () => { if (locked) await lock.query('ROLLBACK'); lock.release(); });
      await lock.query('BEGIN'); locked = true;
      await lock.query('LOCK TABLE public.candidates IN ACCESS EXCLUSIVE MODE');
      const response = http(service.port,'/jobs/1/matches');
      await activeBackend(admin,service.name,true);
      const started = Date.now();
      signal(service.child,stop);
      await service.wait('shutdown_started');
      await assert.rejects(http(service.port,'/health'), (error: unknown) =>
        !!error && typeof error === 'object' && 'code' in error && error.code === 'ECONNREFUSED');
      await lock.query('ROLLBACK'); locked = false;
      const result = await response;
      assert.equal(result.status,200); assert.equal(result.body.matches?.length,15);
      assert.deepEqual(result.body.matches?.slice(0,2).map(row => [row.id,row.score]),[[1,100],[9,46.67]]);
      const pool = await service.wait('pool_closed');
      assert.deepEqual([pool.total,pool.idle,pool.waiting],[0,0,0]);
      assert.equal(await service.closed,0); assert.ok(Date.now()-started < 10000);
      assert.equal(service.output().stderr,'');
      assert.match(service.output().stdout,/shutdown_complete/);
      assert.doesNotMatch(service.output().stdout,/shutdown_failed/);
    });
  }

  await t.test('active statement timeout returns safe 503 while shutdown drains and closes its pool', async t => {
    const service = await childService(t), lock = await admin.connect();
    let locked = false;
    t.after(async () => { if (locked) await lock.query('ROLLBACK'); lock.release(); });
    await lock.query('BEGIN'); locked = true;
    await lock.query('LOCK TABLE public.candidates IN ACCESS EXCLUSIVE MODE');
    const response = http(service.port,'/jobs/1/matches');
    await activeBackend(admin,service.name,true);
    signal(service.child,'SIGTERM');
    await service.wait('shutdown_started');
    const result = await response;
    assert.equal(result.status,503); assert.equal(result.body.error?.code,'DATABASE_UNAVAILABLE');
    assert.equal(result.body.matches,undefined);
    const pool = await service.wait('pool_closed');
    assert.deepEqual([pool.total,pool.idle,pool.waiting],[0,0,0]);
    assert.equal(await service.closed,0); assert.equal(service.output().stderr,'');
    await lock.query('ROLLBACK'); locked = false;
  });

  await t.test('ten-second deadline fails visibly when a test fault keeps real database work active', async t => {
    const service = await childService(t);
    service.child.send('hold_beyond_deadline');
    const pid = await activeBackend(admin,service.name,false);
    t.after(async () => {
      // Terminate only this owned test backend, on the guarded disposable database.
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid = $1 AND datname = current_database() AND application_name = $2',[pid,service.name]);
    });
    const started = Date.now(); signal(service.child,'SIGTERM');
    await service.wait('shutdown_started');
    assert.equal(await service.closed,1);
    assert.ok(Date.now()-started >= 9000 && Date.now()-started < 16000);
    assert.match(service.output().stdout,/shutdown_failed/);
    assert.doesNotMatch(service.output().stdout,/shutdown_complete/);
    assert.equal(service.output().stderr,'');
  });
  await verifyDatabase(admin,runtime,config.database);
});
