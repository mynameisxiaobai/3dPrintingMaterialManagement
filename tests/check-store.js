/* check-store.js — 服务端 store API 断言（P1 验收）
   真起一个 agent 实例（独立端口 + 临时数据目录），全部走 HTTP 验证，
   不碰项目目录、不影响正在运行的 8787。

   跑法（在项目根）：node tests/check-store.js
   ────────────────────────────────────────────────────────────── */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const PORT = Number(process.env.CHECK_STORE_PORT) || 8891;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-store-'));
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

/* 必须用 http 模块：本机 Node 内置 fetch(undici) 连不上 127.0.0.1 */
function req(method, p, body, raw) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : (raw ? body : Buffer.from(JSON.stringify(body), 'utf8'));
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: p, method: method, family: 4,
      headers: payload ? Object.assign({ 'Content-Type': 'application/json', 'Content-Length': payload.length }) : {},
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const txt = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(txt); } catch (e) { /* 非 JSON 由调用方判 */ }
        resolve({ status: res.statusCode, headers: res.headers, text: txt, json: json });
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
    const tick = () => {
      req('GET', '/api/health').then(r => {
        if (r.status === 200) return resolve(true);
        retry();
      }).catch(retry);
    };
    const retry = () => {
      if (Date.now() > until) return resolve(false);
      setTimeout(tick, 120);
    };
    tick();
  });
}

function start() {
  const child = spawn(process.execPath, [AGENT], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PRINTER_AGENT_DIR: DIR,
      PRINTER_AGENT_PORT: String(PORT),
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', d => {
    if (process.env.VERBOSE) process.stdout.write('[agent] ' + d);
  });
  child.stderr.on('data', d => process.stdout.write('[agent:err] ' + d));
  return child;
}

function stop(child, sig) {
  return new Promise(resolve => {
    if (!child || child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
    try { child.kill(sig || 'SIGKILL'); } catch (e) { resolve(); }
    setTimeout(resolve, 3000);
  });
}

/* ── 落盘布局（v2）：一个键一个文件，_meta.json 只放版本号 ── */
const storeDir  = () => path.join(DIR, 'store');
const metaFile  = () => path.join(storeDir(), '_meta.json');
const keyFile   = k => path.join(storeDir(), k + '.json');
const legacyFile = () => path.join(DIR, 'app-store.json');
function readJsonSafe(f) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; }
}
function tmpLeft() {
  try { return fs.readdirSync(storeDir()).filter(f => /\.tmp$/.test(f)); } catch (e) { return []; }
}

(async () => {
  console.log('\n── 启动测试实例 ' + PORT + ' · ' + DIR + ' ──');
  let child = start();
  const up = await waitUp(12000);
  if (!up) { console.log('❌ agent 没起来'); process.exit(1); }
  console.log('  agent 就绪\n');

  /* ── 1. 空库 ── */
  console.log('── 一、空库与基本形态 ──');
  let r = await req('GET', '/api/store');
  eq(r.status, 200, '1.1 空库 GET 200');
  eq(r.json.rev, 0, '1.2 初始 rev = 0');
  eq(r.json.keys, {}, '1.3 初始 keys = {}');
  eq(r.json.initialized, false, '1.4 初始 initialized = false');
  r = await req('GET', '/api/store?meta=1');
  eq(r.json.keys, {}, '1.5 meta 空 keys');
  eq(typeof r.json.rev, 'number', '1.6 meta 有 rev');

  /* ── 2. 写入与冲突 ── */
  console.log('\n── 二、写入与同键冲突 ──');
  r = await req('PUT', '/api/store', { base: { filaments: 0 }, keys: { filaments: '[{"id":1,"name":"甲"}]' } });
  eq(r.status, 200, '2.1 首次 PUT 200');
  const r1 = r.json.keys.filaments;
  ok(r1 >= 1, '2.2 拿到新版本号', 'v=' + r1);
  r = await req('GET', '/api/store');
  eq(r.json.keys.filaments.val, '[{"id":1,"name":"甲"}]', '2.3 值已落库');
  eq(r.json.initialized, true, '2.4 initialized 置真');

  r = await req('PUT', '/api/store', { base: { filaments: 0 }, keys: { filaments: '[]' } });
  eq(r.status, 409, '2.5 带旧 base 再写 → 409');
  eq(r.json.conflict.filaments.val, '[{"id":1,"name":"甲"}]', '2.6 冲突时回传服务端现值');

  r = await req('PUT', '/api/store', { base: { filaments: r1 }, keys: { filaments: '[]' } });
  eq(r.status, 200, '2.7 用新 base 可覆盖');

  /* ── 3. 两个客户端交错改不同键（全量覆盖方案必挂的用例） ── */
  console.log('\n── 三、跨键不互相覆盖 ──');
  const meta0 = (await req('GET', '/api/store?meta=1')).json.keys;
  await req('PUT', '/api/store', { base: { filaments: meta0.filaments }, keys: { filaments: '["A"]' } });
  const meta1 = (await req('GET', '/api/store?meta=1')).json.keys;
  await req('PUT', '/api/store', { base: { prnCalibLog: meta1.prnCalibLog || 0 }, keys: { prnCalibLog: '[{"at":"x"}]' } });
  r = await req('GET', '/api/store');
  eq(r.json.keys.filaments.val, '["A"]', '3.1 A 改的 filaments 还在');
  eq(r.json.keys.prnCalibLog.val, '[{"at":"x"}]', '3.2 B 改的 prnCalibLog 没被覆盖');

  /* ── 4. 超大请求体 ── */
  console.log('\n── 四、超限与非法输入 ──');
  const big = Buffer.alloc(9 * 1024 * 1024, 0x41);
  r = await req('PUT', '/api/store', big, true).catch(e => ({ status: 0, text: String(e && e.code || e) }));
  eq(r.status, 413, '4.1 9MB 请求体 → 413（不是连接重置）');
  ok(r.json && typeof r.json.error === 'string', '4.2 413 回的是 JSON', r.text && r.text.slice(0, 60));

  const beforeMeta = fs.readFileSync(metaFile(), 'utf8');
  const beforeFil = fs.readFileSync(keyFile('filaments'), 'utf8');
  r = await req('PUT', '/api/store', '{"keys":', true);
  eq(r.status, 400, '4.3 非法 JSON → 400');
  eq(fs.readFileSync(metaFile(), 'utf8'), beforeMeta, '4.4 非法 JSON 没动 _meta.json');
  eq(fs.readFileSync(keyFile('filaments'), 'utf8'), beforeFil, '4.4b 非法 JSON 没动数据文件');

  /* 必须发原始字符串：JS 对象字面量里的 {'__proto__':'x'} 走的是「设置原型」语义，
     JSON.stringify 之后会变成空对象，测不到白名单 */
  r = await req('PUT', '/api/store', '{"keys":{"__proto__":"x"}}', true);
  eq(r.status, 400, '4.5 白名单外的键 → 400');
  ok(({}).x === undefined, '4.5b 没有原型污染');
  r = await req('PUT', '/api/store', { keys: { filaments: 123 } });
  eq(r.status, 400, '4.6 值不是字符串 → 400');
  r = await req('PUT', '/api/store', { keys: { printerCfg: '{}' } });
  eq(r.status, 400, '4.7 printerCfg 不进 store（派生缓存）');
  r = await req('PUT', '/api/store', { keys: { swView: 'list' } });
  eq(r.status, 400, '4.8 swView 不同步（设备本地偏好）');
  r = await req('PUT', '/api/store', { keys: { prnSlotMatch: '{"__v":1}' } });
  eq(r.status, 200, '4.9 prnSlotMatch 可同步（槽位匹配账本）');
  r = await req('PUT', '/api/store', { keys: { prnSlicedSeen: '{}' } });
  eq(r.status, 200, '4.10 prnSlicedSeen 可同步（切片幂等索引）');

  /* ── 5. 并发 ── */
  console.log('\n── 五、并发写入 ──');
  const keys10 = ['filaments', 'savedTags', 'swFavs', 'trash', 'lowStockCfg',
    'prnTagBind', 'prnTagArc', 'prnCalibLog', 'prnSlotHist', 'prnSlicedApply',
    'prnSlotMatch', 'prnSlicedSeen'];
  const cur = (await req('GET', '/api/store?meta=1')).json.keys;
  const jobs = [];
  for (let i = 0; i < 20; i++) {
    const k = keys10[i % keys10.length];
    const body = {};
    body[k] = JSON.stringify({ i: i });
    jobs.push(req('PUT', '/api/store', { base: { [k]: cur[k] || 0 }, keys: body })
      .then(x => ({ k: k, status: x.status, rev: x.json && x.json.rev }))
      .catch(e => ({ k: k, status: 0, err: String(e && e.code || e) })));
  }
  const res = await Promise.all(jobs);
  const okCount = res.filter(x => x.status === 200).length;
  ok(okCount >= 10, '5.1 至少 10 个并发写成功', '成功 ' + okCount);
  ok(res.every(x => x.status === 200 || x.status === 409), '5.2 其余是 409 而非 5xx',
    JSON.stringify(res.filter(x => x.status !== 200 && x.status !== 409)));
  let parsed = null;
  try { parsed = JSON.parse(fs.readFileSync(metaFile(), 'utf8')); } catch (e) { /* 下面判 */ }
  ok(!!parsed && !!parsed.keys, '5.3 _meta.json 仍然可解析');
  const badFiles = parsed ? Object.keys(parsed.keys).filter(k => readJsonSafe(keyFile(k)) === null) : ['?'];
  eq(badFiles, [], '5.3b 每个键文件都是合法 JSON');
  const revs = res.filter(x => x.status === 200).map(x => x.rev).sort((a, b) => a - b);
  ok(revs.every((v, i) => i === 0 || v >= revs[i - 1]), '5.4 rev 单调不降', JSON.stringify(revs));
  eq(tmpLeft(), [], '5.5 没有残留 .tmp');

  /* ── 6. 断电式重启 ── */
  console.log('\n── 六、进程被 kill -9 后重启 ──');
  const snapshotBefore = (await req('GET', '/api/store')).json;
  await stop(child, 'SIGKILL');
  child = start();
  ok(await waitUp(12000), '6.1 重启成功');
  r = await req('GET', '/api/store');
  eq(r.json.rev, snapshotBefore.rev, '6.2 rev 不丢');
  eq(r.json.keys.filaments.val, snapshotBefore.keys.filaments.val, '6.3 数据不丢');

  /* ── 7. meta 损坏 → 按数据文件重建（数据不能丢） ── */
  console.log('\n── 七、meta 损坏不拖垮服务 ──');
  const beforeBreak = (await req('GET', '/api/store')).json;
  const keysBefore = Object.keys(beforeBreak.keys);
  await stop(child, 'SIGKILL');
  fs.writeFileSync(metaFile(), '{ 这不是 JSON');
  child = start();
  ok(await waitUp(12000), '7.1 meta 损坏后仍能启动（不 throw）');
  const h = await req('GET', '/api/health');
  eq(h.json.store, 'degraded', '7.2 health 标 degraded');
  r = await req('GET', '/api/store');
  ok(keysBefore.length > 0 && keysBefore.every(k => !!r.json.keys[k]), '7.3 数据没丢（按 store/*.json 重建索引）');
  eq(r.json.rev, 0, '7.4 rev 归零（索引是推断的，客户端首轮会走 409 确认而不是静默覆盖）');
  ok(fs.readdirSync(storeDir()).some(f => f.indexOf('_meta.json.corrupt-') === 0), '7.5 坏 meta 已备份改名');

  /* ── 7b. 单个键文件损坏：只丢那个键 ── */
  await stop(child, 'SIGKILL');
  fs.writeFileSync(keyFile('filaments'), '{ 也坏了');
  child = start();
  ok(await waitUp(12000), '7.6 单键文件损坏仍能启动');
  r = await req('GET', '/api/store');
  ok(!r.json.keys.filaments, '7.7 坏的那个键被跳过（绝不把非法 JSON 喂给前端）');
  ok(Object.keys(r.json.keys).length > 0, '7.8 其他键照常服务');
  ok(fs.readdirSync(storeDir()).some(f => f.indexOf('filaments.json.corrupt-') === 0), '7.9 坏数据文件已备份改名');

  /* ── 8. 导出 ── */
  console.log('\n── 八、整库导出 ──');
  await req('PUT', '/api/store', { keys: { filaments: '[{"id":9}]' } });
  r = await req('GET', '/api/store/export');
  eq(r.status, 200, '8.1 export 200');
  eq(r.json.kind, 'server-store', '8.2 标明来源');
  eq(r.json.keys.filaments, [{ id: 9 }], '8.3 键值已还原成 JSON 而不是字符串');

  /* ── 9. 落盘形态：一个键一个文件，人能直接读 ── */
  console.log('\n── 九、落盘形态（data/store/ 一键一文件） ──');
  ok(fs.existsSync(storeDir()), '9.1 store/ 子目录存在');
  const filTxt = fs.readFileSync(keyFile('filaments'), 'utf8');
  ok(/^\s*\[/.test(filTxt), '9.2 filaments.json 直接就是数组，不用解嵌套转义', filTxt.slice(0, 40));
  eq(JSON.parse(filTxt)[0].id, 9, '9.3 文件内容与接口一致');
  const metaTxt = fs.readFileSync(metaFile(), 'utf8');
  ok(metaTxt.indexOf('"val"') < 0, '9.4 _meta.json 不含数据本体（只有版本号）');
  ok(metaTxt.indexOf('"filaments"') >= 0, '9.5 meta 记录了键名与版本号');

  /* 只写一个键时，别的键文件不该被重写（一键一文件的意义就在这） */
  const others = keys10.filter(k => k !== 'filaments' && fs.existsSync(keyFile(k)));
  ok(others.length >= 3, '9.6 有足够的旁证文件', '共 ' + others.length + ' 个');
  const mtBefore = others.map(k => fs.statSync(keyFile(k)).mtimeMs);
  await new Promise(rs => setTimeout(rs, 40));
  r = await req('PUT', '/api/store', { keys: { filaments: '[{"id":10}]' } });
  eq(r.status, 200, '9.7 只写 filaments 成功（不带 base = 不做版本校验）');
  const mtAfter = others.map(k => fs.statSync(keyFile(k)).mtimeMs);
  eq(mtAfter, mtBefore, '9.8 其他键文件的 mtime 没变（没有被整体重写）');

  const info = (await req('GET', '/api/store?info=1')).json;
  eq(info.schema, 2, '9.9 info 报告 schema=2');
  eq(info.meta, 'store/_meta.json', '9.10 info 指出 meta 相对路径');
  ok(typeof info.dir === 'string' && info.dir.length > 0, '9.11 info 给出数据目录');
  ok(Array.isArray(info.files) && info.files.length > 0, '9.12 info 给出文件清单');
  ok(info.files.some(f => f.file === 'store/filaments.json'), '9.13 清单里能看到 store/filaments.json');
  ok(info.files.every(f => typeof f.bytes === 'number'), '9.14 每个文件都带字节数');
  eq(info.legacyPresent, false, '9.15 没有遗留的 v1 app-store.json');

  /* ── 10. v1（单文件 app-store.json）自动迁移 ── */
  console.log('\n── 十、v1 单文件自动迁移 ──');
  const { AppStore } = require('../server/printer-store');
  const D1 = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-mig-'));
  fs.writeFileSync(path.join(D1, 'app-store.json'), JSON.stringify({
    schema: 1, rev: 7, initialized: true,
    keys: {
      filaments: { v: 7, at: '2026-01-01T00:00:00.000Z', val: '[{"id":1,"name":"迁移来的"}]' },
      prnSlotMatch: { v: 5, at: null, val: '{"__v":1}' },
      printerCfg: { v: 9, at: null, val: '{}' },          // 白名单外，必须被丢弃
    },
  }));
  const st = new AppStore({ dir: D1 });
  eq(st.db.rev, 7, '10.1 rev 原样保留');
  eq(Object.keys(st.db.keys).sort(), ['filaments', 'prnSlotMatch'], '10.2 只迁移白名单内的键');
  ok(st.migrated === true, '10.3 标记为已迁移');
  ok(fs.existsSync(path.join(D1, 'store', 'filaments.json')), '10.4 生成了分文件');
  eq(fs.readFileSync(path.join(D1, 'store', 'filaments.json'), 'utf8'),
    '[{"id":1,"name":"迁移来的"}]', '10.5 文件内容就是原始值（没二次转义）');
  ok(!fs.existsSync(path.join(D1, 'app-store.json')), '10.6 旧文件已改名，不会重复迁移');
  ok(fs.readdirSync(D1).some(f => f.indexOf('app-store.json.migrated-') === 0), '10.7 旧文件备份可见');

  const st2 = new AppStore({ dir: D1 });
  eq(st2.db.rev, 7, '10.8 重启后 rev 一致');
  eq(st2.db.keys.filaments.val, '[{"id":1,"name":"迁移来的"}]', '10.9 重启后数据一致');
  eq(st2.migrated, false, '10.10 不会重复迁移');
  // 键名要拼进文件名，必须挡住路径穿越
  eq(st2.keyFile('../evil'), null, '10.11 键名带路径分隔符时拒绝拼文件名');
  eq(st2.keyFile('a/b'), null, '10.12 斜杠同样拒绝');
  ok(!!st2.keyFile('filaments'), '10.13 正常键名可用');
  fs.rmSync(D1, { recursive: true, force: true });

  await stop(child, 'SIGKILL');
  console.log('\n════════════════════════');
  console.log((fail === 0 ? '✅ 全部通过' : '❌ 有失败') + '：' + pass + ' / ' + (pass + fail));
  if (fails.length) fails.forEach(f => console.log('  · ' + f));
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.log('❌ 测试异常：' + (e && e.stack || e));
  process.exit(1);
});
