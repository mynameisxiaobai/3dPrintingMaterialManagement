/* ══════════════════════════════════════════════════════════════
   visual-ui6.js — 库存页 6 项交互改造的浏览器级验收
   ──────────────────────────────────────────────────────────────
   为什么必须跑真浏览器：这 6 项里有 5 项是「布局位置」和「浮层是否推动内容」，
   在 jsdom 里全部为 0（没有布局引擎，clientWidth / offsetTop 一律 0）。
   静态断言只能证明源码里写了 position:fixed，证明不了它真的没把内容顶下去。

   ① 工具栏只剩一行，吸顶区变矮
   ② 筛选抽屉：绝对定位、开合都不改变内容位置
   ③ 统计卡可点：点「已用完」落到筛选结果，点「耗材总数」清空
   ④ 批量条吸底：不推内容、不与回到顶部按钮重叠
   ⑤ 切页回顶
   ⑥ 卡片底栏：两格等宽，数值来自 qty × weight

   跑法：node tests/visual-ui6.js
══════════════════════════════════════════════════════════════ */
const path = require('path');
const { chromium } = require('playwright-core');

const CHROME = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe';
const HTML = 'file:///' + path.join(__dirname, '..', 'web', 'filament-manager.html').replace(/\\/g, '/');

/* 12 色系 × 4 条 + 红系补到 26 条（红系必须能触发加宽，砖墙才有高差可测） */
const FAMS = [['#C12E1F', '红'], ['#F59042', '橙'], ['#8B5E34', '棕'], ['#F5D547', '黄'],
  ['#4CAF50', '绿'], ['#2EC4B6', '青'], ['#4A90D9', '蓝'], ['#9B59B6', '紫'],
  ['#F07FB0', '粉'], ['#F2F2F2', '白'], ['#9AA0A6', '灰'], ['#22262C', '黑']];
const SEED = [];
let uid = 1;
FAMS.forEach(([c, n]) => {
  for (let j = 0; j < 4; j++) {
    SEED.push({ id: uid++, name: n + '料 ' + (j + 1), brand: ['bambu', 'esun', 'polymaker'][j % 3],
      material: ['PLA', 'PETG', 'ABS'][j % 3], color: c, weight: 1000,
      qty: j === 3 ? 0 : 2, hasSpool: j % 2 === 0, tags: j === 0 ? ['常用'] : [] });
  }
});
for (let j = 5; j <= 26; j++) {
  SEED.push({ id: 500 + j, name: '红料 ' + j, brand: 'esun', material: 'PLA',
    color: '#C12E1F', weight: 1000, qty: 1, hasSpool: true, tags: [] });
}

let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg); } };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: CHROME, args: ['--allow-file-access-from-files'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));

  await page.goto(HTML);
  await page.waitForTimeout(1200);
  await page.evaluate(s => {
    document.documentElement.setAttribute('data-theme', 'light');
    data = s.map(normalizeItem);
    switchPage('inventory');
    currentView = 'fam';
    renderAll();
    window.scrollTo(0, 0);
  }, SEED);
  await page.waitForTimeout(700);

  /* ── ① 工具栏一行 ── */
  console.log('── ① 工具栏压成一行 ──');
  const t1 = await page.evaluate(() => {
    const tb = document.getElementById('invToolbar');
    const kids = [...tb.children].filter(e => e.offsetParent && !e.id.startsWith('filterDrawer'));
    const tops = [...new Set(kids.map(e => Math.round(e.getBoundingClientRect().top)))];
    const drawerInBar = !!document.getElementById('filterDrawer').closest('#invToolbar');
    return {
      h: Math.round(tb.getBoundingClientRect().height),
      rows: tops.length,
      spread: Math.max(...tops) - Math.min(...tops),
      drawerInBar,
      pinnedH: Math.round(document.getElementById('invPinned').getBoundingClientRect().height),
      brandsInBar: !!document.getElementById('brandFilters').closest('.toolbar') &&
        !document.getElementById('filterDrawer').contains(document.getElementById('brandFilters')),
    };
  });
  /* 「一行」的判据不能是「顶边全等」：align-items:center 下 34px 的搜索框与
     28px 的视图切换在垂直方向本来就差几像素。换行才会拉开 ≥30px。 */
  ok(t1.spread <= 18, `1a 工具栏只有一行（顶边极差 ${t1.spread}px ≤ 18）`);
  ok(t1.h < 46, `1b 工具栏高度 ${t1.h}px（原来两行约 88px）`);
  ok(t1.drawerInBar, '1c 抽屉挂在工具栏内部（定位基准就是工具栏）');
  ok(!t1.brandsInBar, '1d 品牌筛选已离开主行，进了抽屉');
  ok(t1.pinnedH < 180, `1e 吸顶区总高 ${t1.pinnedH}px（原来 200+）`);

  /* ── ② 抽屉不影响布局 ── */
  console.log('── ② 筛选抽屉 ──');
  const brickTop = () => page.evaluate(() => {
    const b = document.querySelector('#famView .fam-grp');
    return { top: Math.round(b.getBoundingClientRect().top), wallH: Math.round(document.getElementById('famWall').getBoundingClientRect().height) };
  });
  const before = await brickTop();
  await page.evaluate(() => toggleFilterDrawer());
  await page.waitForTimeout(350);
  const d1 = await page.evaluate(() => {
    const d = document.getElementById('filterDrawer');
    const r = d.getBoundingClientRect();
    return { hidden: d.hidden, pos: getComputedStyle(d).position, w: Math.round(r.width), h: Math.round(r.height),
      exp: document.getElementById('moreFilterBtn').getAttribute('aria-expanded'),
      scrollH: d.scrollHeight, clientH: d.clientHeight };
  });
  const afterOpen = await brickTop();
  ok(d1.hidden === false && d1.pos === 'absolute', `2a 抽屉展开且是绝对定位（${d1.pos}）`);
  ok(near(afterOpen.top, before.top, 1), `2b 展开不推内容（首块砖 top ${before.top} → ${afterOpen.top}）`);
  ok(near(afterOpen.wallH, before.wallH, 1), '2c 墙高也不变（没触发重排）');
  ok(d1.exp === 'true', '2d 按钮 aria-expanded 同步为 true');
  ok(d1.w > 900, `2e 抽屉宽度跟随工具栏（${d1.w}px）`);
  ok(d1.h <= 520 + 2, `2f 抽屉限高生效（${d1.h}px ≤ 520）`);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  const d2 = await page.evaluate(() => ({ hidden: document.getElementById('filterDrawer').hidden,
    exp: document.getElementById('moreFilterBtn').getAttribute('aria-expanded') }));
  ok(d2.hidden === true && d2.exp === 'false', '2g Esc 能关，且 aria-expanded 回到 false');

  await page.evaluate(() => toggleFilterDrawer());
  await page.waitForTimeout(200);
  await page.mouse.click(700, 24);            // 点页头（抽屉在工具栏下方，不在这个区域）
  await page.waitForTimeout(250);
  ok(await page.evaluate(() => document.getElementById('filterDrawer').hidden), '2h 点外部关闭');

  /* ── ③ 统计卡下钻 ── */
  console.log('── ③ 统计卡可点 ──');
  const statCount = await page.evaluate(() => document.querySelectorAll('#statsBar .stat-card').length);
  const tagName = await page.evaluate(() => document.querySelector('#statsBar .stat-card').tagName);
  ok(tagName === 'BUTTON', `3a 统计卡是 <button>（${tagName}）`);

  const chipsAll = await page.evaluate(() => document.querySelectorAll('#famView .spool-chip').length);
  await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#statsBar .stat-card')];
    cards.find(c => c.textContent.includes('已用完')).click();
  });
  await page.waitForTimeout(500);
  const fin = await page.evaluate(() => ({
    st: statusFilter,
    chips: document.querySelectorAll('#famView .spool-chip').length,
    active: document.getElementById('filterFinished').classList.contains('active'),
  }));
  ok(fin.st === 'finished', '3b 点「已用完」把状态筛选切过去');
  ok(fin.active, '3c 工具栏上「已用完」按钮同步高亮');
  ok(fin.chips > 0 && fin.chips < chipsAll, `3d 结果真的收窄了（${chipsAll} → ${fin.chips} 格）`);

  await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#statsBar .stat-card')];
    cards.find(c => c.textContent.includes('耗材总数')).click();
  });
  await page.waitForTimeout(500);
  const tot = await page.evaluate(() => ({
    st: statusFilter, chips: document.querySelectorAll('#famView .spool-chip').length,
    all: document.getElementById('filterAll').classList.contains('active'),
  }));
  ok(tot.st === 'all' && tot.all, '3e 点「耗材总数」回到全部');
  ok(tot.chips === SEED.length, `3f 清空后格数回到全量（${tot.chips}/${SEED.length}）`);

  /* 先把两个藏在抽屉里的条件打开，验证「总数」会连带清掉 */
  await page.evaluate(() => { amsFilter = true; renderAll(); });
  await page.waitForTimeout(300);
  const badge1 = await page.evaluate(() => document.getElementById('moreFilterCount').hidden ? null
    : document.getElementById('moreFilterCount').textContent);
  ok(badge1 === '1', `3g 抽屉条件生效时徽标显示 1（拿到 ${badge1}）`);
  await page.evaluate(() => {
    [...document.querySelectorAll('#statsBar .stat-card')].find(c => c.textContent.includes('耗材总数')).click();
  });
  await page.waitForTimeout(400);
  const badge2 = await page.evaluate(() => ({
    ams: amsFilter,
    hidden: document.getElementById('moreFilterCount').hidden,
  }));
  ok(badge2.ams === false && badge2.hidden, '3h 「总数」把抽屉里的条件也清了，徽标隐回');

  /* ── ④ 批量条吸底 ── */
  console.log('── ④ 批量条吸底 ──');
  const brick3 = await page.evaluate(() => Math.round(document.querySelector('#famView .fam-grp').getBoundingClientRect().top));
  await page.evaluate(() => toggleEditMode());
  await page.waitForTimeout(450);
  const bt = await page.evaluate(() => {
    const bb = document.getElementById('batchBar');
    const r = bb.getBoundingClientRect();
    const cs = getComputedStyle(bb);
    const fab = document.getElementById('toTop').getBoundingClientRect();
    return {
      pos: cs.position,
      top: Math.round(r.top), h: Math.round(r.height), w: Math.round(r.width),
      gapBottom: Math.round(innerHeight - r.bottom),
      overlapFab: !(r.top >= fab.bottom || r.bottom <= fab.top || r.right <= fab.left || r.left >= fab.right),
      padBottom: getComputedStyle(document.querySelector('main')).paddingBottom,
      bodyCls: document.body.classList.contains('batch-on'),
      brickTop: Math.round(document.querySelector('#famView .fam-grp').getBoundingClientRect().top),
      inPinned: !!bb.closest('#invPinned'),
    };
  });
  ok(bt.pos === 'fixed', `4a 批量条是 fixed（${bt.pos}）`);
  ok(bt.gapBottom < 40, `4b 贴在底部（下边距 ${bt.gapBottom}px）`);
  ok(!bt.inPinned, '4c 已脱离 #invPinned（否则会跟着 sticky 停在半空）');
  ok(near(bt.brickTop, brick3, 1), `4d 进编辑模式不推内容（首块砖 top ${brick3} → ${bt.brickTop}）`);
  ok(bt.bodyCls && bt.padBottom === '110px', `4e main 垫了底部内边距（${bt.padBottom}）`);
  ok(!bt.overlapFab, '4f 与回到顶部按钮不重叠');
  ok(bt.w <= 760, `4g 大屏上限宽（${bt.w}px），不散成通栏`);

  /* 滚到中间，批量条仍在视口内 */
  await page.evaluate(() => window.scrollTo(0, 1400));
  await page.waitForTimeout(400);
  const bt2 = await page.evaluate(() => {
    const r = document.getElementById('batchBar').getBoundingClientRect();
    return { inView: r.top >= 0 && r.bottom <= innerHeight + 1, top: Math.round(r.top) };
  });
  ok(bt2.inView, `4h 滚到 1400px 时仍在视口内（top=${bt2.top}）—— 这正是它存在的理由`);
  await page.evaluate(() => toggleEditMode());
  await page.waitForTimeout(300);
  ok(await page.evaluate(() => !document.body.classList.contains('batch-on')), '4i 退出编辑清除 batch-on');

  /* ── ⑤ 切页回顶 ── */
  console.log('── ⑤ 切页回顶 ──');
  /* 切到网格视图：色系墙在 70 条数据下只有 632px 高（砖块是并排摊开的），
     整个文档才 1066px，滚不到 1200。网格视图 70 张卡才有足够长度。 */
  await page.evaluate(() => { setView('grid'); renderAll(); });
  await page.waitForTimeout(500);
  const pre5 = await page.evaluate(() => ({
    docH: document.documentElement.scrollHeight, view: currentView,
    cards: document.querySelectorAll('#gridView .filament-card').length,
  }));
  console.log('     （滚前：docH=' + pre5.docH + ' view=' + pre5.view + ' 卡=' + pre5.cards + '）');
  await page.evaluate(() => window.scrollTo(0, 1200));
  await page.waitForTimeout(300);
  const y0 = await page.evaluate(() => Math.round(window.scrollY));
  await page.evaluate(() => switchPage('data'));
  await page.waitForTimeout(400);
  const y1 = await page.evaluate(() => Math.round(window.scrollY));
  ok(y0 > 300 && y1 === 0, `5a 切页回到顶部（${y0} → ${y1}）`);

  await page.evaluate(() => switchPage('inventory'));
  await page.waitForTimeout(300);
  ok(await page.evaluate(() => window.scrollY === 0), '5b 切回库存页同样在顶部');

  /* ── ⑥ 卡片底栏 ── */
  console.log('── ⑥ 卡片底栏的两个数字 ──');
  await page.evaluate(() => { setView('grid'); renderAll(); });
  await page.waitForTimeout(500);
  const card = await page.evaluate(() => {
    const c = document.querySelector('#gridView .filament-card');
    const stats = [...c.querySelectorAll('.cf-stat')];
    const ks = stats.map(s => s.querySelector('.cf-k').textContent.trim());
    const vs = stats.map(s => s.querySelector('.cf-v').textContent.trim());
    const ws = stats.map(s => Math.round(s.getBoundingClientRect().width));
    const d0 = data.find(x => x.id === Number(c.dataset.id));
    return { ks, vs, ws, qty: d0.qty, weight: d0.weight, title: stats[0].getAttribute('title') };
  });
  ok(card.ks.join('/') === '库存/90天', `6a 两格标签是「库存 / 90天」（${card.ks.join('/')}）`);
  ok(card.ws.length === 2 && near(card.ws[0], card.ws[1], 2), `6b 两格等宽（${card.ws.join(' / ')}px）`);
  const wantKg = (card.weight * card.qty / 1000);
  const gotNum = parseFloat(card.vs[0].replace(/[^\d.]/g, ''));
  ok(near(gotNum, wantKg, 0.02), `6c 库存重量 = ${card.qty} × ${card.weight}g（显示 ${card.vs[0]}，应为 ${wantKg.toFixed(2)}kg）`);
  ok(/qty} 卷 ×/.test(card.title) || card.title.includes('×'), `6d 规格退到 title 里（${card.title}）`);
  ok(!/有料盘/.test(await page.evaluate(() => document.querySelector('#gridView').textContent)),
    '6e 卡面上不再有「有料盘」这行字（默认态）');

  /* ── ⑦ 勾选不跳顶 ── */
  console.log('── ⑦ 勾选不跳回顶部 ──');
  await page.evaluate(() => { toggleEditMode(); setView('grid'); renderAll(); });
  await page.waitForTimeout(500);
  await page.evaluate(() => window.scrollTo(0, 900));
  await page.waitForTimeout(300);
  const yA = await page.evaluate(() => Math.round(window.scrollY));
  await page.evaluate(() => { toggleSelect(data[5].id); });
  await page.waitForTimeout(450);
  const yB = await page.evaluate(() => ({ y: Math.round(window.scrollY), sel: selectedIds.size,
    cnt: document.getElementById('selectedCount').textContent }));
  ok(yA > 700, `7a 勾选前确实滚下去了（scrollY=${yA}）`);
  ok(Math.abs(yB.y - yA) < 60, `7b 勾选后停在原处（${yA} → ${yB.y}）—— 不清空 innerHTML 补回 keepY 的话这里会变成 0`);
  ok(yB.sel === 1 && yB.cnt === '1', `7c 勾选真的生效了（已选中 ${yB.cnt} 条）`);
  await page.evaluate(() => toggleEditMode());

  /* ── 收尾 ── */
  ok(errs.length === 0, errs.length ? `页面报错：${errs[0]}` : '全流程无 JS 报错');

  await browser.close();
  console.log('\n══════════════════════════════════════════════════');
  if (fail) { console.log(`❌ 浏览器级验收：${pass} 通过 / ${fail} 失败`); process.exit(1); }
  console.log(`✅ 浏览器级验收：${pass} 通过 / 0 失败`);
})();
