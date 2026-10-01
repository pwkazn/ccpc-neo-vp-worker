import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'dist');

await mkdir(path.join(output, 'app'), { recursive: true });
await mkdir(path.join(output, 'shared'), { recursive: true });

await copyFile(path.join(root, 'web', 'index.html'), path.join(output, 'index.html'));
for (const file of ['app.mjs', 'board.mjs', 'ui.css']) {
  await copyFile(path.join(root, 'web', file), path.join(output, 'app', file));
}
for (const file of ['live.mjs', 'replay.mjs', 'rules.mjs', 'srk.mjs']) {
  await copyFile(path.join(root, 'shared', file), path.join(output, 'shared', file));
}

process.stdout.write('Cloudflare Worker static assets built in dist/.\n');
