/** Cloudflare Workers entry point for the CCPC Neo VP application. */

import { buildTimeline, WIRE_VERSION } from './server/build-timeline.mjs';
import { createRanklandClient, RanklandError } from './server/rankland.mjs';

const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
const CONTEST_TTL_SECONDS = 30 * 60;
const TIMELINE_TTL_SECONDS = 60 * 60;

function jsonResponse(request, payload, status = 200, cacheSeconds = 0) {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': cacheSeconds > 0 ? `public, max-age=${cacheSeconds}` : 'no-store',
    'x-content-type-options': 'nosniff',
  });
  return new Response(request.method === 'HEAD' ? null : JSON.stringify(payload), { status, headers });
}

function sendError(request, status, code, message) {
  return jsonResponse(request, { error: { code, message } }, status);
}

function httpError(status, code, message) {
  const error = new Error(message);
  error.httpStatus = status;
  error.code = code;
  return error;
}

async function readJsonBody(request) {
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_IMPORT_BYTES) {
    throw httpError(413, 'payload_too_large', '请求体超过 50 MiB 限制');
  }

  if (!request.body) throw httpError(400, 'invalid_json', '请求体不是合法 JSON');
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_IMPORT_BYTES) {
      await reader.cancel();
      throw httpError(413, 'payload_too_large', '请求体超过 50 MiB 限制');
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return JSON.parse(text);
  } catch (cause) {
    throw httpError(400, 'invalid_json', `请求体不是合法 JSON: ${cause.message}`);
  }
}

function cacheApi() {
  return globalThis.caches?.default ?? null;
}

async function readCachedValue(keyUrl, context, ttlSeconds, loader, bypass = false) {
  const cache = cacheApi();
  const key = new Request(keyUrl, { method: 'GET' });

  if (cache && !bypass) {
    try {
      const response = await cache.match(key);
      if (response) return { value: await response.json(), cached: true };
    } catch {
      // A corrupt or unavailable cache entry falls through to the source.
    }
  }

  const value = await loader();
  if (cache && ttlSeconds > 0) {
    try {
      const stored = jsonResponse({ method: 'GET' }, value, 200, ttlSeconds);
      context.waitUntil(cache.put(key, stored).catch(() => {}));
    } catch {
      // Cache availability must not affect the API response.
    }
  }
  return { value, cached: false };
}

function createClient(env) {
  return createRanklandClient({
    baseUrl: env.RL_BASE_URL,
    connectTimeoutMs: positiveNumber(env.RL_CONNECT_TIMEOUT_MS),
    stallTimeoutMs: positiveNumber(env.RL_STALL_TIMEOUT_MS),
  });
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

async function getContests(client, requestUrl, context, { force = false } = {}) {
  const keyUrl = new URL('/api/contests', requestUrl.origin).href;
  return readCachedValue(
    keyUrl,
    context,
    CONTEST_TTL_SECONDS,
    async () => ({ contests: await client.listContests(), fetchedAt: Date.now() }),
    force,
  );
}

async function resolveSrk(client, requestUrl, context, uk) {
  const { value } = await getContests(client, requestUrl, context);
  const summary = value.contests.find((contest) => contest.uk === uk);
  if (!summary) throw httpError(404, 'unknown_contest', `未知比赛: ${uk}`);
  if (!summary.srkFileID) throw httpError(404, 'no_srk', `比赛 ${uk} 没有榜单文件`);
  const meta = await client.getFileMeta(summary.srkFileID);
  return { summary, meta };
}

async function handleImport(request) {
  if (request.method !== 'POST') {
    return sendError(request, 405, 'method_not_allowed', '导入接口仅支持 POST');
  }

  const contentType = (request.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json' && !contentType.endsWith('+json')) {
    return sendError(request, 415, 'unsupported_media_type', '请使用 application/json');
  }

  const body = await readJsonBody(request);
  const ranklist = body?.ranklist ?? body;
  if (!ranklist || typeof ranklist !== 'object'
    || !Array.isArray(ranklist.problems) || !Array.isArray(ranklist.rows)) {
    return sendError(request, 400, 'invalid_ranklist', '请求需要 Standard Ranklist JSON，且包含 problems[] 和 rows[]');
  }
  if (body?.ranklist !== undefined && body.name !== undefined && typeof body.name !== 'string') {
    return sendError(request, 400, 'invalid_name', 'name 必须是字符串');
  }
  if (body?.ranklist !== undefined && typeof body.name === 'string' && body.name.length > 200) {
    return sendError(request, 400, 'invalid_name', 'name 最长 200 个字符');
  }
  if (body?.ranklist !== undefined && body.uk !== undefined && typeof body.uk !== 'string') {
    return sendError(request, 400, 'invalid_uk', 'uk 必须是字符串');
  }
  if (body?.ranklist !== undefined && typeof body.uk === 'string' && body.uk.length > 128) {
    return sendError(request, 400, 'invalid_uk', 'uk 最长 128 个字符');
  }

  const name = body?.ranklist && typeof body.name === 'string' ? body.name.trim() : '';
  const uk = body?.ranklist && typeof body.uk === 'string' && body.uk.trim()
    ? body.uk.trim()
    : 'local-import';

  let timeline;
  try {
    timeline = buildTimeline(ranklist, { uk, name: name || undefined });
  } catch (error) {
    return sendError(request, 400, 'invalid_ranklist', `无法处理榜单数据: ${error.message}`);
  }
  return jsonResponse(request, { success: true, data: { timeline } });
}

async function handleDiagnose(request, client, context) {
  const url = new URL(request.url);
  const requested = url.searchParams.get('uk') ?? 'ccpc2026preliminary';
  const steps = [];
  const timeIt = async (name, callback) => {
    const started = Date.now();
    try {
      const value = await callback();
      steps.push({ name, ok: true, ms: Date.now() - started, ...value });
    } catch (error) {
      steps.push({
        name,
        ok: false,
        ms: Date.now() - started,
        code: error.code ?? 'error',
        error: error.message,
        cause: error.cause?.message ?? null,
      });
    }
  };

  let summary = null;
  await timeIt('listContests', async () => {
    const { value } = await getContests(client, url, context, { force: true });
    summary = value.contests.find((contest) => contest.uk === requested) ?? null;
    return { contests: value.contests.length, stale: false, found: Boolean(summary) };
  });

  if (summary?.srkFileID) {
    let meta = null;
    let ranklist = null;
    await timeIt('getFileMeta', async () => {
      meta = await client.getFileMeta(summary.srkFileID);
      return { name: meta.name, size: meta.size, url: meta.url };
    });
    if (meta?.url) {
      await timeIt('downloadSrk', async () => {
        const fetched = await client.fetchSrk(meta.url);
        ranklist = fetched.ranklist;
        return { bytes: fetched.text.length };
      });
      if (ranklist) {
        await timeIt('buildTimeline', async () => {
          const timeline = buildTimeline(ranklist, {
            uk: summary.uk,
            name: summary.name,
            srkHash: meta.hashValue,
            srkUrl: meta.url,
            srkSize: meta.size,
          });
          return {
            teams: timeline.teams.length,
            problems: timeline.problems.length,
            events: timeline.events.length,
            exact: timeline.coverage.exact,
          };
        });
      }
    }
  }

  return jsonResponse(request, {
    success: true,
    data: {
      uk: requested,
      baseUrl: client.baseUrl,
      timeouts: { connectMs: client.connectTimeoutMs, stallMs: client.stallTimeoutMs },
      steps,
    },
  });
}

async function handleApi(request, env, context) {
  const url = new URL(request.url);
  const { pathname } = url;

  if (pathname === '/api/import') return handleImport(request);

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return sendError(request, 405, 'method_not_allowed', '仅支持 GET/HEAD；POST 仅用于 /api/import');
  }

  const client = createClient(env);

  if (pathname === '/api/health') {
    return jsonResponse(request, {
      ok: true,
      wireVersion: WIRE_VERSION,
      baseUrl: client.baseUrl,
      timeouts: { connectMs: client.connectTimeoutMs, stallMs: client.stallTimeoutMs },
    });
  }

  if (pathname === '/api/diagnose') return handleDiagnose(request, client, context);

  if (pathname === '/api/contests') {
    const result = await getContests(client, url, context, { force: url.searchParams.get('refresh') === '1' });
    const { contests, fetchedAt } = result.value;
    const selectable = contests.map((contest) => ({
      uk: contest.uk,
      name: contest.name,
      startAt: contest.startAt,
      durationSec: contest.duration?.[0] ?? null,
      durationUnit: contest.duration?.[1] ?? null,
      frozenDurationSec: contest.frozenDuration?.[0] ?? null,
      frozenDurationUnit: contest.frozenDuration?.[1] ?? null,
      hasRanklist: Boolean(contest.srkFileID),
      viewCount: contest.viewCount ?? null,
    }));
    return jsonResponse(request, {
      success: true,
      data: { fetchedAt, stale: false, count: selectable.length, contests: selectable },
    }, 200, 300);
  }

  const contestMatch = /^\/api\/contests\/([^/]+)$/.exec(pathname);
  if (contestMatch) {
    const uk = decodeURIComponent(contestMatch[1]);
    const { summary, meta } = await resolveSrk(client, url, context, uk);
    const detail = await client.getContest(uk);
    return jsonResponse(request, { success: true, data: { summary, file: meta, detail } });
  }

  if (pathname === '/api/timeline') {
    const uk = url.searchParams.get('uk');
    if (!uk) return sendError(request, 400, 'missing_uk', '缺少 uk 查询参数');

    const { summary, meta } = await resolveSrk(client, url, context, uk);
    const sourceVersion = meta.hashValue ?? meta.url;
    const cacheUrl = new URL('/api/timeline-cache', url.origin);
    cacheUrl.searchParams.set('uk', uk);
    cacheUrl.searchParams.set('source', sourceVersion ?? '');
    const result = await readCachedValue(cacheUrl.href, context, TIMELINE_TTL_SECONDS, async () => {
      let ranklist;
      try {
        ranklist = (await client.fetchSrk(meta.url)).ranklist;
      } catch (error) {
        throw new RanklandError(`下载榜单失败：${error.message}`, {
          code: 'srk_download_failed',
          status: error.status ?? 0,
          url: meta.url,
          cause: error,
        });
      }
      return buildTimeline(ranklist, {
        uk: summary.uk,
        name: summary.name,
        srkHash: meta.hashValue,
        srkUrl: meta.url,
        srkSize: meta.size,
      });
    });

    return jsonResponse(request, {
      success: true,
      data: { cached: result.cached, stale: false, timeline: result.value },
    }, 200, TIMELINE_TTL_SECONDS);
  }

  return sendError(request, 404, 'not_found', `未找到 ${pathname}`);
}

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    try {
      return await handleApi(request, env, context);
    } catch (error) {
      const status = error.httpStatus
        ?? (error instanceof RanklandError && error.code === 'unknown_contest' ? 404 : 502);
      return sendError(request, status, error.code ?? 'internal_error', error.message ?? '请求失败');
    }
  },
};
