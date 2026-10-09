// Generates TypeScript types from the JSON Schemas owned by `core/schemas/`.
// Usage: pnpm gen:schemas   (expects the `core` repo checked out next to this one)
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from 'json-schema-to-typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schemasDir = resolve(root, process.env.CALIBAN_SCHEMAS_DIR ?? '../core/schemas');

/** schema file -> [output file, root type name] */
const targets = [['node.schema.json', 'src/generated/node.ts', 'NodeSpec']];

for (const [file, out, typeName] of targets) {
  const schemaPath = resolve(schemasDir, file);
  const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
  // Force a stable root type name regardless of the schema's human-readable title.
  const ts = await compile({ ...schema, title: typeName }, typeName, {
    bannerComment: [
      '/* eslint-disable */',
      '/**',
      ` * AUTO-GENERATED from core/schemas/${file} by scripts/gen-schemas.mjs.`,
      ' * Do not edit by hand. Run `pnpm gen:schemas` to regenerate.',
      ' */',
    ].join('\n'),
    unknownAny: true,
    strictIndexSignatures: false,
    format: true,
    cwd: schemasDir,
    style: { singleQuote: true, semi: true, printWidth: 100 },
  });
  const outPath = resolve(root, out);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, ts);
  console.log(`${file} -> ${out} (${typeName})`);
}
