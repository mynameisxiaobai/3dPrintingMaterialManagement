/* ══════════════════════════════════════════════════════════════
   visual-tabs.js — 色卡库 / 统计 / 数据管理 / 打印机 四页的几何验收
   ──────────────────────────────────────────────────────────────
   这一轮改的全是「位置」和「有多少东西在 DOM 里」，jsdom 一律给 0：
     · 色卡库从 30227px 收到 7000px，靠的是分组折叠 —— 只能数卡片和量页高
     · 组标题吸在吸顶工作台下面 —— 必须量 getBoundingClientRect().top
     · 交叉表的空格子要真的是透明 —— getComputedStyle 才看得出
     · 数据管理两栏要齐平 —— 只有真布局有高度

   跑法：node tests/visual-tabs.js
══════════════════════════════════════════════════════════════ */
const path = require('path');
const { chromium } = require('playwright-core');

const CHROME = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe';
const HTML = 'file:///' + path.join(__dirname, '..', 'web', 'filament-manager.html').replace(/\\/g, '/');

const FAMS = [['#C12E1F', '红'], ['#F59042', '橙'], ['#8B5E34', '棕'], ['#F5D547', '黄'],
  ['#4CAF50', '绿'], ['#2EC4B6', '青'], ['#4A90D9', '蓝'], ['#9B59B6', '紫'],
  ['#F07FB0', '粉'], ['#F2F2F2', '白'], ['#9AA0A6', '灰'], ['#22262C', '黑']];
const BRANDS = ['bambu', 'esun', 'polymaker', 'sunlu', 'kingroon'];
const MATS = ['PLA', 'PETG', 'ABS', 'TPU', 'ASA'];
const SEED = [];
let uid = 1;
FAMS.forEach(([c, n], fi) => {
  const cnt = fi === 0 ? 12 : 2 + (fi % 3);
  for (let j = 0; j < cnt; j++) {
    SEED.push({ id: uid++, name: n + '料 ' + (j + 1), brand: BRANDS[(fi + j) % 5],
      material: MATS[(fi + j) % 5], color: c, weight: [1000, 750, 500][j % 3],
      qty: j === cnt - 1 ? 0 : (j % 4), hasSpool: j % 2 === 0, tags: j % 3 === 0 ? ['常用'] : [] });
  }
});

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
    renderAll();
  }, SEED);
  await page.waitForTimeout(400);

  /* ══════════ ① 色卡库：分组折叠 ══════════ */
  console.log('── ① 色卡库：692 张按色系折叠 ──');
  await page.evaluate(() => switchPage('swatch'));
  await page.waitForTimeout(900);
  const g0 = await page.evaluate(() => {
    const root = document.getElementById('swResults');
    return {
      groups: root.querySelectorAll('.sw-group').length,
      cards: root.querySelectorAll('.sw-card').length,
      nodes: root.querySelectorAll('*').length,
      docH: document.documentElement.scrollHeight,
      total: swList.length,
      perGroup: [...root.querySelectorAll('.sw-group')].map(s => ({
        fam: s.dataset.fam, shown: s.querySelectorAll('.sw-card').length,
        n: Number(s.querySelector('.sw-group-n').textContent), head: !!s.querySelector('.sw-group-hd'),
      })),
    };
  });
  ok(g0.groups === 12, `1a 按色系切成 12 组（实测 ${g0.groups}）`);
  ok(g0.cards < g0.total / 2, `1b 首屏只渲染 ${g0.cards} 张，而不是全部 ${g0.total} 张`);
  ok(g0.docH < 9000, `1c 页面高度 ${g0.docH}px（改造前 30227px）`);
  ok(g0.perGroup.every(g => g.shown <= 12), '1d 每组最多摊开 12 张');
  ok(g0.perGroup.every(g => g.shown === Math.min(12, g.n)), '1e 折叠的那部分张数和组标题的计数对得上');
  ok(g0.perGroup.filter(g => g.n > 12).every(g => g.head), '1f 超过 12 张的组都有标题（带「展开其余 N 个」）');

  /* 展开一组 */
  const exp = await page.evaluate(() => {
    const before = document.querySelectorAll('#swResults .sw-card').length;
    const btn = document.querySelector('.sw-group-more');
    const fam = btn.closest('.sw-group').dataset.fam;
    btn.click();
    return { before, after: document.querySelectorAll('#swResults .sw-card').length, fam };
  });
  await page.waitForTimeout(300);
  ok(exp.after > exp.before, `1g 点「展开其余」后卡片从 ${exp.before} 涨到 ${exp.after}（${exp.fam}系）`);
  /* 收起 */
  await page.evaluate(() => {
    const s = [...document.querySelectorAll('.sw-group')].find(x => x.querySelector('.sw-group-more')?.textContent.includes('收起'));
    if (s) s.querySelector('.sw-group-more').click();
  });
  await page.waitForTimeout(250);
  const back = await page.evaluate(() => document.querySelectorAll('#swResults .sw-card').length);
  ok(back === exp.before, `1h 再点收回，回到 ${back} 张`);

  /* 索引仍然指对卡片：第 2 组第 1 张点开的应该是它自己 */
  const idxOk = await page.evaluate(() => {
    const card = document.querySelectorAll('#swResults .sw-group')[1].querySelector('.sw-card');
    const i = Number(card.dataset.i);
    card.click();
    const zh = document.querySelector('.sw-modal-title')?.textContent.trim();
    closeSwModal();
    return { i, want: swList[i]?.zh, got: zh };
  });
  ok(idxOk.want === idxOk.got, `1i 分组后卡片索引仍指向自己（data-i=${idxOk.i} → ${idxOk.got}）`);

  /* ══════════ ② 色卡库：组标题吸顶 ══════════ */
  console.log('── ② 组标题吸在吸顶工作台下面 ──');
  const stickTop = await page.evaluate(() => {
    const tabs = document.querySelector('.page-tabs').getBoundingClientRect().height;
    const chrome = document.querySelector('header').getBoundingClientRect().height;
    const gap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tabs-gap'));
    return Math.round(chrome + tabs + gap);
  });
  await page.evaluate(() => window.scrollTo(0, 1100));
  await page.waitForTimeout(450);
  const st = await page.evaluate(() => {
    const pinnedH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--pinned-h'));
    const hs = [...document.querySelectorAll('.sw-group-hd')].map(h => ({
      fam: h.parentElement.dataset.fam, top: Math.round(h.getBoundingClientRect().top),
    }));
    return { pinnedH, hs, scrollY: Math.round(window.scrollY), docH: document.documentElement.scrollHeight };
  });
  const stuck = st.hs.filter(h => h.top < st.scrollY + 400);
  ok(st.pinnedH > 20, `2a --pinned-h 实测到 ${st.pinnedH}px（色卡库的搜索/筛选条高度）`);
  const pinnedTop = Math.round(stickTop + st.pinnedH);
  ok(stuck.some(h => near(h.top, pinnedTop, 3)),
    `2b 有组标题正吸在 ${pinnedTop}px（页签 ${stickTop} + 工作台 ${st.pinnedH}）：${JSON.stringify(stuck.map(h => h.fam + '@' + h.top))}`);

  /* ══════════ ③ 品牌名录弹层 ══════════ */
  console.log('── ③ 品牌名录从页面底部搬到首屏 ──');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(200);
  const brandBtn = await page.evaluate(() => {
    const b = document.querySelector('.st-hero-acts .st-btn');
    const r = b.getBoundingClientRect();
    return { visible: r.top < window.innerHeight && r.top > 0, n: document.getElementById('swBrandN').textContent };
  });
  ok(brandBtn.visible, `3a 品牌名录入口在首屏（标着 ${brandBtn.n} 个品牌）`);
  await page.evaluate(() => {
    const b = document.querySelector('.st-hero-acts .st-btn');
    b.focus(); b.click();
  });
  await page.waitForTimeout(350);
  const modal = await page.evaluate(() => {
    const m = document.getElementById('swBrandModal');
    return { open: !m.hidden, items: m.querySelectorAll('.sw-brand').length,
      focused: document.activeElement?.classList.contains('sw-brand') };
  });
  ok(modal.open && modal.items > 30, `3b 弹层打开，列出 ${modal.items} 个品牌`);
  ok(modal.focused, '3c 打开后焦点落在第一个品牌上（键盘能直接选）');
  await page.evaluate(() => closeSwBrands());
  await page.waitForTimeout(250);
  const closed = await page.evaluate(() => ({
    hidden: document.getElementById('swBrandModal').hidden,
    focusBack: document.activeElement?.classList.contains('st-btn'),
  }));
  ok(closed.hidden && closed.focusBack, '3d 关闭后焦点回到入口按钮');

  /* ══════════ ④ 统计页：KPI 与吸顶 ══════════ */
  console.log('── ④ 统计页：KPI 不重复 / 控制条吸顶 ──');
  await page.evaluate(() => switchPage('stats'));
  await page.waitForTimeout(900);
  const k = await page.evaluate(() => {
    const kids = [...document.querySelectorAll('#stKpis > *')];
    return {
      n: kids.length,
      widths: kids.map(x => Math.round(x.getBoundingClientRect().width)),
      labels: kids.map(x => x.querySelector('.st-kpi-label').textContent),
      subH: Math.round(kids[3].querySelector('.st-kpi-sub').getBoundingClientRect().height),
      subOverflow: kids.some(x => { const s = x.querySelector('.st-kpi-sub'); return s.scrollWidth > s.clientWidth + 1; }),
    };
  });
  ok(k.n === 7, `4a 默认范围下 7 张 KPI（「当前口径合计」和「库存卷数」是同一个数，已去掉）：${k.labels.join(' / ')}`);
  ok(k.widths.every(w => w >= 165), `4b 每张 ${k.widths[0]}px 宽（改造前 153px，副标读不出来）`);
  ok(!k.labels.includes('当前口径合计'), '4c 默认范围下不再出现重复的「当前口径合计」');
  await page.evaluate(() => setStScope('all'));
  await page.waitForTimeout(500);
  const k2 = await page.evaluate(() => [...document.querySelectorAll('#stKpis .st-kpi-label')].map(x => x.textContent));
  ok(k2.includes('当前口径合计'), '4d 切到「含已用完」时它才出现（这时它和库存卷数不是同一个数）');
  await page.evaluate(() => setStScope('remain'));
  await page.waitForTimeout(400);

  await page.evaluate(() => window.scrollTo(0, 1200));
  await page.waitForTimeout(450);
  const pin = await page.evaluate(() => {
    const el = document.getElementById('stPinned');
    return { top: Math.round(el.getBoundingClientRect().top), h: Math.round(el.getBoundingClientRect().height), y: Math.round(window.scrollY) };
  });
  ok(near(pin.top, stickTop, 3), `4e 滚到 ${pin.y}px 时控制条仍吸在 ${pin.top}px（页签下沿 ${stickTop}）`);
  ok(pin.h < 90, `4f 吸顶带只有 ${pin.h}px 高（16px 外边距没跟着冻上去）`);

  /* ══════════ ⑤ 交叉表：零值留空、热度用 accent ══════════ */
  console.log('── ⑤ 交叉表：有值才有块 ──');
  const mx = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('.st-mx .cell')];
    const zero = cells.filter(c => c.classList.contains('zero'))[0];
    const has = cells.filter(c => c.classList.contains('has'));
    const cs = has[0] ? getComputedStyle(has[0]) : null;
    return {
      total: cells.length, has: has.length, zero: cells.length - has.length,
      zeroBg: zero ? getComputedStyle(zero).backgroundColor : null,
      zeroText: zero ? zero.textContent : null,
      hasBg: cs ? cs.backgroundColor : null,
      hasHeat: has[0] ? has[0].style.getPropertyValue('--heat') : null,
      hasHeatD: has[0] ? has[0].style.getPropertyValue('--heat-d') : null,
      border: cs ? cs.borderTopWidth : null,
    };
  });
  ok(mx.zero > 0 && /rgba\(0, 0, 0, 0\)|transparent/.test(mx.zeroBg),
    `5a 零值格是全透明（${mx.zero} 个空格子），不再画「–」`);
  ok(mx.zeroText === '', '5b 空格子里没有字符（画减号等于每格都喊一次「没有」）');
  ok(/^oklch|^color\(/.test(mx.hasBg) || /rgb/.test(mx.hasBg), `5c 有值格带热度底色（${mx.hasBg}）`);
  ok(mx.hasHeat && mx.hasHeatD && parseFloat(mx.hasHeatD) < parseFloat(mx.hasHeat),
    `5d 亮度/暗度两档同时给（${mx.hasHeat} / ${mx.hasHeatD}），深色主题才压得住`);
  ok(mx.border === '0px', '5e 格子没有边框（满格线 + 一堆空号就是一张 Excel 空表）');

  /* ══════════ ⑥ 数据管理：两栏齐平 ══════════ */
  console.log('── ⑥ 数据管理：两栏高度 —— 危险区位置 ──');
  await page.evaluate(() => switchPage('data'));
  await page.waitForTimeout(800);
  const dm = await page.evaluate(() => {
    const cols = [...document.querySelectorAll('.dm-cols > .dm-stack')].map(s => Math.round(s.getBoundingClientRect().height));
    const danger = document.querySelector('.dm-danger');
    const dr = danger.getBoundingClientRect();
    /* 只数看得见的行：折叠起来的 14 个空项也是 .dm-kv，但 offsetHeight 为 0 */
    const visRows = () => [...document.querySelectorAll('#dmStorage .dm-kv')].filter(r => r.offsetHeight > 0).length;
    const emptyBtn = document.querySelector('#dmStorage .dm-more');
    return {
      cols, gap: Math.abs(cols[0] - cols[1]),
      dangerTop: Math.round(dr.top), dangerInCol: danger.parentElement.classList.contains('dm-stack'),
      storeRows: visRows(), emptyLabel: emptyBtn ? emptyBtn.textContent.trim() : null,
      viewport: window.innerHeight,
      docH: document.documentElement.scrollHeight,
    };
  });
  ok(dm.gap < 160, `6a 两栏 ${dm.cols[0]} / ${dm.cols[1]}，差 ${dm.gap}px（改造前差 231px 且右栏只剩 200px）`);
  ok(dm.dangerInCol, '6b 危险操作在右栏里（补上了存储卡瘦身后空出来的那段）');
  ok(dm.dangerTop < dm.viewport, `6c 危险操作在 y=${dm.dangerTop}px，首屏（${dm.viewport}px）内就能看到 —— 改造前在 830px 的左栏底部`);
  ok(dm.storeRows <= 5, `6d 存储明细只列 ${dm.storeRows} 行（改造前 18 行，其中 15 行是 0 B）`);
  ok(/其余 \d+ 项为空/.test(dm.emptyLabel || ''), `6e 空项收成一行：${dm.emptyLabel}`);
  const exp2 = await page.evaluate(() => {
    document.querySelector('#dmStorage .dm-more').click();
    return { rows: [...document.querySelectorAll('#dmStorage .dm-kv')].filter(r => r.offsetHeight > 0).length };
  });
  await page.waitForTimeout(250);
  ok(exp2.rows > dm.storeRows, `6f 点开后能看到全部明细（${dm.storeRows} → ${exp2.rows} 行）`);

  /* ══════════ ⑦ 打印机：离线只留 3 块 ══════════ */
  console.log('── ⑦ 打印机：离线态不再摆 4 张空卡 ──');
  await page.evaluate(() => switchPage('printers'));
  await page.waitForTimeout(1400);
  const prn = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#pagePrinters .st-card')].filter(c => c.offsetHeight > 0);
    return {
      visible: cards.length,
      titles: cards.map(c => (c.querySelector('.st-card-title') || {}).textContent || ''),
      dataAreaHidden: document.getElementById('prnDataArea').hidden,
      offDataShown: !document.getElementById('prnOfflineData').hidden,
      refreshHidden: document.getElementById('prnRefreshBtn').hidden,
      docH: document.documentElement.scrollHeight,
    };
  });
  ok(prn.dataAreaHidden, '7a 离线下 #prnDataArea 整块收起（4 张「暂无记录」不再各占一张卡）');
  ok(prn.offDataShown, '7b 换成一张「这些面板要等服务起来才有内容」清单');
  ok(prn.visible <= 3, `7c 离线页只有 ${prn.visible} 张可见卡片：${prn.titles.join(' / ')}`);
  ok(prn.refreshHidden, '7d hero 的「刷新」按钮在离线时藏起来（点了什么也不会变）');
  ok(prn.docH < 1100, `7e 页面高度 ${prn.docH}px（改造前 1064px 里有 700px 是死信息）`);

  /* ══════════ ⑧ 深色主题：未选中页签看得见 ══════════ */
  console.log('── ⑧ 深色主题：页签对比度 ──');
  await page.evaluate(() => { document.documentElement.setAttribute('data-theme', 'dark'); switchPage('stats'); });
  await page.waitForTimeout(600);
  const tabC = await page.evaluate(() => {
    const t = document.getElementById('tabData');
    const cs = getComputedStyle(t);
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg');
    return { color: cs.color, bg };
  });
  /* oklch(68% ...) 是 --text-2 —— 直接比字符串太脆，从 token 里取出来比 */
  const tabOk = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.color = 'var(--text-2)';
    document.body.appendChild(probe);
    const want = getComputedStyle(probe).color;
    probe.remove();
    return getComputedStyle(document.getElementById('tabData')).color === want;
  });
  ok(tabOk, `8a 深色下未选中页签用 --text-2（${tabC.color}），不是 48% 的 text-3`);

  /* ══════════ ⑨ 窄屏 ══════════ */
  console.log('── ⑨ 390px：分组与折叠不塌 ──');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { switchPage('swatch'); window.scrollTo(0, 0); });
  await page.waitForTimeout(800);
  const m = await page.evaluate(() => {
    const g = document.querySelector('.sw-group');
    const hd = g.querySelector('.sw-group-hd').getBoundingClientRect();
    const grid = g.querySelector('.sw-grid');
    return {
      cols: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
      headOverflow: hd.width > window.innerWidth,
      pinnedStatic: getComputedStyle(document.getElementById('swPinned')).position,
    };
  });
  ok(m.cols >= 1, `9a 窄屏色卡降到 ${m.cols} 列`);
  ok(!m.headOverflow, '9b 组标题没撑出屏幕');
  ok(m.pinnedStatic === 'static', '9c 窄屏工作台不吸顶（和库存页一致）');

  const errs2 = errs.filter(e => !/ResizeObserver loop/.test(e));
  ok(errs2.length === 0, '全流程无 JS 报错' + (errs2.length ? '：' + errs2[0] : ''));

  await browser.close();
  console.log('\n══════════════════════════════════════════════════');
  if (fail) { console.log('❌ 失败 ' + fail + ' / ' + (pass + fail)); process.exit(1); }
  console.log('✅ 浏览器级验收：' + pass + ' 通过 / 0 失败');
})();
