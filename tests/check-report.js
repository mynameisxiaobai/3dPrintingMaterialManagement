/* check-report.js — 统计页「入库时间线」与「消耗报表」
   运行：node tests/check-report.js
   不联网，fetch 永不 resolve（agent 视为离线）。

   这两张报表最容易出的三类错，本文件专门守着：
     ① createdAt 兜底写进了 normalizeItem → 每次加载 map 一遍，
        全部时间被刷成「现在」，时间线永远只剩今天
     ② 消耗三源相加而不是互斥 → 同一卷既被切片记过又被校准记过，双计
     ③ 日期用 toISOString().slice(0,10) → UTC，东八区凌晨的事算到前一天
*/
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const HTML = path.join(__dirname, '..', 'web', 'filament-manager.html');
const SRC = fs.readFileSync(HTML, 'utf8');

let pass = 0, fail = 0;
const fails = [];
function ok(c, n) { if (c) pass++; else { fail++; fails.push(n); console.log('  ✗ ' + n); } }
function eq(a, b, n) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa === sb) pass++; else { fail++; fails.push(n + '  得到 ' + sa + ' 期望 ' + sb); console.log('  ✗ ' + n + '  得到 ' + sa + ' 期望 ' + sb); }
}

const dom = new JSDOM(SRC, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'http://localhost/filament-manager.html',
  beforeParse(w) {
    w.fetch = () => new Promise(() => {});
    w.confirm = () => true;
    w.alert = () => {};
    w.onerror = () => {};
  },
});
const w = dom.window;
const ev = c => w.eval(c);
/* 顶层 let/const 不挂 window，且跨 realm 对象原型不同 → 一律 JSON 往返 */
const J = c => JSON.parse(ev('JSON.stringify(' + c + ')'));
const run = c => ev('(function(){' + c + '})()');
const ago = d => new Date(Date.now() - d * 864e5).toISOString();

/* 每次换场景前把状态清干净，避免上一条用例的流水污染下一条 */
function reset() {
  run(`
    data = [];
    flLog = [];
    trash = [];
    nextId = 1;
    prnSlicedApply = [];
    prnCalibLog = [];
    printerUsage = [];
    prnTagArc = {};
    prnSlicedSeen = new Set();
    prnSlicedSeenDb = {};
    prnUsageMapReset();
    stTlWin = 0;
    stUseWin = 90;
  `);
}
setTimeout(() => {
  try {
    /* ══════════ 一、数据模型：createdAt 不多不少 ══════════ */
    console.log('── 一、数据模型 ──');
    const iso = ago(10);

    const keep = J('normalizeItem({ id: 7, name: "A", createdAt: ' + JSON.stringify(iso) + ', createdAtSrc: "user" })');
    eq(keep.createdAt, iso, '1.1 合法 createdAt 原样保留');
    eq(keep.createdAtSrc, 'user', '1.2 createdAtSrc 合法值保留');

    const bad = J('normalizeItem({ id: 8, name: "B", createdAt: "不是时间", createdAtSrc: "hack" })');
    eq(bad.createdAt, null, '1.3 非法 createdAt → null（不写 now）');
    eq(bad.createdAtSrc, null, '1.4 非法 createdAtSrc → null');

    const none = J('normalizeItem({ id: 9, name: "C" })');
    eq(none.createdAt, null, '1.5 缺失 createdAt 不自动补 now（关键：否则每次刷新都改时间）');

    /* 二次归一化必须幂等 —— 这是「时间被刷成现在」的唯一防线 */
    const twice = J('(function(){var a = normalizeItem({id:10,name:"D",createdAt:' + JSON.stringify(iso) + '});'
      + 'return normalizeItem(a);})()');
    eq(twice.createdAt, iso, '1.6 二次归一化后 createdAt 不变（幂等）');

    /* 非法但可被 Date.parse 接受的写法要统一成字符串原样，不做时区转换 */
    const tz = J('normalizeItem({ id: 11, name: "E", createdAt: "2026-03-01T08:30:00.000Z" })');
    eq(tz.createdAt, '2026-03-01T08:30:00.000Z', '1.7 带 Z 的 ISO 原样保留');

    /* ══════════ 二、入库埋点：每个动作都留痕 ══════════ */
    console.log('── 二、入库埋点 ──');
    reset();

    /* 用 adjustQty / pushTrash / dmRestoreTrash 这些真实入口，而不是直接调 flLogPush */
    run(`data.push(normalizeItem({ id: 1, name: '哑光浅灰', brand: '锐造新材', material: 'PLA',
          color: '#B8BAB6', weight: 1000, qty: 2 }));
         flLogPush('add', data[0], { src: 'user' });`);
    let log = J('flLog');
    eq(log.length, 1, '2.1 新增一条 → 1 条 add 事件');
    eq(log[0].kind, 'add', '2.2 kind=add');
    eq(log[0].qty, 2, '2.3 事件带当时卷数');
    eq(log[0].weight, 1000, '2.4 事件带规格');
    ok(Math.abs(Date.parse(log[0].at) - Date.now()) < 5000, '2.5 at 是刚发生的时间');

    run(`adjustQty(1, 1)`);
    log = J('flLog');
    eq(log.length, 2, '2.6 补货 +1 → 多一条事件');
    eq(log[1].kind, 'restock', '2.7 kind=restock');
    eq(log[1].delta, 1, '2.8 delta=+1');
    eq(log[1].qty, 3, '2.9 事件里的卷数是变更后的值');

    /* 已经是 0 卷时再减，实际没变化 → 不该污染时间线 */
    run(`data[0].qty = 0; flLog = []; adjustQty(1, -2)`);
    eq(J('flLog.length'), 0, '2.10 0 卷时再减不记事件（没有真实变化）');

    /* 删除：事件必须比条目活得久 */
    reset();
    run(`data.push(normalizeItem({ id: 1, name: '会被删的卷', brand: 'X', material: 'PLA',
          color: '#123456', weight: 750, qty: 1 }));
         flLogPush('add', data[0]);
         pushTrash([data[0]]);
         data = data.filter(function(x){ return x.id !== 1; });`);
    eq(J('data.length'), 0, '2.11 条目已删除');
    log = J('flLog');
    eq(log.length, 2, '2.12 删除后事件仍在（add + remove）');
    eq(log[1].kind, 'remove', '2.13 kind=remove');
    eq(log[1].name, '会被删的卷', '2.14 事件存的是快照，不是引用');
    eq(log[1].weight, 750, '2.15 快照字段完整');

    /* 还原 */
    run(`dmRestoreTrash(0)`);
    log = J('flLog');
    eq(log.length, 3, '2.16 还原 → 多一条 restore');
    eq(log[2].kind, 'restore', '2.17 kind=restore');
    ok(!!log[0].at, '2.18 原始入库事件还在');

    /* 上限 */
    reset();
    run(`var arr = []; for (var i = 0; i < 1500; i++) arr.push({ at: new Date().toISOString(), kind: 'add',
          itemId: i + 1, name: 'x' + i, brand: '', material: 'PLA', color: '#888888', weight: 1000, qty: 1 });
         flLog = arr;
         flLogPush('add', { id: 9999, name: '最后一卷', weight: 1000, qty: 1 });`);
    eq(J('flLog.length'), 1500, '2.19 超过上限后仍为 1500');
    eq(J('flLog[1499].name'), '最后一卷', '2.20 保留最新一条');
    eq(J('flLog[0].itemId'), 2, '2.21 最旧的被丢掉');

    /* ══════════ 三、时间线聚合 ══════════ */
    console.log('── 三、时间线聚合 ──');
    reset();
    run(`flLog = [
        { at: '${ago(3)}', kind: 'add', itemId: 1, name: '三天前', brand: 'B', material: 'PLA', color: '#111111', weight: 1000, qty: 1 },
        { at: '${ago(1)}', kind: 'add', itemId: 2, name: '一天前', brand: 'B', material: 'PETG', color: '#222222', weight: 1000, qty: 1 },
        { at: '${ago(2)}', kind: 'remove', itemId: 1, name: '三天前', brand: 'B', material: 'PLA', color: '#111111', weight: 1000, qty: 0 }
      ];
      data = [normalizeItem({ id: 1, name: '三天前', createdAt: '${ago(3)}' }),
              normalizeItem({ id: 2, name: '一天前', createdAt: '${ago(1)}' }),
              normalizeItem({ id: 3, name: '只有 createdAt', createdAt: '${ago(5)}' }),
              normalizeItem({ id: 4, name: '没有时间' })];`);
    const evs = J('flAddEvents()');
    eq(evs.map(e => e.name), ['一天前', '三天前', '只有 createdAt'], '3.1 只取入库事件，按时间倒序');
    ok(evs.every(e => e.kind !== 'remove'), '3.2 remove 不进入库时间线');
    eq(evs.filter(e => e.name === '三天前').length, 1, '3.3 有 add 事件的条目不会因 createdAt 再补一条（无重复）');
    eq(J('flAddEvents().length'), 3, '3.4 缺 createdAt 的条目不被凭空造时间');

    /* 升级回填的存量必须单独成组：混进按天分组会让升级当天凭空多出一堆「入库」，
       还会把顶部的「最近一次」顶掉（真踩过） */
    run(`data = [normalizeItem({ id: 1, name: '真新增', createdAt: '${ago(1)}' }),
                  normalizeItem({ id: 2, name: '升级前就有', createdAt: '${ago(1)}', createdAtSrc: 'migrated' })];
         flLog = []; switchPage('stats');`);
    eq(J('flAddEvents().filter(function(e){return !!e.migrated;}).length'), 1, '3.5 migrated 标记正确');
    const tl2 = w.document.querySelector('.st-card[data-id="timeline"]');
    ok(!!tl2 && tl2.textContent.indexOf('升级前') >= 0, '3.6 存量在时间线里单独成组');
    ok(!!tl2 && tl2.textContent.indexOf('1 条入库') >= 0, '3.7 顶部只统计真实入库条数');
    eq(w.document.querySelectorAll('.st-card[data-id="timeline"] .st-tl-day').length, 2, '3.8 一天 + 存量组 = 2 组');

    /* ══════════ 四、消耗报表：三源互斥 ══════════ */
    console.log('── 四、消耗报表 ──');
    reset();
    run(`
      data = [
        normalizeItem({ id: 1, name: '切片卷', material: 'PLA', weight: 1000, qty: 1 }),
        normalizeItem({ id: 2, name: '校准卷', material: 'PLA', weight: 1000, qty: 1 }),
        normalizeItem({ id: 3, name: '纯 RFID 卷', material: 'PLA', weight: 1000, qty: 1 })
      ];
      /* 任务 T1 用切片记了 item1 的 100g；RFID 侧同一任务又报了 item1 的 100g */
      prnSlicedApply = [{ key: 'k1', at: '${ago(2)}', taskKey: 'T1', taskId: 'T1', taskName: '任务一',
                          itemId: 1, itemName: '切片卷', grams: 100, src: '3mf' }];
      printerUsage = [{ id: 'T1', taskKey: 'T1', taskName: '任务一', endAt: '${ago(2)}',
                        consumed: [{ tagUid: 'TAG1', grams: 100 }, { tagUid: 'TAG3', grams: 60 }] }];
      prnTagArc = { TAG1: { itemId: 1 }, TAG3: { itemId: 3 } };
      /* item2 只有校准；item1 也有校准，但有精确来源 → 不该参与 */
      prnCalibLog = [
        { at: '${ago(1)}', itemId: 2, prev: 800, grams: 500, task: '手动' },
        { at: '${ago(1)}', itemId: 1, prev: 900, grams: 700, task: '手动' }
      ];
    `);
    const ue = J('flUseEvents(90)');
    const sumBy = {};
    ue.forEach(e => { sumBy[e.itemId] = (sumBy[e.itemId] || 0) + e.grams; });
    eq(sumBy[1], 100, '4.1 同任务同卷：切片优先，RFID 不重复计');
    eq(sumBy[2], 300, '4.2 只有校准的卷走校准差值');
    eq(sumBy[3], 60, '4.3 无切片记录的 RFID 正常计入');
    eq(ue.length, 3, '4.4 三条事件，没有第四份');
    eq(ue.filter(e => e.src === 'slice').length, 1, '4.5 来源标记正确（切片）');
    ok(ue.every(e => Number.isFinite(e.at) && e.at > 0), '4.6 每条事件都有可排序的时间戳');

    /* 与库存角标自洽：近 90 天时，每卷合计必须等于 prnUsageOf */
    const cmp = J(`(function(){
      var m = {}; flUseEvents(90).forEach(function(e){ m[e.itemId] = (m[e.itemId]||0) + e.grams; });
      var out = {};
      data.forEach(function(d){ out[d.id] = { report: Math.round((m[d.id]||0)*10)/10, badge: Math.round(prnUsageOf(d)*10)/10 }; });
      return out;
    })()`);
    eq(cmp['1'], { report: 100, badge: 100 }, '4.7 切片卷：报表 = 库存角标');
    eq(cmp['2'], { report: 300, badge: 300 }, '4.8 校准卷：报表 = 库存角标');
    eq(cmp['3'], { report: 60, badge: 60 }, '4.9 RFID 卷：报表 = 库存角标');

    /* 零头与补料 */
    run(`prnCalibLog = [{ at: '${ago(1)}', itemId: 2, prev: 800, grams: 799.8 },
                       { at: '${ago(1)}', itemId: 2, prev: 500, grams: 900 }];
         prnSlicedApply = []; printerUsage = []; prnUsageMapReset();`);
    eq(J('flUseEvents(90).length'), 0, '4.10 ≤0.5g 与「余量上升（补料）」都不算消耗');

    /* 窗口过滤 */
    run(`prnSlicedApply = [{ key: 'old', at: '${ago(120)}', taskKey: 'OLD', itemId: 1, itemName: '切片卷', grams: 500, src: '3mf' },
                          { key: 'new', at: '${ago(3)}', taskKey: 'NEW', itemId: 1, itemName: '切片卷', grams: 40, src: '3mf' }];
         prnCalibLog = []; printerUsage = []; prnUsageMapReset();`);
    eq(J('flUseEvents(90).length'), 1, '4.11 90 天窗口只留窗口内的事件');
    eq(J('flUseEvents(0).length'), 2, '4.12 「全部」窗口把历史都放出来');
    eq(J('flUseEvents(7).map(function(e){return e.grams;})'), [40], '4.13 7 天窗口');

    /* 已删除的耗材要能显示成名字，而不是 undefined */
    run(`data = []; prnUsageMapReset();`);
    eq(J('flUseEvents(0)[0].name'), '切片卷', '4.14 条目已删除时用流水里的名称快照');

    /* ══════════ 五、日期边界（东八区） ══════════ */
    console.log('── 五、日期口径 ──');
    /* 本地 00:30 必须算成当天，用 toISOString 会掉到前一天 */
    const localLate = new Date(2026, 4, 20, 0, 30, 0).toISOString();
    run(`flLog = [{ at: '${localLate}', kind: 'add', itemId: 1, name: '深夜入库', color: '#888888', weight: 1000, qty: 1 }];
         data = [];`);
    eq(J('flDayKey(flLog[0].at)'), '2026-05-20', '5.1 本地 00:30 归到当天（不是 UTC 的前一天）');
    eq(J('flHm(flLog[0].at)'), '00:30', '5.2 时刻按本地时区显示');
    eq(J('flDayKey("乱写")'), null, '5.3 非法时间返回 null 而不是 Invalid Date 字符串');
    eq(J('flHm("")'), '', '5.4 空时间返回空串');

    /* ══════════ 六、页面渲染 ══════════ */
    console.log('── 六、统计页渲染 ──');
    run(`
      data = [
        normalizeItem({ id: 1, name: '哑光浅灰', brand: '锐造新材', material: 'PLA', color: '#B8BAB6', weight: 1000, qty: 2, createdAt: '${ago(2)}' }),
        normalizeItem({ id: 2, name: '丝绸金', brand: '锐造新材', material: 'PLA', color: '#D4AF37', weight: 1000, qty: 1, createdAt: '${ago(1)}' })
      ];
      flLog = [];
      prnSlicedApply = [{ key: 'k1', at: '${ago(1)}', taskKey: 'T1', itemId: 1, itemName: '哑光浅灰', grams: 123.4, taskName: '测试任务', src: '3mf' }];
      prnUsageMapReset();
      switchPage('stats');
    `);
    const tlCard = w.document.querySelector('.st-card[data-id="timeline"]');
    const useCard = w.document.querySelector('.st-card[data-id="useReport"]');
    ok(!!tlCard, '6.1 统计页出现「入库时间线」卡片');
    ok(!!useCard, '6.2 统计页出现「消耗报表」卡片');
    ok(tlCard && tlCard.textContent.indexOf('哑光浅灰') >= 0, '6.3 时间线列出耗材名');
    ok(tlCard && tlCard.textContent.indexOf('丝绸金') >= 0, '6.4 两条都在');
    ok(!!(tlCard && tlCard.querySelector('.st-tl-dayh')), '6.5 时间线按天分组渲染');
    ok(!!(tlCard && tlCard.querySelectorAll('.st-tl-row').length >= 2), '6.6 每天下面有明细行');
    ok(!!(useCard && useCard.textContent.indexOf('123.4') >= 0 || (useCard && useCard.textContent.indexOf('123') >= 0)), '6.7 消耗报表显示克重');
    ok(!!(useCard && useCard.textContent.indexOf('测试任务') >= 0), '6.8 消耗报表显示任务名');
    ok(!!(useCard && useCard.querySelector('.st-day')), '6.9 按天聚合有条形');
    const segCount = tlCard.querySelectorAll('.st-seg button').length;
    eq(segCount, 3, '6.10 时间线有 3 个窗口按钮');
    eq(useCard.querySelectorAll('.st-seg button').length, 4, '6.11 消耗报表有 4 个窗口按钮');

    /* 有库存但没有任何流水 → 两张卡必须仍在，显示空态。
       整卡消失会让人以为「这个功能没做」，而不是「我还没有数据」。 */
    run(`data = [normalizeItem({ id: 1, name: '只有库存', material: 'PLA', weight: 1000, qty: 1 })];
         flLog = []; prnSlicedApply = []; prnCalibLog = []; printerUsage = [];
         prnUsageMapReset(); switchPage('stats');`);
    const tlEmpty = w.document.querySelector('.st-card[data-id="timeline"]');
    const useEmpty = w.document.querySelector('.st-card[data-id="useReport"]');
    ok(!!tlEmpty, '6.12 无流水时时间线卡仍在（显示空态）');
    ok(!!tlEmpty && tlEmpty.textContent.indexOf('还没有入库记录') >= 0, '6.13 时间线空态有引导文案');
    ok(!!useEmpty && useEmpty.textContent.indexOf('没有可归属') >= 0, '6.14 消耗报表空态有引导文案');

    /* 连库存都没有时走整页空态（既有行为，别被新卡片带跑） */
    run(`data = []; switchPage('stats');`);
    eq(w.document.getElementById('stCards').innerHTML, '', '6.15 库存为空时统计卡区整体为空（沿用既有空态）');

    /* 切换窗口不报错、且能改状态 */
    run(`setStUseWin(30); setStTlWin(90);`);
    eq(J('stUseWin'), 30, '6.16 setStUseWin 生效');
    eq(J('stTlWin'), 90, '6.17 setStTlWin 生效');
    run(`setStUseWin(0); setStTlWin(0);`);
    eq([J('stUseWin'), J('stTlWin')], [0, 0], '6.18 「全部」窗口是 0 而不是被吞成默认值');

    /* ══════════ 七、CSV 导出含两段报表 ══════════ */
    console.log('── 七、CSV 导出 ──');
    ok(SRC.indexOf("['耗材入库时间线']") >= 0, '7.1 导出含「耗材入库时间线」段');
    ok(SRC.indexOf("['耗材消耗明细']") >= 0, '7.2 导出含「耗材消耗明细」段');
    ok(SRC.indexOf("'入库时间'") >= 0, '7.3 库存明细表头带「入库时间」列');
    /* 这条守的是一个真实踩过的坑：.st-day-f 是 <span>，默认 inline，
       height/width 全不生效，条形退化成一条深色轨道 —— 看起来像"没渲染数据" */
    ok(/\.st-day-f\s*\{[^}]*display:\s*block/.test(SRC), '7.4 按天消耗条必须是 block（inline 会让条不可见）');

    /* ══════════ 八、持久键接线（漏一处 PUT 整批 400） ══════════ */
    console.log('── 八、持久键接线 ──');
    ok(/filamentLog:\s*'入库时间线'/.test(SRC), '8.1 FM_LABELS 有 filamentLog');
    ok(/'prnSlotMatch', 'prnSlicedSeen', 'filamentLog'\]/.test(SRC), '8.2 FM.SYNC 有 filamentLog');
    ok(/\[.filamentLog.,\s*.入库时间线.\]/.test(SRC), '8.3 DM_STORE_KEYS 有 filamentLog');
    const PSRC = fs.readFileSync(path.join(__dirname, '..', 'server', 'printer-store.js'), 'utf8');
    ok(/'prnSlotMatch', 'prnSlicedSeen', 'filamentLog'/.test(PSRC), '8.4 服务端 SYNC_KEYS 有 filamentLog');
    ok(/filamentLog: flLog/.test(SRC), '8.5 备份导出带 filamentLog');
    ok(/filamentLogIn: Array\.isArray/.test(SRC), '8.6 备份导入解析 filamentLog');

    /* ══════════ 汇总 ══════════ */
    console.log('\n════════════════════════');
    if (fail) {
      console.log(`❌ 有失败：${pass} / ${pass + fail}`);
      fails.forEach(f => console.log('  · ' + f));
      process.exit(1);
    } else {
      console.log(`✅ 全部通过：${pass} / ${pass + fail}`);
      process.exit(0);
    }
  } catch (e) {
    console.log('\n💥 异常：' + (e && e.stack || e));
    process.exit(1);
  }
}, 300);
