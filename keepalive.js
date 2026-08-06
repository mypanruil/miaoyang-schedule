'use strict';
// 保活心跳：定期请求本地服务，尽量防止 Cloud Studio 工作空间休眠。
// 注意：这是"尽力而为"，容器若被平台整体暂停则心跳也会停；
// 若要更稳，建议再配合一个外部监控（如 UptimeRobot）定时打公网网址。
const http = require('http');
const PORT = process.env.PORT || 8080;
const HOST = process.env.KEEPALIVE_HOST || '127.0.0.1';
const MIN = Number(process.env.KEEPALIVE_MIN || 4); // 默认每 4 分钟一次
const INTERVAL = Math.max(1, MIN) * 60 * 1000;

function ping() {
  const t = new Date().toISOString();
  const req = http.get({ host: HOST, port: PORT, path: '/api/config', timeout: 8000 }, res => {
    res.resume();
    console.log(`[keepalive] ${t} 已请求 /api/config -> ${res.statusCode}`);
  });
  req.on('error', e => console.log(`[keepalive] ${t} 请求失败: ${e.message}`));
  req.on('timeout', function () { this.destroy(); console.log(`[keepalive] ${t} 请求超时`); });
}

console.log(`[keepalive] 启动：每 ${MIN} 分钟请求一次 http://${HOST}:${PORT}/api/config`);
ping();
setInterval(ping, INTERVAL);
