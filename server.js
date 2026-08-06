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
  configVersion: 2,
  company: '徐州妙漾医疗美容有限公司',
  earlyShift: '09:00-17:00',
  lateShift: '10:00-19:00',
  fullShift: '09:00-19:00',
  restDaysPerMonth: 5,
  employees: Array.from({ length: 12 }, (_, i) => ({ name: '员工' + String(i + 1).padStart(2, '0'), pin: '' }))
};

function loadData() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    d.config = Object.assign({}, DEFAULT_CONFIG, d.config || {});
    if (!d.config.employees || !d.config.employees.length) d.config.employees = DEFAULT_CONFIG.employees;
    d.schedules = d.schedules || {};
    d.lastSubmitted = d.lastSubmitted || {};
    d.adminTokens = d.adminTokens || [];
    d.leaves = d.leaves || {};  // leaves[emp] = [{from, to, reason, createdAt}]
    return d;
  } catch (e) {
    const d = { config: DEFAULT_CONFIG, schedules: {}, lastSubmitted: {}, adminTokens: [], leaves: {} };
    saveData(d);
    return d;
  }
}
function saveData(d) { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2), 'utf8'); }

let DATA = loadData();
// 管理员密码：环境变量 ADMIN_PASSWORD 优先 > 已保存密码 > 默认 admin
// configVersion=2: 清理历史遗留密码问题——仅当密码为空 / 旧默认 admin123 /
// 疑似旧版自动生成的16位随机密码（[a-zA-Z0-9]×16）时重置为 admin；
// 用户在后台手动设置过的密码（如 newpass456）一律保留，不再覆盖
if (!DATA.config.configVersion || DATA.config.configVersion < 2) {
  const p = String(DATA.config.adminPassword || '');
  const looksRandom = /^[a-zA-Z0-9]{16}$/.test(p);
  if (!p || p === 'admin123' || looksRandom) {
    DATA.config.adminPassword = 'admin';
    console.log('[安全] 密码已重置为默认值 admin（建议登录后台后通过"修改密码"自行更改）');
  }
  DATA.config.configVersion = 2;
}
if (process.env.ADMIN_PASSWORD) {
  DATA.config.adminPassword = process.env.ADMIN_PASSWORD;
}
if (DATA.config.adminPassword === 'admin123') DATA.config.adminPassword = 'admin';
saveData(DATA);
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
    fullShift: DATA.config.fullShift,
    restDaysPerMonth: DATA.config.restDaysPerMonth,
    employees: DATA.config.employees.map(e => ({ name: e.name, realName: e.realName || '', hasPin: !!(e.pin && e.pin.length) }))
  };
}
function daysInMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}
function countRest(schedule) {
  return Object.values(schedule || {}).filter(v => v === 'rest').length;
}
function countShift(schedule) {
  let e = 0, l = 0, f = 0, r = 0;
  Object.values(schedule || {}).forEach(v => {
    if (v === 'early') e++;
    else if (v === 'late') l++;
    else if (v === 'full') f++;
    else if (v === 'rest') r++;
  });
  return { e, l, f, r };
}
function firstOffset(month) {
  const [y, m] = month.split('-').map(Number);
  return (new Date(y, m - 1, 1).getDay() + 6) % 7;
}
// 获取员工在某月的请假记录
function getLeaves(emp, month) {
  const all = DATA.leaves[emp] || [];
  const [y, m] = month.split('-').map(Number);
  return all.filter(l => {
    if (!l.from) return false;
    const [fy, fm] = l.from.split('-').map(Number);
    return (fy === y && fm === m);
  });
}
function leavesInRange(from, to, month) {
  // 返回该请假在 month 里覆盖的天数
  const [y, m] = month.split('-').map(Number);
  const n = daysInMonth(month);
  const start = from ? new Date(from) : null;
  const end = to ? new Date(to) : null;
  if (!start || !end) return [];
  // 求与本月 [1, n] 的交集
  const mStart = new Date(y, m - 1, 1);
  const mEnd = new Date(y, m - 1, n, 23, 59, 59);
  const s = start > mStart ? start : mStart;
  const e = end < mEnd ? end : mEnd;
  if (s > e) return [];
  const days = [];
  const cur = new Date(s);
  while (cur <= e) {
    if (cur.getMonth() + 1 === m && cur.getFullYear() === y) {
      days.push(cur.getDate());
    }
    cur.setDate(cur.getDate() + 1);
  }
  return days;
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
    const myLeaves = getLeaves(emp, month);
    return sendJson(res, 200, {
      schedule: sch,
      lastEdit: DATA.lastSubmitted[emp] || null,
      restDays: countRest(sch),
      leaves: myLeaves
    });
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
      // 超期校验
      const now = new Date();
      const [yy, mm] = month.split('-').map(Number);
      const curY = now.getFullYear(), curM = now.getMonth() + 1;
      if (yy < curY || (yy === curY && mm < curM)) return sendJson(res, 400, { error: '该月排班已过期，不能修改' });
      if (yy === curY && mm === curM) {
        const today = now.getDate();
        const prev = (DATA.schedules[month] && DATA.schedules[month][emp]) || {};
        for (const k of Object.keys(schedule)) {
          const dd = Number(k);
          if (dd < today && prev[k] !== undefined && schedule[k] !== prev[k]) {
            return sendJson(res, 400, { error: `已过期的日期（${mm}月${dd}日及之前）不能修改` });
          }
        }
      }
      DATA.schedules[month] = DATA.schedules[month] || {};
      DATA.schedules[month][emp] = schedule;
      DATA.lastSubmitted[emp] = new Date().toISOString();
      saveData(DATA);
      return sendJson(res, 200, { ok: true, lastEdit: DATA.lastSubmitted[emp], restDays: rest });
    });
  }

  // ---- 员工：提交请假 ----
  if (p === '/api/leave' && req.method === 'POST') {
    return readBody(req, (err, b) => {
      if (err) return sendJson(res, 400, { error: '数据格式错误' });
      const { emp, pin, from, to, reason } = b;
      if (!emp || !from || !to) return sendJson(res, 400, { error: '缺少员工/请假起始日期/结束日期' });
      const empCfg = DATA.config.employees.find(e => e.name === emp);
      if (!empCfg) return sendJson(res, 400, { error: '员工不存在' });
      if (empCfg.pin && empCfg.pin.length && String(pin) !== empCfg.pin) return sendJson(res, 403, { error: 'PIN 不正确' });
      if (from > to) return sendJson(res, 400, { error: '结束日期不能早于开始日期' });
      DATA.leaves[emp] = DATA.leaves[emp] || [];
      DATA.leaves[emp].push({
        from, to,
        reason: (reason || '').trim(),
        createdAt: new Date().toISOString()
      });
      saveData(DATA);
      return sendJson(res, 200, { ok: true });
    });
  }

  // ---- 员工：查看自己的请假记录 ----
  if (p === '/api/leave' && req.method === 'GET') {
    const emp = url.searchParams.get('emp');
    const month = url.searchParams.get('month');
    if (!emp) return sendJson(res, 400, { error: '缺少员工' });
    let records = DATA.leaves[emp] || [];
    if (month) {
      const [y, m] = month.split('-').map(Number);
      records = records.filter(l => {
        if (!l.from) return false;
        const [fy, fm] = l.from.split('-').map(Number);
        return fy === y && fm === m;
      });
    }
    // 返回时附带该请假覆盖的本月天数
    const enhanced = records.map(r => {
      const days = month ? leavesInRange(r.from, r.to, month) : [];
      return { ...r, days };
    });
    return sendJson(res, 200, { leaves: enhanced });
  }

  // ---- 全员排班公开总览（员工可查看汇总结果）----
  if (p === '/api/summary' && req.method === 'GET') {
    const month = url.searchParams.get('month');
    if (!month) return sendJson(res, 400, { error: '缺少月份' });
    const sch = DATA.schedules[month] || {};
    // 加载请假数据（供前端排班总览表格渲染红色标记）
    let leaves = {};
    for (const emp of Object.keys(DATA.leaves || {})) {
      const recs = DATA.leaves[emp].filter(l => {
        if (!l.from) return false;
        const [fy, fm] = l.from.split('-').map(Number);
        return fy === parseInt(month.split('-')[0]) && fm === parseInt(month.split('-')[1]);
      });
      if (recs.length) leaves[emp] = recs;
    }
    return sendJson(res, 200, {
      month,
      days: daysInMonth(month),
      employees: DATA.config.employees.map(e => e.name),
      schedules: sch,
      leaves
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
    const month = url.searchParams.get('month');
    let leaves = {};
    if (month) {
      for (const emp of Object.keys(DATA.leaves || {})) {
        const recs = DATA.leaves[emp].filter(l => {
          if (!l.from) return false;
          const [fy, fm] = l.from.split('-').map(Number);
          return fy === parseInt(month.split('-')[0]) && fm === parseInt(month.split('-')[1]);
        });
        if (recs.length) leaves[emp] = recs;
      }
    }
    return sendJson(res, 200, { config: publicConfig(), schedules: DATA.schedules, months: Object.keys(DATA.schedules), leaves });
  }

  // ---- 管理员：获取所有请假记录 ----
  if (p === '/api/admin/leaves' && req.method === 'GET') {
    const token = url.searchParams.get('token') || req.headers['x-admin-token'];
    if (!validToken(token)) return sendJson(res, 401, { error: '未授权' });
    const month = url.searchParams.get('month');
    const result = {};
    for (const emp of Object.keys(DATA.leaves || {})) {
      let recs = DATA.leaves[emp];
      if (month) {
        const [y, m] = month.split('-').map(Number);
        recs = recs.filter(l => {
          if (!l.from) return false;
          const [fy, fm] = l.from.split('-').map(Number);
          return fy === y && fm === m;
        });
      }
      if (recs.length) result[emp] = recs.map(r => {
        const days = month ? leavesInRange(r.from, r.to, month) : [];
        return { ...r, days };
      });
    }
    return sendJson(res, 200, { leaves: result });
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
      if (typeof c.fullShift === 'string') DATA.config.fullShift = c.fullShift;
      if (Number.isInteger(c.restDaysPerMonth)) DATA.config.restDaysPerMonth = c.restDaysPerMonth;
      if (Array.isArray(c.employees)) {
        DATA.config.employees = c.employees.map(e => ({ name: String(e.name || '').trim() || '未命名', realName: (e.realName != null ? String(e.realName) : ''), pin: String(e.pin || '') }));
      }
      if (typeof c.adminPassword === 'string' && c.adminPassword.length) DATA.config.adminPassword = c.adminPassword;
      saveData(DATA);
      return sendJson(res, 200, { ok: true });
    });
  }

  // ---- 管理员：修改管理员密码 ----
  if (p === '/api/admin/change-password' && req.method === 'POST') {
    return readBody(req, (err, b) => {
      if (err) return sendJson(res, 400, { error: '数据格式错误' });
      const token = (b && b.token) || req.headers['x-admin-token'];
      if (!validToken(token)) return sendJson(res, 401, { error: '未授权' });
      const oldPw = (b && b.oldPassword || '').trim();
      const newPw = (b && b.newPassword || '').trim();
      if (!oldPw || !newPw) return sendJson(res, 400, { error: '请输入旧密码和新密码' });
      if (oldPw !== DATA.config.adminPassword) return sendJson(res, 403, { error: '旧密码错误' });
      if (newPw.length < 6) return sendJson(res, 400, { error: '新密码至少 6 位' });
      DATA.config.adminPassword = newPw;
      DATA.adminTokens = [];
      adminTokens.clear();
      saveData(DATA);
      return sendJson(res, 200, { ok: true, msg: '密码修改成功，请重新登录' });
    });
  }

  // ---- 管理员：删除员工请假记录 ----
  if (p === '/api/admin/delete-leave' && req.method === 'POST') {
    return readBody(req, (err, b) => {
      if (err) return sendJson(res, 400, { error: '数据格式错误' });
      const token = b.token || req.headers['x-admin-token'];
      if (!validToken(token)) return sendJson(res, 401, { error: '未授权' });
      const emp = b.emp;
      const idx = b.index;  // 请假记录在数组中的索引
      if (!emp || idx === undefined || idx === null) return sendJson(res, 400, { error: '缺少参数' });
      if (!DATA.leaves[emp] || !DATA.leaves[emp][idx]) return sendJson(res, 404, { error: '记录不存在' });
      DATA.leaves[emp].splice(idx, 1);
      if (!DATA.leaves[emp].length) delete DATA.leaves[emp];
      saveData(DATA);
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

  // ---- 管理员：清除员工排班记录 ----
  if (p === '/api/admin/clear' && req.method === 'POST') {
    return readBody(req, (err, b) => {
      if (err) return sendJson(res, 400, { error: '数据格式错误' });
      const token = b.token || req.headers['x-admin-token'];
      if (!validToken(token)) return sendJson(res, 401, { error: '未授权' });
      const emp = b.emp;
      if (!emp) return sendJson(res, 400, { error: '缺少员工' });
      let removed = 0;
      if (b.allMonths) {
        for (const m of Object.keys(DATA.schedules)) {
          if (DATA.schedules[m] && DATA.schedules[m][emp]) { delete DATA.schedules[m][emp]; removed++; }
        }
      } else if (b.month) {
        if (DATA.schedules[b.month] && DATA.schedules[b.month][emp]) { delete DATA.schedules[b.month][emp]; removed++; }
      } else {
        return sendJson(res, 400, { error: '缺少月份（或未指定全部月份）' });
      }
      saveData(DATA);
      return sendJson(res, 200, { ok: true, removed });
    });
  }

  // ---- 管理员：多维度统计（月底汇总分析）----
  if (p === '/api/admin/stats' && req.method === 'GET') {
    const token = url.searchParams.get('token') || req.headers['x-admin-token'];
    if (!validToken(token)) return sendJson(res, 401, { error: '未授权' });
    const month = url.searchParams.get('month');
    if (!month) return sendJson(res, 400, { error: '缺少月份' });
    const cfg = DATA.config;
    const empReal = {};
    cfg.employees.forEach(e => { empReal[e.name] = e.realName || ''; });
    const names = cfg.employees.map(e => e.name);
    const n = daysInMonth(month);
    const sch = DATA.schedules[month] || {};
    const off = firstOffset(month);

    const perEmployee = names.map(name => {
      const s = sch[name] || {};
      const c = countShift(s);
      const submitted = Object.keys(s).length > 0;
      const empLeaves = getLeaves(name, month);
      const leaveDays = empLeaves.reduce((sum, l) => sum + (l.days ? l.days.length : 0), 0);
      return { name, realName: empReal[name] || '', early: c.e, late: c.l, full: c.f, rest: c.r, submitted, overRest: c.r > cfg.restDaysPerMonth, leaveDays };
    });

    const perDay = [];
    for (let d = 1; d <= n; d++) {
      let e = 0, l = 0, f = 0, r = 0;
      names.forEach(name => {
        const v = (sch[name] || {})[String(d)];
        if (v === 'early') e++;
        else if (v === 'late') l++;
        else if (v === 'full') f++;
        else if (v === 'rest') r++;
      });
      perDay.push({ day: d, weekday: (off + d - 1) % 7, early: e, late: l, full: f, rest: r });
    }

    let totalE = 0, totalL = 0, totalF = 0, totalR = 0, wkE = 0, wkL = 0, wkF = 0, wkR = 0, weE = 0, weL = 0, weF = 0, weR = 0, submitted = 0, totalLeaveDays = 0;
    names.forEach(name => {
      const s = sch[name] || {};
      const c = countShift(s);
      totalE += c.e; totalL += c.l; totalF += c.f; totalR += c.r;
      if (Object.keys(s).length > 0) submitted++;
      const empLeaves = getLeaves(name, month);
      totalLeaveDays += empLeaves.reduce((sum, l) => sum + leavesInRange(l.from, l.to, month).length, 0);
    });
    perDay.forEach(d => {
      if (d.weekday === 5 || d.weekday === 6) { weE += d.early; weL += d.late; weF += d.full; weR += d.rest; }
      else { wkE += d.early; wkL += d.late; wkF += d.full; wkR += d.rest; }
    });

    const restDist = {};
    perEmployee.forEach(e => { restDist[e.rest] = (restDist[e.rest] || 0) + 1; });

    // 请假明细
    const leaveDetail = [];
    for (const emp of Object.keys(DATA.leaves || {})) {
      const recs = DATA.leaves[emp].filter(l => {
        if (!l.from) return false;
        const [fy, fm] = l.from.split('-').map(Number);
        return fy === parseInt(month.split('-')[0]) && fm === parseInt(month.split('-')[1]);
      });
      if (recs.length) {
        leaveDetail.push({ emp, count: recs.length, totalDays: recs.reduce((s, r) => s + leavesInRange(r.from, r.to, month).length, 0), records: recs.map(r => ({ from: r.from, to: r.to, reason: r.reason, days: leavesInRange(r.from, r.to, month).length })) });
      }
    }

    return sendJson(res, 200, {
      month,
      days: n,
      config: { company: cfg.company, earlyShift: cfg.earlyShift, lateShift: cfg.lateShift, fullShift: cfg.fullShift, restDaysPerMonth: cfg.restDaysPerMonth },
      perEmployee,
      perDay,
      totals: { early: totalE, late: totalL, full: totalF, rest: totalR, leaveDays: totalLeaveDays },
      weekday: { early: wkE, late: wkL, full: wkF, rest: wkR },
      weekend: { early: weE, late: weL, full: weF, rest: weR },
      restDist,
      submitted,
      total: names.length,
      leaveDetail
    });
  }

  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: 'not found' }));
});

function buildReportHtml(month, sch) {
  const cfg = DATA.config;
  const names = cfg.employees.map(e => e.name);
  const n = daysInMonth(month);
  const legend = `早班 ${cfg.earlyShift} ｜ 晚班 ${cfg.lateShift} ｜ 通班 ${cfg.fullShift} ｜ 休息 ×${cfg.restDaysPerMonth}`;
  let rows = '';
  for (const name of names) {
    const s = sch[name] || {};
    const rest = countRest(s);
    const bad = rest > cfg.restDaysPerMonth;
    rows += `<tr><td class="${bad ? 'bad' : ''}">${esc(name)}${bad ? ` <span class="warn">(${rest}天)</span>` : ''}</td>`;
    for (let d = 1; d <= n; d++) {
      const v = s[String(d)] || '';
      const cls = v === 'rest' ? 'rest' : v === 'early' ? 'early' : v === 'late' ? 'late' : v === 'full' ? 'full' : '';
      const txt = v === 'rest' ? '休' : v === 'early' ? '早' : v === 'late' ? '晚' : v === 'full' ? '通' : '';
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
 th{background:#f0f0f0;} td.rest{background:#ffe1e1;color:#b00;} td.early{background:#e7f0ff;} td.late{background:#fff3d6;} td.full{background:#e8f5e9;color:#2e7d32;}
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
  console.log('[权限] 员工端: / ｜ 管理员后台: /admin.html ｜ 管理员密码: ' + (process.env.ADMIN_PASSWORD ? '(环境变量 ADMIN_PASSWORD)' : DATA.config.adminPassword) + ' （建议在后台修改密码处自行更改）');
});
