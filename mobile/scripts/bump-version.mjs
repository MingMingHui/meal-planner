#!/usr/bin/env node
/**
 * Increments mobile/version.json's versionCode (Google Play rejects any
 * upload whose versionCode is not higher than every previous upload) and
 * optionally sets a new versionName, keeping package.json's version in step.
 *
 * Usage: npm run version:bump                 # 1.0.0 (1) → 1.0.0 (2)
 *        npm run version:bump -- 1.1.0        # → 1.1.0 (3)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mobileDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const versionPath = path.join(mobileDir, 'version.json');
const pkgPath = path.join(mobileDir, 'package.json');

const version = JSON.parse(fs.readFileSync(versionPath, 'utf8'));
const newName = process.argv[2];
if (newName && !/^\d+\.\d+\.\d+$/.test(newName)) {
  console.error(`versionName must look like 1.2.3 (got "${newName}").`);
  process.exit(1);
}

version.versionCode += 1;
if (newName) version.versionName = newName;
fs.writeFileSync(versionPath, `${JSON.stringify(version, null, 2)}\n`);

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.version = version.versionName;
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

console.log(`versionName ${version.versionName}, versionCode ${version.versionCode}`);
