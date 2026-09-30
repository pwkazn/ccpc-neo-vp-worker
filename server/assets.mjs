/**
 * Minimal, dependency-free static file server.
 *
 * Only `web/` and `shared/` are exposed. Every resolved path is re-checked
 * against its root before being read, so `..` traversal cannot escape.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(here, '..');

const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
});

/**
 * @param {object} [options]
 * @param {string} [options.webRoot] absolute path of the browser assets
 * @param {string} [options.sharedRoot] absolute path of the isomorphic engine
 */
export function createStaticServer(options = {}) {
  const webRoot = options.webRoot ?? path.join(PROJECT_ROOT, 'web');
  const sharedRoot = options.sharedRoot ?? path.join(PROJECT_ROOT, 'shared');
  const indexPath = path.join(webRoot, 'index.html');

  /** Mount table: URL prefix -> (root directory, whether a directory index is allowed). */
  const mounts = [
    { prefix: '/app/', root: webRoot, index: false },
    { prefix: '/shared/', root: sharedRoot, index: false },
  ];

  /**
   * Resolve a URL pathname to a file inside one of the mounts.
   * @param {string} pathname
   * @returns {{file: string, root: string}|null}
   */
  function resolve(pathname) {
    for (const mount of mounts) {
      if (!pathname.startsWith(mount.prefix)) continue;
      const relative = pathname.slice(mount.prefix.length);
      if (relative.length === 0) return null;
      const decoded = safeDecode(relative);
      if (decoded === null) return null;
      const candidate = path.resolve(mount.root, decoded);
      // Containment check: the resolved path must stay inside the mount root.
      if (candidate !== mount.root && !candidate.startsWith(mount.root + path.sep)) {
        return null;
      }
      return { file: candidate, root: mount.root };
    }
    return null;
  }

  /**
   * Serve a static asset.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {string} pathname
   * @returns {Promise<boolean>} true when a response was sent
   */
  async function serve(req, res, pathname) {
    const target = resolve(pathname);
    if (!target) return false;

    let stat;
    try {
      stat = await fs.stat(target.file);
    } catch {
      return false;
    }
    if (!stat.isFile()) return false;

    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    const contentType = MIME_TYPES[path.extname(target.file).toLowerCase()] ?? 'application/octet-stream';

    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag, 'cache-control': 'no-cache' });
      res.end();
      return true;
    }

    const body = await fs.readFile(target.file);
    res.writeHead(200, {
      'content-type': contentType,
      'content-length': String(body.byteLength),
      etag,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  }

  return { serve, serveIndex, mounts, webRoot, sharedRoot, indexPath };

  /** Serve the single-page app shell. */
  async function serveIndex() {
    return fs.readFile(indexPath, 'utf8');
  }
}

/** Decode a URI component, returning null when it is malformed. */
function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
