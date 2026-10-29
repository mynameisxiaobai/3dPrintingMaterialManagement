/* visual-spoolpop.js — 色系砖墙「瀑布流打包 + 锚定浮层」浏览器级验收
   **非 CI**：需要 playwright-core + 已缓存的 chromium（jsdom 没有布局引擎，
   offsetTop / getBoundingClientRect 全 0，砖块坐标与浮层定位完全测不了）。
     NODE_PATH=C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules \
       node tests/visual-spoolpop.js
   覆盖：
   ① 鼠标停在砖头 1.5s → 不发生任何 class / 高度变化（没有 hover 展开）
   ② 鼠标停在迷你卷上 1.2s → 不弹浮层（浮层只认点击）
   ③ 点迷你卷 → 浮层出现，四边都在视口内，且贴在格子下方 8px
   ④ 滚到页面底部那一组 → 浮层自动翻到格子上方
   ⑤ 点外部 / Esc / 滚页面分别关闭；滚浮层内部不关
   ⑥ 编辑模式下点迷你卷 = 勾选，不弹浮层
   ⑦ 瀑布流几何：砖块互不重叠、列内无空洞、墙高 = 最高列底、全量渲染不截断、
      卷多的砖被加宽、缩窗后自动重排且仍然无重叠
   纯逻辑与静态防回退断言见 tests/check-views.js。 */
'use strict';
const path = require('path');
const { chromium } = require('playwright-core');

const HTML = 'file:///' + path.join(__dirname, '..', 'web', 'filament-manager.html').replace(/\\/g, '/');
const EXEC = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };

/* 12 个色系 × 8 条 + 红系额外 22 条 = 118 条。
   「红」凑到 30 条是刻意的：它按 1 列宽放会到 630px 高，必须触发「加宽到 2 列」，
   7e 验的就是这条判据；其余色系 8 条保持竖向，形成高低混排的瀑布墙。 */
const FAMS = [['#C12E1F', '红'], ['#F59042', '橙'], ['#8B5E34', '棕'], ['#F5D547', '黄'],
  ['#4CAF50', '绿'], ['#2EC4B6', '青'], ['#4A90D9', '蓝'], ['#9B59B6', '紫'],
  ['#F07FB0', '粉'], ['#F2F2F2', '白'], ['#9AA0A6', '灰'], ['#22262C', '黑']];
const SEED = [];
FAMS.forEach(([c, n], fi) => {
  for (let j = 0; j < 8; j++) {
    SEED.push({ id: fi * 8 + j + 1, name: n + '料 ' + (j + 1), brand: 'bambu',
      material: j % 2 ? 'PLA' : 'PETG', color: c, weight: 1000, qty: (j % 4) + 1, hasSpool: j % 3 !== 0 });
  }
});
for (let j = 9; j <= 30; j++) {
  SEED.push({ id: 1000 + j, name: '红料 ' + j, brand: 'esun', material: 'PLA',
    color: '#C12E1F', weight: 1000, qty: 1, hasSpool: true });
}

const near = (a, b, tol) => Math.abs(a - b) <= (tol == null ? 1.5 : tol);

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
    switchPage('inventory');
    setView('fam');
    renderAll();
    window.scrollTo(0, 0);
  }, SEED);
  await page.waitForTimeout(600);

  const chipSel = '#famView .spool-chip';
  console.log('色系卡数 =', await page.locator('#famView .fam-grp').count(),
    '/ 迷你卷数 =', await page.locator(chipSel).count());

  /* ── ① 悬停砖头不许有任何展开 ── */
  console.log('── ① hover 不展开 ──');
  const head = page.locator('#famView .fam-grp .fam-hd').nth(1);
  const hb = await head.boundingBox();
  const snap = () => page.evaluate(() => ({
    hits: [...document.querySelectorAll('#famView .fam-grp.is-hit')].length,
    h: document.querySelector('#famView').getBoundingClientRect().height,
  }));
  const before = await snap();
  await page.evaluate(() => {
    window.__flips = 0;
    [...document.querySelectorAll('#famView .fam-grp')].forEach(g => {
      new MutationObserver(m => { if (m.some(x => x.attributeName === 'class')) window.__flips++; })
        .observe(g, { attributes: true, attributeFilter: ['class'] });
    });
  });
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.waitForTimeout(1500);
  const afterHover = await snap();
  ok(afterHover.hits === before.hits, `1a 悬停 1.5s 不触发任何高亮/展开（${before.hits} → ${afterHover.hits}）`);
  ok(await page.evaluate(() => window.__flips) === 0,
    `1b 悬停期间 class 一次都没变（实测 ${await page.evaluate(() => window.__flips)} 次）`);
  ok(near(afterHover.h, before.h, 2), `1c 视图总高度不变（${before.h.toFixed(0)} → ${afterHover.h.toFixed(0)}）`);

  /* ── ② 悬停迷你卷也不弹浮层 ── */
  console.log('── ② hover 迷你卷不出浮层 ──');
  const c0 = page.locator(chipSel).nth(2);
  const cb = await c0.boundingBox();
  await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
  await page.waitForTimeout(1200);
  ok(await page.locator('#spoolPop').isHidden(), '2 悬停 1.2s 仍无浮层（浮层只认点击）');

  /* ── ③ 点击 → 浮层贴在下方 8px 且不出视口 ── */
  console.log('── ③ 锚定定位 ──');
  await page.mouse.click(cb.x + cb.width / 2, cb.y + cb.height / 2);
  await page.waitForTimeout(250);
  ok(await page.locator('#spoolPop').isVisible(), '3a 点击出现浮层');
  const geo = await page.evaluate(() => {
    const p = document.getElementById('spoolPop');
    const pr = p.getBoundingClientRect();
    const chip = p._anchor.getBoundingClientRect();
    return { p: { l: pr.left, t: pr.top, r: pr.right, b: pr.bottom, w: pr.width, h: pr.height },
             c: { l: chip.left, t: chip.top, r: chip.right, b: chip.bottom },
             vw: innerWidth, vh: innerHeight };
  });
  ok(geo.p.l >= 7 && geo.p.t >= 7 && geo.p.r <= geo.vw - 7 && geo.p.b <= geo.vh - 7,
    `3b 四边都在视口内（l=${geo.p.l.toFixed(0)} t=${geo.p.t.toFixed(0)} r=${geo.p.r.toFixed(0)} b=${geo.p.b.toFixed(0)}）`);
  ok(near(geo.p.t, geo.c.b + 8, 2), `3c 贴在格子下沿 +8px（chip.b=${geo.c.b.toFixed(0)} pop.t=${geo.p.t.toFixed(0)}）`);
  ok(geo.p.l >= 7 && geo.p.l <= geo.c.l + 1, '3d 左缘对齐格子左缘（且不越出视口）');

  /* ── ⑤ 关闭路径 ── */
  console.log('── ⑤ 关闭路径 ──');
  await page.mouse.click(geo.vw - 40, 40);
  await page.waitForTimeout(180);
  ok(await page.locator('#spoolPop').isHidden(), '5a 点页面空白 → 关闭');

  await page.mouse.click(cb.x + cb.width / 2, cb.y + cb.height / 2);
  await page.waitForTimeout(200);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(180);
  ok(await page.locator('#spoolPop').isHidden(), '5b Esc → 关闭');
  ok(await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('spool-chip')),
    '5c 关闭后焦点回到锚点迷你卷');

  await page.mouse.click(cb.x + cb.width / 2, cb.y + cb.height / 2);
  await page.waitForTimeout(200);
  /* 滚浮层内部：浮层内容一般不会溢出，这里人为造出内部滚动 */
  await page.evaluate(() => {
    const p = document.getElementById('spoolPop');
    p.style.maxHeight = '60px'; p.style.overflowY = 'auto';   // 人为造出内部滚动
    p.scrollTop = 20;
    p.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await page.waitForTimeout(180);
  ok(await page.locator('#spoolPop').isVisible(), '5d 浮层自身滚动不会把它关掉');
  await page.evaluate(() => { const p = document.getElementById('spoolPop'); p.style.maxHeight = ''; p.style.overflowY = ''; });

  /* 5e 需要页面真的能滚。先把视口压矮（3 行卡墙 + 上方 chrome 在 900 高下可能刚好不够），
     点开浮层后再缩窗口会被 resize 关掉，所以顺序必须是：缩窗口 → 重新取位置 → 点开 → 滚。 */
  await page.setViewportSize({ width: 1280, height: 560 });
  await page.waitForTimeout(300);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(150);
  const c1 = page.locator(chipSel).first();
  const c1b = await c1.boundingBox();
  await page.mouse.click(c1b.x + c1b.width / 2, c1b.y + c1b.height / 2);
  await page.waitForTimeout(220);
  ok(await page.locator('#spoolPop').isVisible(), '5e-0 缩窗口后仍能点开浮层');
  await page.evaluate(() => window.scrollBy(0, 120));
  await page.waitForTimeout(260);
  ok(await page.locator('#spoolPop').isHidden(), '5e 页面滚动 → 关闭（锚点位置已失效）');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(300);
  await page.evaluate(() => window.scrollTo(0, 0));

  /* ── ④ 底部那一组：浮层翻到上方 ── */
  console.log('── ④ 空间不足时翻到上方 ──');
  await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#famView .fam-grp')];
    cards[cards.length - 1].scrollIntoView({ block: 'end' });
    window.scrollBy(0, 40);
  });
  await page.waitForTimeout(400);
  const lastChip = page.locator('#famView .fam-grp').last().locator('.spool-chip').last();
  const lb = await lastChip.boundingBox();
  await page.mouse.click(lb.x + lb.width / 2, lb.y + lb.height / 2);
  await page.waitForTimeout(250);
  const geo2 = await page.evaluate(() => {
    const p = document.getElementById('spoolPop');
    const pr = p.getBoundingClientRect();
    const chip = p._anchor.getBoundingClientRect();
    return { pt: pr.top, pb: pr.bottom, ct: chip.top, cb: chip.bottom, vh: innerHeight };
  });
  ok(geo2.pb <= geo2.ct + 1, `4a 下方放不下 → 翻到格子上方（pop.b=${geo2.pb.toFixed(0)} ≤ chip.t=${geo2.ct.toFixed(0)}）`);
  ok(geo2.pt >= 7, '4b 翻上去后也没有越出视口顶部');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);

  /* ── ⑥ 编辑模式 ── */
  console.log('── ⑥ 编辑模式 ──');
  await page.evaluate(() => { window.scrollTo(0, 0); toggleEditMode(); });
  await page.waitForTimeout(300);
  const ec = page.locator(chipSel).first();
  const eb = await ec.boundingBox();
  await page.mouse.click(eb.x + eb.width / 2, eb.y + eb.height / 2);
  await page.waitForTimeout(220);
  ok(await page.locator('#spoolPop').isHidden(), '6a 编辑模式下点击不弹浮层');
  ok(await ec.evaluate(el => el.classList.contains('selected')), '6b 编辑模式下点击 = 勾选');
  ok(await ec.evaluate(el => !el.hasAttribute('aria-haspopup')), '6c 编辑模式下 chip 不是 dialog 触发器');
  await page.evaluate(() => toggleEditMode());
  await page.waitForTimeout(300);

  /* ── ⑦ 瀑布流几何：不重叠、列内无洞、墙高对齐、全量渲染、卷多的砖加宽 ── */
  console.log('── ⑦ 瀑布流几何 ──');
  await page.evaluate(() => { window.scrollTo(0, 0); });
  await page.waitForTimeout(300);

  const wallGeo = () => page.evaluate(() => {
    const wall = document.getElementById('famWall');
    const cards = [...wall.children].filter(e => e.classList.contains('fam-grp'));
    const list = cards.map(c => ({
      fam: c.dataset.fam, span: c.dataset.span,
      l: Math.round(c.offsetLeft), t: Math.round(c.offsetTop),
      w: Math.round(c.offsetWidth), h: Math.round(c.offsetHeight),
      n: c.querySelectorAll('.spool-chip').length,
    }));
    /* 两两重叠检测：矩形的边允许刚好相接，所以每边留 1px 容差 */
    let overlaps = [];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (a.l < b.l + b.w - 1 && b.l < a.l + a.w - 1 && a.t < b.t + b.h - 1 && b.t < a.t + a.h - 1) {
          overlaps.push(a.fam + '×' + b.fam);
        }
      }
    }
    /* 列内空洞：同列相邻两砖之间的竖向空档（正常只有 14px 的砖缝） */
    const cols = new Map();
    list.forEach(c => {
      if (!cols.has(c.l)) cols.set(c.l, []);
      cols.get(c.l).push(c);
    });
    let holes = [];
    cols.forEach(arr => {
      arr.sort((x, y) => x.t - y.t);
      for (let i = 1; i < arr.length; i++) {
        const gap = arr[i].t - (arr[i - 1].t + arr[i - 1].h) - 14;
        if (gap > 1.5) holes.push(arr[i - 1].fam + '↓' + arr[i].fam + ' ' + Math.round(gap) + 'px');
      }
    });
    return {
      list, overlaps, holes,
      cols: cols.size,
      wallH: Math.round(wall.getBoundingClientRect().height),
      maxBottom: Math.round(Math.max.apply(null, list.map(c => c.t + c.h))),
      chips: document.querySelectorAll('#famView .spool-chip').length,
      packed: wall.classList.contains('is-packed'),
    };
  });

  const g0 = await wallGeo();
  ok(g0.packed, '7a 墙已打包（.is-packed 已挂，坐标生效）');
  ok(g0.overlaps.length === 0, `7b 砖块互不重叠（${g0.cols} 列 / ${g0.list.length} 块，重叠 ${g0.overlaps.length} 对）`);
  ok(g0.holes.length === 0, `7c 每列内部没有空洞（${g0.holes.join('、') || '无'}）`);
  ok(near(g0.wallH, g0.maxBottom, 2), `7d 墙高 = 最高列底（${g0.wallH} vs ${g0.maxBottom}）`);
  ok(g0.chips === SEED.length, `7e 全量渲染：${SEED.length} 条 = ${g0.chips} 格（没有截断）`);

  const red = g0.list.find(c => c.fam === '红');
  const small = g0.list.filter(c => c.fam !== '红');
  ok(red && red.span === '2', `7f 卷数最多的红系（${red && red.n} 格）被加宽到 2 列（data-span=${red && red.span}）`);
  ok(small.every(c => c.span === '1'), '7g 其余色系仍是 1 列竖向（卷少的竖着放）');
  ok(red && red.w > 1.9 * small[0].w, `7h 宽砖宽度 ≈ 2 列（${red && red.w} vs 单列 ${small[0].w}）`);

  /* 左缘必须落在列网格上，且宽度只能是 1 列或 2 列 */
  const colW = Math.min.apply(null, g0.list.map(c => c.w));
  const pitch = colW + 14;
  const offGrid = g0.list.filter(c => {
    const k = c.l / pitch;
    const onLeft = Math.abs(k - Math.round(k)) * pitch < 1.5;
    const onWidth = Math.abs(c.w - colW) < 1.5 || Math.abs(c.w - (colW * 2 + 14)) < 1.5;
    return !onLeft || !onWidth;
  });
  ok(offGrid.length === 0,
    `7i 每块砖的 left/width 都对齐列网格（${offGrid.map(c => c.fam + '@' + c.l).join('、') || '全部对齐'}）`);

  /* 缩窗 → 重新打包（window resize + rAF），仍然不重叠、不出洞 */
  await page.setViewportSize({ width: 720, height: 900 });
  await page.waitForTimeout(500);
  const g1 = await wallGeo();
  ok(g1.cols <= 2, `7j 缩到 720px → 降到 ${g1.cols} 列（列数由容器宽度算，不写死）`);
  ok(g1.overlaps.length === 0 && g1.holes.length === 0,
    `7k 重排后仍然不重叠、列内无空洞（重叠 ${g1.overlaps.length} / 空洞 ${g1.holes.length}）`);
  ok(g1.list.every(c => c.span === '1'),
    `7l 双列时不再加宽（cols<3 → maxSpan 锁 1，${g1.list.map(c => c.span).join('')}）`);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(500);
  const g2 = await wallGeo();
  ok(g2.chips === SEED.length && g2.overlaps.length === 0 && g2.holes.length === 0,
    '7m 缩回原宽度 → 自动复原且几何仍正确');

  await browser.close();
  console.log(`\n${fail === 0 ? '✅' : '❌'} 浏览器级验收：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
