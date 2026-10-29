/* visual-cardfx.js — 耗材卡片色块「悬停洪水」的浏览器级验收
   运行：node tests/visual-cardfx.js
   不进 npm test（要真 chromium + WebGL），与 visual-tabs / visual-sticky 同级手动跑。

   为什么必须在浏览器里做：jsdom 没有 WebGL、没有布局引擎，给不出「静止态真的全透明」
   「满程真的盖住四个角」「两张卡复用同一个 canvas 节点」这些结论。

   headless 的 WebGL 走 ANGLE/SwiftShader，Chrome 131+ 需要显式 --enable-unsafe-swiftshader，
   否则 getContext('webgl') 直接返回 null，整套测试会静默退化成「只验证降级路径」。
   所以第 3 条断言是硬门槛：拿不到 gl 就报失败，不跳过。
*/
'use strict';

const path = require('path');
const { chromium } = require('playwright-core');

const HTML = 'file:///' + path.join(__dirname, '..', 'web', 'filament-manager.html').replace(/\\/g, '/');
const EXEC = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe';

let pass = 0, fail = 0;
const fails = [];
const ok = (c, m) => {
  if (c) { pass++; console.log('  ✓ ' + m); }
  else { fail++; fails.push(m); console.log('  ✗ ' + m); }
};

/* 24 张卡：够横扫，色相也够杂（白 / 近黑 / 灰 / 高饱和都要出现） */
const PALETTE = ['#C12E1F', '#FFFFFF', '#101014', '#808080', '#F5761A', '#1E5BD6', '#5BD6A8', '#F2E8D5'];
const SEED = Array.from({ length: 24 }, (_, i) => ({
  id: i + 1,
  name: '色卡 ' + (i + 1),
  brand: ['拓竹', 'ESUN', 'polymaker'][i % 3],
  material: ['PLA', 'PETG', 'ABS'][i % 3],
  color: PALETTE[i % PALETTE.length],
  weight: 1000,
  qty: i % 3 === 0 ? 0 : 2,
  hasSpool: i % 4 !== 0,
  tags: i % 5 === 0 ? ['哑光'] : [],
}));

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: EXEC,
    args: ['--allow-file-access-from-files', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));

  const boot = async (url) => {
    await page.goto(url || (HTML + '?cardfx=1'));
    await page.waitForTimeout(1200);
    await page.evaluate(seed => {
      document.documentElement.setAttribute('data-theme', 'dark');
      data = seed.map(normalizeItem);
      switchPage('inventory');
      setView('grid');
      renderAll();
      window.scrollTo(0, 0);
    }, SEED);
    await page.waitForTimeout(500);
  };

  /* 第 idx 张卡的色块中心（页面坐标；卡片在首屏，不滚动） */
  const swatchBox = idx => page.evaluate(i => {
    const card = document.querySelectorAll('#gridView .filament-card')[i];
    if (!card) return null;
    const r = card.querySelector('.card-swatch').getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, id: card.dataset.id };
  }, idx);

  const hover = async idx => {
    const b = await swatchBox(idx);
    await page.mouse.move(b.x + b.w / 2, b.y + b.h / 2);
    return b;
  };
  const fx = expr => page.evaluate(e => {
    const api = window.__cardFx;
    return eval(e);
  }, expr);

  console.log('\n── 一、单例与上下文 ──');

  await boot();
  ok(await page.evaluate(() => document.querySelectorAll('canvas').length) === 1,
    '1.1 启动后文档里只有 1 个 canvas');
  ok(await page.evaluate(() => {
    const c = document.querySelector('canvas');
    return !!c && c.parentElement.className.indexOf('card-fx-host') >= 0;
  }), '1.2 静止态停在 .card-fx-host（不在任何卡片里 → 色块与改造前逐像素一致）');

  const b0 = await hover(0);
  await page.waitForTimeout(120);
  const glInfo = await page.evaluate(() => {
    const gl = window.__cardFx.gl;
    if (!gl) return null;
    return { lost: gl.isContextLost(), renderer: gl.getParameter(gl.RENDERER), ver: gl.getParameter(gl.VERSION) };
  });
  ok(glInfo && !glInfo.lost, '1.3 拿到了可用的 WebGL 上下文（拿不到就说明 swiftshader 没放行，不能静默跳过）');
  if (glInfo) console.log('     renderer: ' + glInfo.renderer + ' / ' + glInfo.ver);

  console.log('\n── 二、进入与进度曲线 ──');

  const att = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    return {
      parent: c.parentElement.className,
      cardId: c.closest('.filament-card') ? c.closest('.filament-card').dataset.id : null,
      canvasCount: document.querySelectorAll('canvas').length,
    };
  });
  ok(att.parent.indexOf('card-swatch') >= 0, '2.1 悬停后 canvas 被移进那张卡的 .card-swatch');
  ok(att.cardId === b0.id, `2.2 进的是被悬停那张卡（id ${att.cardId} = ${b0.id}）`);
  ok(att.canvasCount === 1, '2.3 移进去之后文档里仍然只有 1 个 canvas');

  const p0 = await page.evaluate(() => window.__cardFx.prog);
  await page.waitForTimeout(100);
  const p1 = await page.evaluate(() => window.__cardFx.prog);
  await page.waitForTimeout(200);
  const p2 = await page.evaluate(() => window.__cardFx.prog);
  await page.waitForTimeout(420);
  const p3 = await page.evaluate(() => ({
    prog: window.__cardFx.prog, state: window.__cardFx.state,
  }));
  ok(p0 <= p1 && p1 <= p2 && p2 <= p3.prog,
    `2.4 进度单调不减：${p0.toFixed(2)} → ${p1.toFixed(2)} → ${p2.toFixed(2)} → ${p3.prog.toFixed(2)}`);
  ok(p1 > 0.15 && p1 < 1, `2.5 100ms 时确实在漫开途中（${p1.toFixed(2)}），不是瞬间铺满`);
  ok(p3.prog >= 0.99 && p3.state === 'flowing', '2.6 700ms 后满程且转入 flowing');

  console.log('\n── 三、逐像素：静止全透明 / 满程覆盖 / 波前有噪声 ──');

  const s0 = await page.evaluate(() => window.__cardFx.freeze(0));
  ok(s0 && s0.alphaMean === 0 && s0.alphaMax === 0, '3.1 进度 0 时整帧全透明（逐像素 alpha 全 0）');
  ok(s0 && s0.corners.every(v => v === 0), '3.2 四角也是 0（不是"中心透明、边缘有残留"）');

  const s45 = await page.evaluate(() => window.__cardFx.freeze(0.45));
  ok(s45 && s45.bins > 30,
    `3.3 波前是碎的而不是干净圆弧（0.45 时 alpha 有 ${s45 ? s45.bins : 0} 档不同取值）`);
  ok(s45 && s45.corners.every(v => v < 210),
    `3.4 0.45 时还没盖到四角（${s45 ? s45.corners.join('/') : '-'}）`);

  const s100 = await page.evaluate(() => window.__cardFx.freeze(1));
  ok(s100 && s100.alphaMean > 0.75, `3.5 满程时画布被填满（平均 alpha ${s100 ? s100.alphaMean.toFixed(2) : '-'}）`);
  ok(s100 && s100.corners.every(v => v >= 200),
    `3.6 满程时四个角都被盖住（${s100 ? s100.corners.join('/') : '-'}）`);
  ok(s100 && s100.alphaMax >= 0.85, `3.7 最浓处留出了原色的余量（alphaMax ${s100 ? s100.alphaMax.toFixed(2) : '-'}，不是 1.0 硬盖）`);

  console.log('\n── 四、截图：像素确实变了，且静止态与"没有 canvas"完全一致 ──');

  /* 先把"悬停本身引起的视觉变化"（操作条淡入、卡片抬 1px、边框亮一档）全部冻住，
     否则截图差的是这些，而不是洪水层。 */
  await page.addStyleTag({
    content: '.card-edit-overlay{display:none!important}'
      + ' #gridView .filament-card{transform:none!important}'
      + ' #gridView .filament-card:hover{border-color:var(--border)!important}',
  });
  /* 打上 id，第四节验完就摘掉 —— 操作条被 display:none 之后，第八节点不到按钮 */
  await page.evaluate(() => {
    const all = document.querySelectorAll('style');
    all[all.length - 1].id = 'fx-isolate';
  });
  const clip = { x: b0.x, y: b0.y, width: b0.w, height: Math.round(b0.h * 0.35) };
  await page.waitForTimeout(300);            // 等 .card-edit-overlay 的 0.15s 淡入走完

  /* 注意：比的是像素，不是 PNG 字节。同一画面两次截图压缩结果可能不同，sha1 会假失败。 */
  const shot = async () => {
    const b64 = (await page.screenshot({ clip })).toString('base64');
    return page.evaluate(async s => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + s;
      await img.decode();
      const c = document.createElement('canvas');     // 不挂 DOM，不影响 canvas 计数
      c.width = img.width; c.height = img.height;
      const x = c.getContext('2d');
      x.drawImage(img, 0, 0);
      return Array.from(x.getImageData(0, 0, c.width, c.height).data);
    }, b64);
  };
  const diffStat = (a, b) => {
    let max = 0, sum = 0, n = 0;
    for (let i = 0; i < a.length; i += 4) {
      for (let k = 0; k < 3; k++) {
        const d = Math.abs(a[i + k] - b[i + k]);
        if (d > max) max = d;
        sum += d; n++;
      }
    }
    return { max, mean: sum / n };
  };

  await page.evaluate(() => window.__cardFx.freeze(0));   // 基线必须是"完全透明"这一帧
  const px0 = await shot();
  await page.evaluate(() => window.__cardFx.freeze(0.9));
  const px90 = await shot();
  const dOn = diffStat(px0, px90);
  ok(dOn.mean > 0.5, `4.1 冻结在 90% 时色块像素确实变了（平均差 ${dOn.mean.toFixed(1)} / 最大 ${dOn.max}）`);

  await page.evaluate(() => window.__cardFx.detach());
  const pxNone = await shot();
  const dOff = diffStat(px0, pxNone);
  ok(dOff.max <= 1, `4.2 收起 canvas 后与"完全透明"逐像素相同（最大差 ${dOff.max}）——静止态没有任何常驻痕迹`);

  /* 撤掉隔离样式：操作条要能重新显示，否则第八节点不到按钮 */
  await page.evaluate(() => {
    const s = document.getElementById('fx-isolate');
    if (s) s.remove();
  });

  console.log('\n── 五、离开与回收 ──');

  await page.mouse.move(4, 4);
  await page.waitForTimeout(460);
  const left = await page.evaluate(() => ({
    prog: window.__cardFx.prog,
    state: window.__cardFx.state,
    parent: document.querySelector('canvas').parentElement.className,
    canvasCount: document.querySelectorAll('canvas').length,
  }));
  ok(left.prog === 0 && left.state === 'idle', `5.1 离开 460ms 后归零并回到 idle（${left.state} / ${left.prog}）`);
  ok(left.parent.indexOf('card-fx-host') >= 0, '5.2 canvas 已收回隐藏宿主');
  ok(left.canvasCount === 1, '5.3 全程没有多建一个画布');

  console.log('\n── 六、复用同一个节点 ──');

  const nodeA = await page.evaluateHandle(() => document.querySelector('canvas'));
  await hover(1);
  await page.waitForTimeout(200);
  const same = await page.evaluate(n => n === document.querySelector('canvas'), nodeA);
  ok(same, '6.1 换成另一张卡，复用同一个 canvas 节点（不是每卡新建）');
  const creates = await page.evaluate(() => window.__cardFx.creates);
  ok(creates === 1, `6.2 上下文只创建过 1 次（creates=${creates}）`);

  console.log('\n── 七、重渲染冲掉后的恢复 ──');

  const before = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    return { cardId: c.closest('.filament-card') ? c.closest('.filament-card').dataset.id : null };
  });
  errs.length = 0;
  await page.evaluate(() => renderAll());
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    const card = c.closest('.filament-card');
    return {
      canvasCount: document.querySelectorAll('canvas').length,
      parent: c.parentElement.className,
      cardId: card ? card.dataset.id : null,
      state: window.__cardFx.state,
    };
  });
  ok(errs.length === 0, '7.1 悬停中 renderAll 不抛错');
  ok(after.canvasCount === 1, '7.2 重建后仍然只有 1 个 canvas');
  ok(after.parent.indexOf('card-swatch') >= 0 && after.cardId === before.cardId,
    `7.3 鼠标没动也自己找回了同一张卡（before=${before.cardId} after=${after.cardId} parent=${after.parent}）`);
  ok(after.state === 'flowing', `7.4 续上满程而不是重播开场（state=${after.state}）`);

  /* 再确认重建后依然能正常离开 */
  await page.mouse.move(4, 4);
  await page.waitForTimeout(460);
  ok(await page.evaluate(() => window.__cardFx.state) === 'idle', '7.5 重建后的实例照常能收');

  console.log('\n── 八、不挡交互 ──');

  const bi = await hover(2);
  await page.waitForTimeout(260);
  const beforeQty = await page.evaluate(id => data.find(x => String(x.id) === String(id)).qty, bi.id);
  await page.click('#gridView .filament-card:nth-child(3) .card-action-btn.finish', { force: false })
    .catch(() => {});
  await page.waitForTimeout(200);
  const afterQty = await page.evaluate(id => {
    const d = data.find(x => String(x.id) === String(id));
    return d ? d.qty : null;
  }, bi.id);
  ok(afterQty !== beforeQty,
    `8.1 洪水层不吃指针，卡片上的「用完」按钮照常可点（qty ${beforeQty} → ${afterQty}）`);

  console.log('\n── 九、横扫 20 张 ──');

  await page.mouse.move(4, 4);
  await page.waitForTimeout(400);
  errs.length = 0;
  for (let i = 0; i < 20; i++) {
    const b = await swatchBox(i);
    await page.mouse.move(b.x + b.w / 2, b.y + b.h / 2, { steps: 2 });
    await page.waitForTimeout(75);
  }
  const swept = await page.evaluate(() => ({
    creates: window.__cardFx.creates,
    lost: window.__cardFx.gl ? window.__cardFx.gl.isContextLost() : true,
    canvasCount: document.querySelectorAll('canvas').length,
  }));
  ok(swept.creates === 1, `9.1 扫过 20 张卡只建过 1 次上下文（${swept.creates}）`);
  ok(!swept.lost, '9.2 上下文没有丢失');
  ok(swept.canvasCount === 1, '9.3 画布数恒为 1');
  ok(errs.length === 0, '9.4 横扫过程无 JS 报错');

  console.log('\n── 十、prefers-reduced-motion ──');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await boot();
  await hover(0);
  await page.waitForTimeout(400);
  const rm = await page.evaluate(() => ({
    state: window.__cardFx.state,
    parent: document.querySelector('canvas').parentElement.className,
    prog: window.__cardFx.prog,
  }));
  ok(rm.state === 'idle' && rm.prog === 0 && rm.parent.indexOf('card-fx-host') >= 0,
    '10.1 系统要求减少动效时彻底不做（不是调快），canvas 停在宿主里');

  await page.emulateMedia({ reducedMotion: 'no-preference' });

  ok(errs.length === 0, '全流程无 JS 报错');

  await browser.close();
  console.log('\n══════════════════════════════════════════════════');
  if (fail) {
    console.log('❌ 失败 ' + fail + ' / ' + (pass + fail));
    fails.slice(0, 20).forEach(f => console.log('   · ' + f));
    process.exit(1);
  }
  console.log('✅ 浏览器级验收：' + pass + ' 通过 / 0 失败');
})();
