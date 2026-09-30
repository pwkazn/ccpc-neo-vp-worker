/**
 * Small on-disk cache for contest lists, SRK files and built timelines.
 *
 * Layout:
 *   <dataDir>/contests.json
 *   <dataDir>/srk/<sha256>.json
 *   <dataDir>/timeline/<sha256>.json
 *
 * Writes are atomic (temp file + rename) so a killed process never leaves a
 * half-written cache entry behind.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

/**
 * @param {object} [options]
 * @param {string} [options.dataDir]
 * @param {number} [options.memoryLimit] max entries kept in the memory layer
 */
export function createCache(options = {}) {
  const dataDir = options.dataDir
    ?? process.env.CCPC_NEO_VP_DATA_DIR
    ?? path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'ccpc-neo-vp');

  const memoryLimit = options.memoryLimit ?? 64;
  /** @type {Map<string, unknown>} */
  const memory = new Map();

  const paths = {
    root: dataDir,
    contests: path.join(dataDir, 'contests.json'),
    srk: path.join(dataDir, 'srk'),
    timeline: path.join(dataDir, 'timeline'),
  };

  function remember(key, value) {
    memory.delete(key);
    memory.set(key, value);
    while (memory.size > memoryLimit) {
      const oldest = memory.keys().next().value;
      memory.delete(oldest);
    }
    return value;
  }

  async function readJson(file) {
    try {
      const raw = await fs.readFile(file, 'utf8');
      return JSON.parse(raw);
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  async function writeJson(file, value) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(value), 'utf8');
    await fs.rename(temp, file);
  }

  return {
    dataDir,
    paths,

    /** Ensure the cache directories exist. */
    async init() {
      await fs.mkdir(paths.srk, { recursive: true });
      await fs.mkdir(paths.timeline, { recursive: true });
    },

    /** @returns {Promise<{contests: object[], fetchedAt: number}|null>} */
    async readContests() {
      return readJson(paths.contests);
    },

    /** @param {object[]} contests */
    async writeContests(contests) {
      const record = { contests, fetchedAt: Date.now() };
      remember('contests', record);
      await writeJson(paths.contests, record);
      return record;
    },

    /**
     * Read a cached SRK document by content hash.
     * @param {string} hash
     */
    async readSrk(hash) {
      if (!hash) return null;
      const key = `srk:${hash}`;
      if (memory.has(key)) return memory.get(key);
      const value = await readJson(path.join(paths.srk, `${sanitize(hash)}.json`));
      return value ? remember(key, value) : null;
    },

    /**
     * @param {string} hash
     * @param {object} ranklist
     */
    async writeSrk(hash, ranklist) {
      if (!hash) return;
      remember(`srk:${hash}`, ranklist);
      await writeJson(path.join(paths.srk, `${sanitize(hash)}.json`), ranklist);
    },

    /**
     * Read a cached wire timeline by SRK content hash.
     * @param {string} hash
     */
    async readTimeline(hash) {
      if (!hash) return null;
      const key = `timeline:${hash}`;
      if (memory.has(key)) return memory.get(key);
      const value = await readJson(path.join(paths.timeline, `${sanitize(hash)}.json`));
      return value ? remember(key, value) : null;
    },

    /**
     * @param {string} hash
     * @param {object} timeline
     */
    async writeTimeline(hash, timeline) {
      if (!hash) return;
      remember(`timeline:${hash}`, timeline);
      await writeJson(path.join(paths.timeline, `${sanitize(hash)}.json`), timeline);
    },

    /** Remove every cached file. */
    async clear() {
      memory.clear();
      await fs.rm(paths.root, { recursive: true, force: true });
      await this.init();
    },

    /** Best-effort disk usage report for `--cache-info`. */
    async stats() {
      const collect = async (dir) => {
        let files = 0;
        let bytes = 0;
        let entries;
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          return { files, bytes };
        }
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          try {
            const stat = await fs.stat(path.join(dir, entry.name));
            files++;
            bytes += stat.size;
          } catch {
            /* ignore unreadable entries */
          }
        }
        return { files, bytes };
      };

      const [srk, timeline] = await Promise.all([collect(paths.srk), collect(paths.timeline)]);
      return { dataDir, srk, timeline };
    },
  };
}

/** Keep hashes from escaping the cache directory. */
function sanitize(hash) {
  return String(hash).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128);
}
