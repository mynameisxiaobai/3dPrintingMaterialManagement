/* check-sync.js — 脏键推送与冲突处理断言（P4 验收）
   真起 agent + 真发 HTTP：jsdom 里的 window.fetch 用 http 模块实现，
   所以每次 PUT 都真的落到服务端，可以数次数、看 body。

   跑法（在项目根）：node tests/check-sync.js
   ────────────────────────────────────────────────────────────── */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { JSDOM } = require('jsdom');

const PORT = Number(process.env.CHECK_SYNC_PORT) || 8894;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-sync-'));
const ROOT = path.join(__dirname, '..');
const AGENT = path.join(ROOT, 'server', 'printer-agent.js');

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; fails.push(name + (extra ? '  ' + extra : '')); console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function eq(got, want, name) {
  ok(JSON.stringify(got) === JSON.stringify(want), name, '得到 ' + JSON.stringify(got) + ' 期望 ' + JSON.stringify(want));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

let TOKEN = null;   // 服务端生成后读出来；raw() 默认自动带上

function raw(method, p, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    const headers = Object.assign({}, TOKEN ? { 'X-FM-Token': TOKEN } : {}, extraHeaders || {});
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: p, method: method, family: 4, headers: headers,
    }, res => {
      const c = [];
      res.on('data', d => c.push(d));
      res.on('end', () => {
        const txt = Buffer.concat(c).toString('utf8');
        let json = null;
        try { json = JSON.parse(txt); } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, text: txt, json: json });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function waitUp(ms) {
  const until = Date.now() + ms;
  return new Promise(resolve => {
    const tick = () => raw('GET', '/api/health').then(r => (r.status === 200 ? resolve(true) : retry())).catch(retry);
    const retry = () => (Date.now() > until ? resolve(false) : setTimeout(tick, 120));
    tick();
  });
}

function start() {
  const child = spawn(process.execPath, [AGENT], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PRINTER_AGENT_DIR: DIR, PRINTER_AGENT_PORT: String(PORT), PRINTER_AGENT_HOST: '127.0.0.1',
      FM_AUTH: 'on',                    // 连带把令牌链路一起测了
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', d => { if (process.env.VERBOSE) process.stdout.write('[agent] ' + d); });
  child.stderr.on('data', d => process.stdout.write('[agent:err] ' + d));
  return child;
}
function stop(child) {
  return new Promise(resolve => {
    if (!child || child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    try { child.kill('SIGKILL'); } catch (e) { resolve(); }
    setTimeout(resolve, 3000);
  });
}

/* 记录所有请求，用于数次数、看 body */
const log = { puts: [], others: [] };

function makeFetch() {
  return function (url, opts) {
    const u = String(url);
    const p = /^https?:/.test(u) ? (new URL(u).pathname + (new URL(u).search || '')) : u;
    const method = ((opts && opts.method) || 'GET').toUpperCase();
    const body = opts && opts.body;
    const hdrs = Object.assign({}, (opts && opts.headers) || {});
    if (method === 'PUT') log.puts.push({ path: p, body: body ? JSON.parse(body) : null, headers: hdrs });
    else log.others.push({ path: p, method: method });
    return raw(method, p, body, hdrs).then(r => ({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: () => Promise.resolve(r.json),
      text: () => Promise.resolve(r.text),
    }));
  };
}

async function load() {
  const html = (await raw('GET', '/')).text;
  const dom = new JSDOM(html, {
    url: 'http://localhost/index.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(w) {
      w.fetch = makeFetch();
      if (!w.AbortController) w.AbortController = function () { this.abort = () => {}; this.signal = {}; };
    },
  });
  await new Promise(r => {
    if (dom.window.document.readyState === 'complete') return r();
    dom.window.addEventListener('load', r);
    setTimeout(r, 4000);
  });
  return dom;
}

const ITEMS = [
  { id: 1, name: '甲', brand: 'eSun', material: 'PLA', color: '#111111', weight: 1000, qty: 1 },
  { id: 2, name: '乙', brand: '三绿', material: 'PETG', color: '#F5F5F5', weight: 1000, qty: 1 },
];

(async () => {
  console.log('\n── 启动测试实例 ' + PORT + ' · ' + DIR + ' ──');
  const child = start();
  if (!await waitUp(12000)) { console.log('❌ agent 没起来'); process.exit(1); }
  TOKEN = fs.readFileSync(path.join(DIR, 'agent-token'), 'utf8').trim();
  ok(!!TOKEN && TOKEN.length >= 32, '0.0 首次启动已生成访问令牌', TOKEN.slice(0, 8) + '…');
  console.log('  agent 就绪\n');

  await raw('PUT', '/api/store', { keys: { filaments: JSON.stringify(ITEMS) } });
  let dom = await load();
  await sleep(300);
  eq(dom.window.eval('FM.on'), true, '0.1 页面进入服务端模式');
  eq(dom.window.eval('window.__FM_TOKEN__ === ' + JSON.stringify(TOKEN)), true, '0.2 令牌已注入页面');
  eq(dom.window.eval('data.length'), 2, '0.3 首屏 2 条');

  /* 首次启动会把历史 amsRef 迁移成「槽位匹配账本」，这本身会产生一个
     只含 prnSlotMatch 的 PUT。先把它收掉，「一次编辑只推一个键」才有意义。 */
  await sleep(500);
  if (log.puts.length) {
    eq(Object.keys(log.puts[log.puts.length - 1].body.keys), ['prnSlotMatch'], '0.4 首次启动只额外推了匹配账本');
    eq(dom.window.eval('prnSlotMatch.__v'), 1, '0.5 账本已写版本号（迁移只跑一次）');
  } else ok(false, '0.4 首次启动应有一次账本迁移写入');
  log.puts.length = 0;

  /* ── 一、一次编辑只推一个键 ── */
  console.log('\n── 一、一次编辑只推改动的那一个键 ──');
  log.puts.length = 0;
  dom.window.eval(`data.push(normalizeItem(${JSON.stringify({ id: 3, name: '丙', brand: '拓竹', material: 'ABS', color: '#C12E1F', weight: 1000, qty: 1 })})); save();`);
  await sleep(900);
  eq(log.puts.length, 1, '1.1 只发了 1 个 PUT');
  eq(Object.keys((log.puts[0] || {}).body.keys || {}), ['filaments'], '1.2 body 里只有 filaments');
  eq((log.puts[0] || {}).body.base.filaments > 0, true, '1.3 带上了 base 版本号');
  eq(((log.puts[0] || {}).headers || {})['X-FM-Token'], TOKEN, '1.3b PUT 自动带了访问令牌');
  let srv = (await raw('GET', '/api/store')).json;
  eq(JSON.parse(srv.keys.filaments.val).length, 3, '1.4 服务端确实变成 3 条');

  /* ── 二、连续 5 次编辑合并 ── */
  console.log('\n── 二、连续编辑合并成 1 个请求 ──');
  log.puts.length = 0;
  for (let i = 0; i < 5; i++) {
    dom.window.eval('data[0].qty = ' + (i + 2) + '; save();');
    await sleep(40);
  }
  await sleep(1000);
  ok(log.puts.length >= 1 && log.puts.length <= 2, '2.1 5 次编辑合并成 1~2 个 PUT', String(log.puts.length));
  srv = (await raw('GET', '/api/store')).json;
  eq(JSON.parse(srv.keys.filaments.val)[0].qty, 6, '2.2 最终值是最新那次');

  /* ── 三、派生缓存不推（打印机页轮询的写放大） ── */
  console.log('\n── 三、printerCfg / printerUsage / swView 不参与同步 ──');
  log.puts.length = 0;
  dom.window.eval('persistPrinterCfg(); persistPrinterUsage(); setSwView("list");');
  await sleep(900);
  eq(log.puts.length, 0, '3.1 这三个键的写入不产生 PUT');
  eq(dom.window.eval("JSON.parse(localStorage.getItem('fmKeyRev')).printerCfg === undefined"), true, '3.2 printerCfg 不在版本表里');

  /* ── 四、同键冲突：不静默丢，要提示 ── */
  console.log('\n── 四、同键冲突 ──');
  await raw('PUT', '/api/store', {
    base: { filaments: (await raw('GET', '/api/store?meta=1')).json.keys.filaments },
    keys: { filaments: JSON.stringify([{ id: 99, name: '别的设备加的', brand: 'x', material: 'PLA', color: '#000000', weight: 1000, qty: 1 }]) },
  });
  log.puts.length = 0;
  /* 把本地版本号改旧，模拟「这台还在用旧版本」 */
  dom.window.eval(`(function(){var r=JSON.parse(localStorage.getItem('fmKeyRev'));r.filaments=1;localStorage.setItem('fmKeyRev',JSON.stringify(r));})()`);
  dom.window.eval('data[0].qty = 77; save();');
  await sleep(1200);
  eq(log.puts.length, 1, '4.1 发了 1 个 PUT');
  const toastTxt = dom.window.eval("(document.getElementById('swToastMsg')||{}).textContent || ''");
  ok(toastTxt.indexOf('另一台设备') >= 0, '4.2 明确提示「另一台设备也改过」', JSON.stringify(toastTxt));
  eq(dom.window.eval('data[0].qty'), 77, '4.3 本地改动没有被回滚');
  const synced = (await raw('GET', '/api/store')).json;
  eq(JSON.parse(synced.keys.filaments.val)[0].name, '别的设备加的', '4.4 服务端仍是对方的版本（不静默覆盖）');

  /* ── 五、关页面前兜底 flush ── */
  console.log('\n── 五、pagehide 兜底 flush ──');
  dom.window.eval(`(function(){var r=JSON.parse(localStorage.getItem('fmKeyRev'));r.filaments=${JSON.stringify((await raw('GET', '/api/store?meta=1')).json.keys.filaments)};localStorage.setItem('fmKeyRev',JSON.stringify(r));})()`);
  log.puts.length = 0;
  dom.window.eval('data[0].qty = 88; save();');
  dom.window.dispatchEvent(new dom.window.Event('pagehide'));   // 不等 400ms 防抖
  await sleep(600);
  eq(log.puts.length, 1, '5.1 pagehide 立刻推了一次');
  const last = (await raw('GET', '/api/store')).json;
  eq(JSON.parse(last.keys.filaments.val)[0].qty, 88, '5.2 关页面前那次改动没丢');

  /* ── 六、离线时改动进 fmUnsent，下次打开能补推 ── */
  console.log('\n── 六、推送失败不丢数据 ──');
  dom.window.eval("localStorage.removeItem('fmUnsent')");
  await stop(child);                        // 让服务端下线
  dom.window.eval('data[0].qty = 999; save();');
  await sleep(900);
  const unsent = dom.window.eval("localStorage.getItem('fmUnsent')");
  ok(unsent && unsent.indexOf('filaments') >= 0, '6.1 失败的改动落到了 fmUnsent', String(unsent).slice(0, 40));
  dom.close ? dom.close() : dom.window.close();

  /* ── 七、服务端回来后再开页面，把没推上去的补上去 ── */
  const child2 = start();
  ok(await waitUp(12000), '7.1 服务端重新上线');
  /* 直接把 fmUnsent 灌进新页面的 localStorage：jsdom 每次新建都是干净存储，
     所以这里手工预置，模拟「上次没推上去的那次改动」 */
  const html = (await raw('GET', '/')).text;
  const dom2 = new JSDOM(html, {
    url: 'http://localhost/index.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(w) {
      w.fetch = makeFetch();
      if (!w.AbortController) w.AbortController = function () { this.abort = () => {}; this.signal = {}; };
      w.localStorage.setItem('fmUnsent', JSON.stringify({ filaments: JSON.stringify([{ id: 500, name: '离线加的', brand: 'x', material: 'PLA', color: '#000000', weight: 1000, qty: 1 }]) }));
    },
  });
  await new Promise(r => { dom2.window.addEventListener('load', r); setTimeout(r, 4000); });
  await sleep(1200);
  eq(dom2.window.eval('data.length'), 1, '7.2 离线改动优先于服务端旧值');
  eq(dom2.window.eval('data[0].name'), '离线加的', '7.3 是离线那条');
  const after = (await raw('GET', '/api/store')).json;
  ok(after.keys.filaments.val.indexOf('离线加的') >= 0, '7.4 已经补推到服务端');
  dom2.window.close();

  await stop(child2);
  console.log('\n════════════════════════');
  console.log((fail === 0 ? '✅ 全部通过' : '❌ 有失败') + '：' + pass + ' / ' + (pass + fail));
  if (fails.length) fails.forEach(f => console.log('  · ' + f));
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.log('❌ 测试异常：' + (e && e.stack || e));
  process.exit(1);
});
