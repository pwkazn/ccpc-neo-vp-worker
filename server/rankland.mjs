/**
 * RankLand (rank.ac / rl.algoux.cn) public API client.
 *
 * Only the read-only `/api/v2/public/*` endpoints are used. No credentials are
 * required and none are ever sent.
 */

export const DEFAULT_BASE_URL = 'https://rl.algoux.cn/api/v2';

/** Requests for the large SRK files need a generous timeout. */
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_RETRIES = 3;

export class RanklandError extends Error {
  constructor(message, { status = 0, url = '', code = 'rankland_error' } = {}) {
    super(message);
    this.name = 'RanklandError';
    this.status = status;
    this.url = url;
    this.code = code;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Create a RankLand API client.
 *
 * @param {object} [options]
 * @param {string} [options.baseUrl] override the API base (mirrors, tests)
 * @param {number} [options.timeoutMs]
 * @param {number} [options.retries]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(message: string) => void} [options.log]
 */
export function createRanklandClient(options = {}) {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const log = options.log ?? (() => {});

  if (typeof fetchImpl !== 'function') {
    throw new TypeError('global fetch is unavailable; Node >= 20 is required');
  }

  /**
   * Perform one HTTP GET with a timeout, returning the parsed JSON body.
   * Retries transient failures with exponential backoff.
   */
  async function getJson(url, { retries: maxRetries = retries } = {}) {
    let lastError = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, {
          signal: controller.signal,
          headers: {
            accept: 'application/json, text/plain, */*',
            'user-agent': 'ccpc-neo-vp/0.1 (+personal use)',
          },
        });

        if (!response.ok) {
          // 4xx other than 429 are permanent; do not burn retries on them.
          const permanent = response.status >= 400 && response.status < 500 && response.status !== 429;
          throw new RanklandError(
            `HTTP ${response.status} for ${url}`,
            { status: response.status, url, code: permanent ? 'http_client_error' : 'http_error' },
          );
        }

        const body = await response.json();
        if (body && typeof body === 'object' && body.success === false) {
          throw new RanklandError(
            `RankLand reported failure for ${url}: ${body.message ?? body.code ?? 'unknown'}`,
            { status: response.status, url, code: 'api_error' },
          );
        }
        return body;
      } catch (error) {
        lastError = error;
        const permanent = error instanceof RanklandError && error.code === 'http_client_error';
        if (permanent || attempt === maxRetries) break;
        const backoff = 400 * 2 ** attempt;
        log(`retrying ${url} after ${error.message} (attempt ${attempt + 2}/${maxRetries + 1})`);
        await sleep(backoff);
      } finally {
        clearTimeout(timer);
      }
    }

    if (lastError instanceof RanklandError) throw lastError;
    throw new RanklandError(
      `request failed for ${url}: ${lastError?.message ?? 'unknown error'}`,
      { url, code: 'network_error' },
    );
  }

  /** Download a text resource (the SRK files are plain JSON on a CDN). */
  async function getText(url, { retries: maxRetries = 2 } = {}) {
    let lastError = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, {
          signal: controller.signal,
          headers: {
            accept: 'application/json, text/plain, */*',
            'user-agent': 'ccpc-neo-vp/0.1 (+personal use)',
          },
        });
        if (!response.ok) {
          throw new RanklandError(`HTTP ${response.status} for ${url}`, {
            status: response.status,
            url,
            code: response.status === 404 ? 'not_found' : 'http_error',
          });
        }
        return await response.text();
      } catch (error) {
        lastError = error;
        if (error instanceof RanklandError && error.code === 'not_found') break;
        if (attempt === maxRetries) break;
        await sleep(500 * 2 ** attempt);
      } finally {
        clearTimeout(timer);
      }
    }
    if (lastError instanceof RanklandError) throw lastError;
    throw new RanklandError(`failed to download ${url}: ${lastError?.message}`, {
      url,
      code: 'network_error',
    });
  }

  return {
    baseUrl,

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
      const text = await getText(url, { retries: 2 });
      let ranklist;
      try {
        ranklist = JSON.parse(text);
      } catch (error) {
        throw new RanklandError(`ranklist is not valid JSON: ${error.message}`, {
          url,
          code: 'bad_json',
        });
      }
      return { ranklist, text };
    },
  };
}
