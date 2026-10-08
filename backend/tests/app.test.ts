import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import { createApp } from '../src/app.js';
import { errorHandler } from '../src/errors.js';
import { createLogger, type LogEntry } from '../src/logger.js';
import { serve } from './helpers.js';

void test('/health succeeds independently of the database and generates its own request ID', async (t) => {
  let calls = 0;
  const logs: LogEntry[] = [];
  const app = createApp({ checkReady: () => { calls++; return Promise.reject(new Error('private')); } },
    (entry) => { logs.push(entry); });
  const http = await serve(app);
  t.after(() => http.close());
  const response = await fetch(`${http.url}/health`, { headers: { 'X-Request-Id': 'untrusted-secret' } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
  assert.match(response.headers.get('X-Request-Id') ?? '', /^[0-9a-f-]{36}$/);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('X-Powered-By'), null);
  assert.match(response.headers.get('Content-Type') ?? '', /application\/json/);
  assert.equal(calls, 0);
  assert.equal(logs[0]?.event, 'http_request');
  assert.doesNotMatch(JSON.stringify(logs), /untrusted-secret|private/);
});

void test('/ready returns 200 only after the injected database probe succeeds', async (t) => {
  let calls = 0;
  const http = await serve(createApp({ checkReady: () => { calls++; return Promise.resolve(); } }, () => {}));
  t.after(() => http.close());
  const response = await fetch(`${http.url}/ready`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ready' });
  assert.equal(calls, 1);
});

void test('/ready has a safe 503 envelope on failure while /health remains healthy', async (t) => {
  const logs: string[] = [];
  const logger = createLogger((line) => { logs.push(line); });
  const http = await serve(createApp({ checkReady: () => Promise.reject(new Error('postgresql://secret SQL stack')) }, logger));
  t.after(() => http.close());
  const response = await fetch(`${http.url}/ready?password=secret`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: {
    code: 'DATABASE_NOT_READY', message: 'Database is not ready.',
    requestId: response.headers.get('X-Request-Id'),
  } });
  assert.equal((await fetch(`${http.url}/health`)).status, 200);
  assert.doesNotMatch(logs.join(''), /secret|postgresql|SQL|stack/);
  for (const line of logs) assert.equal(typeof JSON.parse(line), 'object');
});

void test('unsupported routes use the common 404 envelope and never log request paths/query strings', async (t) => {
  const logs: LogEntry[] = [];
  const http = await serve(createApp({ checkReady: () => Promise.resolve() }, (entry) => { logs.push(entry); }));
  t.after(() => http.close());
  for (const path of ['/secret-path?token=secret', '/jobs/1/matches', '/candidates/1/matches']) {
    const response = await fetch(`${http.url}${path}`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: {
      code: 'ROUTE_NOT_FOUND', message: 'Route not found.', requestId: response.headers.get('X-Request-Id'),
    } });
  }
  assert.doesNotMatch(JSON.stringify(logs), /secret|jobs|candidates/);
});

void test('the central handler hides unexpected error details', async (t) => {
  const app = express();
  app.use((_request, response, next) => {
    response.setHeader('X-Request-Id', 'test-generated-id');
    next(new Error('private SQL and credentials'));
  });
  app.use(errorHandler);
  const http = await serve(app);
  t.after(() => http.close());
  const response = await fetch(http.url);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: {
    code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.', requestId: 'test-generated-id',
  } });
});
