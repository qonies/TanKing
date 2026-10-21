// 启动前检查 dist 构建产物，避免误托管缺失/陈旧的前端（P2 修复；配合 scripts/stamp-dist.cjs）
const fs = require('fs');
const path = require('path');

const html = path.join(__dirname, '..', 'dist', 'index.html');
if (!fs.existsSync(html)) {
  console.error('[TanKing] 缺少 dist/index.html，局域网联机请先运行 npm run build');
  process.exit(1);
}

const info = path.join(__dirname, '..', 'dist', 'build-info.json');
if (!fs.existsSync(info)) {
  console.log('[TanKing] 警告: dist/ 缺少 build-info.json，疑似旧版本构建产物，建议重新执行 npm run build');
} else {
  try {
    const parsed = JSON.parse(fs.readFileSync(info, 'utf8'));
    const pkg = require(path.join(__dirname, '..', 'package.json'));
    if (parsed.version !== pkg.version) {
      console.log(`[TanKing] 警告: dist 构建版本 (${parsed.version}) 与当前 (${pkg.version}) 不一致，建议重新执行 npm run build`);
    }
  } catch {
    console.log('[TanKing] 警告: dist/build-info.json 无法解析，建议重新执行 npm run build');
  }
}
