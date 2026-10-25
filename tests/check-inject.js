/* check-inject.js — 注入快照 + 同步 hydrate 断言（P3 验收）
   真起 agent → 写入 store → 把 / 吐出来的 HTML 丢进 jsdom →
   断言「DOMContentLoaded 时刻页面里就是服务端那三条」，而不是 DEFAULT_DATA 的 8 条示例。

   跑法（在项目根）：node tests/check-inject.js
   ────────────────────────────────────────────────────────────── */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { JSDOM } = require('jsdom');

const PORT = Number(process.env.CHECK_INJECT_PORT) || 8893;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-inject-'));
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

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: p, method: method, family: 4,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
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
    const tick = () => req('GET', '/api/health')
      .then(r => (r.status === 200 ? resolve(true) : retry()))
      .catch(retry);
    const retry = () => (Date.now() > until ? resolve(false) : setTimeout(tick, 120));
    tick();
  });
}

function start() {
  const child = spawn(process.execPath, [AGENT], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PRINTER_AGENT_DIR: DIR,
      PRINTER_AGENT_PORT: String(PORT),
      PRINTER_AGENT_HOST: '127.0.0.1',
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

/* 把一个 URL 的 HTML 丢进 jsdom，等 load 后返回 window。
   fetch 必须 stub 成永不 resolve（和 smoke-slice 保持一致）：
   否则 prnProbe 会真去连 /api/health，慢机器上会拖到超时。 */
async function load(html) {
  const dom = new JSDOM(html, {
    url: 'http://localhost/index.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(w) {
      w.fetch = () => new Promise(() => {});
      w.AbortController = w.AbortController || function () { this.abort = () => {}; this.signal = {}; };
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
  { id: 11, name: '甲牌黑PLA', brand: 'eSun', material: 'PLA', color: '#111111', weight: 1000, qty: 1 },
  { id: 12, name: '乙牌白PETG', brand: '三绿', material: 'PETG', color: '#F5F5F5', weight: 1000, qty: 2 },
  { id: 13, name: '丙牌红ABS', brand: '拓竹', material: 'ABS', color: '#C12E1F', weight: 1000, qty: 1 },
];

/* 带正确 base 的写入（不带 base 时服务端会按版本号冲突返回 409，这是设计如此） */
async function put(key, val) {
  const m = (await req('GET', '/api/store?meta=1')).json.keys || {};
  const keys = {}; keys[key] = val;
  const base = {}; base[key] = m[key] || 0;
  return req('PUT', '/api/store', { base: base, keys: keys });
}

function etag() {
  return new Promise(res => http.get({ host: '127.0.0.1', port: PORT, path: '/', family: 4 }, x => { x.resume(); res(x.headers.etag); }));
}

/* body.textContent 会把内联 <script> 的源码也算进去（DEFAULT_DATA 里就有「玉白」），
   所以查渲染结果前先把 script 摘掉 */
function visibleText(dom) {
  dom.window.eval("[...document.querySelectorAll('script')].forEach(s => s.remove())");
  return dom.window.document.body.textContent;
}

(async () => {
  console.log('\n── 启动测试实例 ' + PORT + ' · ' + DIR + ' ──');
  const child = start();
  if (!await waitUp(12000)) { console.log('❌ agent 没起来'); process.exit(1); }
  console.log('  agent 就绪\n');

  /* ── 一、空 store：显示示例数据，但不许偷偷写回服务端 ── */
  console.log('── 一、空 store ──');
  let r = await req('GET', '/');
  ok(r.text.indexOf('__FM_STORE__') > 0, '1.1 页面里有注入的快照');
  ok(r.text.indexOf('__FM_SERVER__=1') > 0, '1.2 标记了服务端模式');
  let dom = await load(r.text);
  eq(dom.window.eval('data.length'), 8, '1.3 空库时显示 8 条内置示例');
  dom.window.close();
  r = await req('GET', '/api/store');
  eq(r.json.keys, {}, '1.4 示例数据没有被写回服务端');
  eq(r.json.initialized, false, '1.5 initialized 仍为 false');

  /* ── 二、写入 3 条 → 首屏直接就是这 3 条 ── */
  console.log('\n── 二、注入后首屏就是服务端数据 ──');
  r = await req('PUT', '/api/store', { keys: { filaments: JSON.stringify(ITEMS) } });
  eq(r.status, 200, '2.1 写入成功');
  r = await req('GET', '/');
  dom = await load(r.text);
  eq(dom.window.eval('data.length'), 3, '2.2 首屏 3 条（不是示例的 8 条）');
  eq(dom.window.eval('data.map(d=>d.name)'), ['甲牌黑PLA', '乙牌白PETG', '丙牌红ABS'], '2.3 名字与服务端一致');
  ok(visibleText(dom).indexOf('玉白') < 0, '2.4 页面上找不到示例数据「玉白」');
  eq(dom.window.eval("localStorage.getItem('fmKeyRev') && JSON.parse(localStorage.getItem('fmKeyRev')).filaments > 0"), true,
    '2.5 每键版本号已落到 localStorage');
  dom.window.close();

  /* ── 三、rev 变了 ETag 必须跟着变（否则 304 会让页面停在旧快照） ── */
  console.log('\n── 三、ETag 随 rev 变 ──');
  const h1 = await etag();
  eq((await put('filaments', '[]')).status, 200, '3.0 清空写入成功');
  const h2 = await etag();
  ok(h1 && h2 && h1 !== h2, '3.1 rev 变化后 ETag 跟着变', h1 + ' → ' + h2);
  const inm = await new Promise(res => http.get({
    host: '127.0.0.1', port: PORT, path: '/', family: 4,
    headers: { 'If-None-Match': h1 },
  }, x => { x.resume(); res(x.statusCode); }));
  eq(inm, 200, '3.2 拿旧 ETag 来换，必须回 200 新内容而不是 304');

  /* ── 四、删空就是空，不再「删空复活」 ── */
  console.log('\n── 四、删空不再复活 ──');
  r = await req('GET', '/');
  dom = await load(r.text);
  eq(dom.window.eval('data.length'), 0, '4.1 filaments=[] 时页面 0 条');
  dom.window.close();

  /* ── 五、脏数据里带 </script> 不能截断页面 ── */
  console.log('\n── 五、注入内容不会被 </script> 截断 ──');
  const evil = [{ id: 21, name: '危险</script><script>window.__PWN__=1</script>', brand: 'x', material: 'PLA', color: '#000000', weight: 1000, qty: 1 }];
  eq((await put('filaments', JSON.stringify(evil))).status, 200, '5.0 恶意内容写入成功');
  r = await req('GET', '/');
  /* 基准从源文件取：页面里有几个 script 块是它自己的事（head 里有一个防白闪的主题预置），
     这里只关心「脏数据有没有多造出一个 </script>」。 */
  const srcScripts = (fs.readFileSync(path.join(ROOT, 'web', 'filament-manager.html'), 'utf8').match(/<\/script>/g) || []).length;
  eq((r.text.match(/<\/script>/g) || []).length, srcScripts, '5.1 注入后 </script> 数量不增加（脏数据没截断页面）');
  dom = await load(r.text);
  eq(dom.window.__PWN__, undefined, '5.2 没有执行注入的脚本');
  eq(dom.window.eval('data.length'), 1, '5.3 页面仍然正常初始化');
  ok(dom.window.eval('data[0].name').indexOf('</script>') > 0, '5.4 名字里的 </script> 被正确还原');
  dom.window.close();

  /* ── 六、file:// 场景（无注入）完全不受影响 ── */
  console.log('\n── 六、无注入时行为不变 ──');
  const raw = fs.readFileSync(path.join(ROOT, 'web', 'filament-manager.html'), 'utf8');
  dom = await load(raw);
  eq(dom.window.eval('typeof FM'), 'object', '6.1 FM 垫片存在');
  eq(dom.window.eval('FM.on'), false, '6.2 但处于关闭状态');
  eq(dom.window.eval('data.length'), 8, '6.3 无存储时走 8 条示例（老行为）');
  eq(dom.window.eval("typeof lsSet"), 'function', '6.4 lsSet 可用');
  dom.window.close();

  /* ── 七、容器 bridge 网络下「搜不到」必须说清是网络模式问题 ── */
  console.log('\n── 七、组播不可用的降级文案 ──');
  dom = await load(raw);
  const dTxt = dom.window.eval('(function(){prnDiscoverList=[];prnDiscoverScanned=true;prnDiscoverError="NO_MULTICAST";prnRenderDiscover();return document.getElementById("prnDiscoverBox").textContent})()');
  ok(dTxt.indexOf('组播') >= 0, '7.1 点明是收不到组播而不是打印机没开', String(dTxt).slice(0, 40));
  ok(dTxt.indexOf('手动') >= 0 && dTxt.indexOf('IP') >= 0, '7.2 给出了「手动填 IP」的出路', String(dTxt).slice(0, 60));
  dom.window.close();

  /* ── 八、自动搜索的自动回填（一台都没配 + 只搜到一台 → 直接填进表单） ── */
  console.log('\n── 八、自动搜索的自动回填 ──');
  const ONE = [{ serial: '01S00A0001', name: 'A1 mini', model: 'A1 mini', ip: '192.168.1.50', connect: 'lan' }];
  const TWO = ONE.concat([{ serial: '01S00B0002', name: 'X1C', model: 'X1 Carbon', ip: '192.168.1.51', connect: 'lan' }]);

  /* prnFetch / prnProbe 都是函数声明 → 顶层有同名可写绑定，直接覆盖即可 */
  function stubDiscover(w, printers) {
    w.eval('prnProbe = async () => true;');
    w.eval('prnFetch = async () => ({ ok: true, status: 200, json: async () => (' +
      JSON.stringify({ ok: true, printers: printers, scannedMs: 12 }) + ') });');
  }

  dom = await load((await req('GET', '/')).text);
  dom.window.eval('printerCfg.printers = [];');
  stubDiscover(dom.window, ONE);
  await dom.window.eval('prnDiscover(true)');
  eq(dom.window.document.getElementById('prnNewHost').value, '192.168.1.50', '8.1 只搜到一台且未配置 → 自动回填 IP');
  eq(dom.window.document.getElementById('prnNewSerial').value, '01S00A0001', '8.2 自动回填序列号');
  eq(dom.window.document.getElementById('prnNewName').value, 'A1 mini', '8.3 自动回填名称');
  eq(dom.window.document.getElementById('prnNewCode').value, '', '8.4 访问码绝不瞎填（SSDP 报文里没有）');
  dom.window.close();

  dom = await load((await req('GET', '/')).text);
  dom.window.eval('printerCfg.printers = [];');
  stubDiscover(dom.window, TWO);
  await dom.window.eval('prnDiscover(true)');
  eq(dom.window.document.getElementById('prnNewHost').value, '', '8.5 搜到两台时不抢着回填，交给用户选');
  dom.window.close();

  dom = await load((await req('GET', '/')).text);
  dom.window.eval('printerCfg.printers = [{ id: "p1", serial: "01S00A0001" }];');
  stubDiscover(dom.window, ONE);
  await dom.window.eval('prnDiscover(true)');
  eq(dom.window.document.getElementById('prnNewHost').value, '', '8.6 已经配好打印机时不再自动回填');
  dom.window.close();

  /* 一台都没配时进页要能反复尝试（60s 节流），而不是每会话只试一次 */
  dom = await load((await req('GET', '/')).text);
  dom.window.eval('printerCfg.printers = []; prnLastDiscoverAt = 0; prnAutoDoneMem = false;');
  dom.window.eval('prnProbe = async () => true; window.__calls = 0;');
  dom.window.eval('prnFetch = async (u) => { window.__calls++; return { ok: true, status: 200, json: async () => ({ ok: true, printers: [], scannedMs: 5 }) }; };');
  dom.window.eval('prnMaybeAutoDiscover()');
  await new Promise(res => setTimeout(res, 120));
  eq(dom.window.eval('window.__calls'), 1, '8.7 未配置打印机时进页自动搜一次');
  dom.window.eval('prnMaybeAutoDiscover()');
  await new Promise(res => setTimeout(res, 120));
  eq(dom.window.eval('window.__calls'), 1, '8.8 60s 内不重复扫（节流生效）');
  dom.window.close();

  await stop(child);
  console.log('\n════════════════════════');
  console.log((fail === 0 ? '✅ 全部通过' : '❌ 有失败') + '：' + pass + ' / ' + (pass + fail));
  if (fails.length) fails.forEach(f => console.log('  · ' + f));
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.log('❌ 测试异常：' + (e && e.stack || e));
  process.exit(1);
});
