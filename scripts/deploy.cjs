/** M5 部署脚本：构建（总是重新构建，防止陈旧 dist）+ 打印局域网访问地址与防火墙提示。运行：npm run deploy */
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const PORT = process.env.PORT || 3000;

// 总是重新构建：避免陈旧 dist 被托管（build 含 tsc 检查 + vite 构建 + 构建戳记）
console.log('正在构建（npm run build）…');
execSync('npm run build', { cwd: root, stdio: 'inherit' });
if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('构建后仍缺少 dist/index.html，请检查构建日志');
  process.exit(1);
}

const nets = os.networkInterfaces();
const urls = [];
for (const addrs of Object.values(nets)) {
  for (const a of addrs || []) {
    if (a.family === 'IPv4' && !a.internal) urls.push(`http://${a.address}:${PORT}`);
  }
}

console.log('\n=== TanKing 部署就绪 ===');
console.log('本机访问:   http://localhost:' + PORT);
urls.forEach((u) => console.log('局域网访问: ' + u));
console.log('\n启动服务:   npm start（需保持运行）');
console.log('首次部署如局域网无法访问，请放行防火墙（管理员 PowerShell）:');
console.log('  npm run firewall');
console.log('然后让其他玩家浏览器打开上面的局域网地址即可加入。\n');
