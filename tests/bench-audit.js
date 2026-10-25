/* 基准：最坏数据量下 prnAudit() 的耗时（进打印机页会调用它） */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('web/filament-manager.html', 'utf8');
const dom = new JSDOM(html, {
  url: 'http://localhost/filament-manager.html', runScripts: 'dangerously', pretendToBeVisual: true,
  beforeParse(w) { w.fetch = () => new Promise(() => {}); w.confirm = () => true; w.alert = () => {}; w.onerror = () => {}; },
});
const w = dom.window;
setTimeout(() => {
  const ev = c => w.eval(c);
  const now = Date.now();
  const D = 864e5;
  const iso = ms => new Date(now + ms).toISOString();

  /* 造最坏规模：200 卷 / 200 任务 / 500 流水 / 2000 校准 */
  ev('data.length = 0');
  for (let i = 0; i < 200; i++) {
    ev('data.push(normalizeItem({name:"卷' + i + '", material:"PLA", color:"#2850E0", weight:1000, qty:1, spoolRemainG:500, spoolRemainSrc:"slice"}))');
  }
  const tasks = [];
  for (let i = 0; i < 200; i++) {
    tasks.push({
      id: 't' + i, printerId: 'p1', taskId: String(1000 + i), taskKey: 'p1|k' + i, taskName: '任务' + i,
      startAt: iso(-(i + 1) * 6 * 36e5), endAt: iso(-(i + 1) * 6 * 36e5 + 2 * 36e5),
      sliced: { filaments: [{ id: 1, slot: 0, type: 'PLA', colorHex: '#2850E0', usedG: 100 }] },
    });
  }
  ev('printerUsage = ' + JSON.stringify(tasks));

  const apply = [];
  for (let i = 0; i < 500; i++) {
    apply.push({
      key: 'p1|k' + (i % 200) + '|s' + i, at: iso(-(i + 1) * 36e5),
      pid: 'p1', taskId: String(1000 + (i % 200)), taskKey: 'p1|k' + (i % 200),
      itemId: ev('data[' + (i % 200) + '].id'), grams: 100, before: 600, after: 500, how: 'bind',
    });
  }
  ev('prnSlicedApply = ' + JSON.stringify(apply));

  const calib = [];
  for (let i = 0; i < 2000; i++) {
    calib.push({
      at: iso(-(i + 1) * 36e5), itemId: ev('data[' + (i % 200) + '].id'),
      grams: 500 - i, prev: 600 - i, amsRef: 'p1:0:0',
    });
  }
  ev('prnCalibLog = ' + JSON.stringify(calib));

  /* 预热 + 计时 */
  ev('prnAudit()');
  const N = 5;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) ev('prnAudit()');
  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / 1e6 / N;
  const findings = ev('prnAudit().length');

  /* 对照组：把 A13 还原成优化前的写法（嵌套 find + 回调里 Date.parse），
     只跑这一段，量出单项差距。 */
  ev(`window.__oldA13 = function(){
    let n = 0, cmp = 0;
    prnSlicedApply.forEach(r => {
      if (!r || !r.pid) return;
      const t = printerUsage.find(x => { cmp++; return x && (x.taskId === r.taskId || x.taskKey === r.taskKey); });
      if (!t || !t.startAt || !t.endAt) return;
      const s0 = Date.parse(t.startAt), s1 = Date.parse(t.endAt);
      if (!Number.isFinite(s0) || !Number.isFinite(s1)) return;
      const hit = prnCalibLog.find(c => { cmp++; return c && c.itemId === r.itemId && c.prev != null
        && (() => { const a = Date.parse(c.at); return Number.isFinite(a) && a >= s0 && a <= s1; })(); });
      if (hit) n++;
    });
    window.__cmp = cmp;
    return n;
  }`);
  ev('__oldA13()');
  const o0 = process.hrtime.bigint();
  for (let i = 0; i < 3; i++) ev('__oldA13()');
  const o1 = process.hrtime.bigint();
  const oldMs = Number(o1 - o0) / 1e6 / 3;

  /* 统计页的两张时间报表：每次切页都会重算，同样按最坏规模量 */
  ev('flUseEvents(90)');
  const r0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) ev('flUseEvents(90)');
  const r1 = process.hrtime.bigint();
  const repMs = Number(r1 - r0) / 1e6 / N;
  ev("switchPage('stats'); renderStatsPage();");
  const p0 = process.hrtime.bigint();
  for (let i = 0; i < 3; i++) ev('renderStatsPage()');
  const p1 = process.hrtime.bigint();
  const pageMs = Number(p1 - p0) / 1e6 / 3;

  console.log('数据规模: 200 卷 / 200 任务 / 500 流水 / 2000 校准');
  console.log('prnAudit() 优化后平均: ' + ms.toFixed(2) + ' ms');
  console.log('A13 旧写法单项平均  : ' + oldMs.toFixed(2) + ' ms  （比较次数 ' + ev('__cmp') + '）');
  console.log('flUseEvents(90) 平均 : ' + repMs.toFixed(2) + ' ms  （消耗报表数据源）');
  console.log('renderStatsPage 整页 : ' + pageMs.toFixed(2) + ' ms  （含两张时间报表）');
  console.log('检出条目: ' + findings);
  dom.window.close();
}, 900);
