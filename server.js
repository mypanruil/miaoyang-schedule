'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'schedule.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });

const DEFAULT_CONFIG = {
  company: '徐州妙漾医疗美容有限公司',
  earlyShift: '09:00-17:00',
  lateShift: '10:00-19:00',
  restDaysPerMonth: 5,
  adminPassword: 'MiaoYang@2026',
  employees: Array.from({ length: 12 }, (_, i) => ({ name: '员工' + String(i + 1).padStart(2, '0'), pin: '' }))
};

function loadData() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    d.config = Object.assign({}, DEFAULT_CONFIG, d.config || {});
    if (!d.config.employees || !d.config.employees.length) d.config.employees = DEFAULT_CONFIG.employees;
    d.schedules = d.schedules || {};      // schedules[month][emp] = {day: 'early'|'late'|'rest'}
    d.lastSubmitted = d.lastSubmitted || {}; // lastSubmitted[emp] = ISO
    d.adminTokens = d.adminTokens || [];
    return d;
  } catch (e) {
    const d = { config: DEFAULT_CONFIG, schedules: {}, lastSubmitted: {}, adminTokens: [] };
    saveData(d);
    return d;
  }
}
function saveData(d) { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2), 'utf8'); }

let DATA = loadData();
// 安全：把历史弱默认密码 admin123 升级为强密码
if (DATA.config.adminPassword === 'admin123') {
  DATA.config.adminPassword = DEFAULT_CONFIG.adminPassword;
  saveData(DATA);
  console.log('[安全] 已将历史默认管理员密码 admin123 升级为强密码');
}
const adminTokens = new Set(DATA.adminTokens);

function readBody(req, cb) {
  let body = '';
  req.on('data', c => { body += c; if (body.length > 5e6) req.destroy(); });
  req.on('end', () => {
    try { cb(null, body ? JSON.parse(body) : {}); }
    catch (e) { cb(e); }
  });
}
function sendJson(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(s);
}
function sendFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(file).toLowerCase();
    const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(buf);
  });
}
function validToken(token) { return token && adminTokens.has(token); }
function publicConfig() {
  return {
    company: DATA.config.company,
    earlyShift: DATA.config.earlyShift,
    lateShift: DATA.config.lateShift,
    restDaysPerMonth: DATA.config.restDaysPerMonth,
    employees: DATA.config.employees.map(e => ({ name: e.name, hasPin: !!(e.pin && e.pin.length) }))
  };
}
function daysInMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}
function countRest(schedule) {
  return Object.values(schedule || {}).filter(v => v === 'rest').length;
}
function lockInfo(emp) {
  // 员工提交后可随时更改，不再锁定；仅记录最后提交时间供参考
  const last = DATA.lastSubmitted[emp];
  return { locked: false, lastEdit: last || null };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  // ---- 静态首页 ----
  if (p === '/' && req.method === 'GET') return sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
  if (p.startsWith('/static/') && req.method === 'GET') return sendFile(res, path.join(PUBLIC_DIR, path.basename(p)));
  if (p === '/admin.html' && req.method === 'GET') return sendFile(res, path.join(PUBLIC_DIR, 'admin.html'));
  if (p === '/admin' && req.method === 'GET') return sendFile(res, path.join(PUBLIC_DIR, 'admin.html'));

  // ---- 员工：配置 ----
  if (p === '/api/config' && req.method === 'GET') return sendJson(res, 200, publicConfig());

  // ---- 员工：读取自己的排班 ----
  if (p === '/api/schedule' && req.method === 'GET') {
    const emp = url.searchParams.get('emp');
    const month = url.searchParams.get('month');
    const sch = (DATA.schedules[month] && DATA.schedules[month][emp]) || {};
    return sendJson(res, 200, { schedule: sch, ...lockInfo(emp), restDays: countRest(sch) });
  }

  // ---- 员工：提交排班 ----
  if (p === '/api/submit' && req.method === 'POST') {
    return readBody(req, (err, b) => {
      if (err) return sendJson(res, 400, { error: '数据格式错误' });
      const { emp, pin, month, schedule } = b;
      if (!emp || !month || !schedule) return sendJson(res, 400, { error: '缺少员工/月份/排班' });
      const empCfg = DATA.config.employees.find(e => e.name === emp);
      if (!empCfg) return sendJson(res, 400, { error: '员工不存在' });
      if (empCfg.pin && empCfg.pin.length && String(pin) !== empCfg.pin) return sendJson(res, 403, { error: 'PIN 不正确' });
      const rest = countRest(schedule);
      if (rest > DATA.config.restDaysPerMonth) return sendJson(res, 400, { error: `休息天数不能超过 ${DATA.config.restDaysPerMonth} 天（当前 ${rest} 天）` });
      DATA.schedules[month] = DATA.schedules[month] || {};
      DATA.schedules[month][emp] = schedule;
      DATA.lastSubmitted[emp] = new Date().toISOString();
      saveData(DATA);
      return sendJson(res, 200, { ok: true, lastEdit: lockInfo(emp).lastEdit, restDays: rest });
    });
  }

  // ---- 全员排班公开总览（员工可查看汇总结果）----
  if (p === '/api/summary' && req.method === 'GET') {
    const month = url.searchParams.get('month');
    if (!month) return sendJson(res, 400, { error: '缺少月份' });
    const sch = DATA.schedules[month] || {};
    return sendJson(res, 200, {
      month,
      days: daysInMonth(month),
      employees: DATA.config.employees.map(e => e.name),
      schedules: sch
    });
  }

  // ---- 管理员：登录 ----
  if (p === '/api/admin/login' && req.method === 'POST') {
    return readBody(req, (err, b) => {
      if (err) return sendJson(res, 400, { error: '数据格式错误' });
      const pw = process.env.ADMIN_PASSWORD || DATA.config.adminPassword;
      if (String(b.password) !== pw) return sendJson(res, 401, { error: '管理员密码错误' });
      const token = crypto.randomBytes(24).toString('hex');
      adminTokens.add(token);
      DATA.adminTokens = Array.from(adminTokens).slice(-20);
      saveData(DATA);
      return sendJson(res, 200, { token });
    });
  }

  // ---- 管理员：取全部数据 ----
  if (p === '/api/admin/data' && req.method === 'GET') {
    const token = url.searchParams.get('token') || req.headers['x-admin-token'];
    if (!validToken(token)) return sendJson(res, 401, { error: '未授权' });
    return sendJson(res, 200, { config: publicConfig(), schedules: DATA.schedules, months: Object.keys(DATA.schedules) });
  }

  // ---- 管理员：保存单人排班 ----
  if (p === '/api/admin/save' && req.method === 'POST') {
    return readBody(req, (err, b) => {
      if (err) return sendJson(res, 400, { error: '数据格式错误' });
      const token = b.token || req.headers['x-admin-token'];
      if (!validToken(token)) return sendJson(res, 401, { error: '未授权' });
      const { month, emp, schedule } = b;
      if (!month || !emp || !schedule) return sendJson(res, 400, { error: '缺少参数' });
      DATA.schedules[month] = DATA.schedules[month] || {};
      DATA.schedules[month][emp] = schedule;
      saveData(DATA);
      return sendJson(res, 200, { ok: true });
    });
  }

  // ---- 管理员：更新配置 ----
  if (p === '/api/admin/config' && req.method === 'POST') {
    return readBody(req, (err, b) => {
      if (err) return sendJson(res, 400, { error: '数据格式错误' });
      const token = b.token || req.headers['x-admin-token'];
      if (!validToken(token)) return sendJson(res, 401, { error: '未授权' });
      const c = b.config || {};
      if (typeof c.company === 'string') DATA.config.company = c.company;
      if (typeof c.earlyShift === 'string') DATA.config.earlyShift = c.earlyShift;
      if (typeof c.lateShift === 'string') DATA.config.lateShift = c.lateShift;
      if (Number.isInteger(c.restDaysPerMonth)) DATA.config.restDaysPerMonth = c.restDaysPerMonth;
      if (Array.isArray(c.employees)) {
        DATA.config.employees = c.employees.map(e => ({ name: String(e.name || '').trim() || '未命名', pin: String(e.pin || '') }));
      }
      if (typeof c.adminPassword === 'string' && c.adminPassword.length) DATA.config.adminPassword = c.adminPassword;
      saveData(DATA);
      return sendJson(res, 200, { ok: true });
    });
  }

  // ---- 管理员：解除某员工锁定 ----
  if (p === '/api/admin/unlock' && req.method === 'POST') {
    return readBody(req, (err, b) => {
      const token = (b && b.token) || req.headers['x-admin-token'];
      if (!validToken(token)) return sendJson(res, 401, { error: '未授权' });
      if (b && b.emp) { delete DATA.lastSubmitted[b.emp]; saveData(DATA); }
      return sendJson(res, 200, { ok: true });
    });
  }

  // ---- 管理员：导出打印用 HTML（前端再另存为 PDF） ----
  if (p === '/api/admin/export' && req.method === 'GET') {
    const token = url.searchParams.get('token') || req.headers['x-admin-token'];
    if (!validToken(token)) return sendJson(res, 401, { error: '未授权' });
    const month = url.searchParams.get('month');
    const sch = DATA.schedules[month] || {};
    const html = buildReportHtml(month, sch);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: 'not found' }));
});

function buildReportHtml(month, sch) {
  const cfg = DATA.config;
  const names = cfg.employees.map(e => e.name);
  const n = daysInMonth(month);
  const legend = `早班 ${cfg.earlyShift} ｜ 晚班 ${cfg.lateShift} ｜ 休息 ×${cfg.restDaysPerMonth}`;
  let rows = '';
  for (const name of names) {
    const s = sch[name] || {};
    const rest = countRest(s);
    const bad = rest > cfg.restDaysPerMonth;
    rows += `<tr><td class="${bad ? 'bad' : ''}">${esc(name)}${bad ? ` <span class="warn">(${rest}天)</span>` : ''}</td>`;
    for (let d = 1; d <= n; d++) {
      const v = s[String(d)] || '';
      const cls = v === 'rest' ? 'rest' : v === 'early' ? 'early' : v === 'late' ? 'late' : '';
      const txt = v === 'rest' ? '休' : v === 'early' ? '早' : v === 'late' ? '晚' : '';
      rows += `<td class="${cls}">${txt}</td>`;
    }
    rows += '</tr>';
  }
  const head = '<th>员工</th>' + Array.from({ length: n }, (_, i) => `<th>${i + 1}</th>`).join('');
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<style>
 body{font-family:"Microsoft YaHei",sans-serif;margin:16px;}
 h2{margin:4px 0;} .legend{color:#555;margin-bottom:8px;}
 table{border-collapse:collapse;width:100%;font-size:11px;}
 th,td{border:1px solid #bbb;padding:3px 2px;text-align:center;min-width:18px;}
 th{background:#f0f0f0;} td.rest{background:#ffe1e1;color:#b00;} td.early{background:#e7f0ff;} td.late{background:#fff3d6;}
 td.bad{color:#b00;font-weight:bold;} .warn{color:#b00;font-size:9px;}
 @media print{body{margin:0;}}
</style></head><body>
 <h2>${esc(cfg.company)} 排班表</h2>
 <div class="legend">${esc(month)} ｜ ${esc(legend)}</div>
 <table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>
 <script>window.onload=function(){window.print();}</script>
</body></html>`;
}
function esc(s) { return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

server.listen(PORT, '0.0.0.0', () => {
  console.log('排班系统已启动: http://localhost:' + PORT);
  console.log('[权限] 员工端: / ｜ 管理员后台: /admin.html ｜ 管理员密码: ' + (process.env.ADMIN_PASSWORD || DATA.config.adminPassword) + ' （可在 Cloud Studio 环境变量 ADMIN_PASSWORD 中修改）');
});
