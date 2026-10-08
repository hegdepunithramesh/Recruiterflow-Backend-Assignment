import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { startServer } from '../src/lifecycle.js';
import type { LogEntry } from '../src/logger.js';
import { testDatabaseUrl } from './helpers.js';

const config = { databaseUrl: testDatabaseUrl, port: 0, nodeEnv: 'test' as const };

void test('startup database failure closes the dependency and never advertises listening', async () => {
  let closed = false;
  const logs: LogEntry[] = [];
  await assert.rejects(startServer(config, {
    checkReady: () => Promise.reject(new Error('unavailable')),
    close: () => { closed = true; return Promise.resolve(); },
  }, (entry) => { logs.push(entry); }));
  assert.equal(closed, true);
  assert.deepEqual(logs, []);
});

void test('shutdown drains an in-flight request, then closes the database exactly once', async (t) => {
  let calls = 0;
  let closes = 0;
  let finishProbe: (() => void) | undefined;
  let probeStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { probeStarted = resolve; });
  const blocked = new Promise<void>((resolve) => { finishProbe = resolve; });
  const runtime = await startServer(config, {
    checkReady: () => { calls++; if (calls === 1) return Promise.resolve(); probeStarted?.(); return blocked; },
    close: () => { closes++; return Promise.resolve(); },
  }, () => {});
  t.after(async () => { finishProbe?.(); await runtime.shutdown(); });
  const address = runtime.server.address();
  assert.ok(address && typeof address === 'object');
  const response = fetch(`http://127.0.0.1:${address.port}/ready`);
  await started;
  const shutdown = runtime.shutdown();
  assert.equal(closes, 0);
  finishProbe?.();
  assert.equal((await response).status, 200);
  await shutdown;
  await runtime.shutdown();
  assert.equal(closes, 1);
  assert.equal(runtime.server.listening, false);
});

void test('listener failure releases the database dependency', async (t) => {
  const first = await startServer(config, { checkReady: () => Promise.resolve(), close: () => Promise.resolve() }, () => {});
  t.after(() => first.shutdown());
  const address = first.server.address();
  assert.ok(address && typeof address === 'object');
  let closes = 0;
  await assert.rejects(startServer({ ...config, port: address.port }, {
    checkReady: () => Promise.resolve(), close: () => { closes++; return Promise.resolve(); },
  }, () => {}));
  assert.equal(closes, 1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  void test(`${signal} handler lets a child process exit cleanly (injected database)`, { timeout: 10000 }, async (t) => {
    const child = fork('tests/fixtures/signal-child.ts', [], {
      execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    const closed = once(child, 'close');
    await once(child, 'message');
    child.send(signal);
    const exit: unknown[] = await closed;
    assert.equal(exit[0], 0);
    assert.equal(stderr, '');
    assert.match(stdout, /shutdown_complete/);
    assert.match(stdout, /test_database_closed/);
    assert.doesNotMatch(stdout, /shutdown_failed/);
  });
}
