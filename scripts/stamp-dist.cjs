// 构建后写入 dist/build-info.json（版本 + 时间戳），供 scripts/check-dist.cjs 检查 dist 新旧
const fs = require('fs');
const path = require('path');

const pkg = require(path.join(__dirname, '..', 'package.json'));
const out = path.join(__dirname, '..', 'dist', 'build-info.json');
fs.writeFileSync(out, JSON.stringify({ version: pkg.version, builtAt: new Date().toISOString() }, null, 2) + '\n');
console.log(`[TanKing] dist 构建戳记已写入 (${pkg.version})`);
