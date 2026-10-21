/** M5 部署脚本：构建（如缺失）+ 打印局域网访问地址与防火墙提示。运行：npm run deploy */
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const PORT = process.env.PORT || 3000;

if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.log('dist/ 缺失，先执行构建…');
  execSync('npm run build', { cwd: root, stdio: 'inherit' });
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
