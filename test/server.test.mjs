/**
 * HTTP-level tests for JSON response framing.
 *
 * These exist because the browser-facing failure mode was protocol-level: a
 * hand-rolled `Content-Encoding: gzip` plus a too-short keep-alive made Firefox
 * sit on an unanswered request until it aborted. The assertions here are the
 * ones a browser relies on:
 *
 *   - `Content-Length` matches the bytes actually written;
 *   - no `Content-Encoding` is advertised (so nothing can be double-decoded);
 *   - keep-alive outlives a browser's idle socket.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createServer, sendJson } from '../server/index.mjs';

/** Minimal request helper against a listening server. */
function request(port, pathname, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function withServer(fn, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ccpc-neo-vp-http-'));
  // Force every upstream call to fail fast so the test never needs the network.
  const fetchImpl = async () => {
    throw Object.assign(new Error('offline test'), { name: 'TypeError' });
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const { server } = await createServer({ port: 0, host: '127.0.0.1', dataDir: dir, ...options });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    return await fn({ server, port, dir });
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}

test('sendJson frames the body honestly and never sets Content-Encoding', () => {
  const chunks = [];
  const headers = {};
  const res = {
    writeHead(status, h) { this.status = status; Object.assign(headers, h); },
    end(body) { if (body) chunks.push(Buffer.from(body)); this.ended = true; },
  };

  const payload = { filler: 'x'.repeat(5000) };
  sendJson({ method: 'GET', headers: { 'accept-encoding': 'gzip, deflate, br, zstd' } }, res, 200, payload);

  assert.equal(res.status, 200);
  assert.equal(headers['content-encoding'], undefined, 'no encoding is advertised');
  assert.equal(headers['content-type'], 'application/json; charset=utf-8');

  const body = Buffer.concat(chunks);
  assert.equal(Number(headers['content-length']), body.byteLength, 'content-length matches the bytes');
  assert.deepEqual(JSON.parse(body.toString('utf8')), payload, 'the body round-trips');
});

test('keep-alive is configured well beyond a browser idle timeout', async () => {
  await withServer(async ({ server }) => {
    assert.ok(
      server.keepAliveTimeout >= 60_000,
      `keepAliveTimeout must outlive an idle browser socket (got ${server.keepAliveTimeout}ms)`,
    );
    assert.ok(
      server.headersTimeout > server.keepAliveTimeout,
      'headersTimeout must exceed keepAliveTimeout to avoid spurious resets',
    );
  });
});

test('/api/health responds with uncompressed JSON and a correct length', async () => {
  await withServer(async ({ port }) => {
    const res = await request(port, '/api/health', {
      headers: { 'accept-encoding': 'gzip, deflate, br, zstd' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-encoding'], undefined);
    assert.equal(Number(res.headers['content-length']), res.body.byteLength);
    const body = JSON.parse(res.body.toString('utf8'));
    assert.equal(body.ok, true);
    assert.equal(typeof body.timeouts.connectMs, 'number');
  });
});

test('a large JSON error response is also uncompressed and correctly framed', async () => {
  await withServer(async ({ port }) => {
    // With the upstream forced offline this returns a 502 JSON error.
    const res = await request(port, '/api/timeline?uk=ccpc2026preliminary', {
      headers: { 'accept-encoding': 'gzip' },
    });
    assert.equal(res.status, 502);
    assert.equal(res.headers['content-encoding'], undefined);
    assert.equal(Number(res.headers['content-length']), res.body.byteLength);
    const body = JSON.parse(res.body.toString('utf8'));
    assert.ok(body.error?.message, 'the error body explains itself');
  });
});

test('keep-alive survives an idle gap then a new request on the same socket', async () => {
  await withServer(async ({ port }) => {
    // A single agent keeps the connection alive between the two requests.
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const once = () => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/health', agent }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
      req.end();
    });

    assert.equal(await once(), 200);
    await new Promise((r) => setTimeout(r, 2500)); // longer than the old 5s default risk window
    assert.equal(await once(), 200, 'the reused socket still answers');
    agent.destroy();
  });
});
