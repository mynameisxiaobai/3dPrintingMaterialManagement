/* visual-sticky.js — 吸顶栈 + 回到顶部 + 卡宽一致性 浏览器级验收
   **非 CI**：需要 playwright-core + 已缓存的 chromium（jsdom 没有布局引擎，
   getBoundingClientRect 全 0，sticky 是否真的吸住、卡宽是否真的相等，全测不了）。
     NODE_PATH=C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules \
       node tests/visual-sticky.js
   覆盖：
   ① 首屏：header / 页签 / 工作台 三层从上到下依次排开，不重叠
   ② 滚动 900px：三层都吸住且位置不变；下方内容确实从工作台背后滚过
   ③ 紧凑态：滚动后统计卡变矮（96 → ~34），且数字没丢
   ④ 回到顶部：滚动 900px 后按钮出现，点击回到 0，按钮自己隐藏；
      且整段逐帧采样只翻一次紧凑态、一次都不往回弹（翻多次就是用户报的「闪」）
   ⑤ 卡片密度：所有砖同一宽度、所有卡同一宽度（用户说的「大小统一」）
   ⑥ 迷你密度：卷多的色系仍然加宽（加宽判据没被卡片密度的限制顺手改死）
   ⑦ 色卡库页：它的工作台也吸得住，hero 正常滚走
   ⑧ 390px 窄屏：工作台不吸顶（手机不能吃掉半屏），页签仍吸顶
   纯逻辑与静态防回退断言见 tests/check-views.js。 */
'use strict';
const path = require('path');
const { chromium } = require('playwright-core');

const HTML = 'file:///' + path.join(__dirname, '..', 'web', 'filament-manager.html').replace(/\\/g, '/');
const EXEC = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };
const near = (a, b, tol) => Math.abs(a - b) <= (tol == null ? 1.5 : tol);

/* 12 色系 × 18 条 + 红系补到 40 条：一是让页面足够长（回落按钮的阈值是 320px，
   文档短于这个数就永远不该出现，会被误判成 bug），二是红系在迷你密度下必须加宽、
   在卡片密度下必须保持 1 列（两条判据互相独立，都要验）。 */
const FAMS = [['#C12E1F', '红'], ['#F59042', '橙'], ['#8B5E34', '棕'], ['#F5D547', '黄'],
  ['#4CAF50', '绿'], ['#2EC4B6', '青'], ['#4A90D9', '蓝'], ['#9B59B6', '紫'],
  ['#F07FB0', '粉'], ['#F2F2F2', '白'], ['#9AA0A6', '灰'], ['#22262C', '黑']];
const SEED = [];
FAMS.forEach(([c, n], fi) => {
  for (let j = 0; j < 18; j++) {
    SEED.push({ id: fi * 18 + j + 1, name: n + '料 ' + (j + 1), brand: ['bambu', 'esun', 'polymaker'][j % 3],
      material: ['PLA', 'PETG', 'ABS'][j % 3], color: c, weight: 1000, qty: (j % 4) + 1, hasSpool: j % 3 !== 0 });
  }
});
for (let j = 19; j <= 40; j++) {
  SEED.push({ id: 1000 + j, name: '红料 ' + j, brand: 'esun', material: 'PLA',
    color: '#C12E1F', weight: 1000, qty: 1, hasSpool: true });
}

/* 一根「尺子」：读出 header / 页签 / 工作台 的 top，以及三层是否互相压住。
   必须取「当前页」里的 .pinned —— 两个页面各有一个，querySelector 会命中文档顺序靠前的
   那个隐藏页，rect 全 0，断言会假通过。 */
const ruler = () => {
  const r = el => { const b = el.getBoundingClientRect(); return { t: Math.round(b.top), b: Math.round(b.bottom), h: Math.round(b.height) }; };
  const pinned = document.querySelector('.page.active .pinned');
  const stats = document.getElementById('statsBar');
  return {
    scrollY: Math.round(window.scrollY),
    header: r(document.querySelector('header')),
    tabs: r(document.querySelector('.page-tabs')),
    pinned: r(pinned),
    pinnedBottom: r(pinned).b,
    stats: r(stats),
    tight: pinned.classList.contains('is-tight'),
    stuck: pinned.classList.contains('is-stuck'),
    toTop: !!(document.getElementById('toTop') || {}).classList &&
      document.getElementById('toTop').classList.contains('show'),
    vars: {
      chrome: getComputedStyle(document.documentElement).getPropertyValue('--chrome-h').trim(),
      tabs: getComputedStyle(document.documentElement).getPropertyValue('--tabs-h').trim(),
    },
  };
};

/* 墙的几何：每块砖的宽/位置、每张卡片的宽（卡片密度下必须全部相等） */
const wallGeo = () => {
  const wall = document.getElementById('famWall');
  const bricks = [...wall.children].filter(e => e.classList.contains('fam-grp'));
  const widths = bricks.map(b => Math.round(b.offsetWidth));
  const spans = bricks.map(b => b.dataset.span);
  const cards = [...wall.querySelectorAll('.fam-cards > *')].map(c => Math.round(c.getBoundingClientRect().width));
  const uniq = a => [...new Set(a)];
  return {
    bricks: bricks.length,
    widthUniq: uniq(widths),
    spanUniq: uniq(spans),
    cardUniq: uniq(cards),
    cardCount: cards.length,
    cardMin: Math.min.apply(null, cards),
    cardMax: Math.max.apply(null, cards),
    cards: cards.slice(0, 8),
  };
};

(async () => {
  const browser = await chromium.launch({
    headless: true, executablePath: EXEC,
    args: ['--allow-file-access-from-files'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', e => console.log('  PAGEERROR:', e.message));
  await page.goto(HTML);
  await page.waitForTimeout(1200);
  await page.evaluate(seed => {
    data = seed.map(normalizeItem);
    try { localStorage.setItem('fmTheme', 'light'); } catch (e) {}
    document.documentElement.setAttribute('data-theme', 'light');
    switchPage('inventory');
    setView('fam');
    renderAll();
    window.scrollTo(0, 0);
  }, SEED);
  await page.waitForTimeout(600);

  /* ── ① 首屏三层顺序 ── */
  console.log('── ① 首屏：三层依次排开 ──');
  const a = await page.evaluate(ruler);
  ok(a.header.t === 0, `1a header 在最顶（top=${a.header.t}）`);
  /* 首屏三层都在文档流里，页签上面还有 main 的上内边距，所以是「依次在下方」而不是紧贴 */
  ok(a.tabs.t > a.header.b, `1b 页签在 header 下方（tabs.t=${a.tabs.t} > header.b=${a.header.b}）`);
  ok(a.pinned.t >= a.tabs.b - 1, `1c 工作台在页签下方（pinned.t=${a.pinned.t} tabs.b=${a.tabs.b}）`);
  ok(a.vars.chrome !== '' && a.vars.tabs !== '', `1d 两个高度变量已实测写入（chrome=${a.vars.chrome} tabs=${a.vars.tabs}）`);
  ok(!a.tight && !a.stuck, '1e 首屏不是紧凑态、也没有分层阴影');
  ok(!a.toTop, '1f 首屏不显示回到顶部按钮');

  /* 吸顶后的理论位置：header + 页签 + 缝隙。这个数只能从 CSS 变量算，写死就失去意义 */
  const stickTop = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const px = n => parseFloat(cs.getPropertyValue(n));
    return Math.round(px('--chrome-h') + px('--tabs-h') + px('--tabs-gap'));
  });

  /* ── ② 滚动后三层吸住 ── */
  console.log('── ② 滚动 900px：三层都吸住 ──');
  await page.evaluate(() => window.scrollTo(0, 1200));
  await page.waitForTimeout(450);
  const b = await page.evaluate(ruler);
  /* 文档有多长就滚到底，不写死目标值：写死 900 会因夹具变短而假失败 */
  ok(b.scrollY >= 700, `2a 确实滚下去了（scrollY=${b.scrollY}）`);
  ok(b.header.t === 0, `2b header 仍贴在 0（top=${b.header.t}）`);
  ok(near(b.tabs.t, b.header.b, 1.5), `2c 页签仍贴在 header 底（tabs.t=${b.tabs.t}）`);
  ok(near(b.pinned.t, stickTop, 1.5),
    `2d 工作台确实吸住了：t 从 ${a.pinned.t} 变成 ${b.pinned.t}，等于「header+页签+缝隙」= ${stickTop}`);
  ok(b.stuck, '2e 吸住后加上了分层阴影（is-stuck）');

  /* 内容确实从工作台背后滚过：砖墙的第一块砖此刻已经在工作台上方 */
  const overlap = await page.evaluate(() => {
    const wall = document.getElementById('famWall');
    const first = wall.querySelector('.fam-grp');
    const pin = document.querySelector('.pinned');
    return {
      firstTop: Math.round(first.getBoundingClientRect().top),
      pinBottom: Math.round(pin.getBoundingClientRect().bottom),
    };
  });
  ok(overlap.firstTop < overlap.pinBottom,
    `2f 内容确实在往上滚（首砖 top=${overlap.firstTop} < 工作台底 ${overlap.pinBottom}）—— 这就是「冻结」的意义`);

  /* ── ③ 紧凑态 ── */
  console.log('── ③ 紧凑态：统计卡压成一行 ──');
  ok(b.tight, '3a 滚动后进入紧凑态');
  ok(b.stats.h < a.stats.h - 40, `3b 统计区变矮（${a.stats.h}px → ${b.stats.h}px）`);
  const labels = await page.evaluate(() => [...document.querySelectorAll('.pinned .stat-card')]
    .map(c => (c.textContent || '').replace(/\s+/g, ' ').trim()));
  ok(labels.length === 5 && labels.every(s => s.length > 1), `3c 5 张卡的「标签 + 数字」都还在（${labels[2]}）`);
  ok(labels.some(s => /耗材总数/.test(s)) && labels.some(s => /kg/.test(s)),
    '3d 标签没有被压掉（删了标签只剩数字就不知道是什么了）');

  /* ── ④ 回到顶部 ── */
  console.log('── ④ 回到顶部 ──');
  ok(b.toTop, '4a 滚过 320px 后按钮出现');
  const btnBox = await page.evaluate(() => {
    const el = document.getElementById('toTop');
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return { w: Math.round(r.width), h: Math.round(r.height), right: Math.round(innerWidth - r.right),
      bottom: Math.round(innerHeight - r.bottom), vis: cs.visibility, op: Number(cs.opacity) };
  });
  ok(btnBox.w >= 40 && btnBox.w === btnBox.h, `4b 是 42px 圆形按钮（${btnBox.w}×${btnBox.h}）`);
  ok(btnBox.right < 60 && btnBox.bottom < 60, `4c 贴在右下角（右 ${btnBox.right}px / 下 ${btnBox.bottom}px）`);
  ok(btnBox.vis === 'visible' && btnBox.op > 0.9, '4d 可见且不透明（visibility 而不是 display）');

  /* 回顶过程逐帧采样。用户报的「点回顶网页会闪」就是这里：紧凑态一翻转，.pinned
     高度就变 ~65px，滚动锚定把 scrollY 反向补偿回去，判定又翻回来 —— 在阈值附近
     来回横跳，每跳一次内容位移 65px。所以断言「整段只翻一次 + 没有正向回弹」。 */
  await page.evaluate(() => window.scrollTo(0, 1500));
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const pin = document.querySelector('.page.active .pinned');
    window.__ft = []; window.__ftStop = false;
    const tick = () => {
      window.__ft.push([Math.round(window.scrollY), pin.classList.contains('is-tight') ? 1 : 0]);
      if (!window.__ftStop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.click('#toTop');
  await page.waitForTimeout(1500);
  const flight = await page.evaluate(() => { window.__ftStop = true; return window.__ft; });
  const flips = [], backs = [];
  for (let i = 1; i < flight.length; i++) {
    if (flight[i][1] !== flight[i - 1][1]) flips.push(flight[i][0]);
    if (flight[i][0] - flight[i - 1][0] > 2) backs.push(`${flight[i - 1][0]}→${flight[i][0]}`);
  }
  ok(flight.length > 30, `4e 采到 ${flight.length} 帧（够判断闪不闪）`);
  ok(flips.length === 1, `4f 全程只翻转一次紧凑态（翻转点 y=${flips.join(',') || '无'}）`);
  ok(backs.length === 0, `4g 上滚途中一次都没往回弹（${backs.join(' ') || '无'}）`);
  ok(await page.evaluate(() => pinDelta) > 60, '4h 迟滞宽度用的是实测高度差，不是猜的数');
  await page.waitForTimeout(200);
  const c = await page.evaluate(ruler);
  ok(c.scrollY <= 2, `4i 点击后回到顶部（scrollY=${c.scrollY}）`);
  ok(!c.toTop, '4j 回到顶部后按钮自己藏起来');
  ok(!c.tight && !c.stuck, '4k 顶部后紧凑态与阴影都撤掉');

  /* ── ⑤ 卡片密度：所有卡同宽 ── */
  console.log('── ⑤ 卡片密度：大小统一 ──');
  await page.evaluate(() => { setFamDensity('card'); window.scrollTo(0, 0); });
  await page.waitForTimeout(700);
  const g5 = await page.evaluate(wallGeo);
  ok(g5.spanUniq.length === 1 && g5.spanUniq[0] === '1',
    `5a 所有砖都是 1 列宽（span=${g5.spanUniq.join(',')}）—— 卷多的也不加宽`);
  ok(g5.widthUniq.length === 1, `5b 所有砖同宽（${g5.widthUniq.join(' / ')}px）`);
  ok(g5.cardUniq.length === 1 && g5.cardCount > 60,
    `5c 所有卡片同宽：${g5.cardCount} 张卡只有 ${g5.cardUniq.length} 种宽度（${g5.cardUniq.join(' / ')}px）`);

  /* ── ⑥ 迷你密度：加宽判据还活着 ── */
  console.log('── ⑥ 迷你密度：卷多的仍然加宽 ──');
  await page.evaluate(() => { setFamDensity('mini'); window.scrollTo(0, 0); });
  await page.waitForTimeout(700);
  const g6 = await page.evaluate(wallGeo);
  ok(g6.spanUniq.includes('2'), `6a 红系 40 卷被加宽到 2 列（span 集合：${g6.spanUniq.join(',')}）`);
  /* 迷你格子是「按行均分」，砖宽 385→785 只是从 2 列变 5 列，格子宽度只差十几个像素；
     卡片是「按砖整张缩放」，同样的加宽会让卡宽差 59%。所以只有卡片密度需要禁加宽。 */
  const spread = (g6.cardMax - g6.cardMin) / g6.cardMax;
  ok(spread < 0.25,
    `6b 迷你密度加宽后格子宽度只差 ${(spread * 100).toFixed(0)}%（${g6.cardMin}~${g6.cardMax}px），肉眼仍是一套尺寸`);

  /* ── ⑦ 色卡库页 ── */
  console.log('── ⑦ 色卡库：工作台也吸住 ──');
  await page.evaluate(() => { switchPage('swatch'); window.scrollTo(0, 0); });
  await page.waitForTimeout(900);
  const s0 = await page.evaluate(ruler);
  await page.evaluate(() => window.scrollTo(0, 900));
  await page.waitForTimeout(450);
  const s1 = await page.evaluate(ruler);
  ok(s1.scrollY > 800, `7a 滚下去了（scrollY=${s1.scrollY}）`);
  /* 首屏它排在 hero 下面（358px），滚上去之后被吸在页签底下（= stickTop） */
  ok(near(s1.pinned.t, stickTop, 2) && s1.pinned.t < s0.pinned.t,
    `7b 搜索/筛选条吸住了（从 hero 下面 ${s0.pinned.t}px 收到 ${s1.pinned.t}px = stickTop ${stickTop}）`);
  /* 色卡库的 hero 已并入统一的 .st-hero（原来是独立的 .sw-hero） */
  const heroGone = await page.evaluate(() => Math.round(document.querySelector('#pageSwatch .st-hero').getBoundingClientRect().bottom));
  ok(heroGone < 0, `7c hero 正常滚走（bottom=${heroGone} < 0）—— 介绍文案不该占着冻结位`);
  /* 色卡库没有统计卡，紧凑态不该把它压变形 */
  const swToolbarH = await page.evaluate(() => Math.round(document.querySelector('.sw-toolbar').getBoundingClientRect().height));
  ok(swToolbarH > 30, `7d 色卡库的工作台在紧凑态下没被压坏（高 ${swToolbarH}px）`);

  /* ── ⑧ 窄屏 ── */
  console.log('── ⑧ 390px：工作台不吸顶、页签还吸 ──');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { switchPage('inventory'); setView('fam'); window.scrollTo(0, 0); });
  await page.waitForTimeout(700);
  const m0 = await page.evaluate(ruler);
  await page.evaluate(() => window.scrollTo(0, 900));
  await page.waitForTimeout(450);
  const m1 = await page.evaluate(ruler);
  ok(m1.pinned.t < m0.pinned.t - 100,
    `8a 窄屏工作台跟着滚走（${m0.pinned.t} → ${m1.pinned.t}），没冻结`);
  ok(near(m1.tabs.t, m1.header.b, 2), `8b 页签仍然吸在 header 下（tabs.t=${m1.tabs.t}）`);
  ok(m1.header.h > 70, `8c header 在窄屏换行变高（${m1.header.h}px）—— 所以高度必须实测`);
  ok(m1.toTop, '8d 窄屏的回到顶部按钮也在');

  await browser.close();
  console.log('\n══════════════════════════════════════════════════');
  if (fail) { console.log(`❌ 浏览器级验收：${pass} 通过 / ${fail} 失败`); process.exit(1); }
  console.log(`✅ 浏览器级验收：${pass} 通过 / 0 失败`);
})().catch(e => { console.error(e); process.exit(1); });
