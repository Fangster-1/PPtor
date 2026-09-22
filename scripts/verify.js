'use strict';
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const checks = ['selftest.js', 'export-regression.js', 'runtime-regression.js', 'pet-ui-regression.js'];
for (const file of checks) {
  const result = spawnSync(process.execPath, [path.join(__dirname, file)], {
    cwd: path.join(__dirname, '..'), stdio: 'inherit', timeout: 120000, windowsHide: true
  });
  if (result.error || result.status !== 0) {
    console.error(`Verification failed: ${file}`, result.error?.message || result.signal || result.status);
    process.exit(1);
  }
}
console.log('All core regressions passed. Run npm run smoke for native Electron acceptance.');
