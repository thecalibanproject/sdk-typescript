// Generates TypeScript types from the OpenAPI contract owned by `core/api/openapi.yaml`.
// Usage: pnpm gen:api   (expects the `core` repo checked out next to this one)
//
// CALIBAN_CORE_DIR overrides where core is (default ../core). CALIBAN_GEN_OUT_DIR writes the
// output under another directory instead of src/generated/ (the drift check uses it).
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const coreDir = resolve(root, process.env.CALIBAN_CORE_DIR ?? '../core');
const outDir = resolve(root, process.env.CALIBAN_GEN_OUT_DIR ?? 'src/generated');

const require = createRequire(import.meta.url);
const pkgPath = require.resolve('openapi-typescript/package.json');
const cli = resolve(dirname(pkgPath), JSON.parse(readFileSync(pkgPath, 'utf8')).bin['openapi-typescript']);

const input = resolve(coreDir, 'api/openapi.yaml');
const output = resolve(outDir, 'schema.ts');
mkdirSync(outDir, { recursive: true });
execFileSync(process.execPath, [cli, input, '--default-non-nullable', 'false', '--output', output], {
  stdio: ['ignore', 'ignore', 'inherit'],
});
console.log(`api/openapi.yaml -> ${output}`);
