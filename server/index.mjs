#!/usr/bin/env node
/**
 * ccpc-neo-vp HTTP server.
 *
 * Serves the browser UI plus a small read-only JSON API that proxies RankLand
 * and converts SRK ranklists into the compact wire timeline the UI replays.
 */

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCache } from './cache.mjs';
import { createRanklandClient, RanklandError } from './rankland.mjs';
import { createStaticServer } from './assets.mjs';
import { buildTimeline, WIRE_VERSION } from './build-timeline.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(here, '..');

const HELP = `ccpc-neo-vp —— CCPC 新赛制实时榜单模拟器

用法:
  node server/index.mjs [options]
  nix run . -- [options]

选项:
  --port <n>        监听端口 (默认 5173, 被占用时自动顺延)
  --host <addr>     监听地址 (默认 127.0.0.1)
  --data-dir <dir>  缓存目录 (默认 $XDG_CACHE_HOME/ccpc-neo-vp)
  --base-url <url>  RankLand API 基地址 (默认 https://rl.algoux.cn/api/v2)
  --verbose         打印每个上游请求的详情（排查网络问题时使用）
  --clear-cache     启动前清空缓存后退出
  --cache-info      打印缓存占用后退出
  -h, --help        显示本帮助

排查网络问题:
  --verbose 启动后打开 http://127.0.0.1:<port>/api/diagnose?uk=<比赛>
  会逐步测试 比赛列表 / 文件元信息 / 榜单下载 并报告耗时与错误。
  连接慢或读取停滞时可放宽超时:
    RL_CONNECT_TIMEOUT_MS=60000 RL_STALL_TIMEOUT_MS=120000

环境变量:
  PORT, HOST, CCPC_NEO_VP_DATA_DIR, RL_BASE_URL,
  RL_CONNECT_TIMEOUT_MS, RL_STALL_TIMEOUT_MS
`;

/** Parse argv into an options object. Returns { help } / { exit } for one-shot modes. */
export function parseArgs(argv) {
  const options = {
    port: Number(process.env.PORT) || 5173,
    host: process.env.HOST || '127.0.0.1',
    dataDir: process.env.CCPC_NEO_VP_DATA_DIR || undefined,
    baseUrl: process.env.RL_BASE_URL || undefined,
    verbose: false,
    clearCache: false,
    cacheInfo: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`选项 ${arg} 缺少参数`);
      return value;
    };
    switch (arg) {
      case '--port': options.port = Number(next()); break;
      case '--host': options.host = next(); break;
      case '--data-dir': options.dataDir = next(); break;
      case '--base-url': options.baseUrl = next(); break;
      case '--clear-cache': options.clearCache = true; break;
      case '--cache-info': options.cacheInfo = true; break;
      case '-v':
      case '--verbose': options.verbose = true; break;
      case '-h':
      case '--help': options.help = true; break;
      default:
        if (arg.startsWith('-')) throw new Error(`未知选项 ${arg}`);
    }
  }

  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error(`端口不合法: ${options.port}`);
  }
  return options;
}

/**
 * Send a JSON body.
 *
 * Deliberately *not* compressed. The client is a browser on the same host, and
 * hand-rolling `Content-Encoding` here caused a body-read stall in Firefox
 * while every other HTTP client was happy. The cost is ~0.8 MB of JSON once per
 * contest over loopback, which is irrelevant next to the risk of an encoding
 * the server manages by hand.
 *
 * Exported for tests, which assert the framing stays honest.
 */
export function sendJson(req, res, status, payload, { cacheSeconds = 0 } = {}) {
  const raw = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(raw.byteLength),
    'cache-control': cacheSeconds > 0 ? `public, max-age=${cacheSeconds}` : 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(req.method === 'HEAD' ? undefined : raw);
}

function sendError(req, res, status, code, message) {
  sendJson(req, res, status, { error: { code, message } });
}

/**
 * Create the server without listening, so tests can drive it directly.
 * @param {object} options parseArgs() output
 */
export async function createServer(options) {
  const cache = createCache({ dataDir: options.dataDir });
  await cache.init();

  const log = (message) => process.stderr.write(`[ccpc-neo-vp] ${message}\n`);
  const verbose = Boolean(options.verbose);
  const debug = (message) => {
    if (verbose) process.stderr.write(`[ccpc-neo-vp:debug] ${message}\n`);
  };
  const rankland = createRanklandClient({ baseUrl: options.baseUrl, log: debug });
  const assets = createStaticServer();

  const CONTEST_TTL_MS = 30 * 60 * 1000;
  /** De-duplicate concurrent timeline builds for the same contest. */
  const inFlight = new Map();

  /** Contest list with a soft TTL; serves stale data when RankLand is down. */
  async function getContests({ force = false } = {}) {
    const cached = await cache.readContests();
    const fresh = cached && Date.now() - cached.fetchedAt < CONTEST_TTL_MS;
    if (!force && fresh) {
      return { contests: cached.contests, fetchedAt: cached.fetchedAt, stale: false };
    }
    try {
      const contests = await rankland.listContests();
      const record = await cache.writeContests(contests);
      return { contests: record.contests, fetchedAt: record.fetchedAt, stale: false };
    } catch (error) {
      if (cached) {
        log(`contest list refresh failed (${error.message}); serving stale cache`);
        return { contests: cached.contests, fetchedAt: cached.fetchedAt, stale: true };
      }
      throw error;
    }
  }

  /** Resolve a contest uk to its SRK file metadata, using cached SRK when possible. */
  async function resolveSrk(uk) {
    const { contests } = await getContests();
    const summary = contests.find((contest) => contest.uk === uk);
    if (!summary) {
      const error = new RanklandError(`未知比赛: ${uk}`, { code: 'unknown_contest' });
      error.httpStatus = 404;
      throw error;
    }
    if (!summary.srkFileID) {
      const error = new RanklandError(`比赛 ${uk} 没有榜单文件`, { code: 'no_srk' });
      error.httpStatus = 404;
      throw error;
    }

    const meta = await rankland.getFileMeta(summary.srkFileID);
    return { summary, meta };
  }

  /**
   * Build (or load from cache) the wire timeline for a contest.
   * @param {string} uk
   */
  async function getTimeline(uk) {
    const existing = inFlight.get(uk);
    if (existing) return existing;

    const task = (async () => {
      const { summary, meta } = await resolveSrk(uk);
      const hash = meta.hashValue ?? null;
      debug(`${uk}: srkFileID=${summary.srkFileID} size=${meta.size} url=${meta.url}`);

      const cachedTimeline = await cache.readTimeline(hash);
      if (cachedTimeline && cachedTimeline.version === WIRE_VERSION) {
        debug(`${uk}: timeline served from cache`);
        return { timeline: cachedTimeline, cached: true, stale: false, meta };
      }

      let ranklist = await cache.readSrk(hash);
      let stale = false;
      if (!ranklist) {
        try {
          const fetched = await rankland.fetchSrk(meta.url);
          ranklist = fetched.ranklist;
          await cache.writeSrk(hash, ranklist);
        } catch (error) {
          // Preserve the concrete reason so the terminal and the UI both show
          // *why* the download failed instead of a generic message.
          log(`下载榜单失败 (${uk}): ${error.code ?? 'unknown'} — ${error.message}`);
          throw new RanklandError(`下载榜单失败：${error.message}`, {
            code: 'srk_download_failed',
            status: error.status ?? 0,
            url: meta.url,
            cause: error,
          });
        }
      } else {
        debug(`${uk}: using cached SRK (${hash})`);
      }

      const timeline = buildTimeline(ranklist, {
        uk: summary.uk,
        name: summary.name,
        srkHash: hash,
        srkUrl: meta.url,
        srkSize: meta.size,
      });
      debug(`${uk}: built timeline with ${timeline.events.length} events (${timeline.coverage.exact ? 'exact' : 'legacy'})`);
      await cache.writeTimeline(hash, timeline);
      return { timeline, cached: false, stale, meta };
    })();

    inFlight.set(uk, task);
    try {
      return await task;
    } finally {
      inFlight.delete(uk);
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;

    try {
      if (verbose) log(`→ ${req.method} ${pathname}${url.search}`);

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendError(req, res, 405, 'method_not_allowed', '仅支持 GET/HEAD');
        return;
      }

      if (pathname === '/' || pathname === '/index.html') {
        let html;
        try {
          html = await assets.serveIndex();
        } catch {
          sendError(req, res, 500, 'ui_missing', '前端资源缺失: web/index.html');
          return;
        }
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-cache',
        });
        res.end(req.method === 'HEAD' ? undefined : html);
        return;
      }

      if (pathname === '/api/health') {
        sendJson(req, res, 200, {
          ok: true,
          wireVersion: WIRE_VERSION,
          dataDir: cache.dataDir,
          baseUrl: rankland.baseUrl,
          timeouts: {
            connectMs: rankland.connectTimeoutMs,
            stallMs: rankland.stallTimeoutMs,
          },
        });
        return;
      }

      // Step-by-step upstream probe. Useful when a download fails on an
      // unusual network route: it reports where the failure happened.
      if (pathname === '/api/diagnose') {
        const requested = url.searchParams.get('uk') ?? 'ccpc2026preliminary';
        const steps = [];
        const timeIt = async (name, fn) => {
          const started = Date.now();
          try {
            const value = await fn();
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

        let contestSummary = null;
        await timeIt('listContests', async () => {
          const { contests, stale } = await getContests({ force: true });
          contestSummary = contests.find((contest) => contest.uk === requested) ?? null;
          return { contests: contests.length, stale, found: Boolean(contestSummary) };
        });

        if (contestSummary?.srkFileID) {
          let meta = null;
          await timeIt('getFileMeta', async () => {
            meta = await rankland.getFileMeta(contestSummary.srkFileID);
            return { name: meta.name, size: meta.size, url: meta.url };
          });

          if (meta?.url) {
            await timeIt('downloadSrk', async () => {
              const { text } = await rankland.fetchSrk(meta.url);
              return { bytes: text.length };
            });
            await timeIt('buildTimeline', async () => {
              const { timeline } = await getTimeline(requested);
              return {
                teams: timeline.teams.length,
                problems: timeline.problems.length,
                events: timeline.events.length,
                exact: timeline.coverage.exact,
              };
            });
          }
        }

        sendJson(req, res, 200, {
          success: true,
          data: {
            uk: requested,
            baseUrl: rankland.baseUrl,
            timeouts: {
              connectMs: rankland.connectTimeoutMs,
              stallMs: rankland.stallTimeoutMs,
            },
            steps,
          },
        });
        return;
      }

      if (pathname === '/api/contests') {
        const force = url.searchParams.get('refresh') === '1';
        const { contests, fetchedAt, stale } = await getContests({ force });
        sendJson(req, res, 200, {
          success: true,
          data: {
            fetchedAt,
            stale,
            count: contests.length,
            contests: contests.map((contest) => ({
              uk: contest.uk,
              name: contest.name,
              startAt: contest.startAt,
              durationSec: contest.duration?.[0] ?? null,
              durationUnit: contest.duration?.[1] ?? null,
              frozenDurationSec: contest.frozenDuration?.[0] ?? null,
              frozenDurationUnit: contest.frozenDuration?.[1] ?? null,
              hasRanklist: Boolean(contest.srkFileID),
              viewCount: contest.viewCount ?? null,
            })),
          },
        }, { cacheSeconds: 300 });
        return;
      }

      const contestMatch = /^\/api\/contests\/([^/]+)$/.exec(pathname);
      if (contestMatch) {
        const uk = decodeURIComponent(contestMatch[1]);
        const { summary, meta } = await resolveSrk(uk);
        const detail = await rankland.getContest(uk);
        sendJson(req, res, 200, {
          success: true,
          data: { summary, file: meta, detail },
        });
        return;
      }

      if (pathname === '/api/timeline') {
        const uk = url.searchParams.get('uk');
        if (!uk) {
          sendError(req, res, 400, 'missing_uk', '缺少 uk 查询参数');
          return;
        }
        const { timeline, cached, stale } = await getTimeline(uk);
        sendJson(req, res, 200, {
          success: true,
          data: {
            cached,
            stale,
            timeline,
          },
        }, { cacheSeconds: 3600 });
        return;
      }

      if (await assets.serve(req, res, pathname)) return;

      sendError(req, res, 404, 'not_found', `未找到 ${pathname}`);
    } catch (error) {
      const status = error.httpStatus
        ?? (error instanceof RanklandError && error.code === 'unknown_contest' ? 404 : 502);
      log(`请求失败 ${req.method} ${pathname}: [${error.code ?? 'internal_error'}] ${error.message}`);
      if (error.cause?.message) log(`  原因: ${error.cause.message}`);
      // Keep the full trace for real faults. Client mistakes (404/400) are
      // expected and would only add noise.
      if (error.stack && status >= 500) log(error.stack);
      sendError(req, res, status, error.code ?? 'internal_error', error.message);
    }
  });

  // Keep-alive must outlive the client's idle expectation. Node's default
  // keepAliveTimeout is 5s, which lets a browser pick a socket that Node is
  // about to close; the request then sits unanswered until the browser gives up
  // with "The operation was aborted." Browsers commonly hold idle sockets for
  // over a minute, so stay comfortably above that.
  server.keepAliveTimeout = 130_000;
  server.headersTimeout = 140_000;
  server.requestTimeout = 300_000;

  return { server, cache, rankland, getTimeline, getContests };
}

/** Find a free port, starting from the requested one. */
async function listenWithFallback(server, host, port, attempts = 20) {
  for (let i = 0; i < attempts; i++) {
    const candidate = port + i;
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.removeListener('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.removeListener('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(candidate, host);
      });
      return candidate;
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
      process.stderr.write(`[ccpc-neo-vp] 端口 ${candidate} 被占用, 尝试 ${candidate + 1}\n`);
    }
  }
  throw new Error(`无法在 ${port}..${port + attempts - 1} 范围内找到可用端口`);
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`参数错误: ${error.message}\n\n${HELP}`);
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    process.stdout.write(HELP);
    return;
  }

  const cache = createCache({ dataDir: options.dataDir });

  if (options.clearCache) {
    await cache.clear();
    process.stdout.write(`已清空缓存: ${cache.dataDir}\n`);
    return;
  }

  if (options.cacheInfo) {
    const stats = await cache.stats();
    const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;
    process.stdout.write(
      `缓存目录: ${stats.dataDir}\n`
      + `  srk:      ${stats.srk.files} 个文件, ${mb(stats.srk.bytes)}\n`
      + `  timeline: ${stats.timeline.files} 个文件, ${mb(stats.timeline.bytes)}\n`,
    );
    return;
  }

  const { server, rankland } = await createServer(options);
  const port = await listenWithFallback(server, options.host, options.port);
  const url = `http://${options.host === '0.0.0.0' ? '127.0.0.1' : options.host}:${port}`;
  process.stdout.write(
    `ccpc-neo-vp 已启动\n`
    + `  打开: ${url}\n`
    + `  缓存: ${cache.dataDir}\n`
    + `  数据源: ${rankland.baseUrl}\n`
    + `  超时: 连接 ${Math.round(rankland.connectTimeoutMs / 1000)}s / 读取停滞 ${Math.round(rankland.stallTimeoutMs / 1000)}s\n`
    + `  自检: ${url}/api/diagnose?uk=ccpc2026preliminary\n`
    + `  (Ctrl+C 退出)\n`,
  );

  const shutdown = async (signal) => {
    process.stdout.write(`\n收到 ${signal}, 正在退出...\n`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

// Only run when executed directly (not when imported by tests).
const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`启动失败: ${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}

export { HELP, PROJECT_ROOT };
