/**
 * RankLand (rank.ac / rl.algoux.cn) public API client.
 *
 * Only the read-only `/api/v2/public/*` endpoints are used. No credentials are
 * required and none are ever sent.
 *
 * Timeouts
 * --------
 * There is deliberately **no total-time timeout**. A large ranklist on a slow
 * route can legitimately take minutes; the failure worth detecting is a *stall*
 * or a *dead peer*, not a slow transfer. Every request therefore uses:
 *
 *   - `connectTimeoutMs`: time allowed until response headers arrive;
 *   - `stallTimeoutMs`: time allowed between chunks once reading has begun.
 *
 * Both can be widened from the environment (`RL_CONNECT_TIMEOUT_MS`,
 * `RL_STALL_TIMEOUT_MS`) when a route is unusually slow.
 */

export const DEFAULT_BASE_URL = 'https://rl.algoux.cn/api/v2';

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_STALL_TIMEOUT_MS = 45_000;
const DEFAULT_RETRIES = 3;

const envNumber = (name, environment) => {
  const value = Number(environment?.[name] ?? globalThis.process?.env?.[name]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
};

export class RanklandError extends Error {
  constructor(message, { status = 0, url = '', code = 'rankland_error', cause } = {}) {
    super(message);
    this.name = 'RanklandError';
    this.status = status;
    this.url = url;
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Values that are worth retrying: network faults, stalls, 429 and 5xx. */
const RETRYABLE_CODES = new Set([
  'timeout',
  'stalled',
  'network_error',
  'body_error',
  'http_error',
  'api_error',
  'bad_json',
]);

const isRetryable = (error) => error instanceof RanklandError && RETRYABLE_CODES.has(error.code);

/** A stable, human-readable reason for any thrown value. */
function describeError(error) {
  if (error instanceof RanklandError) return error.message;
  if (error?.name === 'AbortError') return '请求被中止';
  if (error?.name === 'TimeoutError') return '请求超时';
  if (error?.cause?.message) return `${error.message} (${error.cause.message})`;
  return error?.message ?? String(error);
}

/**
 * Create a RankLand API client.
 *
 * @param {object} [options]
 * @param {string} [options.baseUrl] override the API base (mirrors, tests)
 * @param {number} [options.connectTimeoutMs]
 * @param {number} [options.stallTimeoutMs]
 * @param {number} [options.retries]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(message: string) => void} [options.log] diagnostic sink
 */
export function createRanklandClient(options = {}) {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const environment = options.env ?? {};
  const connectTimeoutMs = options.connectTimeoutMs
    ?? envNumber('RL_CONNECT_TIMEOUT_MS', environment)
    ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const stallTimeoutMs = options.stallTimeoutMs
    ?? envNumber('RL_STALL_TIMEOUT_MS', environment)
    ?? DEFAULT_STALL_TIMEOUT_MS;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const log = options.log ?? (() => {});

  if (typeof fetchImpl !== 'function') {
    throw new TypeError('global fetch is unavailable');
  }

  const requestHeaders = {
    accept: 'application/json, text/plain, */*',
  };

  /**
   * Fetch and read a response body as text, arming a stall watchdog while
   * reading. Returns the text plus the response (for status/headers).
   */
  async function readText(url, { method = 'GET' } = {}) {
    const controller = new AbortController();
    let watchdog = null;
    let sawHeaders = false;
    let lastError = null;

    const arm = (ms) => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        lastError = new RanklandError(
          sawHeaders
            ? `读取响应停滞超过 ${Math.round(ms / 1000)} 秒: ${url}`
            : `连接 ${url} 超时（${Math.round(ms / 1000)} 秒内未收到响应头）`,
          { url, code: sawHeaders ? 'stalled' : 'timeout' },
        );
        controller.abort();
      }, ms);
      // Do not let a pending watchdog keep the process alive.
      watchdog.unref?.();
    };

    try {
      arm(connectTimeoutMs);
      const response = await fetchImpl(url, {
        method,
        signal: controller.signal,
        headers: requestHeaders,
      });
      sawHeaders = true;
      arm(stallTimeoutMs);

      if (!response.ok) {
        throw new RanklandError(`HTTP ${response.status} for ${url}`, {
          status: response.status,
          url,
          code: response.status >= 400 && response.status < 500 && response.status !== 429
            ? 'http_client_error'
            : 'http_error',
        });
      }

      let text;
      if (response.body && typeof response.body.getReader === 'function') {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const chunks = [];
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          arm(stallTimeoutMs);
          if (value) chunks.push(decoder.decode(value, { stream: true }));
        }
        chunks.push(decoder.decode());
        text = chunks.join('');
      } else {
        text = await response.text();
      }
      return { text, response };
    } catch (error) {
      if (error instanceof RanklandError) throw error;
      // The watchdog aborted us: report the concrete reason, not "aborted".
      if (lastError) throw lastError;
      throw new RanklandError(`无法访问 ${url}: ${describeError(error)}`, {
        url,
        code: 'network_error',
        cause: error,
      });
    } finally {
      if (watchdog) clearTimeout(watchdog);
    }
  }

  /** GET + JSON parse, applied with retry/backoff. */
  async function getJson(url, { retries: maxRetries = retries } = {}) {
    return withRetry(url, maxRetries, async () => {
      const { text } = await readText(url);
      let body;
      try {
        body = JSON.parse(text);
      } catch (error) {
        throw new RanklandError(`响应不是合法 JSON: ${error.message}`, {
          url,
          code: 'bad_json',
          cause: error,
        });
      }
      if (body && typeof body === 'object' && body.success === false) {
        throw new RanklandError(
          `RankLand 返回失败: ${body.message ?? body.code ?? 'unknown'}`,
          { url, code: 'api_error' },
        );
      }
      return body;
    });
  }

  /** GET + text, applied with retry/backoff. */
  async function getText(url, { retries: maxRetries = 2 } = {}) {
    return withRetry(url, maxRetries, async () => (await readText(url)).text);
  }

  /** Retry `worker` on retryable failures with exponential backoff. */
  async function withRetry(url, maxRetries, worker) {
    let lastError = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await worker();
      } catch (error) {
        lastError = error;
        if (!isRetryable(error) || attempt === maxRetries) break;
        const backoff = 400 * 2 ** attempt;
        log(`${describeError(error)} — ${Math.round(backoff / 1000)} 秒后重试 (${attempt + 2}/${maxRetries + 1})`);
        await sleep(backoff);
      }
    }
    if (lastError instanceof RanklandError) throw lastError;
    throw new RanklandError(`请求失败: ${describeError(lastError)}`, {
      url,
      code: 'network_error',
      cause: lastError,
    });
  }

  return {
    baseUrl,
    connectTimeoutMs,
    stallTimeoutMs,

    /** @returns {Promise<Array<object>>} every contest that has a ranklist */
    async listContests() {
      const body = await getJson(`${baseUrl}/public/contests`);
      const contests = body?.data?.contests;
      if (!Array.isArray(contests)) {
        throw new RanklandError('unexpected /public/contests payload', {
          url: `${baseUrl}/public/contests`,
          code: 'bad_payload',
        });
      }
      return contests;
    },

    /** @returns {Promise<object>} one contest's detail */
    async getContest(uk) {
      const url = `${baseUrl}/public/contests/${encodeURIComponent(uk)}`;
      const body = await getJson(url);
      if (!body?.data || typeof body.data !== 'object') {
        throw new RanklandError('unexpected contest detail payload', { url, code: 'bad_payload' });
      }
      return body.data;
    },

    /** @returns {Promise<object>} file metadata, including the download url */
    async getFileMeta(id) {
      const url = `${baseUrl}/public/files/${encodeURIComponent(id)}`;
      const body = await getJson(url);
      if (!body?.data || typeof body.data !== 'object') {
        throw new RanklandError('unexpected file payload', { url, code: 'bad_payload' });
      }
      return body.data;
    },

    /**
     * Download and parse an SRK ranklist.
     * @returns {Promise<{ranklist: object, text: string}>}
     */
    async fetchSrk(url) {
      const started = Date.now();
      const text = await getText(url, { retries: 2 });
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      log(`下载榜单 ${url} 完成: ${(text.length / 1024).toFixed(0)} KiB / ${seconds}s`);
      let ranklist;
      try {
        ranklist = JSON.parse(text);
      } catch (error) {
        throw new RanklandError(`榜单文件不是合法 JSON: ${error.message}`, {
          url,
          code: 'bad_json',
          cause: error,
        });
      }
      return { ranklist, text };
    },
  };
}
