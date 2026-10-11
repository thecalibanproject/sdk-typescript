import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

// Drift check: the committed src/generated/ files must be exactly what core's current contract
// produces. Needs core checked out next to this repo (or CALIBAN_CORE_DIR); skipped without it,
// except when CALIBAN_REQUIRE_CORE=1 (CI, `pnpm check:generated`), where a missing core fails.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const coreDir = resolve(root, process.env.CALIBAN_CORE_DIR ?? '../core');
const haveCore =
  existsSync(join(coreDir, 'schemas/node.schema.json')) && existsSync(join(coreDir, 'api/openapi.yaml'));
const required = process.env.CALIBAN_REQUIRE_CORE === '1';

const outDir = mkdtempSync(join(tmpdir(), 'caliban-gen-'));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

function generate(script: string): void {
  const env: NodeJS.ProcessEnv = { ...process.env, CALIBAN_CORE_DIR: coreDir, CALIBAN_GEN_OUT_DIR: outDir };
  delete env.CALIBAN_SCHEMAS_DIR; // compare against the core checkout, not another schemas dir
  execFileSync(process.execPath, [join(root, 'scripts', script)], {
    cwd: root,
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

function expectInSync(file: string, command: string): void {
  const committed = readFileSync(join(root, 'src/generated', file), 'utf8');
  const fresh = readFileSync(join(outDir, file), 'utf8');
  expect(committed === fresh, `src/generated/${file} is stale: run \`${command}\` and commit the result`).toBe(true);
}

describe.skipIf(!haveCore && !required)('generated code is in sync with core', () => {
  it('finds the core checkout', () => {
    expect(haveCore, `core not found at ${coreDir} (set CALIBAN_CORE_DIR)`).toBe(true);
  });

  it.skipIf(!haveCore)('src/generated/node.ts matches core/schemas/node.schema.json', () => {
    generate('gen-schemas.mjs');
    expectInSync('node.ts', 'pnpm gen:schemas');
  });

  it.skipIf(!haveCore)('src/generated/schema.ts matches core/api/openapi.yaml', () => {
    generate('gen-api.mjs');
    expectInSync('schema.ts', 'pnpm gen:api');
  }, 60_000);
});
