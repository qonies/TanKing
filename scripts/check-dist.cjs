// 启动前检查 dist 构建产物，避免误托管缺失/陈旧的前端（P2 修复）
const fs = require('fs');
const path = require('path');
const html = path.join(__dirname, '..', 'dist', 'index.html');
if (!fs.existsSync(html)) {
  console.error('[TanKing] 缺少 dist/index.html，局域网联机请先运行 npm run build');
  process.exit(1);
}
const content = fs.readFileSync(html, 'utf8');
if (content.includes('M1 单机核心')) {
  console.log('[TanKing] 警告: dist/ 疑似旧版本构建产物，建议重新执行 npm run build');
}