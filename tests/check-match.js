/* check-match.js — 匹配账本 / 换卷识别 / 数据体检（对账）
   运行：node tests/check-match.js
   不联网，fetch 永不 resolve（agent 视为离线）。

   两个必须绕开的坑（之前踩过）：
   ① jsdom 用 file:// 是 opaque origin，localStorage 直接抛 SecurityError
      → 必须给一个 http:// 的 url
   ② 页面顶层 let/const 不挂 window，`w.data` 是 undefined
      → 一律走 w.eval() 在页面上下文里读写 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { JSDOM } = require('jsdom');
const AG = require('../server/printer-agent');   // 只 require，不启动服务

const HTML = path.join(__dirname, '..', 'web', 'filament-manager.html');
let pass = 0, fail = 0;
const fails = [];
function ok(c, n) { if (c) pass++; else { fail++; fails.push(n); console.log('  ✗ ' + n); } }
function eq(a, b, n) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa === sb) pass++; else { fail++; fails.push(n + '  得到 ' + sa + ' 期望 ' + sb); console.log('  ✗ ' + n + '  得到 ' + sa + ' 期望 ' + sb); }
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

/* 时间一律相对现在构造：写死日期会在越过窗口（切片补记 30 天 / 用量统计 90 天）
   之后让断言莫名失败，看起来像功能坏了。 */
const _NOW = Date.now();
const _H = 3600e3, _DAY = 864e5;
const iso = ms => new Date(_NOW + ms).toISOString();
const A_APPLY_AT1 = iso(-20 * _DAY);    // 切片流水：远早但仍在 90 天统计窗口内
const A_APPLY_AT2 = iso(-19 * _DAY);
const A_SPOOL_AT  = iso(-4 * _DAY);     // 余量时间：早于任务
const A_TASK_S    = iso(-3 * _DAY);     // 任务开始
const A_TASK_E    = iso(-3 * _DAY + 3 * _H);
/* 造一卷：o 里的字段会被 normalizeItem 归一化 */
function seed(o) {
  ev('data.push(normalizeItem(' + JSON.stringify(o) + ', data.length))');
  return ev('data[data.length-1].id');
}
function reset() {
  ev('data.length = 0; printerState = {}; prnPending = []; prnSlicedPending = [];');
  ev('prnSlicedApply.length = 0; prnCalibLog.length = 0; prnSlotHist = {};');
  ev('prnTagBind = {}; prnTagArc = {}; printerUsage.length = 0;');
}
/* 取体检结果里某一项（没有则 null） */
function aud(id) { return ev('prnAudit()').filter(x => x.id === id)[0] || null; }
function audAll() { return ev('prnAudit()'); }

setTimeout(() => {
  try {
    /* ══════════════ 一、页面加载与面板接线 ══════════════ */
    console.log('\n── 一、页面加载与面板接线 ──');
    eq(errors.filter(e => !/fetch|Network|Failed/i.test(e)), [], '1.1 加载期无脚本异常');
    ok(typeof w.prnAudit === 'function', '1.2 prnAudit 已定义');
    ok(typeof w.prnRenderAudit === 'function', '1.3 prnRenderAudit 已定义');
    ok(typeof w.__PRN_AUDIT__ === 'function', '1.4 window.__PRN_AUDIT__ 已暴露');
    ok(typeof w.__PRN_AUDIT_TEXT__ === 'function', '1.5 window.__PRN_AUDIT_TEXT__ 已暴露');
    ok(!!d.getElementById('prnAuditCard'), '1.6 体检卡片已插入');
    ok(!!d.getElementById('prnAuditBox'), '1.7 体检内容区已插入');
    ok(!!d.getElementById('prnAuditSum'), '1.8 体检汇总徽标已插入');

    /* ══════════════ 二、只读性（P0 最重要的一条） ══════════════ */
    console.log('\n── 二、体检必须只读 ──');
    reset();
    seed({ name: 'A', material: 'PLA', color: '#2850E0', weight: 1000, qty: 1, spoolRemainG: 2000, amsRef: 'p1:0:0' });
    seed({ name: 'B', material: 'PLA', color: '#2850E0', weight: 1000, qty: 0, amsRef: 'p1:0:0' });
    ev('printerState.p1 = ' + JSON.stringify({
      ams: [{ amsId: '0', slots: [
        { slot: 0, material: 'ABS', colorHex: '#FF0000', weightG: 500, remainPct: 50,
          tagUid: 'AAAA1111', hasRfid: true, state: 11 },
      ] }],
    }));
    const before = ev('JSON.stringify({ d: data, t: prnTagBind, a: prnTagArc, p: prnPending })');
    const lsBefore = ev('JSON.stringify({ f: localStorage.getItem("filaments"), b: localStorage.getItem("prnTagBind") })');
    audAll(); audAll();
    eq(ev('JSON.stringify({ d: data, t: prnTagBind, a: prnTagArc, p: prnPending })'), before, '2.1 体检不改内存数据');
    eq(ev('JSON.stringify({ f: localStorage.getItem("filaments"), b: localStorage.getItem("prnTagBind") })'), lsBefore, '2.2 体检不写 localStorage');
    ok(ev('prnAudit().length') > 0, '2.3 这份脏数据能查出问题');
    ok(ev('prnAudit().every(x => x.id && x.sev && x.title && x.detail)'), '2.4 每条都有 id/sev/title/detail');
    ok(ev('prnAudit().every(x => ["bad","warn","info"].indexOf(x.sev) >= 0)'), '2.5 sev 取值合法');

    /* ══════════════ 三、A1 同一槽位绑了多卷 ══════════════ */
    console.log('\n── 三、A1 同一槽位绑了多卷 ──');
    reset();
    seed({ name: '卷甲', material: 'PLA', color: '#2850E0', weight: 1000, qty: 1, amsRef: 'p1:0:0' });
    seed({ name: '卷乙', material: 'PLA', color: '#2850E0', weight: 1000, qty: 1, amsRef: 'p1:0:0' });
    let a = aud('A1');
    ok(!!a, '3.1 检出 A1');
    eq(a && a.sev, 'bad', '3.2 A1 是严重级');
    ok(/卷甲/.test(a.detail) && /卷乙/.test(a.detail), '3.3 两卷都列出来');
    reset();
    seed({ name: '独占卷', material: 'PLA', color: '#2850E0', weight: 1000, qty: 1, amsRef: 'p1:0:0' });
    eq(aud('A1'), null, '3.4 唯一绑定时不误报');

    /* ══════════════ 四、A2 芯片归属与绑定卷不一致 ══════════════ */
    console.log('\n── 四、A2 芯片与绑定卷不一致 ──');
    reset();
    const idOld = seed({ name: '旧卷', material: 'PLA', color: '#2850E0', weight: 1000, qty: 1 });
    const idNew = seed({ name: '新卷', material: 'PETG', color: '#E03A3A', weight: 1000, qty: 1, amsRef: 'p1:0:0' });
    ev('prnTagArc["AAAA1111"] = { itemId: ' + idOld + ', at: "2026-09-01T00:00:00Z" }');
    ev('printerState.p1 = ' + JSON.stringify({
      ams: [{ amsId: '0', slots: [
        { slot: 0, material: 'PLA', colorHex: '#2850E0', weightG: 800, remainPct: 80,
          tagUid: 'AAAA1111', hasRfid: true, state: 11 },
      ] }],
    }));
    a = aud('A2');
    ok(!!a, '4.1 检出 A2（换卷没被识别）');
    eq(a && a.sev, 'bad', '4.2 A2 是严重级');
    ok(/旧卷/.test(a.detail) && /新卷/.test(a.detail), '4.3 指出芯片归属与现有绑定');
    /* 绑定卷就是芯片归属卷时不该报 */
    ev('data.find(x => x.id === ' + idNew + ').amsRef = null');
    ev('data.find(x => x.id === ' + idOld + ').amsRef = "p1:0:0"');
    eq(aud('A2'), null, '4.4 绑定与芯片一致时不误报');
    /* 全 0 tag 不算 RFID，不能报 A2 */
    reset();
    seed({ name: '无芯片', material: 'PLA', color: '#2850E0', weight: 1000, qty: 1, amsRef: 'p1:0:0' });
    ev('printerState.p1 = ' + JSON.stringify({
      ams: [{ amsId: '0', slots: [
        { slot: 0, material: 'PLA', colorHex: '#2850E0', weightG: null, remainPct: null,
          tagUid: '0000000000000000', hasRfid: false, state: 11 },
      ] }],
    }));
    eq(aud('A2'), null, '4.5 全 0 tagUid 不参与 A2');

    /* ══════════════ 五、A3 已用完的卷仍挂在有料的槽上 ══════════════ */
    console.log('\n── 五、A3 已用完仍挂槽 ──');
    reset();
    seed({ name: '空卷', material: 'PLA', color: '#2850E0', weight: 1000, qty: 0, spoolRemainG: 0, amsRef: 'p1:0:0' });
    ev('printerState.p1 = ' + JSON.stringify({
      ams: [{ amsId: '0', slots: [
        { slot: 0, material: 'PLA', colorHex: '#2850E0', weightG: 700, remainPct: 70,
          tagUid: '0000000000000000', hasRfid: false, state: 11 },
      ] }],
    }));
    a = aud('A3');
    ok(!!a, '5.1 检出 A3');
    eq(a && a.sev, 'bad', '5.2 A3 是严重级');
    /* 槽里是空槽时不算 —— 取出料盘是正常操作 */
    ev('printerState.p1.ams[0].slots[0].state = 1');       // 未装料
    eq(aud('A3'), null, '5.3 空槽不误报');
    /* qty > 0 且有剩余时不报 */
    ev('printerState.p1.ams[0].slots[0].state = 11');
    ev('data[0].qty = 2; data[0].spoolRemainG = 300');
    eq(aud('A3'), null, '5.4 还有料时不误报');

    /* ══════════════ 六、A4 / A5 余量越界与归零 ══════════════ */
    console.log('\n── 六、A4 / A5 余量越界与归零 ──');
    reset();
    seed({ name: '超量卷', material: 'PLA', color: '#2850E0', weight: 1000, qty: 1, spoolRemainG: 1200 });
    a = aud('A4');
    ok(!!a, '6.1 检出 A4（余量超过整卷）');
    eq(a && a.sev, 'warn', '6.2 A4 是警告级');
    ev('data[0].spoolRemainG = 1000');
    eq(aud('A4'), null, '6.3 刚好等于整卷不报');
    ev('data[0].weight = 800; data[0].spoolRemainG = 800');
    eq(aud('A4'), null, '6.4 刚好等于整卷容量时不误报');
    ev('data[0].spoolRemainG = 820');
    ok(!!aud('A4'), '6.5 800g 整卷 + 820g 余量确实报 A4');
    reset();
    seed({ name: '归零在库', material: 'PLA', color: '#2850E0', weight: 1000, qty: 1, spoolRemainG: 0 });
    a = aud('A5');
    ok(!!a, '6.6 检出 A5（0g 但仍在库）');
    eq(a && a.sev, 'warn', '6.7 A5 是警告级');
    ev('data[0].qty = 0');
    eq(aud('A5'), null, '6.8 qty 也为 0 时不报');
    ev('data[0].qty = 1; data[0].spoolRemainG = null');
    eq(aud('A5'), null, '6.9 余量未知（null）不算归零');

    /* ══════════════ 七、A6 绑定的槽位已不存在 ══════════════ */
    console.log('\n── 七、A6 槽位消失 ──');
    reset();
    seed({ name: '孤儿绑定', material: 'PLA', color: '#2850E0', weight: 1000, qty: 1,
      spoolRemainG: 500, amsRef: 'p1:0:3' });
    ev('printerState.p1 = ' + JSON.stringify({
      ams: [{ amsId: '0', slots: [
        { slot: 0, material: 'PLA', colorHex: '#2850E0', weightG: 700, remainPct: 70,
          tagUid: '0000000000000000', hasRfid: false, state: 11 },
      ] }],
    }));
    a = aud('A6');
    ok(!!a, '7.1 检出 A6');
    eq(a && a.sev, 'warn', '7.2 A6 是警告级');
    /* 完全没有 AMS 数据（离线）时不能判 A6 —— 否则离线进页满屏警告 */
    ev('printerState = {}');
    eq(aud('A6'), null, '7.3 读不到打印机状态时不误报');

    /* ══════════════ 八、A7 / A8 两张 RFID 表的一致性 ══════════════ */
    console.log('\n── 八、A7 / A8 RFID 表一致性 ──');
    reset();
    seed({ name: '未登记', material: 'PLA', color: '#2850E0', weight: 1000, qty: 1, amsRef: 'p1:0:0' });
    ev('printerState.p1 = ' + JSON.stringify({
      ams: [{ amsId: '0', slots: [
        { slot: 0, material: 'PLA', colorHex: '#2850E0', weightG: 900, remainPct: 90,
          tagUid: 'BBBB2222', hasRfid: true, state: 11 },
      ] }],
    }));
    a = aud('A7');
    ok(!!a, '8.1 检出 A7（芯片没进绑定表）');
    eq(a && a.sev, 'info', '8.2 A7 是提示级');
    ev('prnTagBind["BBBB2222"] = ' + ev('data[0].id'));
    eq(aud('A7'), null, '8.3 登记进绑定表后不报');
    reset();
    ev('prnTagArc["CCCC3333"] = { itemId: 99999, at: "2026-01-01T00:00:00Z" }');
    a = aud('A8');
    ok(!!a, '8.4 检出 A8（归档指向已删除的卷）');
    eq(a && a.sev, 'info', '8.5 A8 是提示级');
    ok(/99999/.test(a.detail), '8.6 指出失效的 id');

    /* ══════════════ 九、A9 材质/颜色对不上 ══════════════ */
    console.log('\n── 九、A9 材质颜色不符 ──');
    reset();
    seed({ name: '红PETG', material: 'PETG', color: '#FF0000', weight: 1000, qty: 1, amsRef: 'p1:0:0' });
    ev('printerState.p1 = ' + JSON.stringify({
      ams: [{ amsId: '0', slots: [
        { slot: 0, material: 'PLA', colorHex: '#0000FF', weightG: 800, remainPct: 80,
          tagUid: '0000000000000000', hasRfid: false, state: 11 },
      ] }],
    }));
    a = aud('A9');
    ok(!!a, '9.1 检出 A9');
    eq(a && a.sev, 'warn', '9.2 A9 是警告级');
    ok(/PETG/.test(a.detail) && /PLA/.test(a.detail), '9.3 指出材质差异');
    ok(/色距/.test(a.detail), '9.4 也指出色距');
    /* 同材质同色不该报 */
    ev('printerState.p1.ams[0].slots[0].material = "PETG"; printerState.p1.ams[0].slots[0].colorHex = "#FF0000"');
    eq(aud('A9'), null, '9.5 完全一致时不误报');

    /* ══════════════ 十、A10 / A11 流水与余量来源对账 ══════════════ */
    console.log('\n── 十、A10 / A11 记账流水对账 ──');
    reset();
    const idS = seed({ name: '切片卷', material: 'PLA', color: '#2850E0', weight: 1000, qty: 1,
      spoolRemainG: 700, spoolRemainSrc: 'slice' });
    a = aud('A10');
    ok(!!a, '10.1 检出 A10（来源是切片但没有流水）');
    eq(a && a.sev, 'warn', '10.2 A10 是警告级');
    ev('prnSlicedApply.push({ key: "p1|t1|0", at: "' + A_APPLY_AT1 + '", itemId: ' + idS +
      ', grams: 100, before: 800, after: 700 })');
    eq(aud('A10'), null, '10.3 有流水后不报');
    ev('prnSlicedApply.push({ key: "p1|t1|0", at: "' + A_APPLY_AT2 + '", itemId: ' + idS +
      ', grams: 100, before: 700, after: 600 })');
    a = aud('A11');
    ok(!!a, '10.4 检出 A11（同一幂等键重复）');
    eq(a && a.sev, 'bad', '10.5 A11 是严重级');
    ok(/p1\|t1\|0/.test(a.detail), '10.6 指出重复的幂等键');

    /* ══════════════ 十一、A14 待处理槽位 ══════════════ */
    console.log('\n── 十一、A14 待处理槽位 ──');
    reset();
    eq(aud('A14'), null, '11.1 没有待处理项时不报');
    ev('prnPending.push({ pid: "p1", printerName: "P1", amsId: "0", slot: { slot: 0 }, kind: "new" })');
    a = aud('A14');
    ok(!!a, '11.2 检出 A14');
    eq(a && a.sev, 'info', '11.3 A14 是提示级');
    ev('prnSlicedPending.push({ key: "k", taskName: "T", slot: 0, grams: 12, why: "NOITEM" })');
    const allA14 = ev('prnAudit()').filter(x => x.id === 'A14');
    eq(allA14.length, 2, '11.4 同步待确认与切片待确认各提示一条');

    /* ══════════════ 十二、排序与渲染 ══════════════ */
    console.log('\n── 十二、排序与渲染 ──');
    reset();
    ev('prnPending.push({ pid: "p1", printerName: "P1", amsId: "0", slot: { slot: 0 }, kind: "new" })');
    seed({ name: '越界卷', material: 'PLA', color: '#2850E0', weight: 1000, qty: 1, spoolRemainG: 1500 });
    seed({ name: '一号', material: 'PLA', color: '#2850E0', weight: 1000, qty: 1, amsRef: 'p1:0:0' });
    seed({ name: '二号', material: 'PLA', color: '#2850E0', weight: 1000, qty: 1, amsRef: 'p1:0:0' });
    const seq = ev('prnAudit().map(x => x.sev)');
    const rank = { bad: 0, warn: 1, info: 2 };
    ok(seq.length >= 3, '12.1 三类问题都检出');
    ok(seq.every((v, i) => i === 0 || rank[seq[i - 1]] <= rank[v]), '12.2 严重 → 警告 → 提示 的顺序');
    w.prnRenderAudit();
    const sumTxt = (d.getElementById('prnAuditSum') || {}).textContent || '';
    ok(/共 \d+ 项/.test(sumTxt), '12.3 汇总徽标显示条目数');
    ok(/严重 [1-9]/.test(sumTxt), '12.4 汇总徽标显示严重数');
    const boxHtml = (d.getElementById('prnAuditBox') || {}).innerHTML || '';
    ok(/prn-aud-row bad/.test(boxHtml), '12.5 渲染出严重级行');
    ok(/定位卷/.test(boxHtml), '12.6 有库存卷的问题带「定位卷」按钮');
    ok(ev('window.__PRN_AUDIT_TEXT__().indexOf("[BAD]") === 0'), '12.7 文本导出以严重项开头');
    /* 干净数据必须显示「未发现异常」 */
    reset();
    w.prnRenderAudit();
    ok(/未发现异常/.test((d.getElementById('prnAuditSum') || {}).textContent || ''), '12.8 干净数据汇总显示「未发现异常」');
    ok(/没有发现对不上的地方/.test((d.getElementById('prnAuditBox') || {}).innerHTML || ''), '12.9 干净数据正文给出明确结论');
    eq(w.__PRN_AUDIT__(), [], '12.10 干净数据返回空数组');

    /* ══════════════ 十三、ref 归一（vt 双写法） ══════════════ */
    console.log('\n── 十三、ref 归一 ──');
    eq(ev('prnRefRaw("p1","0",3)'), 'p1:0:3', '13.1 AMS 槽 ref 原样拼装');
    eq(ev('prnRefRaw("p1","vt","vt")'), 'p1:vt:vt', '13.2 外置料盘统一写成 pid:vt:vt');
    eq(ev('prnRefRaw("p1","vt",0)'), 'p1:vt:vt', '13.3 pid:vt:0 也归一成 pid:vt:vt');
    eq(ev('prnRefNorm("p1:vt:0")'), 'p1:vt:vt', '13.4 老写法 prnRefNorm 后归一');
    eq(ev('prnRefNorm("p1:0:3")'), 'p1:0:3', '13.5 正常 ref 不变');
    eq(ev('prnRefOf("p1","0",{slot:2})'), 'p1:0:2', '13.6 接受托盘对象');
    eq(ev('prnRefOf("p1","vt",{slot:"vt"})'), 'p1:vt:vt', '13.7 托盘对象是 vt 时也归一');

    /* ══════════════ 十四、账本写入口的五条不变量 ══════════════ */
    console.log('\n── 十四、prnMatchSet 不变量 ──');
    reset();
    ev('prnSlotMatch = {}');
    const idEx = seed({ name: '独占卷', material: 'PLA', color: '#2850E0', weight: 1000, qty: 1,
      spoolRemainG: 500 });
    ev('prnMatchSet("p1:0:0", { itemId: ' + idEx + ', state: "confirmed" })');
    eq(ev('prnMatchGet("p1:0:0").itemId'), idEx, '14.1 账本记下归属');
    eq(ev('prnMatchGet("p1:0:0").state'), 'confirmed', '14.2 默认 confirmed');
    eq(ev('data[0].amsRef'), 'p1:0:0', '14.3 amsRef 是账本的投影');
    /* 第二个槽来抢同一卷 → 原槽必须冻结并留痕，绝不静默覆盖 */
    ev('prnMatchSet("p1:0:1", { itemId: ' + idEx + ', state: "confirmed" })');
    eq(ev('prnMatchGet("p1:0:1").itemId'), idEx, '14.4 新槽接管');
    eq(ev('prnMatchGet("p1:0:0").itemId'), null, '14.5 原槽已释放（不会出现一卷两槽）');
    eq(ev('prnMatchGet("p1:0:0").state'), 'frozen', '14.6 原槽置 frozen');
    ok(/接管/.test(ev('prnMatchGet("p1:0:0").reason') || ''), '14.7 原槽留下被接管的原因');
    eq(ev('data[0].amsRef'), 'p1:0:1', '14.8 amsRef 跟着账本走');
    /* 真 RFID → 顺带记两张表 */
    seed({ name: '芯片卷', material: 'PLA', color: '#E03A3A', weight: 1000, qty: 1 });
    ev('prnMatchSet("p1:0:2", { itemId: ' + ev('data[1].id') + ', state: "confirmed", tagUid: "DDDD4444" })');
    eq(ev('prnTagBind["DDDD4444"]'), ev('data[1].id'), '14.9 confirmed + 真 RFID → 写活匹配表');
    eq(ev('prnTagArc["DDDD4444"].itemId'), ev('data[1].id'), '14.10 同时写归档表');
    /* 全 0 tag 不是 RFID，禁止写表 */
    ev('prnMatchSet("p1:0:3", { itemId: ' + ev('data[1].id') + ', state: "confirmed", tagUid: "0000000000000000" })');
    ok(ev('prnTagBind["0000000000000000"]') === undefined, '14.11 全 0 tag 不进绑定表');
    /* pending 不写表（还没确认的归属不能污染 RFID 历史） */
    ev('prnMatchSet("p1:0:4", { itemId: ' + ev('data[1].id') + ', state: "pending", tagUid: "EEEE5555" })');
    ok(ev('prnTagBind["EEEE5555"]') === undefined, '14.12 pending 状态不写 RFID 表');

    /* ══════════════ 十五、解绑 / 撤销 ══════════════ */
    console.log('\n── 十五、解绑与撤销 ──');
    reset();
    ev('prnSlotMatch = {}');
    const idU = seed({ name: '撤销卷', material: 'PLA', color: '#2850E0', weight: 1000, qty: 1,
      spoolRemainG: 640, spoolRemainSrc: 'manual' });
    ev('prnMatchSet("p1:0:0", { itemId: ' + idU + ', state: "confirmed" })');
    ev('prnMatchClear("p1:0:0")');
    eq(ev('prnMatchGet("p1:0:0").itemId'), null, '15.1 解绑后账本不再持有库存卷');
    eq(ev('prnMatchGet("p1:0:0").state'), 'frozen', '15.2 解绑置 frozen');
    eq(ev('data[0].amsRef'), null, '15.3 amsRef 一并清空');
    eq(ev('data[0].spoolRemainG'), 640, '15.4 余量保留（冻结值，不清零）');
    eq(ev('data[0].spoolRemainSrc'), 'manual', '15.5 余量来源保留');
    eq(ev('prnMatchUndo("p1:0:0")'), true, '15.6 5 秒内可以撤销');
    eq(ev('prnMatchGet("p1:0:0").itemId'), idU, '15.7 撤销后归属回来');
    eq(ev('data[0].amsRef'), 'p1:0:0', '15.8 撤销后 amsRef 也回来');
    ev('prnMatchClear("p1:0:0")');
    ev('prnSlotMatch["p1:0:0"].undo.at = Date.now() - 31000');
    eq(ev('prnMatchUndo("p1:0:0")'), false, '15.9 超过 30 秒不再允许撤销');

    /* ══════════════ 十六、容量与淘汰策略 ══════════════ */
    console.log('\n── 十六、容量与淘汰 ──');
    reset();
    ev('prnSlotMatch = {}');
    ev('for (var i = 0; i < 305; i++) prnSlotMatch["p9:0:" + i] = { itemId: null, state: "pending", at: i, cand: [] }');
    ev('prnMatchPrune()');
    eq(ev('prnMatchKeys().length'), 305, '16.1 pending 永不淘汰（305 条全留）');
    ev('prnSlotMatch = {}');
    ev('for (var j = 0; j < 305; j++) prnSlotMatch["p9:1:" + j] = { itemId: null, state: "confirmed", at: j }');
    ev('prnMatchPrune()');
    eq(ev('prnMatchKeys().length'), 300, '16.2 普通记录修剪到 300 条');
    ok(ev('!!prnSlotMatch["p9:1:304"]'), '16.3 最新的一条保留');
    ok(ev('prnSlotMatch["p9:1:0"] === undefined'), '16.4 最老的一条被淘汰');
    ev('prnSlotMatch["p9:2:0"] = { itemId: null, state: "pending", at: 0 }');
    ev('prnMatchPrune()');
    ok(ev('!!prnSlotMatch["p9:2:0"]'), '16.5 混入 pending 时 pending 依然不淘汰');
    eq(ev('prnMatchCount("pending")'), 1, '16.6 prnMatchCount 能按状态计数');

    /* ══════════════ 十七、账本迁移 ══════════════ */
    console.log('\n── 十七、账本迁移 ──');
    reset();
    ev('prnSlotMatch = {}');
    const m1 = seed({ name: '老卷一', material: 'PLA', color: '#2850E0', weight: 1000, qty: 1, amsRef: 'p1:0:0' });
    const m2 = seed({ name: '老卷二', material: 'PLA', color: '#2850E0', weight: 1000, qty: 1, amsRef: 'p1:0:0' });
    const m3 = seed({ name: '外挂卷', material: 'PLA', color: '#2850E0', weight: 1000, qty: 1, amsRef: 'p1:vt:0' });
    ev('prnTagArc["FFFF6666"] = { itemId: ' + m1 + ', at: "2026-09-01T00:00:00Z" }');
    const mig = ev('prnMatchMigrate()');
    eq(mig.ran, true, '17.1 首次迁移会执行');
    eq(mig.filled, 2, '17.2 两卷成功入账');
    eq(mig.conflicts, 1, '17.3 同槽第二卷记为冲突');
    eq(ev('prnMatchGet("p1:0:0").itemId'), m1, '17.4 先来的卷保留');
    eq(ev('prnMatchGet("p1:0:0").state'), 'suspect', '17.5 该槽降级为 suspect（不赌哪条对）');
    ok(ev('(prnMatchGet("p1:0:0").cand || []).indexOf(' + m2 + ') >= 0'), '17.6 后来的卷进候选');
    eq(ev('data.find(function(d){return d.id===' + m2 + '}).amsRef'), null, '17.7 冲突卷的 amsRef 被清掉');
    eq(ev('prnMatchGet("p1:vt:vt").itemId'), m3, '17.8 vt 老写法迁移到归一后的键');
    eq(ev('data.find(function(d){return d.id===' + m3 + '}).amsRef'), 'p1:vt:vt', '17.9 迁移顺手归一来 amsRef');
    eq(ev('prnMatchGet("p1:0:0").tagUid'), 'FFFF6666', '17.10 迁移带上归档到的 RFID');
    eq(ev('prnMatchMigrate().ran'), false, '17.11 有版本号时不再重复迁移');
    eq(ev('prnSlotMatch.__v'), 1, '17.12 版本号已写入');

    /* ══════════════ 十八、对账与 A15 / A16 ══════════════ */
    console.log('\n── 十八、对账 A15 / A16 ──');
    reset();
    ev('prnSlotMatch = {}');
    const dr1 = seed({ name: '有绑定无账本', material: 'PLA', color: '#2850E0', weight: 1000, qty: 1,
      amsRef: 'p1:0:0' });
    let drift = ev('prnMatchReconcile()');
    eq(drift.length, 1, '18.1 有 amsRef 但账本没有 → 检出一处漂移');
    ok(/账本里没有/.test(drift[0].why), '18.2 说明是缺记录');
    a = aud('A15');
    ok(!!a, '18.3 体检出 A15');
    eq(a && a.sev, 'bad', '18.4 A15 是严重级');
    ev('prnMatchSyncFromItems()');
    eq(ev('prnMatchReconcile()').length, 0, '18.5 重放投影后漂移消失');
    eq(ev('prnMatchGet("p1:0:0").itemId'), dr1, '18.6 补出的记录指向正确的卷');
    /* 账本指向另一卷 */
    const dr2 = seed({ name: '另一卷', material: 'PLA', color: '#2850E0', weight: 1000, qty: 1 });
    ev('prnSlotMatch["p1:0:0"].itemId = ' + dr2);
    drift = ev('prnMatchReconcile()');
    ok(drift.length >= 1, '18.7 账本与 amsRef 指向不同卷 → 检出漂移');
    ok(drift.some(x => /不是这一卷/.test(x.why)), '18.8 能区分「指向别的卷」');
    /* 账本指向已删卷 */
    ev('prnSlotMatch["p1:0:9"] = { itemId: 98765, state: "confirmed", at: 1 }');
    drift = ev('prnMatchReconcile()');
    ok(drift.some(x => /已被删除/.test(x.why)), '18.9 账本指向已删卷也能检出');
    ev('prnMatchSyncFromItems()');
    ok(ev('prnSlotMatch["p1:0:9"] === undefined'), '18.10 重放会丢弃指向已删卷的记录');
    /* A16：外置料盘两种写法 */
    reset();
    ev('prnSlotMatch = {}');
    seed({ name: '外挂甲', material: 'PLA', color: '#2850E0', weight: 1000, qty: 1, amsRef: 'p1:vt:vt' });
    seed({ name: '外挂乙', material: 'PLA', color: '#E03A3A', weight: 1000, qty: 1, amsRef: 'p1:vt:0' });
    a = aud('A16');
    ok(!!a, '18.11 检出 A16（vt 两种写法并存）');
    eq(a && a.sev, 'bad', '18.12 A16 是严重级');
    ev('data[1].amsRef = "p1:vt:vt"');
    eq(aud('A16'), null, '18.13 写法统一后不报');

    /* ══════════════ 十九、五级匹配流水线 ══════════════ */
    console.log('\n── 十九、五级匹配 ──');
    /* 造一台打印机：slots 里的槽号、材质、颜色、芯片由各用例自定 */
    const mkState = (slots, vt) => ev('printerState.p1 = ' + JSON.stringify(Object.assign({
      id: 'p1', name: 'P1', online: true,
      ams: [{ amsId: '0', slots: slots }],
    }, vt ? { vtTray: vt } : {})));
    const slotOf = (i, patch) => Object.assign(
      { slot: i, material: 'PLA', colorHex: '#2850E0', weightG: 900, remainPct: 90,
        remainingPct: 90, totalG: 1000, tagUid: '0000000000000000', hasRfid: false, state: 11 }, patch || {});
    const sync = () => ev('prnSyncAll("p1", false)');
    const slotRes = (i, patch) => ev('prnSyncSlot("p1","P1","0",' + JSON.stringify(slotOf(i, patch)) + ',new Set(),{swaps:[]})');

    /* L1 账本 */
    reset();
    ev('prnSlotMatch = {}');
    const L1 = seed({ name: '账本卷', material: 'PLA', color: '#2850E0', weight: 1000, qty: 1 });
    ev('prnMatchSet("p1:0:0", { itemId: ' + L1 + ', state: "confirmed" })');
    eq(ev('prnMatchSlot("p1","0",' + JSON.stringify(slotOf(0)) + ').how'), 'bind', '19.1 L1 账本命中');
    /* 账本指向已用完的卷 → 不再采信 */
    ev('data[0].qty = 0');
    ok(ev('(prnMatchSlot("p1","0",' + JSON.stringify(slotOf(0)) + ') || {}).how') !== 'bind',
      '19.2 L1 不采信 qty=0 的卷');
    ev('data[0].qty = 1');

    /* L2 槽位历史 */
    reset();
    ev('prnSlotMatch = {}');
    const L2 = seed({ name: '历史卷', material: 'PETG', color: '#E03A3A', weight: 1000, qty: 1 });
    ev('prnSlotHist["p1:0:1"] = [' + L2 + ']');
    eq(ev('prnMatchSlot("p1","0",' + JSON.stringify(slotOf(1)) + ').how'), 'hist', '19.3 L2 槽位历史命中');
    eq(ev('prnSlotHistPush("p1:0:1", ' + L2 + '), prnSlotHist["p1:0:1"].length'), 1, '19.4 历史去重（同一卷不重复记）');

    /* L3 RFID */
    reset();
    ev('prnSlotMatch = {}');
    const L3 = seed({ name: '芯片卷', material: 'PLA', color: '#111111', weight: 1000, qty: 1 });
    ev('prnTagBind["AAAA1111"] = ' + L3);
    const withTag = slotOf(2, { tagUid: 'AAAA1111', hasRfid: true });
    eq(ev('prnMatchSlot("p1","0",' + JSON.stringify(withTag) + ').how'), 'rfid', '19.5 L3 RFID 命中');
    /* RFID 指向的卷 qty=0 → 不能匹配 */
    ev('data[0].qty = 0');
    ok(ev('(prnMatchSlot("p1","0",' + JSON.stringify(withTag) + ') || {}).how') !== 'rfid',
      '19.6 RFID 指向的卷已用完 → 不匹配');
    ev('data[0].qty = 1');

    /* L4 色距（未绑定） */
    reset();
    ev('prnSlotMatch = {}');
    seed({ name: '同色卷', material: 'PLA', color: '#2850E0', weight: 1000, qty: 1 });
    const m4 = ev('prnMatchSlot("p1","0",' + JSON.stringify(slotOf(3)) + ')');
    eq(m4.how, 'auto', '19.7 L4 色距命中未绑定的卷');
    ok(m4.item && Number(m4.item.qty) > 0, '19.8 命中的卷确实还有库存');
    /* 材质不同不匹配 */
    reset();
    ev('prnSlotMatch = {}');
    seed({ name: '同色异材质', material: 'PETG', color: '#2850E0', weight: 1000, qty: 1 });
    eq(ev('prnMatchSlot("p1","0",' + JSON.stringify(slotOf(3)) + ')'), null, '19.9 材质不同不匹配');

    /* L4 必须排除已绑在别的槽的卷（旧实现会静默抢绑） */
    reset();
    ev('prnSlotMatch = {}');
    const takenId = seed({ name: '别槽的卷', material: 'PLA', color: '#2850E0', weight: 1000, qty: 1, amsRef: 'p1:0:9' });
    ev('prnMatchSet("p1:0:9", { itemId: ' + takenId + ', state: "confirmed" })');
    const m5 = ev('prnMatchSlot("p1","0",' + JSON.stringify(slotOf(4)) + ')');
    eq(m5 && m5.blockedRef, 'p1:0:9', '19.10 L4 不抢已占用的卷，改由 L5 报 blockedRef');
    eq(slotRes(4), 'suggest', '19.11 prnSyncSlot 对 L5 返回 suggest（待确认）');
    eq(ev('prnMatchGet("p1:0:4").state'), 'pending', '19.12 待确认写进账本（刷新不丢）');
    eq(ev('data.length'), 1, '19.13 没有偷偷建第二卷');
    eq(ev('prnMatchGet("p1:0:9").itemId'), takenId, '19.14 原来那个槽的绑定没被抢走');

    /* ══════════════ 二十、同步落库与投影 ══════════════ */
    console.log('\n── 二十、同步落库 ──');
    reset();
    ev('prnSlotMatch = {}');
    const S1 = seed({ name: '同步卷', material: 'PLA', color: '#2850E0', weight: 1000, qty: 1 });
    mkState([slotOf(0)]);
    sync();
    eq(ev('data.find(function(d){return d.id===' + S1 + '}).amsRef'), 'p1:0:0', '20.1 amsRef 由账本投影写入');
    eq(ev('prnMatchGet("p1:0:0").itemId'), S1, '20.2 账本记录归属');
    eq(ev('prnMatchGet("p1:0:0").state'), 'confirmed', '20.3 状态 confirmed');
    eq(ev('data.find(function(d){return d.id===' + S1 + '}).spoolRemainG'), 900, '20.4 AMS 余量写进库存');
    eq(ev('data.find(function(d){return d.id===' + S1 + '}).spoolRemainSrc'), 'ams', '20.5 来源标 ams');
    ok(ev('(prnSlotHist["p1:0:0"] || []).indexOf(' + S1 + ') >= 0'),
      '20.6 自动同步也写槽位历史（旧实现只 save，不写 hist）');
    eq(ev('prnPendingList().length'), 0, '20.7 正常同步不产生待确认项');

    /* 无 RFID 的槽也参与匹配（旧实现整条跳过 → 手动绑的盘永远判不出换卷） */
    reset();
    ev('prnSlotMatch = {}');
    const S2 = seed({ name: '无芯片卷', material: 'PLA', color: '#2850E0', weight: 1000, qty: 1 });
    mkState([slotOf(0, { weightG: null, remainPct: null, hasRfid: false })]);
    sync();
    eq(ev('prnMatchGet("p1:0:0").itemId'), S2, '20.8 无 RFID 槽也参与匹配');
    eq(ev('data[0].spoolRemainG'), null, '20.9 但绝不写假的 0g 余量');

    /* 同一块芯片出现在两个槽 → 冲突待确认 */
    reset();
    ev('prnSlotMatch = {}');
    const S3 = seed({ name: '重复芯片卷', material: 'PLA', color: '#2850E0', weight: 1000, qty: 1 });
    ev('prnTagBind["BBBB2222"] = ' + S3);
    mkState([slotOf(0, { tagUid: 'BBBB2222', hasRfid: true }),
             slotOf(1, { tagUid: 'BBBB2222', hasRfid: true })]);
    sync();
    eq(ev('prnMatchGet("p1:0:0").itemId'), S3, '20.10 第一个槽拿到归属');
    eq(ev('prnMatchGet("p1:0:1").state'), 'pending', '20.11 第二个槽转待确认（不覆盖第一个）');
    ok(/多个槽/.test(ev('prnMatchGet("p1:0:1").reason') || ''), '20.12 待确认原因写明是重复命中');
    eq(ev('data.length'), 1, '20.13 不会为冲突多建卷');

    /* ══════════════ 二十一、换卷强信号 ══════════════ */
    console.log('\n── 二十一、换卷识别 ──');
    reset();
    ev('prnSlotMatch = {}');
    const oldId = seed({ name: '旧盘', material: 'PLA', color: '#2850E0', weight: 1000, qty: 1,
      spoolRemainG: 420, spoolRemainSrc: 'manual' });
    const newId = seed({ name: '新盘', material: 'PLA', color: '#2850E0', weight: 1000, qty: 1 });
    ev('prnTagArc["OLD00001"] = { itemId: ' + oldId + ', at: "2026-09-01T00:00:00Z" }');
    ev('prnMatchSet("p1:0:0", { itemId: ' + oldId + ', state: "confirmed", tagUid: "OLD00001" })');
    ev('prnSlotHist["p1:0:0"] = [' + oldId + ']');
    /* 把新盘塞进槽位历史，让 L2 能命中它（模拟用户提前登记过） */
    ev('prnSlotHist["p1:0:0"] = [' + newId + ',' + oldId + ']');
    const swapRes = slotRes(0, { tagUid: 'NEW00002', hasRfid: true });
    eq(swapRes, 'swap-auto', '21.1 芯片 A→B 识别为换卷并重绑');
    eq(ev('prnMatchGet("p1:0:0").itemId'), newId, '21.2 新盘接管槽位');
    eq(ev('data.find(function(d){return d.id===' + oldId + '}).amsRef'), null, '21.3 旧盘解绑');
    eq(ev('data.find(function(d){return d.id===' + oldId + '}).spoolRemainG'), 420, '21.4 旧盘余量冻结（不归零）');
    eq(ev('data.find(function(d){return d.id===' + oldId + '}).spoolRemainSrc'), 'manual', '21.5 旧盘来源保留');
    eq(ev('prnMatchUndo("p1:0:0")'), true, '21.6 换卷可撤销');
    eq(ev('prnMatchGet("p1:0:0").itemId'), oldId, '21.7 撤销后回到旧盘');
    eq(ev('data.find(function(d){return d.id===' + oldId + '}).amsRef'), 'p1:0:0', '21.8 撤销后旧盘重新绑定');

    /* 同一枚芯片换槽（不是换卷）→ 只补账，不冻结 */
    reset();
    ev('prnSlotMatch = {}');
    const mvId = seed({ name: '搬槽盘', material: 'PLA', color: '#2850E0', weight: 1000, qty: 1,
      spoolRemainG: 600 });
    ev('prnTagBind["MOVE0003"] = ' + mvId);
    ev('prnMatchSet("p1:0:0", { itemId: ' + mvId + ', state: "confirmed" })');   // 账本漏了 tagUid
    const mvRes = slotRes(0, { tagUid: 'MOVE0003', hasRfid: true });
    eq(mvRes === 'swap', false, '21.9 芯片归属仍是本卷时不算换卷');
    eq(ev('prnMatchGet("p1:0:0").itemId'), mvId, '21.10 绑定保持');
    eq(ev('prnMatchGet("p1:0:0").tagUid'), 'MOVE0003', '21.11 顺手把漏记的 tagUid 补上');
    eq(ev('data[0].spoolRemainSrc'), 'ams', '21.12 顺带按 AMS 实测刷新余量（官方盘以实测为准）');

    /* 空槽第一次读到芯片：不是换卷 */
    reset();
    ev('prnSlotMatch = {}');
    eq(ev('prnSwapCheck("p1","0",' + JSON.stringify(slotOf(5, { tagUid: 'FIRST001', hasRfid: true })) + ', null)'), null,
      '21.13 空槽首次读到芯片不判换卷');

    /* 无芯片槽：判不了，返回 null（交给弱信号提示，不动账） */
    eq(ev('prnSwapCheck("p1","0",' + JSON.stringify(slotOf(5)) + ', null)'), null,
      '21.14 无芯片时不做强判定');

    /* ══════════════ 二十二、换卷弱信号（只提示不改账） ══════════════ */
    console.log('\n── 二十二、弱信号与撤销条 ──');
    reset();
    ev('prnSlotMatch = {}');
    const wId = seed({ name: '弱信号卷', material: 'PLA', color: '#2850E0', weight: 1000, qty: 1,
      spoolRemainG: 500, spoolRemainSrc: 'manual' });
    ev('prnMatchSet("p1:0:0", { itemId: ' + wId + ', state: "confirmed" })');
    ok(/回升/.test(ev('prnSwapWeak(' + JSON.stringify(slotOf(0, { remainPct: 60, weightG: null })) + ', data[0])') || ''),
      '22.1 余量回升 ≥5% → 弱信号');
    eq(ev('prnSwapWeak(' + JSON.stringify(slotOf(0, { remainPct: 52, weightG: null })) + ', data[0])'), null,
      '22.2 回升不到 5% 不提示');
    ok(/材质/.test(ev('prnSwapWeak(' + JSON.stringify(slotOf(0, { remainPct: 50, material: 'PETG', weightG: null })) + ', data[0])') || ''),
      '22.3 材质突变 → 弱信号');
    eq(ev('prnSwapWeak(' + JSON.stringify(slotOf(0, { tagUid: 'ZZZZ9999', hasRfid: true })) + ', data[0])'), null,
      '22.4 有芯片的槽不产生弱信号');
    eq(ev('prnSwapWeak(' + JSON.stringify(slotOf(0, { remainPct: 90 })) + ', null)'), null,
      '22.5 没有绑定时不判定');

    /* 弱信号命中：绑定保留，账本标 suspect */
    mkState([slotOf(0, { remainPct: 60, weightG: null })]);
    sync();
    eq(ev('prnMatchGet("p1:0:0").itemId'), wId, '22.6 弱信号命中后绑定仍然保留');
    eq(ev('prnMatchGet("p1:0:0").state'), 'suspect', '22.7 账本标记为 suspect');
    ok(/回升/.test(ev('prnMatchGet("p1:0:0").reason') || ''), '22.8 原因写进账本（刷新也能看到）');
    eq(ev('data[0].spoolRemainG'), 500, '22.9 绝不用弱信号改余量');
    eq(ev('prnPendingList().length'), 1, '22.10 suspect 会出现在待确认列表里');
    ev('prnPendingIgnore(0)');
    eq(ev('prnMatchGet("p1:0:0").state'), 'confirmed', '22.11 确认后回到 confirmed');
    eq(ev('prnMatchGet("p1:0:0").itemId'), wId, '22.12 确认不会解绑');

    /* 换卷撤销条 */
    reset();
    ev('prnSlotMatch = {}');
    ev('prnSwapRecent = []');
    const sOld = seed({ name: '旧盘B', material: 'PLA', color: '#2850E0', weight: 1000, qty: 1,
      spoolRemainG: 300, spoolRemainSrc: 'manual' });
    const sNew = seed({ name: '新盘B', material: 'PLA', color: '#2850E0', weight: 1000, qty: 1 });
    ev('prnTagArc["OLD00009"] = { itemId: ' + sOld + ', at: "2026-09-01T00:00:00Z" }');
    ev('prnMatchSet("p1:0:0", { itemId: ' + sOld + ', state: "confirmed", tagUid: "OLD00009" })');
    ev('prnSlotHist["p1:0:0"] = [' + sNew + ']');
    mkState([slotOf(0, { tagUid: 'NEW00010', hasRfid: true, weightG: 950, remainPct: 95 })]);
    sync();
    eq(ev('prnSwapRecent.length'), 1, '22.13 同步识别到换卷并记下');
    eq(ev('prnSwapRecent[0].fromId'), sOld, '22.14 记下旧卷');
    eq(ev('prnSwapRecent[0].toId'), sNew, '22.15 记下新卷');
    w.renderPrintersPage();
    ok(d.getElementById('prnSwapCard') && d.getElementById('prnSwapCard').hidden === false, '22.16 换卷提示条显示出来');
    ok((d.getElementById('prnSwapBar') || {}).innerHTML.indexOf('撤销') >= 0, '22.17 提示条带撤销按钮');
    ok((d.getElementById('prnSwapBar') || {}).innerHTML.indexOf('旧盘B') >= 0, '22.18 提示条写明是哪一卷');
    w.prnSwapUndo(0);
    eq(ev('prnMatchGet("p1:0:0").itemId'), sOld, '22.19 撤销后旧卷重新绑回');
    eq(ev('prnSwapRecent.length'), 0, '22.20 撤销后提示条清空');
    ok(d.getElementById('prnSwapCard').hidden === true, '22.21 提示条自动隐藏');
    /* 过期的换卷记录不再显示 */
    ev('prnSwapRecent = [{ ref: "p1:0:0", fromName: "A", toName: "B", at: Date.now() - 60000 }]');
    w.prnRenderSwapBar();
    eq(ev('prnSwapRecent.length'), 0, '22.22 超过 30 秒的换卷记录自动丢弃');
    ok(d.getElementById('prnSwapCard').hidden === true, '22.23 过期后提示条不显示');

    /* ══════════════ 二十三、H5 改用任务快照 ══════════════ */
    console.log('\n── 二十三、H5 任务快照 ──');
    const snapAms = [
      { amsId: '1', slot: 0, material: 'PLA', colorHex: '#2850E0',
        tagUid: '0000000000000000', hasRfid: false, state: 11, weightG: 900, remainPct: 90, totalG: 1000 },
    ];
    reset();
    ev('printerState = {}');                     // 关键：实时状态是空的（刷新后就是这样）
    ev('printerState.p1 = ' + JSON.stringify({ ams: [{ amsId: '1', slots: [snapAms[0]] }] }));
    eq(ev('prnTaskAms(' + JSON.stringify({ amsState: snapAms }) + ').length'), 1, '23.1 快照按 amsId 分组');
    eq(ev('prnTaskAms({})'), null, '23.2 没有快照时返回 null');
    eq(ev('prnTaskAms({ amsState: [] })'), null, '23.3 空快照返回 null');
    eq(ev('prnTaskSlotTag({ endTags: { "1-0": "AAAA1111" } }, "1", 0)'), 'AAAA1111', '23.4 endTags 里取芯片号');
    eq(ev('prnTaskSlotTag({ tags: { "1-0": "BBBB2222" } }, "1", 0)'), 'BBBB2222', '23.5 没有 endTags 时退回开始快照');
    eq(ev('prnTaskSlotTag({ endTags: { "1-0": "CCCC3333" }, tags: { "1-0": "BBBB2222" } }, "1", 0)'), 'CCCC3333',
      '23.6 endTags 优先');
    eq(ev('prnTaskSlotTag({ endTags: { "1-0": "0000000000000000" } }, "1", 0)'), null, '23.7 全 0 芯片号不算 RFID');

    /* 快照说这个槽有 RFID → 跳过扣减（哪怕实时状态里是另一个盘） */
    const mkTask = (amsState, extra) => Object.assign({
      printerId: 'p1', taskKey: 'k1', taskName: 'T1',
      startAt: A_TASK_S, endAt: A_TASK_E,
      amsState: amsState,
      sliced: { src: 'cloud', filaments: [{ id: 1, slot: 0, type: 'PLA', colorHex: '#2850E0', usedG: 100 }] },
      consumed: [],
    }, extra || {});
    const F1 = { id: 1, slot: 0, type: 'PLA', colorHex: '#2850E0', usedG: 100 };
    const rfidSnap = [Object.assign({}, snapAms[0], { tagUid: 'DDDD4444', hasRfid: true })];
    eq(ev('prnDeductOne(' + JSON.stringify(mkTask(rfidSnap)) + ',' + JSON.stringify(F1) + ').why'), 'RFID',
      '23.8 快照里该槽有 RFID → 跳过切片扣减');
    eq(ev('prnDeductOne(' + JSON.stringify(mkTask(rfidSnap, { endTags: { '1-0': 'DDDD4444' } })) + ',' + JSON.stringify(F1) + ').why'),
      'RFID', '23.9 endTags 也能挡住（即使 amsState 缺失）');
    /* 快照说没有 RFID，但实时状态里那个槽现在是官方盘 → 仍然要扣（不信任实时状态） */
    reset();
    ev('prnSlotMatch = {}');
    ev('printerState.p1 = ' + JSON.stringify({ ams: [{ amsId: '1', slots: [
      Object.assign({}, snapAms[0], { tagUid: 'REAL9999', hasRfid: true }) ] }] }));
    const dedId = seed({ name: '待扣卷', material: 'PLA', color: '#2850E0', weight: 1000, qty: 1,
      spoolRemainG: 900, spoolRemainAt: A_SPOOL_AT });
    ev('prnMatchSet("p1:1:0", { itemId: ' + dedId + ', state: "confirmed" })');
    const d21 = ev('prnDeductOne(' + JSON.stringify(mkTask(snapAms)) + ',' + JSON.stringify(F1) + ')');
    eq(d21.ok, true, '23.10 快照说没有 RFID → 正常扣减（不被实时状态误挡）');
    eq(ev('data[0].spoolRemainG'), 800, '23.11 扣掉 100g');
    /* 没有快照的老任务：退回实时状态判定 */
    reset();
    ev('prnSlotMatch = {}');
    ev('printerState.p1 = ' + JSON.stringify({ ams: [{ amsId: '1', slots: [
      Object.assign({}, snapAms[0], { tagUid: 'REAL9999', hasRfid: true }) ] }] }));
    const oldTaskId = seed({ name: '老任务卷', material: 'PLA', color: '#2850E0', weight: 1000, qty: 1,
      spoolRemainG: 900, spoolRemainAt: A_SPOOL_AT });
    ev('prnMatchSet("p1:1:0", { itemId: ' + oldTaskId + ', state: "confirmed" })');
    const dOld = ev('prnDeductOne(' + JSON.stringify(mkTask(undefined)) + ',' + JSON.stringify(F1) + ')');
    eq(dOld.why, 'RFID', '23.12 无快照的老任务退回实时状态（有 RFID 仍能挡住）');

    /* ══════════════ 二十四、三源互斥 ══════════════ */
    console.log('\n── 二十四、三源互斥 ──');
    reset();
    const U1 = seed({ name: '三源卷', material: 'PLA', color: '#2850E0', weight: 1000, qty: 1 });
    ev('prnSlicedApply.push({ key: "p1|k1|s0", at: new Date().toISOString(), itemId: ' + U1 +
      ', taskKey: "k1", grams: 120, before: 900, after: 780 })');
    ev('printerUsage.push({ id: "t1", taskKey: "k1", endAt: new Date().toISOString(), consumed: [{ key: "1-0", tagUid: "EEEE7777", grams: 120 }] })');
    ev('prnTagArc["EEEE7777"] = { itemId: ' + U1 + ', at: new Date().toISOString() }');
    ev('prnUsageMapReset()');
    eq(ev('prnUsageOf(data[0])'), 120, '24.1 同一条任务切片与 RFID 不双计');
    eq(ev('prnUsageSrc(data[0])'), 'slice', '24.2 口径标为切片');
    /* 有 RFID 数据时不再叠加校准 */
    ev('prnCalibLog.push({ at: new Date().toISOString(), itemId: ' + U1 + ', grams: 600, prev: 700 })');
    ev('prnUsageMapReset()');
    eq(ev('prnUsageOf(data[0])'), 120, '24.3 有精确来源时不叠加校准（修 RFID + 校准双计）');
    /* 只有校准 */
    reset();
    const U2 = seed({ name: '只校准卷', material: 'PLA', color: '#E03A3A', weight: 1000, qty: 1 });
    ev('prnCalibLog.push({ at: new Date().toISOString(), itemId: ' + U2 + ', grams: 620, prev: 800 })');
    ev('prnUsageMapReset()');
    eq(ev('prnUsageOf(data[0])'), 180, '24.4 只有校准差值时才用它兜底');
    eq(ev('prnUsageSrc(data[0])'), 'calib', '24.5 口径标为校准');
    ok(/校准/.test(ev('prnUsageTitle(data[0])')), '24.6 文案说明是校准口径');
    /* 另一条任务由 RFID 单独计数 */
    reset();
    const U3 = seed({ name: 'RFID 卷', material: 'PLA', color: '#2850E0', weight: 1000, qty: 1 });
    ev('printerUsage.push({ id: "t9", taskKey: "k9", endAt: new Date().toISOString(), consumed: [{ key: "1-0", tagUid: "FFFF8888", grams: 55 }] })');
    ev('prnTagArc["FFFF8888"] = { itemId: ' + U3 + ', at: new Date().toISOString() }');
    ev('prnUsageMapReset()');
    eq(ev('prnUsageOf(data[0])'), 55, '24.7 纯 RFID 归属可以单独计数');
    eq(ev('prnUsageSrc(data[0])'), 'rfid', '24.8 口径标为 RFID');
    /* 90 天外的流水不计 */
    ev('prnSlicedApply.push({ key: "p1|old|s0", at: new Date(Date.now() - 200 * 864e5).toISOString(), itemId: ' + U3 +
      ', taskKey: "old", grams: 300 })');
    ev('prnUsageMapReset()');
    eq(ev('prnUsageOf(data[0])'), 55, '24.9 90 天以外的切片流水不计入');

    /* ══════════════ 二十五、agent 侧落库 amsState / endTags ══════════════ */
    console.log('\n── 二十五、agent 任务快照 ──');
    const ST = {
      ams: [{ amsId: 0, slots: [
        { slot: 0, material: 'PLA', colorHex: '#2850E0', tagUid: 'AAAA1111', hasRfid: true,
          state: 11, remainPct: 90, totalG: 1000, weightG: 900 },
        { slot: 1, material: 'PETG', colorHex: '#E03A3A', tagUid: '0000000000000000', hasRfid: false,
          state: 11, remainPct: null, totalG: null, weightG: null },
      ] }],
      vtTray: { slot: 'vt', material: 'ABS', colorHex: '#111111', tagUid: 'BBBB2222',
        hasRfid: true, state: 11, remainPct: 50, totalG: 1000, weightG: 500 },
    };
    const snap = AG.slotSnap(ST);
    eq(snap.length, 3, '25.1 三个槽全部拍平（含外置料盘）');
    eq(snap[0].amsId, '0', '25.2 amsId 转成字符串');
    eq(snap[0].tagUid, 'AAAA1111', '25.3 带上芯片号');
    eq(snap[0].hasRfid, true, '25.4 hasRfid 已判定');
    eq(snap[1].hasRfid, false, '25.5 全 0 芯片号 = 无 RFID');
    eq(snap[1].weightG, null, '25.6 未知余量保留 null（不压成 0）');
    eq(snap[2].amsId, 'vt', '25.7 外置料盘记作 vt');
    eq(AG.slotSnap({}).length, 0, '25.8 空状态返回空数组');
    eq(AG.slotSnap(null).length, 0, '25.9 null 也不炸');

    /* closeTask 落库：amsState / endTags 必须进任务记录 */
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-match-'));
    const hs = new AG.HistoryStore(path.join(tmpDir, 'hist.json'), { historyKeepDays: 90 });
    hs.openTask('p1', 'T', AG.slotWeights(ST), AG.slotTags(ST), { gcodeFile: 'a.gcode' });
    const rec = hs.closeTask('p1', AG.slotWeights(ST), 'FINISH', ST);
    ok(!!rec, '25.10 closeTask 产出任务记录');
    eq(Array.isArray(rec.amsState), true, '25.11 任务记录带 amsState');
    eq(rec.amsState.length, 3, '25.12 amsState 槽位数正确');
    eq(rec.endTags['0-0'], 'AAAA1111', '25.13 任务记录带 endTags');
    eq(rec.endTags.vt, 'BBBB2222', '25.14 外置料盘芯片也记下');
    ok(rec.endTags['0-1'] === undefined, '25.15 无芯片的槽不进 endTags');
    /* 落盘后重新读一遍，确认真的持久化了 */
    const hs2 = new AG.HistoryStore(path.join(tmpDir, 'hist.json'), { historyKeepDays: 90 });
    const again = (hs2.db.tasks || [])[0];
    ok(!!again, '25.16 任务已落盘');
    eq(again && again.amsState.length, 3, '25.17 amsState 已持久化');
    eq(again && again.endTags['0-0'], 'AAAA1111', '25.18 endTags 已持久化');
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }

    /* ══════════════ 二十六、展示口径统一（P5） ══════════════ */
    console.log('\n── 二十六、展示口径统一 ──');
    reset();
    ev('lowStockCfg.mode = "percent"; lowStockCfg.percent = 20; lowStockCfg.grams = 100;');
    const W1 = seed({ name: '满卷', material: 'PLA', color: '#2850E0', weight: 1000, qty: 1 });
    const W2 = seed({ name: '半卷', material: 'PLA', color: '#E03A3A', weight: 1000, qty: 1, spoolRemainG: 500, spoolRemainSrc: 'manual' });
    const W3 = seed({ name: '小卷', material: 'PETG', color: '#2FA36B', weight: 250, qty: 1, spoolRemainG: 60, spoolRemainSrc: 'slice', amsRef: 'p1:0:0' });
    const W4 = seed({ name: '空卷', material: 'ABS', color: '#111111', weight: 1000, qty: 1, spoolRemainG: 0, spoolRemainSrc: 'slice' });
    const W5 = seed({ name: '未记录', material: 'TPU', color: '#888888', weight: 500, qty: 1 });

    eq(ev('prnStockOf(data.find(d=>d.id===' + W5 + ')).known'), false, '26.1 没记过余量时 known=false');
    eq(ev('prnStockOf(data.find(d=>d.id===' + W5 + ')).g'), null, '26.2 没记过余量时 g=null（不是 0）');
    /* 分母统一用库存录入重量：250g 的卷剩 60g 是 24%，不是 6% */
    eq(ev('prnPctOf(data.find(d=>d.id===' + W3 + '))'), 24, '26.3 百分比以库存录入重量为分母');
    eq(ev('prnStockOf(data.find(d=>d.id===' + W3 + ')).cap'), 250, '26.4 cap 回填当前分母');
    eq(ev('prnStockOf(data.find(d=>d.id===' + W2 + ')).src'), 'manual', '26.5 src 认出手动录入');
    eq(ev('prnStockOf(data.find(d=>d.id===' + W3 + ')).src'), 'slice', '26.6 src 认出切片扣减');
    const W6 = seed({ name: '冻结卷', material: 'ASA', color: '#556677', weight: 1000, qty: 1, spoolRemainG: 300 });
    eq(ev('prnStockOf(data.find(d=>d.id===' + W6 + ')).src'), 'frozen', '26.7 未绑定的余量算冻结值');
    /* 超额夹到 100，绝不显示 150% */
    ev('data.find(d=>d.id===' + W2 + ').spoolRemainG = 1500');
    eq(ev('prnPctOf(data.find(d=>d.id===' + W2 + '))'), 100, '26.8 余量超过整卷时夹到 100%');
    ev('data.find(d=>d.id===' + W2 + ').spoolRemainG = 500');

    /* prnIsLow 三种模式 */
    ev('lowStockCfg.mode = "percent"');
    eq(ev('prnLowMode(data.find(d=>d.id===' + W3 + '))'), false, '26.9 24% 在 percent 模式下不算低');
    ev('lowStockCfg.mode = "grams"');
    eq(ev('prnLowMode(data.find(d=>d.id===' + W3 + '))'), true, '26.10 切到克重模式后 60g≤100g 判低');
    eq(ev('prnLowMode(data.find(d=>d.id===' + W1 + '))'), false, '26.11 满卷在任何模式下都不算低');
    ev('lowStockCfg.mode = "both"');
    eq(ev('prnLowMode(data.find(d=>d.id===' + W3 + '))'), true, '26.12 both 模式任一满足即低');
    ev('lowStockCfg.mode = "percent"');

    /* 文案：三处共用同一个格式化点 */
    eq(ev('prnStockLabel(data.find(d=>d.id===' + W2 + '))'), '余量 500g · 50% · 手动', '26.13 卡片长文案');
    eq(ev('prnStockLabel(data.find(d=>d.id===' + W3 + '), "short")'), '余 60g（切片）', '26.14 列表短文案');
    eq(ev('prnStockLabel(data.find(d=>d.id===' + W4 + '))'), '余量 0g · 已用尽', '26.15 归零显示已用尽');
    eq(ev('prnStockLabel(data.find(d=>d.id===' + W5 + '))'), null, '26.16 没记过余量不显示角标');

    /* 余量归零只影响展示，外加一个「标记用完」按钮；qty/finished 一个都不动 */
    eq(ev('data.find(d=>d.id===' + W4 + ').qty'), 1, '26.17 归零后库存数量仍是 1（不自动扣）');
    eq(ev('data.find(d=>d.id===' + W4 + ').finished || 0'), 0, '26.18 归零后 finished 仍是 0');
    ok(ev('prnExhaustedBtn(data.find(d=>d.id===' + W4 + '))').indexOf('markFinished') > 0, '26.19 归零的卷给出「标记用完」入口');
    eq(ev('prnExhaustedBtn(data.find(d=>d.id===' + W2 + '))'), '', '26.20 还有余量时不出现该按钮');
    /* 真渲染一遍：网格卡片上必须同时出现「已用尽」和「标记用完」 */
    ev('renderAll()');
    const grid = ev('document.getElementById("gridView").innerHTML');
    ok(/已用尽/.test(grid), '26.21 库存网格出现「已用尽」角标');
    ok(/标记用完/.test(grid), '26.22 库存网格出现「标记用完」按钮');
    ok(!/1kg/.test(ev('prnStockLabel(data.find(d=>d.id===' + W4 + '))')), '26.23 角标不再混入整卷标称重量');
    ev('renderList(data)');
    const listHtml = ev('document.getElementById("listView").innerHTML');
    ok(/（切片）/.test(listHtml), '26.24 列表行用短口径标出切片来源');

    /* 槽位卡：余量未知绝不画成 0%（用一个没有绑定任何库存卷的槽） */
    ev('printerState.p2 = ' + JSON.stringify({
      ams: [{ amsId: '0', slots: [
        { slot: 0, material: 'PETG', colorHex: '#2FA36B', tagUid: '0000000000000000', hasRfid: false,
          state: 11, remainPct: -1, totalG: 0, weightG: null },
      ] }],
    }));
    const slotA = ev('prnSlotHtml("p2","0",printerState.p2.ams[0].slots[0])');
    ok(slotA.indexOf('0%') < 0, '26.25 余量未知时槽位卡不出现 0%');
    ok(slotA.indexOf('—') > 0, '26.26 余量未知时显示占位符 —');
    ok(/prn-fill unknown/.test(slotA), '26.27 余量未知时进度条走斜纹样式');
    ok(slotA.indexOf('无 RFID') > 0, '26.28 余量未知时说明原因');
    /* 同一卷在库存页与槽位卡的百分比必须一致（分母统一） */
    ev('printerState.p1 = ' + JSON.stringify({
      ams: [{ amsId: '0', slots: [
        { slot: 0, material: 'PETG', colorHex: '#2FA36B', tagUid: '0000000000000000', hasRfid: false,
          state: 11, remainPct: -1, totalG: 0, weightG: null },
      ] }],
    }));
    const slotB = ev('prnSlotRemain("p1","0",printerState.p1.ams[0].slots[0])');
    eq(slotB.pct, ev('prnPctOf(data.find(d=>d.id===' + W3 + '))'), '26.29 同一卷两处百分比一致');
    eq(slotB.cap, 250, '26.30 槽位卡分母同库存页');
    /* 阈值模式一改，槽位卡跟着变 */
    ok(!/manual low/.test(ev('prnSlotHtml("p1","0",printerState.p1.ams[0].slots[0])')), '26.31 percent 模式下 24% 不标低');
    ev('lowStockCfg.mode = "grams"');
    ok(/manual low/.test(ev('prnSlotHtml("p1","0",printerState.p1.ams[0].slots[0])')), '26.32 克重模式下同一个槽立刻标低');
    eq(ev('prnLowSlots("p1",printerState.p1).length'), 1, '26.33 低库存横幅与卡片同一判据');
    ev('lowStockCfg.mode = "percent"');
    eq(ev('prnLowSlots("p1",printerState.p1).length'), 0, '26.34 切回 percent 后不再报低');

    /* 三个灰度开关 */
    ev('printerCfg = Object.assign({}, PRN_DEFAULT_CFG);');
    eq([ev('prnFlag("autoMatch")'), ev('prnFlag("autoSwap")'), ev('prnFlag("sliceFallbackRfid")')],
      [true, true, true], '26.35 三个开关默认全开');
    ev('printerCfg.autoMatch = false');
    eq(ev('prnFlag("autoMatch")'), false, '26.36 显式 false 才算关');
    ev('printerCfg.autoMatch = 0');
    eq(ev('prnFlag("autoMatch")'), true, '26.37 只有 false 关，0 不算');
    ev('printerCfg = Object.assign({}, PRN_DEFAULT_CFG);');
    ok(!!d.getElementById('prnAutoMatchToggle'), '26.38 策略卡片已插入页面');
    ok(!!d.getElementById('prnAutoSwapToggle'), '26.39 换卷开关已插入页面');
    ok(!!d.getElementById('prnSliceFallbackToggle'), '26.40 切片兜底开关已插入页面');
    ev('prnToggleFlag("autoMatch")');
    eq(ev('printerCfg.autoMatch'), false, '26.41 点一下写进配置');
    eq(ev('lsGet("printerCfg", {}).autoMatch'), false, '26.42 开关已持久化');
    ev('prnToggleFlag("autoMatch")');

    /* autoMatch 关掉：只认硬证据，不再按色距猜 */
    reset();
    const M1 = seed({ name: '同色卷', material: 'PLA', color: '#2850E0', weight: 1000, qty: 1 });
    const SLOT_M = { slot: 0, material: 'PLA', colorHex: '#2850E0', tagUid: '0000000000000000',
      hasRfid: false, state: 11, remainPct: -1, totalG: 0, weightG: null };
    ev('printerCfg.autoMatch = false');
    eq(ev('prnMatchSlot("p1","0",' + JSON.stringify(SLOT_M) + ')'), null, '26.43 关掉自动匹配后不再按色距猜');
    ev('printerCfg.autoMatch = true');
    eq(ev('(prnMatchSlot("p1","0",' + JSON.stringify(SLOT_M) + ')||{}).how'), 'auto', '26.44 打开后同一槽位可以自动命中');
    /* L1 账本不受开关影响：记过的归属永远续得上 */
    ev('prnMatchSet("p1:0:0", { itemId: ' + M1 + ', state: "confirmed" }, { noUndo: true })');
    ev('printerCfg.autoMatch = false');
    eq(ev('(prnMatchSlot("p1","0",' + JSON.stringify(SLOT_M) + ')||{}).how'), 'bind', '26.45 关掉后账本里的归属仍然续得上');
    ev('printerCfg.autoMatch = true');

    /* autoSwap 关掉：强信号也不动账，只标存疑 */
    reset();
    const SW1 = seed({ name: '旧卷', material: 'PLA', color: '#2850E0', weight: 1000, qty: 1, amsRef: 'p1:0:0' });
    ev('prnMatchSet("p1:0:0", { itemId: ' + SW1 + ', state: "confirmed", tagUid: "AAAA1111" }, { noUndo: true })');
    const SLOT_SWAP = { slot: 0, material: 'PLA', colorHex: '#2850E0', tagUid: 'CCCC3333', hasRfid: true,
      state: 11, remainPct: 80, totalG: 1000, weightG: 800 };
    ev('printerState.p1 = ' + JSON.stringify({ ams: [{ amsId: '0', slots: [SLOT_SWAP] }] }));
    ev('printerCfg.autoSwap = false');
    eq(ev('prnSyncSlot("p1","P1","0",printerState.p1.ams[0].slots[0],new Set(),{swaps:[]})'), 'swap-hold',
      '26.46 关掉换卷自动重绑后只挂起');
    eq(ev('(data.find(x=>x.id===' + SW1 + ')||{}).amsRef'), 'p1:0:0', '26.47 挂起时旧卷绑定保留');
    eq(ev('(prnMatchGet("p1:0:0")||{}).state'), 'suspect', '26.48 挂起时账本标存疑');
    ok(/自动重绑已关闭/.test(String(ev('(prnMatchGet("p1:0:0")||{}).reason'))), '26.49 存疑原因写清是开关关着');
    /* 打开后同样的信号就该正常重绑 */
    ev('printerCfg.autoSwap = true');
    reset();
    const SW2 = seed({ name: '旧卷2', material: 'PLA', color: '#2850E0', weight: 1000, qty: 1, amsRef: 'p1:0:0' });
    ev('prnMatchSet("p1:0:0", { itemId: ' + SW2 + ', state: "confirmed", tagUid: "AAAA1111" }, { noUndo: true })');
    ev('printerState.p1 = ' + JSON.stringify({ ams: [{ amsId: '0', slots: [SLOT_SWAP] }] }));
    eq(ev('prnSyncSlot("p1","P1","0",printerState.p1.ams[0].slots[0],new Set(),{swaps:[]})'), 'swap-auto',
      '26.50 打开后换卷自动重绑');

    /* sliceFallbackRfid：有芯片但 AMS 没读数时，才允许切片兜底 */
    reset();
    const R1 = seed({ name: '官方卷', material: 'PLA', color: '#2850E0', weight: 1000, qty: 1, amsRef: 'p1:0:0' });
    const taskNoVal = {
      printerId: 'p1', taskKey: 'kb1', taskId: 'b1',
      startAt: A_TASK_S, endAt: A_TASK_E,
      amsState: [{ amsId: '0', slot: 0, material: 'PLA', colorHex: '#2850E0', tagUid: 'AAAA1111',
        hasRfid: true, state: 11, remainPct: null, totalG: 1000, weightG: null }],
      endTags: { '0-0': 'AAAA1111' },
      sliced: { filaments: [{ id: 1, slot: 0, type: 'PLA', colorHex: '#2850E0', usedG: 120 }] },
    };
    eq(ev('prnTaskAmsValued(' + JSON.stringify(taskNoVal) + ', "0", 0)'), false,
      '26.51 有芯片但没读数时判定为「AMS 没值」');
    ev('printerCfg.sliceFallbackRfid = false');
    eq(ev('prnDeductOne(' + JSON.stringify(taskNoVal) + ',' + JSON.stringify(taskNoVal.sliced.filaments[0]) + ').why'),
      'RFID', '26.52 开关关掉时 RFID 槽一律跳过');
    ev('printerCfg.sliceFallbackRfid = true');
    const fb = ev('prnDeductOne(' + JSON.stringify(taskNoVal) + ',' + JSON.stringify(taskNoVal.sliced.filaments[0]) + ')');
    eq(fb.ok, true, '26.53 开关打开时芯片无读数可以切片兜底');
    eq(fb.item.id, R1, '26.54 兜底扣到正确的那一卷');
    eq(Math.round(fb.after), 880, '26.55 兜底扣减克重正确');
    /* AMS 有读数时，即使开关打开也绝不用切片（否则双计） */
    const taskVal = JSON.parse(JSON.stringify(taskNoVal));
    taskVal.amsState[0].remainPct = 88;
    taskVal.amsState[0].weightG = 880;
    eq(ev('prnTaskAmsValued(' + JSON.stringify(taskVal) + ', "0", 0)'), true, '26.56 有读数时判定为「AMS 有值」');
    eq(ev('prnDeductOne(' + JSON.stringify(taskVal) + ',' + JSON.stringify(taskVal.sliced.filaments[0]) + ').why'),
      'RFID', '26.57 AMS 有读数时切片一律不扣（防双计）');
    ev('printerCfg = Object.assign({}, PRN_DEFAULT_CFG);');
    ev('lowStockCfg.mode = "percent";');

    /* ══════════════ 二十七、服务端残留 open 自愈与主动结账（P6） ══════════════ */
    console.log('\n── 二十七、残留 open 自愈 ──');
    const tmpStale = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-stale-'));
    const hsStale = new AG.HistoryStore(path.join(tmpStale, 'hist.json'), { historyKeepDays: 90 });
    const SNAP2 = {
      ams: [{ amsId: 0, slots: [
        { slot: 0, material: 'PLA', colorHex: '#2850E0', tagUid: 'AAAA1111', hasRfid: true,
          state: 11, remainPct: 90, totalG: 1000, weightG: 900 },
      ] }],
      vtTray: null,
    };
    const mkSt = (gcode, taskId) => ({
      print: { gcodeState: gcode, taskName: 'T', gcodeFile: 'a.gcode', taskId: taskId || null },
      ams: SNAP2.ams, vtTray: null, online: true,
    });

    /* 正常路径：RUNNING 开账 → FINISH 结账 */
    const lastSnap2 = {};
    const r1 = AG.handleState(hsStale, 'p1', mkSt('RUNNING'), lastSnap2, 60);
    eq(r1.opened, true, '27.1 RUNNING 时开账');
    const r2 = AG.handleState(hsStale, 'p1', mkSt('FINISH'), lastSnap2, 60);
    ok(!!r2.closed, '27.2 FINISH 时正常结账');
    eq(hsStale.getOpen('p1'), null, '27.3 结账后 open 已清空');

    /* 残留：open 挂着，但状态早已不是 RUNNING（模拟服务重启后错过迁移） */
    hsStale.openTask('p1', '僵尸任务', AG.slotWeights(SNAP2), AG.slotTags(SNAP2), { gcodeFile: 'a.gcode' });
    hsStale.db.open.p1.startAt = new Date(Date.now() - 40 * 60 * 1000).toISOString();   // 挂了 40 分钟
    const r3 = AG.handleState(hsStale, 'p1', mkSt('IDLE'), {}, 60);
    ok(!!r3.closed, '27.4 超过 30 分钟的残留 open 被自愈结账');
    eq(r3.closed && r3.closed.result, 'STALE', '27.5 自愈的任务标记为 STALE');
    eq(r3.closed && r3.closed.slicedState, 'stale', '27.6 没抓到切片的标 stale');
    eq(hsStale.getOpen('p1'), null, '27.7 自愈后 open 已清空');
    /* 落库的也要是 stale（前端扫描时靠它跳过） */
    const persisted = (new AG.HistoryStore(path.join(tmpStale, 'hist.json'), { historyKeepDays: 90 })).db.tasks
      .filter(t => t.result === 'STALE')[0];
    ok(!!persisted, '27.8 STALE 任务已落盘');
    eq(persisted && persisted.slicedState, 'stale', '27.9 stale 状态已持久化');

    /* 没到 30 分钟的正常任务不能被误杀 */
    hsStale.openTask('p1', '刚开始跑', AG.slotWeights(SNAP2), AG.slotTags(SNAP2), {});
    const r4 = AG.handleState(hsStale, 'p1', mkSt('PREPARE'), {}, 60);
    eq(r4.closed, null, '27.10 未超时的 open 不会被误杀');
    ok(!!hsStale.getOpen('p1'), '27.11 未超时的 open 仍在');
    /* RUNNING 中的长任务即使超过 30 分钟也不能被自愈 */
    hsStale.db.open.p1.startAt = new Date(Date.now() - 90 * 60 * 1000).toISOString();
    const r5 = AG.handleState(hsStale, 'p1', mkSt('RUNNING'), {}, 60);
    eq(r5.closed, null, '27.12 长任务跑到 90 分钟也不会自愈');
    ok(!!hsStale.getOpen('p1'), '27.13 长任务的 open 保持不动');
    /* 已经抓到切片的残留任务，结账时保留 ok 而不是压成 stale */
    hsStale.setSliced('p1', { src: '3mf', plate: 1, filaments: [{ id: 1, usedG: 10 }] });
    hsStale.db.open.p1.startAt = new Date(Date.now() - 45 * 60 * 1000).toISOString();
    const r6 = AG.handleState(hsStale, 'p1', mkSt('IDLE'), {}, 60);
    ok(!!r6.closed, '27.14 有切片的残留任务同样自愈结账');
    eq(r6.closed && r6.closed.slicedState, 'ok', '27.15 已有切片不被压成 stale');
    try { fs.rmSync(tmpStale, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }

    /* 前端侧：prnForceClose 已在页面里，且版本号已升级 */
    ok(typeof w.prnForceClose === 'function', '27.16 前端有 prnForceClose');
    const agentSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'printer-agent.js'), 'utf8');
    /* 断言用「不低于」而不是精确等于：版本号每升一次就改测试，等于给自己埋一颗
       和硬编码日期同类的定时炸弹。这里关心的是「能力门槛到了」，不是具体数字。 */
    const av = /AGENT_VERSION\s*=\s*(\d+)/.exec(agentSrc);
    ok(av && Number(av[1]) >= 4, '27.17 AGENT_VERSION 不低于 4（v4 退避重连 + 断线结账）');
    ok(/\/task\\\/close\$\/ /.test(agentSrc) || agentSrc.indexOf('task\\/close') > 0, '27.18 已注册主动结账路由');
    ok(agentSrc.indexOf('snap.open') > 0, '27.19 打印机状态响应带 open 快照');
    eq(AG.hasOwnProperty('handleState'), true, '27.20 handleState 已导出');

    /* ══════════════ 二十八、全项目体检修复的回归 ══════════════
       这一节锁的是「照着代码读出来的 bug」，不是需求新增：
       每一条都对应一个能在真机上复现的错误行为。 */
    console.log('\n── 二十八、体检修复回归 ──');

    /* ① normalizeItem 单参调用（导入 / 回收站还原 / CSV 共 5 处）不能产出 NaN id。
       NaN id 之后按 id 查永远查不到：匹配不上、编辑打不开、删不掉。 */
    const idA = ev('normalizeItem({name:"a",material:"PLA",color:"#FF0000"}).id');
    const idB = ev('normalizeItem({name:"b",material:"PLA",color:"#FF0000"}).id');
    ok(Number.isFinite(idA), '28.1 单参 normalizeItem 产出有限 id');
    ok(Number.isFinite(idB) && idA !== idB, '28.2 连续两次生成的 id 不重复');
    ok(Number.isFinite(ev('normalizeItem({}).id')), '28.3 空对象也拿到数字 id');

    /* ② vt 外置料盘的 ref 必须归一：以前 6 处裸拼 `pid+":"+amsId+":"+slot`，
       vt 槽拼成 p:vt:0 而账本存的是 p:vt:vt → 绑定了也认不出来。 */
    ev('data.push(normalizeItem({name:"VT卷", material:"PLA", color:"#00FF00", weight:1000, qty:1, spoolRemainG:600, spoolRemainSrc:"manual"}))');
    const vtId = ev('data[data.length-1].id');
    ev('prnMatchSet("pv:vt:vt", { itemId: ' + vtId + ', state: "confirmed", how: "bind" })');
    const VT_TRAY = { slot: 0, material: 'PLA', colorHex: '#00FF00', tagUid: '0000000000000000',
      hasRfid: false, state: 11, remainPct: -1, totalG: 0, weightG: null };
    eq(ev('prnRefOf("pv","vt",0)'), 'pv:vt:vt', '28.4 vt 的 ref 归一成 pid:vt:vt');
    const vtRem = ev('prnSlotRemain("pv","vt",' + JSON.stringify(VT_TRAY) + ')');
    eq(vtRem.g, 600, '28.5 vt 槽位能认出绑定卷的余量');
    eq(vtRem.src, 'manual', '28.6 vt 余量来源标为手动录入');
    ok(ev('prnSlotHtml("pv","vt",' + JSON.stringify(VT_TRAY) + ')').indexOf('VT卷') > 0,
      '28.7 vt 槽位卡显示已绑定的卷名');
    const htmlSrc = fs.readFileSync(HTML, 'utf8');
    ok(!/amsRef === pid \+ ':' \+ amsId/.test(htmlSrc), '28.8 源码里没有裸拼 ref 的查找');
    ok(!/amsRef === pid \+ ':' \+ s\.amsId/.test(htmlSrc), '28.9 也没有按槽对象裸拼的版本');

    /* ③ jsAttr 必须吃下 &，否则用户存字面量 &quot; 会在属性解码后闭合属性（XSS） */
    eq(ev('jsAttr("a&amp;b")'), 'a&amp;amp;b', '28.10 jsAttr 先转义 & 避免二次解码');
    eq(ev('jsAttr("a&quot;b")'), 'a&amp;quot;b', '28.11 字面量 &quot; 不会穿透成真引号');
    ok(ev('jsAttr("x<b>y")').indexOf('<') < 0, '28.12 jsAttr 转义尖括号');
    eq(ev('jsAttr("a\'b")'), "a\\'b", '28.13 单引号仍走 JS 反斜杠转义');
    ok(htmlSrc.indexOf("prnSlicedUndo('${jsAttr(r.key)}')") > 0, '28.14 撤销按钮参数改用 jsAttr');

    /* ④ 任务身份键三处必须同源：流水写 taskKey||id、互斥判 taskKey||taskId||id 时，
       只有 taskId 的任务两边算出的键不同 → 互斥失效 → 双计。 */
    eq(ev('prnTaskUsageKey({taskId:"T1"})'), 'T1', '28.15 只有 taskId 时身份键用 taskId');
    eq(ev('prnTaskUsageKey({taskKey:"K", taskId:"T1", id:"x"})'), 'K', '28.16 taskKey 优先');
    eq(ev('prnSlicedKeyOf({printerId:"p1",taskId:"T1"},{slot:0})'), 'p1|T1|s0',
      '28.17 幂等键与身份键同一口径');
    ok(!/taskKey: t\.taskKey \|\| t\.id/.test(htmlSrc), '28.18 流水不再自己拼任务键');

    /* ⑤ 切片补记窗口：可配置 + 超窗要计数，不能静默丢 */
    eq(ev('prnCfgNum("sliceWindowDays", 30)'), 30, '28.19 默认窗口 30 天');
    ev('printerCfg.sliceWindowDays = "abc"');
    eq(ev('prnCfgNum("sliceWindowDays", 30)'), 30, '28.20 非法值回落默认（NaN 不生效）');
    ev('printerCfg.sliceWindowDays = ""');
    eq(ev('prnCfgNum("sliceWindowDays", 30)'), 30, '28.21 空串也回落默认');
    ev('delete printerCfg.sliceWindowDays');

    ev('prnSlicedSeenReset(); prnSlicedApply.length = 0;');
    const oldTask = {
      id: 't_old', printerId: 'pw', taskKey: 'pw|2020-01-01T00:00:00Z', taskId: '999',
      taskName: '上古任务', startAt: '2020-01-01T00:00:00Z', endAt: '2020-01-01T02:00:00Z',
      slicedState: 'ok',
      sliced: { src: 'cloud', plate: 1, totalG: 100, filaments: [{ id: 1, slot: 0, type: 'PLA', colorHex: '#FF0000', usedG: 100 }] },
      consumed: [],
    };
    const rOld = ev('prnSlicedSweep([' + JSON.stringify(oldTask) + '])');
    eq(rOld.applied, 0, '28.22 远超窗口的任务不自动扣');
    ok(rOld.stale > 0, '28.23 超窗任务被计数而不是静默丢弃');
    eq(ev('prnSlicedStale'), rOld.stale, '28.24 计数落到 prnSlicedStale 供界面提示');

    /* ⑥ 账本投影要能清掉未归一的 amsRef（否则账本说没绑、字段还挂着） */
    ev('data.push(normalizeItem({name:"脏ref", material:"PLA", color:"#123456", weight:1000, qty:1, amsRef:"pw:vt:0"}))');
    const dirtyId = ev('data[data.length-1].id');
    ev('prnMatchSet("pw:vt:vt", { itemId: null, state: "frozen" })');
    eq(ev('data.find(d => d.id === ' + dirtyId + ').amsRef'), null, '28.25 投影清理能识别未归一写法');

    /* ⑦ 服务端：startAt 缺失时不能因为 `NaN||0` 就把任务判成「挂了 50 年」 */
    const tmpNoStart = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-nostart-'));
    const hsNoStart = new AG.HistoryStore(path.join(tmpNoStart, 'hist.json'), { historyKeepDays: 90 });
    hsNoStart.openTask('p1', '无时间戳', AG.slotWeights(SNAP2), AG.slotTags(SNAP2), {});
    delete hsNoStart.db.open.p1.startAt;
    const rNoStart = AG.handleState(hsNoStart, 'p1', mkSt('IDLE'), {}, 60);
    eq(rNoStart.closed, null, '28.26 startAt 缺失时不误判 stale');
    ok(!!hsNoStart.getOpen('p1'), '28.27 那条 open 仍然保留，等人处理');
    try { fs.rmSync(tmpNoStart, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }

    /* ⑧ prune 不能把「时间字段损坏但数据还在」的任务删掉
         （Date.parse(0)=NaN，NaN>=cut 是 false → 静默删除） */
    const tmpPrune = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-prune-'));
    const hsPrune = new AG.HistoryStore(path.join(tmpPrune, 'hist.json'), { historyKeepDays: 90 });
    hsPrune.db.tasks = [
      { id: 'broken', endAt: null, startAt: null },
      { id: 'ancient', endAt: '2000-01-01T00:00:00Z', startAt: '2000-01-01T00:00:00Z' },
    ];
    hsPrune.prune();
    eq(hsPrune.db.tasks.length, 1, '28.28 prune 只丢掉确实过期的');
    eq(hsPrune.db.tasks[0].id, 'broken', '28.29 时间不明的任务被保留');
    try { fs.rmSync(tmpPrune, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }

    /* ⑨ 服务端存储：落盘失败必须回滚内存，否则重启前后 rev 对不上、之后次次 409 */
    const Store = require('../server/printer-store');
    const tmpRw = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-rw-'));
    const st = new Store.AppStore({ dir: tmpRw, log: () => {} });
    const rOk = st.put({}, { filaments: '[]' });
    eq(rOk.ok, true, '28.30 正常写入成功');
    const revBefore = st.db.rev;
    st.save = () => { throw new Error('disk full'); };
    /* base 必须带上次的版本号，否则先被 409 冲突挡住，测不到落盘失败那条路径 */
    const rBad = st.put({ filaments: rOk.keys.filaments }, { filaments: '[1]' });
    eq(rBad.ok, false, '28.31 落盘失败时返回失败');
    eq(rBad.status, 503, '28.32 落盘失败回 503 而不是静默成功');
    eq(st.db.rev, revBefore, '28.33 rev 已回滚到写之前');
    eq(st.db.keys.filaments.val, '[]', '28.34 键的值也回滚了');
    try { fs.rmSync(tmpRw, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }

    /* ══════════════ 二十九、断电长期离线（v4） ══════════════
       打印机断电后 agent 会一直重试（这是对的，机器随时可能开机），
       但原来的重试是 mqtt.js 的固定 1 秒一轮、每轮一条 warn，也没有任何
       「断线多久算这单结束」的判据。本节锁三件事：
       ① 重连间隔必须退避（1s→60s 封顶）；
       ② 同一条错误日志必须降频；
       ③ 断电时 gcodeState 会永久冻在 RUNNING，必须靠「多久没收到 report」结账。 */
    console.log('\n── 二十九、断电长期离线 ──');

    /* ① 退避曲线 */
    eq(AG.bambuBackoffDelay(0), 1000, '29.1 首次退避 1 秒');
    eq(AG.bambuBackoffDelay(1), 2000, '29.2 第二次 2 秒');
    eq(AG.bambuBackoffDelay(2), 4000, '29.3 第三次 4 秒');
    eq(AG.bambuBackoffDelay(5), 32000, '29.4 第五次 32 秒');
    eq(AG.bambuBackoffDelay(20), 60000, '29.5 封顶 60 秒，不会无限拉长');
    eq(AG.bambuBackoffDelay(-3), 1000, '29.6 负数按第一次处理');
    eq(AG.bambuBackoffDelay('x'), 1000, '29.7 非数字不产出 NaN');
    (() => {
      let prev = 0, mono = true, capped = true;
      for (let i = 0; i < 40; i++) {
        const d = AG.bambuBackoffDelay(i);
        if (d < prev) mono = false;
        if (!(d <= AG.BAMBU_BACKOFF_MAX)) capped = false;
        prev = d;
      }
      ok(mono, '29.8 退避序列单调不减');
      ok(capped, '29.9 重试任意多次都不超过上限');
    })();
    const agentSrc2 = fs.readFileSync(path.join(__dirname, '..', 'server', 'printer-agent.js'), 'utf8');
    ok(/reconnectPeriod:\s*0/.test(agentSrc2), '29.10 已关掉 mqtt.js 自带的固定 1s 重连');
    ok(agentSrc2.indexOf('scheduleReconnect') > 0, '29.11 改由 BambuClient 自己排队重连');

    /* ② 客户端退避状态机（不起真 MQTT） */
    const bk = new AG.BambuClient(
      { id: 'p9', name: '离线机', host: '192.0.2.10', serial: 'S9', accessCode: '1' },
      { cfg: { lowStock: {} } });
    eq(bk.retry, 0, '29.12 新建客户端失败计数为 0');
    eq(bk.state.retryIn, null, '29.13 初始没有待重连');
    bk.scheduleReconnect();
    eq(bk.retry, 1, '29.14 排一次重连后失败计数 +1');
    eq(bk.state.retryIn, 1000, '29.15 第一次只等 1 秒');
    ok(!!bk.retryTimer, '29.16 退避定时器已挂上');
    bk.scheduleReconnect();
    eq(bk.retry, 1, '29.17 已有待重连时不重复排队');
    eq(bk.state.reconnects, 1, '29.18 重连次数只记一次');
    bk.disconnect();
    eq(bk.retryTimer, null, '29.19 disconnect 清掉待重连定时器');
    eq(bk.state.retryIn, null, '29.20 disconnect 后不再显示倒计时');
    bk.connect();
    eq(bk.client, null, '29.21 主动 disconnect 之后不会再自动连');

    /* 连上就把失败计数归零，否则下次断线要干等到 60 秒那一档 */
    const bk2 = new AG.BambuClient(
      { id: 'p10', name: '在线机', host: '127.0.0.1', serial: 'S10', accessCode: '1' },
      { cfg: { lowStock: {} } });
    bk2.retry = 7;
    bk2.state.retryIn = 60000;
    const logBak = console.log;
    try { console.log = () => {}; bk2._onConnect(); } finally { console.log = logBak; }
    eq(bk2.retry, 0, '29.22 连上后失败计数归零');
    eq(bk2.state.retryIn, null, '29.23 连上后清掉倒计时');
    eq(bk2.state.online, true, '29.24 连上后 online 为真');
    bk2.disconnect();

    /* ③ 日志降频：断电整夜不该把 10MB 的日志轮转写满 */
    ok(AG.ACTIVE_PRINT_STATES.has('PAUSE') && AG.ACTIVE_PRINT_STATES.has('PREPARE'),
      '29.25 暂停 / 预热准备都算「仍在同一单」');
    AG.logThrottledReset();
    const warnBak = console.warn;
    const warned = [];
    console.warn = m => warned.push(String(m));
    let l1, l2, l3, l4;
    try {
      const T0 = 1700000000000;
      l1 = AG.logThrottled('k1', 'boom', T0);
      l2 = AG.logThrottled('k1', 'boom', T0 + 1000);
      l3 = AG.logThrottled('k1', 'boom', T0 + 1000 + 5 * 60 * 1000);
      l4 = AG.logThrottled('k2', 'boom', T0 + 2000);
    } finally { console.warn = warnBak; }
    eq(l1, true, '29.26 首次错误照常打印');
    eq(l2, false, '29.27 1 秒后的同类错误被压掉');
    eq(l3, true, '29.28 满 5 分钟后重新打印一次');
    eq(l4, true, '29.29 另一台打印机的错误不受影响');
    eq(warned.length, 3, '29.30 四次调用只输出 3 行日志');
    ok(/重复 1 次/.test(warned[1] || ''), '29.31 补报被压掉的次数');
    AG.logThrottledReset();

    /* ④ 断线静默结账：断电时 gcodeState 冻在 RUNNING，只能靠「多久没说话」判 */
    const tmpSilent = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-silent-'));
    const hsSilent = new AG.HistoryStore(path.join(tmpSilent, 'hist.json'), { historyKeepDays: 90 });
    const mkSilent = gcode => ({
      print: { gcodeState: gcode, taskName: '断电任务', gcodeFile: 'a.gcode', taskId: null },
      ams: SNAP2.ams, vtTray: null, online: false,
    });
    /* openTask 会把 startAt 记成「现在」，这里回拨一小时，模拟「已经挂了一阵」 */
    const openOld = () => {
      hsSilent.openTask('p1', '断电任务', AG.slotWeights(SNAP2), AG.slotTags(SNAP2), {});
      hsSilent.db.open.p1.startAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    };

    openOld();
    const rA = AG.handleState(hsSilent, 'p1', mkSilent('RUNNING'), {}, 60,
      { lastMessageAt: Date.now() - 31 * 60 * 1000 });
    ok(!!rA.closed, '29.32 断电静默 31 分钟自动结账');
    eq(rA.closed && rA.closed.result, 'STALE', '29.33 结账结果记 STALE');
    eq(rA.closed && rA.closed.slicedState, 'stale', '29.34 没抓到切片时标 stale');
    eq(hsSilent.getOpen('p1'), null, '29.35 结账后 open 已清空');

    openOld();
    const rB = AG.handleState(hsSilent, 'p1', mkSilent('RUNNING'), {}, 60,
      { lastMessageAt: Date.now() - 10 * 60 * 1000 });
    eq(rB.closed, null, '29.36 静默 10 分钟不动它（可能只是重启）');
    eq(!!hsSilent.getOpen('p1'), true, '29.37 未超时的 open 仍在');

    const rC = AG.handleState(hsSilent, 'p1', mkSilent('RUNNING'), {}, 60);
    eq(rC.closed, null, '29.38 不带 ctx 的老调用保持原行为');

    openOld();
    const rD = AG.handleState(hsSilent, 'p1', mkSilent('PAUSE'), {}, 60,
      { lastMessageAt: Date.now() - 2000 });
    eq(rD.closed, null, '29.39 暂停 40 分钟不算结束（同一单不该被拆成两条）');
    eq(!!hsSilent.getOpen('p1'), true, '29.40 暂停期间 open 保留');

    const rE = AG.handleState(hsSilent, 'p1', mkSilent('PAUSE'), {}, 60,
      { lastMessageAt: Date.now() - 40 * 60 * 1000 });
    ok(!!rE.closed, '29.41 暂停中打印机彻底失联 40 分钟则结账');

    openOld();
    const rF = AG.handleState(hsSilent, 'p1', mkSilent('RUNNING'), {}, 60, { lastMessageAt: 0 });
    eq(rF.closed, null, '29.42 从没收到过 report 时不拿 1970 当起点误杀');

    /* ⑤ 结账用量取「最后一次上报的余量」，别把断电前耗的料算丢 */
    openOld();
    const lastKnown = {
      print: { gcodeState: 'RUNNING', taskName: '断电任务' },
      ams: [{ amsId: 0, slots: [
        { slot: 0, material: 'PLA', colorHex: '#2850E0', tagUid: 'AAAA1111', hasRfid: true,
          state: 11, remainPct: 80, totalG: 1000, weightG: 800 },
      ] }], vtTray: null,
    };
    const rG = AG.handleState(hsSilent, 'p1', lastKnown, {}, 60,
      { lastMessageAt: Date.now() - 45 * 60 * 1000 });
    ok(!!rG.closed, '29.43 用最后一次上报的余量结账');
    const gUsed = (rG.closed && rG.closed.consumed || []).reduce((s, c) => s + c.grams, 0);
    eq(Math.round(gUsed), 100, '29.44 断电前已耗的 100g 被记下来');
    try { fs.rmSync(tmpSilent, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }

    /* ⑥ 排障字段：断了多久、还要等多久重连，都要能在 /state 里看到 */
    const snap9 = new AG.BambuClient(
      { id: 'p11', name: 'n', host: 'h', serial: 's', accessCode: '1' }, { cfg: { lowStock: {} } });
    ok('retryInMs' in snap9.snapshot().connection, '29.45 snapshot 带 retryInMs');
    ok('silentMin' in snap9.snapshot().connection, '29.46 snapshot 带 silentMin');
    eq(snap9.snapshot().connection.lastMessageAt, null, '29.47 没收到过 report 时 lastMessageAt 为 null');




  } catch (e) {
    fail++;
    fails.push('运行异常：' + (e && e.stack || e));
    console.log('\n✗ 运行异常：' + (e && e.stack || e));
  }
  console.log('\n══════════════════════════════════════════════════');
  if (fail) {
    console.log('❌ ' + fail + ' 项失败 / ' + (pass + fail) + ' 项');
    fails.slice(0, 20).forEach(f => console.log('   · ' + f));
    process.exit(1);
  }
  console.log('✅ 全部通过：' + pass + ' / ' + pass);
  process.exit(0);
}, 60);
