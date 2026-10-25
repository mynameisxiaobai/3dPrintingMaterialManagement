/* visual-spoolpop.js — 色系墙「无 hover 展开 + 行内面板 + 锚定浮层」浏览器级验收
   **非 CI**：需要 playwright-core + 已缓存的 chromium（jsdom 没有布局引擎，
   offsetTop / getBoundingClientRect 全 0，面板插入位置与浮层定位完全测不了）。
     NODE_PATH=C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules \
       node tests/visual-spoolpop.js
   覆盖：
   ① 鼠标停在卡头 1.5s → 不发生任何 class / 高度变化，不会弹出面板
   ② 鼠标停在迷你卷上 1.2s → 不弹浮层（浮层只认点击）
   ③ 点迷你卷 → 浮层出现，四边都在视口内，且贴在格子下方 8px
   ④ 滚到页面底部那一组 → 浮层自动翻到格子上方
   ⑤ 点外部 / Esc / 滚页面分别关闭；滚浮层内部不关
   ⑥ 编辑模式下点迷你卷 = 勾选，不弹浮层
   ⑦ 行内面板几何：插在该卡所在行的**下一行行首**、占满整行、同排其他卡不重排、关闭后复原
   纯逻辑与静态防回退断言见 tests/check-views.js。 */
'use strict';
const path = require('path');
const { chromium } = require('playwright-core');

const HTML = 'file:///' + path.join(__dirname, '..', 'web', 'filament-manager.html').replace(/\\/g, '/');
const EXEC = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };

/* 96 条数据 / 12 个色系各 8 条 —— 1280 宽下 4 列 → 3 行卡墙。
   行数够多才测得出「底部那组浮层翻到上方」和「滚动关闭」，
   每组 8 条正好等于 mini 标准档的 cap，卡片墙不会出现「还有 N 卷」。 */
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

const near = (a, b, tol) => Math.abs(a - b) <= (tol == null ? 1.5 : tol);

/* 每张卡的 offsetTop / offsetLeft / 高度 —— 判「同一行」「是否被重排」的唯一口径。
   不用 getBoundingClientRect：那玩意含 transform，卡片入场动画期间同行能差 6px。 */
const cardsGeo = page => page.evaluate(() =>
  [...document.querySelectorAll('#famView .fam-wall > .fam-grp')].map(g => ({
    fam: g.dataset.fam,
    top: Math.round(g.offsetTop),
    left: Math.round(g.offsetLeft),
    h: Math.round(g.offsetHeight),
  }))
);

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

  /* ── ① 悬停卡头不许有任何展开 ── */
  console.log('── ① hover 不展开 ──');
  const head = page.locator('#famView .fam-grp .fam-hd').nth(1);
  const hb = await head.boundingBox();
  const snap = () => page.evaluate(() => ({
    expanded: [...document.querySelectorAll('#famView .fam-grp.is-expanded')].length,
    panel: document.querySelectorAll('#famPanel').length,
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
  ok(afterHover.expanded === before.expanded && afterHover.panel === 0,
    `1a 悬停 1.5s 既不展开卡也不弹面板（${before.expanded} → ${afterHover.expanded} / panel ${afterHover.panel}）`);
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

  /* ── ⑦ 行内面板几何：插在「下一行行首」，其他卡不重排 ── */
  console.log('── ⑦ 行内面板几何 ──');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);

  const t0 = await cardsGeo(page);
  /* 点第 2 列那张卡 —— 这是「行中间插入」bug 的唯一回归网：
     若面板紧跟被点卡插入，同一行后面两张会被挤到面板下方，墙就散了。 */
  const pick = t0[1];
  const sameRow = t0.filter(c => c.top === pick.top);
  const afterInRow = sameRow.filter(c => c.left > pick.left);
  const below = t0.filter(c => c.top > pick.top);
  const rowBottom = Math.max(...sameRow.map(c => c.top + c.h));

  await page.locator(`#famView .fam-grp[data-fam="${pick.fam}"] .fam-hd`).click();
  await page.waitForTimeout(400);

  const panelGeo = await page.evaluate(() => {
    const wall = document.getElementById('famWall');
    const p = document.getElementById('famPanel');
    if (!p) return null;
    const wr = wall.getBoundingClientRect();
    const pr = p.getBoundingClientRect();
    return {
      top: Math.round(p.offsetTop), left: Math.round(p.offsetLeft),
      w: Math.round(pr.width), wallW: Math.round(wr.width),
      vLeft: Math.round(pr.left), vRight: Math.round(pr.right),
      vWallLeft: Math.round(wr.left), vWallRight: Math.round(wr.right),
      chips: p.querySelectorAll('.spool-chip').length,
      prev: p.previousElementSibling ? (p.previousElementSibling.dataset.fam || null) : null,
    };
  });
  ok(!!panelGeo, '7a 点卡 → 面板出现');
  ok(panelGeo && near(panelGeo.w, panelGeo.wallW, 2),
    `7b 面板占满整行宽（${panelGeo && panelGeo.w} vs wall ${panelGeo && panelGeo.wallW}）`);
  ok(panelGeo && near(panelGeo.vLeft, panelGeo.vWallLeft, 2) && near(panelGeo.vRight, panelGeo.vWallRight, 2),
    `7c 面板左右缘与墙对齐（${panelGeo && panelGeo.vLeft}..${panelGeo && panelGeo.vRight} vs ${panelGeo && panelGeo.vWallLeft}..${panelGeo && panelGeo.vWallRight}）`);
  ok(panelGeo && panelGeo.top >= rowBottom - 1,
    `7d 面板在该行下沿之后（panel.t=${panelGeo && panelGeo.top} ≥ row.bottom=${rowBottom}）`);

  const t1 = await cardsGeo(page);
  const stillInRow = afterInRow.filter(c => {
    const now = t1.find(x => x.fam === c.fam);
    return now && now.top === c.top;
  });
  ok(stillInRow.length === afterInRow.length,
    `7e 同排后面的 ${afterInRow.length} 张卡仍在原行（插到行中间会把它们甩到面板下方：${afterInRow.length - stillInRow.length} 张被挤走）`);

  const pushed = below.filter(c => {
    const now = t1.find(x => x.fam === c.fam);
    return now && now.top > c.top;
  });
  ok(pushed.length === below.length,
    `7f 下一行起的 ${below.length} 张卡整体下移（${pushed.length} 张被推开）`);

  ok(panelGeo && panelGeo.prev && sameRow.some(c => c.fam === panelGeo.prev),
    `7g 面板紧跟在「被点卡所在行的最后一张」之后（prev=${panelGeo && panelGeo.prev}）`);

  const cardChips = await page.locator(`#famView .fam-grp[data-fam="${pick.fam}"] .spool-chip`).count();
  ok(panelGeo && panelGeo.chips >= cardChips,
    `7h 面板里是全量（${panelGeo && panelGeo.chips} ≥ 卡内 ${cardChips}）`);
  ok(await page.evaluate(() => document.activeElement && document.activeElement.id === 'famPanel'),
    '7i 焦点进入面板（DOM 上隔了同排卡，按 Tab 走不到）');

  await page.keyboard.press('Escape');
  await page.waitForTimeout(350);
  ok(await page.evaluate(() => !document.getElementById('famPanel')), '7j Esc → 面板移除');
  const t2 = await cardsGeo(page);
  const restored = t0.every(c => {
    const now = t2.find(x => x.fam === c.fam);
    return now && now.top === c.top && now.left === c.left;
  });
  ok(restored, '7k 关闭后所有卡回到原位（top 与 left 全部复原）');
  ok(await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('fam-hd')),
    '7l 关闭后焦点回到卡头');

  await browser.close();
  console.log(`\n${fail === 0 ? '✅' : '❌'} 浏览器级验收：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
