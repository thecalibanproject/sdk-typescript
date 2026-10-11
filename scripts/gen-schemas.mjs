// Generates TypeScript types from the JSON Schemas owned by `core/schemas/`.
// Usage: pnpm gen:schemas   (expects the `core` repo checked out next to this one)
//
// CALIBAN_CORE_DIR overrides where core is (default ../core; CALIBAN_SCHEMAS_DIR still points at
// the schemas directory itself). CALIBAN_GEN_OUT_DIR writes the output under another directory
// instead of src/generated/ (the drift check uses it).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from 'json-schema-to-typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const coreDir = resolve(root, process.env.CALIBAN_CORE_DIR ?? '../core');
const schemasDir = resolve(root, process.env.CALIBAN_SCHEMAS_DIR ?? resolve(coreDir, 'schemas'));
const outDir = resolve(root, process.env.CALIBAN_GEN_OUT_DIR ?? 'src/generated');

/** schema file -> [output file, root type name] */
const targets = [['node.schema.json', 'node.ts', 'NodeSpec']];

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
  const outPath = resolve(outDir, out);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, ts);
  console.log(`${file} -> ${outPath} (${typeName})`);
}
