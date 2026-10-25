/* smoke-slice.js — jsdom 冒烟：整页加载 + 切片扣减内核 + 云卡片渲染
   运行：NODE_PATH=<isolated>/node_modules node smoke-slice.js
   不联网，fetch 永不 resolve（agent 视为离线）。

   两个必须绕开的坑（之前踩过）：
   ① jsdom 用 file:// 是 opaque origin，localStorage 直接抛 SecurityError
      → 必须给一个 http:// 的 url
   ② 页面顶层 let/const 不挂 window，`w.data` 是 undefined
      → 一律走 w.eval() 在页面上下文里读写 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const HTML = path.join(__dirname, '..', 'web', 'filament-manager.html');

/* 时间一律**相对现在**构造。之前写死 2026-10-17，一旦真实时间越过切片补记窗口
   （7 天 / 30 天），整组用例就会因为「任务太旧被跳过」而集体失败 ——
   看起来像功能坏了，其实是测试自己过期了。 */
const NOW = Date.now();
const H = 3600e3, DAY = 864e5;
const iso = ms => new Date(NOW + ms).toISOString();
const OLD_AT   = iso(-20 * DAY);        // 余量记录时间：远早于任务
const T_START  = iso(-3 * DAY);         // 任务开始
const T_MID    = iso(-3 * DAY + H);     // 任务进行中（校准记录用）
const T_END    = iso(-3 * DAY + 2 * H); // 任务结束
const T_LATER  = iso(-2 * DAY);         // 比任务结束更新（H4 要挡的时间）
let pass = 0, fail = 0;
const fails = [];
function ok(c, n) { if (c) pass++; else { fail++; fails.push(n); console.log('  ✗ ' + n); } }
function eq(a, b, n) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa === sb) pass++; else { fail++; fails.push(n + ' 得到' + sa + ' 期望' + sb); console.log('  ✗ ' + n + '  得到 ' + sa + ' 期望 ' + sb); }
}

const errors = [];
const dom = new JSDOM(fs.readFileSync(HTML, 'utf8'), {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'http://localhost/filament-manager.html',
  beforeParse(w) {
    w.fetch = () => new Promise(() => {});          // 永不 resolve：模拟 agent 不在
    w.confirm = () => true;
    w.alert = () => {};
    w.onerror = (m) => { errors.push(String(m)); };
    const oc = w.console.error;
    w.console.error = function (...a) { errors.push(a.join(' ')); oc.apply(w.console, a); };
  },
});

const w = dom.window;
const d = w.document;
const ev = code => w.eval(code);

setTimeout(() => {
  try {
    console.log('\n── 页面加载 ──');
    eq(errors.filter(e => !/fetch|Network|Failed/i.test(e)), [], '加载期无脚本异常');
    ok(typeof w.prnSlicedSweep === 'function', 'prnSlicedSweep 已定义');
    ok(typeof w.prnDeductOne === 'function', 'prnDeductOne 已定义');
    ok(typeof w.prnCloudLoad === 'function', 'prnCloudLoad 已定义');
    ok(typeof w.prnRenderCloud === 'function', 'prnRenderCloud 已定义');
    ok(typeof w.prnSlicedUndo === 'function', 'prnSlicedUndo 已定义');
    ok(!!d.getElementById('prnCloudCard'), '云卡片已插入');
    ok(!!d.getElementById('prnSlicedList'), '切片流水容器已插入');
    ok(!!d.getElementById('prnCloudBody'), '云卡片内容区已插入');

    console.log('\n── 切片扣减内核 ──');
    /* 造两个库存卷：槽 0 无 RFID 待扣，槽 1 有 RFID 应跳过 */
    ev('data.length = 0');
    const ITEMS = [
      { name: '第三方 PLA 蓝', brand: '三绿', material: 'PLA', color: '#2850E0',
        weight: 1000, qty: 1, spoolRemainG: 800, spoolRemainAt: OLD_AT, amsRef: 'p1:0:0' },
      { name: '官方 PLA 白', brand: '拓竹', material: 'PLA', color: '#FFFFFF',
        weight: 1000, qty: 1, spoolRemainG: 900, spoolRemainAt: OLD_AT, amsRef: 'p1:0:1' },
    ];
    ITEMS.forEach((o, i) => ev('data.push(normalizeItem(' + JSON.stringify(o) + ', ' + i + '))'));
    eq(ev('data.length'), 2, '注入 2 卷');
    const ID0 = ev('data[0].id'), ID1 = ev('data[1].id');
    ok(ID0 != null && ID1 != null && ID0 !== ID1, '两卷 id 有效且不同');

    ev('printerState.p1 = ' + JSON.stringify({
      id: 'p1', name: 'P', online: true,
      print: { gcodeState: 'FINISH', taskName: 'T' },
      ams: [{ amsId: '0', slots: [
        { slot: 0, material: 'PLA', colorHex: '#2850E0', weightG: null, remainPct: null, tagUid: '0000000000000000', hasRfid: false },
        { slot: 1, material: 'PLA', colorHex: '#FFFFFF', weightG: 900, remainPct: 90, tagUid: 'ABCD1234', hasRfid: true },
      ] }],
    }));

    const TASK = {
      id: 't_1', printerId: 'p1', taskKey: 'p1|' + T_START, taskId: '273266206',
      taskName: '胶水拼接版本', startAt: T_START, endAt: T_END,
      slicedState: 'ok',
      sliced: {
        src: 'cloud', taskId: '273266206', plate: 6, totalG: 130,
        filaments: [
          { id: 1, slot: 0, type: 'PLA', colorHex: '#2850E0', usedG: 100 },
          { id: 2, slot: 1, type: 'PLA', colorHex: '#FFFFFF', usedG: 30 },
        ],
      },
      consumed: [],
    };
    const sweep = tasks => ev('prnSlicedSweep(' + JSON.stringify(tasks) + ')');

    const r1 = sweep([TASK]);
    eq(r1.applied, 1, '只扣 1 条（有 RFID 的槽被跳过）');
    eq(ev('data[0].spoolRemainG'), 700, '无 RFID 卷扣掉 100g');
    eq(ev('data[0].spoolRemainSrc'), 'slice', '来源标为 slice');
    eq(ev('data[1].spoolRemainG'), 900, '有 RFID 卷余量不变');
    eq(ev('prnSlicedApply.length'), 1, '流水写 1 条');
    eq(ev('prnSlicedApply[0].itemId'), ID0, '流水指向正确的卷');
    eq(ev('prnSlicedApply[0].grams'), 100, '流水克重 100');
    eq(ev('prnSlicedApply[0].before'), 800, '流水记录扣前值');
    eq(ev('prnSlicedApply[0].after'), 700, '流水记录扣后值');

    console.log('\n── 幂等 ──');
    const r2 = sweep([TASK]);
    eq(r2.applied, 0, '再扫一次不重复扣');
    eq(ev('data[0].spoolRemainG'), 700, '余量保持 700g');
    eq(ev('prnSlicedApply.length'), 1, '流水仍是 1 条');

    console.log('\n── 六条硬规则 ──');
    ev('window.__dt = function(f){ return prnDeductOne(' + JSON.stringify(TASK) + ', f) }');
    const dt = (patch) => ev('__dt(' + JSON.stringify(Object.assign(
      { id: 99, slot: 0, type: 'PLA', colorHex: '#2850E0', usedG: 10 }, patch)) + ')');

    /* H1 零头 */
    eq(dt({ usedG: 0.3 }).why, 'ZERO', 'H1 用量 ≤0.5g 跳过');
    /* H3 窗口内有校准 */
    ev('prnCalibLog.push(' + JSON.stringify({ at: T_MID, itemId: ID0, grams: 50, prev: 800 }) + ')');
    eq(dt({ usedG: 40 }).why, 'CALIB', 'H3 窗口内有校准记录 → 跳过');
    ev('prnCalibLog.length = 0');
    /* H4 余量比任务结束更新 */
    ev('data[0].spoolRemainAt = "' + T_LATER + '"');
    eq(dt({ usedG: 10 }).why, 'FRESH', 'H4 余量已被更新过 → 跳过');
    ev('data[0].spoolRemainAt = "' + OLD_AT + '"');
    /* H6 不为负 */
    ev('data[0].spoolRemainG = 5');
    const n6 = dt({ usedG: 50 });
    eq(n6.after, 0, 'H6 扣到 0 不为负');
    ev('data[0].spoolRemainG = 700');
    /* H5 有 RFID */
    eq(dt({ slot: 1, colorHex: '#FFFFFF' }).why, 'RFID', 'H5 槽位有 RFID → 跳过');
    /* H2 定位不到库存项 */
    ev('window.__dt2 = function(f){ return prnDeductOne(Object.assign({}, ' + JSON.stringify(TASK) + ', {printerId:"pZ", taskKey:"k-m"}), f) }');
    eq(ev('__dt2(' + JSON.stringify({ id: 13, slot: 3, type: 'PEEK', colorHex: '#123456', usedG: 20 }) + ').why'),
       'NOITEM', 'H2 无匹配库存项 → 跳过');
    /* 净重缺失 */
    ev('data[0].weight = 0; data[0].spoolRemainG = null; data[0].spoolRemainAt = null');
    eq(dt({ usedG: 10 }).why, 'NOWEIGHT', '净重与余量都缺失 → 跳过');
    ev('data[0].weight = 1000; data[0].spoolRemainG = 700; data[0].spoolRemainAt = "' + OLD_AT + '"');

    console.log('\n── 撤销 ──');
    const key = ev('prnSlicedApply[0].key');
    ok(!!key, '流水有幂等键');
    ev('prnSlicedUndo(' + JSON.stringify(key) + ')');
    eq(ev('data[0].spoolRemainG'), 800, '撤销后余量还原到 800g');
    eq(ev('prnSlicedApply.length'), 0, '流水里该条已移除');
    /* 撤销不再「删索引」而是「写 undone 墓碑」：删掉的话下一轮扫描会立刻把刚撤销的量
       又扣回去，用户看到的撤销等于无效（C5）。 */
    eq(ev('prnSlicedSeenDb[' + JSON.stringify(key) + '].state'), 'undone', '幂等索引改成 undone 墓碑');
    ok(ev('prnSlicedSeen.has(' + JSON.stringify(key) + ')'), '内存索引仍然占位（跳过扫描）');
    const r3 = sweep([TASK]);
    eq(r3.applied, 0, '撤销后不会被重新扣减');
    eq(ev('data[0].spoolRemainG'), 800, '余量保持在 800g');
    /* 后面的渲染断言需要一行流水：清空索引重新扫一次（正常使用不会这么做） */
    ev('prnSlicedSeenReset()');
    eq(sweep([TASK]).applied, 1, '清空幂等索引后可重新记录（仅测试场景）');

    console.log('\n── 窗口限制 ──');
    const old = Object.assign({}, TASK, {
      taskKey: 'k-old', id: 't_old',
      endAt: new Date(Date.now() - 30 * 864e5).toISOString(),
      sliced: Object.assign({}, TASK.sliced, {
        filaments: [{ id: 1, slot: 0, type: 'PLA', colorHex: '#2850E0', usedG: 42 }] }),
    });
    const r4 = sweep([old]);
    eq(r4.applied, 0, '30 天前的任务不补记');

    console.log('\n── 云卡片渲染 ──');
    ev('printerOnline = false'); ev('prnRenderCloud()');
    ok(d.getElementById('prnCloudBody').innerHTML.indexOf('未启动') >= 0, '离线时提示启动服务');

    ev('printerOnline = true');
    ev('prnCloudState = { loggedIn:false, region:"cn", account:null, ttlSec:-1 }');
    ev('prnCloudModeSet("pwd")');
    ok(!!d.getElementById('prnCloudAccount'), '未登录渲染账号框');
    ok(!!d.getElementById('prnCloudPwd'), '密码模式渲染密码框');
    ok(d.getElementById('prnCloudFlagTxt').textContent.indexOf('未登录') >= 0, '角标显示未登录');

    ev('prnCloudModeSet("code")');
    ok(!!d.getElementById('prnCloudCode'), '验证码模式渲染验证码框');
    ok(!d.getElementById('prnCloudPwd'), '验证码模式不渲染密码框');

    ev('prnCloudState = { loggedIn:true, region:"cn", account:"a@b.com", ttlSec:' + (29 * 86400) + ' }');
    ev('prnCloudTasks = []');
    ev('prnRenderCloud()');
    ok(d.getElementById('prnCloudBody').innerHTML.indexOf('a@b.com') >= 0, '已登录显示账号');
    ok(d.getElementById('prnCloudFlagTxt').textContent.indexOf('29') >= 0, '角标显示剩余天数');

    ev('prnCloudTasks = ' + JSON.stringify([{
      id: 273266206, title: '胶水拼接版本', plateIndex: 6, weight: 130.5,
      deviceId: '20P6BJ650601871', startTime: iso(-3 * DAY + 3.3 * H),
      slots: [{ ams: 0, type: 'PLA', color: '2850E0FF', weight: 100.25 }],
    }]));
    const tl = d.getElementById('prnCloudTaskList');
    ok(!!tl, '已登录渲染任务列表容器');
    if (tl) {
      tl.innerHTML = ev('prnCloudTasksHtml()');
      const html = tl.innerHTML;
      ok(html.indexOf('胶水拼接版本') >= 0, '任务标题渲染');
      ok(html.indexOf('130.5g') >= 0, '总重渲染');
      ok(html.indexOf('100.2g') >= 0 || html.indexOf('100.3g') >= 0, '分槽克重渲染');
      ok(html.indexOf('#2850E0') >= 0, '色块用了槽位颜色');
    }

    console.log('\n── 切片流水渲染 ──');
    ev('prnRenderSlicedLog()');
    const sl = d.getElementById('prnSlicedList').innerHTML;
    ok(sl.indexOf('第三方 PLA 蓝') >= 0, '流水显示耗材名');
    ok(sl.indexOf('−100g') >= 0, '流水显示扣减量');
    ok(sl.indexOf('撤销') >= 0, '流水带撤销按钮');

    console.log('\n── 其它页面不受影响 ──');
    ['inventory', 'swatch', 'stats', 'data', 'printers'].forEach(pg => {
      try { ev('switchPage(' + JSON.stringify(pg) + ')'); ok(true, '切到 ' + pg + ' 不报错'); }
      catch (e) { ok(false, '切到 ' + pg + ' 报错：' + e.message); }
    });

    console.log('\n── 备份键位 ──');
    ok(ev('DM_STORE_KEYS.some(function(k){return k[0]==="prnSlicedApply"})'), 'DM_STORE_KEYS 含 prnSlicedApply');
    ['prnSlotMatch', 'prnSlicedSeen', 'prnTagBind'].forEach(k => {
      ok(ev('DM_STORE_KEYS.some(function(x){return x[0]===' + JSON.stringify(k) + '})'),
        'DM_STORE_KEYS 含 ' + k);
    });
    const bo = ev('JSON.stringify(dmBackupObj())');
    ['prnSlicedApply', 'prnSlotMatch', 'prnSlicedSeen', 'prnTagBind'].forEach(k => {
      ok(bo.indexOf(k) >= 0, '备份对象含 ' + k);
    });

    console.log('\n' + (fail === 0
      ? '✅ 全部通过：' + pass + ' / ' + pass
      : '❌ 失败 ' + fail + ' / ' + (pass + fail) + '\n   ' + fails.join('\n   ')));
    process.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    console.log('\n💥 测试自身抛错：' + ((e && e.stack) || e));
    process.exit(2);
  }
}, 600);
