#!/usr/bin/env node
/** Runs the Android Gradle wrapper with the given tasks on Windows, macOS or Linux. */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const androidDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'android');
const isWindows = process.platform === 'win32';
// Absolute path: cmd.exe may not search the current directory
// (NoDefaultCurrentDirectoryInExePath).
const wrapper = path.join(androidDir, isWindows ? 'gradlew.bat' : 'gradlew');
const args = process.argv.slice(2);
if (!args.length) {
  console.error('Usage: node scripts/gradle.mjs <task> [...more tasks/flags]');
  process.exit(1);
}

// On macOS/Linux run through sh so a checkout without the executable bit
// (e.g. committed from Windows) still works.
const result = isWindows
  ? spawnSync(wrapper, args, { cwd: androidDir, stdio: 'inherit', shell: true })
  : spawnSync('sh', [wrapper, ...args], { cwd: androidDir, stdio: 'inherit' });
process.exit(result.status ?? 1);
