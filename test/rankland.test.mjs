/**
 * RankLand client tests, focused on the timeout semantics.
 *
 * The important property: a *slow but progressing* download must succeed, while
 * a *stalled* one must fail with an explicit reason. Timing out on total
 * duration instead produced the bogus "The operation was aborted." failure.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createRanklandClient, RanklandError, DEFAULT_BASE_URL } from '../server/rankland.mjs';

const encoder = new TextEncoder();

const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

/**
 * Build a fake `fetch` that behaves like the real one with respect to
 * `AbortSignal`: it rejects as soon as the signal fires, including while a
 * simulated delay is in flight.
 *
 * @param {object} spec
 * @param {Array<{delayMs?: number, body?: string, error?: Error}>} [spec.chunks]
 * @param {number} [spec.status]
 * @param {number} [spec.connectDelayMs] delay before response headers resolve
 */
function fakeFetch({ chunks = [], status = 200, connectDelayMs = 0 } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, init });
    const signal = init.signal;

    /** Sleep in slices so an abort is observed promptly. */
    const interruptibleSleep = async (ms) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (signal?.aborted) throw abortError();
        await new Promise((r) => setTimeout(r, Math.min(20, Math.max(0, end - Date.now()))));
      }
      if (signal?.aborted) throw abortError();
    };

    if (connectDelayMs > 0) await interruptibleSleep(connectDelayMs);

    let index = 0;
    const body = {
      getReader() {
        return {
          async read() {
            if (index >= chunks.length) return { done: true, value: undefined };
            const chunk = chunks[index++];
            if (chunk.delayMs) await interruptibleSleep(chunk.delayMs);
            if (chunk.error) throw chunk.error;
            return { done: false, value: encoder.encode(chunk.body ?? '') };
          },
          async cancel() {},
        };
      },
    };

    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      body,
      async text() {
        return chunks.map((chunk) => chunk.body ?? '').join('');
      },
    };
  };
  impl.calls = calls;
  return impl;
}

test('a slow trickling download succeeds with no total-time cap', async () => {
  // 8 chunks of 40ms = ~320ms total: much longer than the 120ms stall timeout,
  // but never stalled, so it must complete and return the whole payload.
  const payload = JSON.stringify({ type: 'general', version: '0.3.13', rows: [] });
  const size = Math.ceil(payload.length / 8);
  const chunks = Array.from({ length: 8 }, (_, i) => ({
    delayMs: 40,
    body: payload.slice(i * size, (i + 1) * size),
  }));
  const fetchImpl = fakeFetch({ chunks });
  const client = createRanklandClient({
    fetchImpl, connectTimeoutMs: 1000, stallTimeoutMs: 120, retries: 0,
  });

  const started = Date.now();
  const { text, ranklist } = await client.fetchSrk('https://cdn.invalid/slow.srk.json');
  const elapsed = Date.now() - started;

  assert.equal(text, payload, 'the whole body was reassembled byte for byte');
  assert.equal(ranklist.version, '0.3.13', 'and it parsed');
  assert.ok(elapsed > 250, `it really did exceed the stall window (took ${elapsed}ms)`);
});

test('a stalled download fails with an explicit stall reason', async () => {
  const fetchImpl = fakeFetch({
    chunks: [
      { body: '{"data":' },
      { delayMs: 5000, body: '{}' }, // never arrives before the stall watchdog
    ],
  });
  const client = createRanklandClient({
    fetchImpl, connectTimeoutMs: 200, stallTimeoutMs: 120, retries: 0,
  });

  const error = await client.getFileMeta('1').then(
    () => null,
    (thrown) => thrown,
  );
  assert.ok(error instanceof RanklandError, 'a RanklandError is thrown');
  assert.equal(error.code, 'stalled');
  assert.match(error.message, /停滞/, 'the message explains the stall');
  assert.doesNotMatch(error.message, /aborted/i, 'never surfaces the raw abort text');
});

test('a dead peer fails with a connect timeout reason', async () => {
  const fetchImpl = fakeFetch({ chunks: [{ body: '{}' }], connectDelayMs: 5000 });
  const client = createRanklandClient({
    fetchImpl, connectTimeoutMs: 120, stallTimeoutMs: 5000, retries: 0,
  });

  const error = await client.getFileMeta('1').then(() => null, (thrown) => thrown);
  assert.equal(error.code, 'timeout');
  assert.match(error.message, /超时/);
  assert.doesNotMatch(error.message, /aborted/i, 'never surfaces the raw abort text');
});

test('a retryable stall is retried and can then succeed', async () => {
  let attempt = 0;
  const payload = '{"data":{"id":"1","url":"https://cdn.invalid/x.srk.json"}}';
  const fetchImpl = async (url, init) => {
    attempt++;
    if (attempt === 1) {
      // First attempt: stall, so the watchdog aborts the read.
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        body: {
          getReader: () => ({
            read: async () => {
              const end = Date.now() + 3000;
              while (Date.now() < end) {
                if (init.signal?.aborted) throw abortError();
                await new Promise((r) => setTimeout(r, 20));
              }
              return { done: true, value: undefined };
            },
          }),
        },
        async text() { return payload; },
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: {
        getReader: () => {
          let sent = false;
          return {
            read: async () => {
              if (sent) return { done: true, value: undefined };
              sent = true;
              return { done: false, value: encoder.encode(payload) };
            },
          };
        },
      },
      async text() { return payload; },
    };
  };

  const logs = [];
  const client = createRanklandClient({
    fetchImpl, connectTimeoutMs: 500, stallTimeoutMs: 100, retries: 2, log: (m) => logs.push(m),
  });

  const meta = await client.getFileMeta('1');
  assert.equal(meta.url, 'https://cdn.invalid/x.srk.json', 'the second attempt succeeded');
  assert.equal(attempt, 2, 'exactly one retry was needed');
  assert.ok(logs.some((line) => /停滞|重试/.test(line)), 'the stall was reported');
});

test('client errors are not retried', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return { ok: false, status: 404, headers: { get: () => null }, body: null, async text() { return ''; } };
  };
  const client = createRanklandClient({ fetchImpl, retries: 3, connectTimeoutMs: 200, stallTimeoutMs: 200 });

  const error = await client.getFileMeta('404').then(() => null, (thrown) => thrown);
  assert.equal(error.code, 'http_client_error');
  assert.equal(calls, 1, 'a 404 is permanent');
});

test('server errors are retried', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return { ok: false, status: 503, headers: { get: () => null }, body: null, async text() { return ''; } };
  };
  const client = createRanklandClient({ fetchImpl, retries: 2, connectTimeoutMs: 200, stallTimeoutMs: 200 });

  const error = await client.getFileMeta('1').then(() => null, (thrown) => thrown);
  assert.equal(error.code, 'http_error');
  assert.equal(calls, 3, 'three attempts: initial + 2 retries');
});

test('a zero-length body is parsed as JSON and reported clearly when invalid', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
    async text() { return ''; },
  });
  const client = createRanklandClient({ fetchImpl, retries: 0, connectTimeoutMs: 200, stallTimeoutMs: 200 });

  const error = await client.getFileMeta('1').then(() => null, (thrown) => thrown);
  assert.equal(error.code, 'bad_json');
  assert.match(error.message, /合法 JSON/);
});

test('fetchSrk parses an SRK document and logs its size', async () => {
  const doc = { type: 'general', version: '0.3.13', problems: [], rows: [] };
  const payload = JSON.stringify(doc);
  const logs = [];
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: {
      getReader: () => {
        let sent = false;
        return {
          read: async () => {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: encoder.encode(payload) };
          },
        };
      },
    },
    async text() { return payload; },
  });
  const client = createRanklandClient({ fetchImpl, retries: 0, connectTimeoutMs: 200, stallTimeoutMs: 200, log: (m) => logs.push(m) });

  const { ranklist, text } = await client.fetchSrk('https://cdn.invalid/x.srk.json');
  assert.deepEqual(ranklist, doc);
  assert.equal(text, payload);
  assert.ok(logs.some((line) => /下载榜单/.test(line)), 'the download is reported');
});

test('a non-JSON ranklist body is reported as bad_json', async () => {
  const payload = '<!DOCTYPE html><html>oops</html>';
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: {
      getReader: () => {
        let sent = false;
        return {
          read: async () => {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: encoder.encode(payload) };
          },
        };
      },
    },
    async text() { return payload; },
  });
  const client = createRanklandClient({ fetchImpl, retries: 0, connectTimeoutMs: 200, stallTimeoutMs: 200 });
  const error = await client.fetchSrk('https://cdn.invalid/x.srk.json').then(() => null, (thrown) => thrown);
  assert.equal(error.code, 'bad_json');
  assert.match(error.message, /合法 JSON/);
});

test('base url defaults and can be overridden', () => {
  const plain = createRanklandClient({ fetchImpl: async () => ({}) });
  assert.equal(plain.baseUrl, DEFAULT_BASE_URL);
  const custom = createRanklandClient({ baseUrl: 'https://mirror.invalid/api/v2/', fetchImpl: async () => ({}) });
  assert.equal(custom.baseUrl, 'https://mirror.invalid/api/v2', 'trailing slashes are trimmed');
});

test('timeouts can be widened from the environment', () => {
  process.env.RL_CONNECT_TIMEOUT_MS = '12345';
  process.env.RL_STALL_TIMEOUT_MS = '67890';
  try {
    const client = createRanklandClient({ fetchImpl: async () => ({}) });
    assert.equal(client.connectTimeoutMs, 12345);
    assert.equal(client.stallTimeoutMs, 67890);
  } finally {
    delete process.env.RL_CONNECT_TIMEOUT_MS;
    delete process.env.RL_STALL_TIMEOUT_MS;
  }
});

test('explicit options win over the environment', () => {
  process.env.RL_STALL_TIMEOUT_MS = '99999';
  try {
    const client = createRanklandClient({ fetchImpl: async () => ({}), stallTimeoutMs: 111 });
    assert.equal(client.stallTimeoutMs, 111);
  } finally {
    delete process.env.RL_STALL_TIMEOUT_MS;
  }
});
