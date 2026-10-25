/* check-calib.js — 验证「不再无谓要求校准」与「换盘后仍能自动扣」两组新行为
   运行：NODE_PATH=<isolated>/node_modules node check-calib.js */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const HTML = path.join(ROOT, 'web', 'filament-manager.html');
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
    w.fetch = () => new Promise(() => {});
    w.confirm = () => true;
    w.alert = () => {};
    w.onerror = m => { errors.push(String(m)); };
  },
});
const w = dom.window;
const ev = code => w.eval(code);

/* 一台只有 1 个 AMS 4 槽的打印机：槽 0..2 有 RFID，槽 3 是无芯片第三方盘 */
const STATE = {
  ams: [{ amsId: '0', slots: [
    { slot: 0, state: 11, material: 'PLA', colorHex: '#00AE42', weightG: 1000, tagUid: '6284BD7600000100', hasRfid: true },
    { slot: 1, state: 11, material: 'PLA', colorHex: '#000000', weightG: 1000, tagUid: 'CAE46D4800000100', hasRfid: true },
    { slot: 2, state: 11, material: 'PLA', colorHex: '#FFFFFF', weightG: 1000, tagUid: '1C0DEFDB00000100', hasRfid: true },
    { slot: 3, state: 11, material: 'PLA', colorHex: '#6F5034', weightG: null, tagUid: '0000000000000000', hasRfid: false },
  ] }],
  vtTray: null,
  print: { gcodeState: 'FINISH', taskName: '测试任务', taskId: '555', percent: 100 },
  online: true,
};

/* 时间一律相对现在构造（写死绝对日期会在越过补记窗口后集体失败） */
const NOW = Date.now();
const H = 3600e3, MIN = 60e3, DAY = 864e5;
const iso = ms => new Date(NOW + ms).toISOString();
const T_BASE = iso(-2 * DAY);                  // 余量记录时间：早于所有任务
const T0     = iso(-1 * DAY);                  // 任务开始
const T0_END = iso(-1 * DAY + 30 * MIN);       // 任务结束
const T_EARLY = iso(-1 * DAY - 90 * MIN);      // 更早的一次任务（A6 兜底场景）
const T1_S = iso(-1 * DAY + H),       T1_E = iso(-1 * DAY + H + 20 * MIN);
const T2_S = iso(-1 * DAY + 2 * H),   T2_E = iso(-1 * DAY + 2 * H + 30 * MIN);

function task(o) {
  return Object.assign({
    id: 'p1|x', printerId: 'p1', taskKey: 'p1|' + T0,
    taskId: '555', taskName: '测试任务',
    startAt: T0, endAt: T0_END,
    slicedState: 'ok', consumed: [],
  }, o);
}
function reset(itemPatch) {
  /* 幂等索引现在独立持久化（prnSlicedSeen），清流水不会再自动清空它。
     每个场景要重新扣减，必须显式 prnSlicedSeenReset()。 */
  ev('data.length = 0; prnSlicedApply.length = 0; prnSlicedSeenReset(); prnSlotHist = {}; printerUsage = []');
  ev(`printerState.p1 = ${JSON.stringify(STATE)}`);
  if (itemPatch) ev(`data.push(normalizeItem(${JSON.stringify(itemPatch)}))`);
}

setTimeout(() => {
  console.log('\n── 页面加载 ──');
  eq(errors.filter(e => !/fetch|Network|Failed/i.test(e)), [], '加载期无脚本异常');
  ok(typeof w.prnCalibPendingSlots === 'function', 'prnCalibPendingSlots 已定义');

  /* ═══ 零、重量字段语义：tray_weight 是整卷标称净重，不是剩余克重 ═══ */
  console.log('\n── 零、tray_weight ≠ 剩余克重 ──');
  const agent = require('../server/printer-agent');
  const T = o => agent.parseTray(Object.assign({ tray_type: 'PLA', tray_color: 'C12E1FFF', state: 11 }, o), 0);
  const t10 = T({ tray_weight: '1000', remain: 10, tag_uid: 'B928F2' });
  eq([t10.weightG, t10.totalG, t10.remainPct], [100, 1000, 10], '官方盘 10% → 剩 100g / 共 1000g');
  eq(T({ tray_weight: '1000', remain: 100, tag_uid: 'AA' }).weightG, 1000, '满盘 100% → 1000g');
  eq(T({ tray_weight: '1000', remain: -1, tag_uid: 'AA' }).weightG, null,
     'remain=-1 → 余量未知（不能当 1000，也不能当 0）');
  eq(T({ tray_weight: '1000', remain: 10, remain_g: 88, tag_uid: 'AA' }).weightG, 88,
     '固件给了 remain_g 就以它为准');
  const tNo = T({ tray_weight: '0', remain: -1, tag_uid: '0000000000000000' });
  eq([tNo.weightG, tNo.remainPct, tNo.hasRfid], [null, null, false], '第三方盘仍是「不知道」');

  /* 界面：同一张卡片必须自洽（10% ↔ 100g，不能是 1000g） */
  reset(null);
  ev(`data.push(normalizeItem({id:1,name:'官方PLA',brand:'Bambu',material:'PLA',color:'#C12E1F',weight:1000,qty:1,hasSpool:true,amsRef:'p1:0:0'}))`);
  ev(`printerState.p1 = {"ams":[{"amsId":"0","slots":[{slot:0,state:11,material:'PLA',subBrand:'PLA Basic',
      colorHex:'#C12E1F',weightG:100,totalG:1000,remainPct:10,tagUid:'B928F2',hasRfid:true}]}],
      "vtTray":null,"print":{},"online":true}`);
  const slotHtml = ev('prnSlotHtml("p1","0",printerState.p1.ams[0].slots[0])');
  ok(slotHtml.indexOf('剩 100g / 共 1000g') >= 0, '槽位卡片显示「剩 100g / 共 1000g」');
  ok(slotHtml.indexOf('· 1000g ·') < 0, '不再把 1000g 当成剩余量显示');
  /* 余量未知时不能渲染成 0g，也不能把库存余量写坏 */
  ev(`printerState.p1.ams[0].slots[0].weightG = null`);
  ev(`printerState.p1.ams[0].slots[0].remainPct = -1`);
  ok(ev('prnSlotHtml("p1","0",printerState.p1.ams[0].slots[0])').indexOf('余量未知') >= 0,
     'weightG 为空 → 显示「余量未知」而不是 0g');
  ev(`prnWriteSpool(data[0], 'p1:0:0', printerState.p1.ams[0].slots[0])`);
  eq(ev('data[0].spoolRemainG'), null, '余量未知时绑定不会把库存余量写成 0');

  /* ═══ 一、校准提示只在「本次真的用到、且没自动扣掉」时出现 ═══ */
  console.log('\n── 一、校准提示精准化 ──');
  const BASE = { id: 1, name: '第三方黑PLA', brand: 'eSun', material: 'PLA', color: '#6F5034',
    weight: 1000, qty: 1, spoolRemainG: 800, spoolRemainAt: T_BASE,
    spoolRemainSrc: 'manual', amsRef: 'p1:0:3' };

  /* A1：本次任务只用了 1 号槽（有 RFID）→ 不该提示校准 */
  reset(BASE);
  ev(`printerUsage = [${JSON.stringify(task({ sliced: { src: 'cloud', filaments: [
    { id: 1, slot: 1, type: 'PLA', colorHex: '#000000', usedG: 12.3 }] } }))}]`);
  ev(`prnCalibTodo.p1 = true; prnLastDone.p1 = { name:'测试任务', endAt:'${T0_END}', taskId:'555' }`);
  eq(ev('JSON.stringify(prnCalibPendingSlots("p1", printerState.p1))'), '[]',
     'A1 只用官方盘 → 不提示校准（用户抱怨的场景）');

  /* A2：本次任务用了 3 号槽（无指纹第三方盘）且尚未扣减 → 应提示 */
  reset(BASE);
  ev(`printerUsage = [${JSON.stringify(task({ sliced: { src: 'cloud', filaments: [
    { id: 1, slot: 3, type: 'PLA', colorHex: '#6F5034', usedG: 30 }] } }))}]`);
  ev(`prnCalibTodo.p1 = true; prnLastDone.p1 = { name:'测试任务', endAt:'${T0_END}', taskId:'555' }`);
  eq(ev('JSON.stringify(prnCalibPendingSlots("p1", printerState.p1))'), '[{"amsId":"0","slot":3}]',
     'A2 用到第三方盘且未扣 → 提示校准该槽');

  /* A3：同一场景，但切片已经把它扣掉了 → 不再提示 */
  const before3 = ev('data[0].spoolRemainG');
  ev(`prnSlicedSweep(printerUsage)`);
  eq(ev('data[0].spoolRemainG'), before3 - 30, 'A3 自动扣掉 30g');
  eq(ev('JSON.stringify(prnCalibPendingSlots("p1", printerState.p1))'), '[]',
     'A3 已自动扣 → 不再要求手动校准');

  /* A4：槽位无绑定库存项 → 提示也没意义，应跳过 */
  reset(null);
  ev(`printerUsage = [${JSON.stringify(task({ sliced: { src: 'cloud', filaments: [
    { id: 1, slot: 3, type: 'PLA', colorHex: '#6F5034', usedG: 30 }] } }))}]`);
  ev(`prnCalibTodo.p1 = true; prnLastDone.p1 = { name:'测试任务', endAt:'${T0_END}', taskId:'555' }`);
  eq(ev('JSON.stringify(prnCalibPendingSlots("p1", printerState.p1))'), '[]',
     'A4 未绑定库存项 → 不提示（提示也没法算）');

  /* A5：数据还没下来（endAt 就在刚刚）→ 先不打扰 */
  reset(BASE);
  ev(`printerUsage = []`);
  ev(`prnCalibTodo.p1 = true; prnLastDone.p1 = { name:'测试任务', endAt:'${new Date().toISOString()}', taskId:'555' }`);
  eq(ev('JSON.stringify(prnCalibPendingSlots("p1", printerState.p1))'), '[]',
     'A5 结束后 90s 内数据未到 → 暂不提示');

  /* A6：超过宽限仍无数据 → 兜底提示（这种情况确实只能手动） */
  ev(`prnLastDone.p1 = { name:'测试任务', endAt:'${T_EARLY}', taskId:'555' }`);
  eq(ev('JSON.stringify(prnCalibPendingSlots("p1", printerState.p1))'), '[{"amsId":"0","slot":3}]',
     'A6 超过宽限仍无用量数据 → 兜底提示');

  /* ═══ 二、换盘后仍能自动扣（匹配兜底）═══ */
  console.log('\n── 二、换盘后自动续上 ──');
  const T3 = task({ sliced: { src: 'cloud', filaments: [
    { id: 1, slot: 3, type: 'PLA', colorHex: '#6F5034', usedG: 25 }] } });

  /* B1：amsRef 被清空，但槽位历史记得它 */
  reset(Object.assign({}, BASE, { amsRef: null }));
  ev(`prnSlotHist['p1:0:3'] = [data[0].id]`);
  ev(`printerUsage = [${JSON.stringify(T3)}]`);
  eq(ev(`prnSlicedSweep(printerUsage).applied`), 1, 'B1 靠槽位历史仍然扣到了');
  eq(ev('data[0].spoolRemainG'), 775, 'B1 扣减 25g 正确');
  eq(ev(`JSON.stringify(prnSlicedApply.map(r=>r.how))`), '["slot-hist"]', 'B1 归属依据是 slot-hist');

  /* B2：amsRef 绑在别的槽（盘换了位置没重绑），颜色一致 → 也能认 */
  reset(Object.assign({}, BASE, { amsRef: 'p1:0:1' }));
  ev(`printerUsage = [${JSON.stringify(T3)}]`);
  eq(ev(`prnSlicedSweep(printerUsage).applied`), 1, 'B2 绑在别的槽也能认出来');
  eq(ev('data[0].spoolRemainG'), 775, 'B2 扣减 25g 正确');

  /* B3：颜色差得远 → 宁可不扣，也不猜 */
  reset(Object.assign({}, BASE, { amsRef: 'p1:0:1', color: '#FFFFFF' }));
  ev(`printerUsage = [${JSON.stringify(task({ sliced: { src: 'cloud', filaments: [
    { id: 1, slot: 3, type: 'PLA', colorHex: '#6F5034', usedG: 25 }] } }))}]`);
  eq(ev(`prnSlicedSweep(printerUsage).applied`), 0, 'B3 颜色差太远 → 不扣（宁缺不错）');
  eq(ev('data[0].spoolRemainG'), 800, 'B3 余量保持不变');

  /* B4：材质不同 → 不认 */
  reset(Object.assign({}, BASE, { amsRef: null, amsRef: null, material: 'PETG' }));
  ev(`prnSlotHist['p1:0:3'] = []`);
  ev(`printerUsage = [${JSON.stringify(T3)}]`);
  eq(ev(`prnSlicedSweep(printerUsage).applied`), 0, 'B4 材质不同 → 不扣');

  /* B5：认不出来时不能静默 —— 要有 pending 记录给界面提示 */
  reset(null);
  ev(`printerUsage = [${JSON.stringify(T3)}]`);
  eq(ev(`prnSlicedSweep(printerUsage).pending`), 1, 'B5 认不出库存项 → 计入 pending');
  eq(ev('prnSlicedPending.length'), 1, 'B5 pending 详情被记录（界面能提示）');
  eq(ev('prnSlicedPending[0].grams'), 25, 'B5 pending 克重正确');
  eq(ev('prnSlicedPending[0].slot'), 3, 'B5 pending 带槽位号');
  /* 用户绑定后重扫能补上 */
  ev(`data.push(normalizeItem(${JSON.stringify(Object.assign({}, BASE, { amsRef: null }))}))`);
  eq(ev(`prnSlicedSweep(printerUsage).applied`), 1, 'B5 补绑后重扫能扣上');
  eq(ev('data[0].spoolRemainG'), 775, 'B5 补扣 25g');
  eq(ev('prnSlicedPending.length'), 0, 'B5 补扣成功后 pending 清空');

  console.log('\n── 三、连续两次打印都能自动扣（只输一次余量的核心诉求）──');
  reset(BASE);
  const T1 = task({ taskId: '901', taskKey: 'p1|' + T1_S,
    startAt: T1_S, endAt: T1_E,
    sliced: { src: 'cloud', filaments: [{ id: 1, slot: 3, type: 'PLA', colorHex: '#6F5034', usedG: 40 }] } });
  const T2 = task({ taskId: '902', taskKey: 'p1|' + T2_S,
    startAt: T2_S, endAt: T2_E,
    sliced: { src: 'cloud', filaments: [{ id: 1, slot: 3, type: 'PLA', colorHex: '#6F5034', usedG: 15.5 }] } });
  ev(`printerUsage = [${JSON.stringify(T2)}, ${JSON.stringify(T1)}]`);
  eq(ev('prnSlicedSweep(printerUsage).applied'), 2, '两次任务各扣一条');
  eq(ev('data[0].spoolRemainG'), 744.5, '800 − 40 − 15.5 = 744.5');
  eq(ev(`prnSlicedApply.length`), 2, '流水两条');
  eq(ev(`JSON.stringify(prnSlicedApply.map(r=>r.grams))`), '[40,15.5]', '两条克重都对');
  /* 再扫一遍：不重复扣 */
  eq(ev('prnSlicedSweep(printerUsage).applied'), 0, '重扫幂等');
  eq(ev('data[0].spoolRemainG'), 744.5, '重扫后余量不变');

  console.log('\n════════════════════════');
  console.log((fail === 0 ? '✅ 全部通过' : '❌ 有失败') + '：' + pass + ' / ' + (pass + fail));
  if (fails.length) fails.forEach(f => console.log('  · ' + f));
  process.exit(fail ? 1 : 0);
}, 800);
