// Portable syntax and package consistency checks; no Electron window or AI calls.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = false;
let checked = 0;

function checkDir(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) checkDir(file);
    else if (/\.(?:mjs|cjs|js)$/.test(entry.name)) {
      const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true });
      checked++;
      if (result.status !== 0) {
        failed = true;
        console.error(`${path.relative(root, file)}\n${result.stderr || result.error || 'Syntax check failed'}`);
      }
    }
  }
}

for (const dir of ['src', 'electron', 'public', 'scripts', 'test']) checkDir(path.join(root, dir));

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
for (const key of ['name', 'version', 'license', 'engines', 'devDependencies']) {
  if (JSON.stringify(pkg[key]) !== JSON.stringify(lock.packages[''][key])) {
    failed = true;
    console.error(`package-lock.json is out of sync: ${key}`);
  }
}

console.log(`Checked ${checked} JavaScript files and package metadata.`);
process.exitCode = failed ? 1 : 0;
