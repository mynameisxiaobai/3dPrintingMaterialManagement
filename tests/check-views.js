/* check-views.js — 三种视图（网格 / 列表 / 色系墙）+ 默认视图偏好
   运行：node tests/check-views.js
   不联网，fetch 永不 resolve（agent 视为离线）。

   覆盖：首屏默认视图、fmDefaultView 的读写（裸字符串，不能走 lsGet）、
         色系分组的汇总数字（卷数 / 色数 / 克重 / 低库存）、色带段数与权重、
         瀑布流砖墙（全量渲染不截断 / 加宽判据 / 空洞判据 / 绝对定位的降级路径）、
         颜色筛选与统计页跳转、编辑模式与勾选联动（含迷你卷）、
         密度偏好、迷你卷详情浮层（锚定浮层 #spoolPop）、
         以及「不许退回 hover 展开」「不许复活截断 + 面板」「不许复活折叠状态机」的防回退断言。
   两个必须绕开的坑见 check-match.js 头部注释（http:// url、w.eval）。
   注意：jsdom 没有布局引擎，packFamWall 会因为 clientWidth=0 直接返回 ——
   涉及真实坐标的验收在 tests/visual-spoolpop.js 里做。
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
  if (sa === sb) pass++;
  else { fail++; fails.push(n + '  得到 ' + sa + ' 期望 ' + sb); console.log('  ✗ ' + n + '  得到 ' + sa + ' 期望 ' + sb); }
}

/* 起一个实例；preset 是「首屏之前就该在 localStorage 里」的键值 */
function boot(preset) {
  const dom = new JSDOM(SRC, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'http://localhost/filament-manager.html',
    beforeParse(w) {
      w.fetch = () => new Promise(() => {});
      w.confirm = () => true;
      w.alert = () => {};
      w.onerror = () => {};
      if (preset) {
        Object.keys(preset).forEach(k => {
          try { w.localStorage.setItem(k, preset[k]); } catch (e) { /* 忽略 */ }
        });
      }
    },
  });
  return dom.window;
}

/* 固定夹具：3 卷红（两种红）、2 卷蓝、1 条白色 0 卷、1 卷黑（低余量）
   期望：红 qty 6 / grams 4500 / 2 色；蓝 2 / 2000 / 1；白 0 / 0 / 1；黑 1 / 1000 / 1 且 low=1 */
const SEED = [
  { id: 1, name: '红A', brand: '测试', material: 'PLA', color: '#C12E1F', weight: 1000, qty: 2 },
  { id: 2, name: '红B', brand: '测试', material: 'PLA', color: '#C12E1F', weight: 1000, qty: 1 },
  { id: 3, name: '红C', brand: '测试', material: 'PLA', color: '#8A1C14', weight: 500, qty: 3 },
  { id: 4, name: '蓝A', brand: '测试', material: 'PETG', color: '#4A90D9', weight: 1000, qty: 2 },
  { id: 5, name: '白A', brand: '测试', material: 'PLA', color: '#FFFFFF', weight: 1000, qty: 0 },
  { id: 6, name: '黑A', brand: '测试', material: 'ABS', color: '#101014', weight: 1000, qty: 1,
    spoolRemainG: 40, spoolRemainSrc: 'manual' },
];

const w = boot(null);
const ev = c => w.eval(c);
/* 顶层 let/const 不挂 window，且跨 realm 的原型不同 → 一律 JSON 序列化后再取 */
const J = c => JSON.parse(ev('JSON.stringify(' + c + ')'));
const $ = sel => w.document.querySelector(sel);
const $$ = sel => [...w.document.querySelectorAll(sel)];
const grp = fam => $(`#famView .fam-grp[data-fam="${fam}"]`);

setTimeout(() => {
  try {
    /* ══════════ 一、首屏默认视图 ══════════ */
    console.log('── 一、首屏默认视图 ──');

    eq(ev('currentView'), 'fam', '1.1 没设过偏好时默认「色系」视图');
    ok($('#famView').classList.contains('visible'), '1.2 #famView 可见');
    ok(!$('#gridView').classList.contains('visible'), '1.3 #gridView 不可见（硬编码 visible 已移除）');
    ok(!$('#listView').classList.contains('visible'), '1.4 #listView 不可见');
    eq($('#viewFam').getAttribute('aria-pressed'), 'true', '1.5 #viewFam aria-pressed=true');
    eq($('#viewGrid').getAttribute('aria-pressed'), 'false', '1.6 #viewGrid aria-pressed=false');
    ok($('#viewFam').classList.contains('active'), '1.7 #viewFam 有 active 类');
    ok(!$('#settingsBackdrop').classList.contains('open'), '1.8 设置面板初始关闭');
    eq($$('#settingsBackdrop [data-view-opt]').length, 3, '1.9 设置面板里有 3 个默认视图选项');
    eq($('#settingsBackdrop [data-view-opt="fam"]').getAttribute('aria-checked'), 'true', '1.10 设置面板标记当前=fam');
    ok($$('#famView .fam-grp').length > 0, '1.11 首屏已渲染出色系分组');
    ok($$('#famView .fam-grp').every(g => g.querySelector('.spool-chip, .filament-card')),
      '1.12 首屏每张卡都直接露出内容（不用点）');
    eq($$('#famView .fam-grp.is-expanded').length, 0,
      '1.13 首屏没有任何「展开/收起」态（砖身本来就是全量摊开的）');
    ok(!!$('#famView .fam-bar'), '1.14 顶部汇总条存在');
    eq(ev('famDensity'), 'mini', '1.15 默认密度是迷你卷');
    eq($('#famView').getAttribute('data-density'), 'mini', '1.16 密度挂在 #famView[data-density] 上供 CSS 分支');
    ok($$('#famView .spool-chip').length > 0, '1.17 首屏就渲染出迷你卷（不是等展开才渲染）');

    /* ══════════ 二、默认视图偏好（设备本地） ══════════ */
    console.log('── 二、默认视图偏好 ──');

    eq(ev('fmPrefRaw("fmDefaultView")'), null, '2.1 首次打开没有存过偏好');
    eq(ev('fmViewOk("fam")'), 'fam', '2.2 fmViewOk 认 fam');
    eq(ev('fmViewOk("nope")'), null, '2.3 fmViewOk 拒非法值');

    ev('setDefaultView("list")');
    eq(ev('localStorage.getItem("fmDefaultView")'), 'list', '2.4 setDefaultView 写的是裸字符串');
    eq(ev('currentView'), 'list', '2.5 setDefaultView 同时切过去');
    eq($('#settingsBackdrop [data-view-opt="list"]').getAttribute('aria-checked'), 'true', '2.6 选完勾移到 list（面板不关，能当场确认）');
    ok($('#listView').classList.contains('visible'), '2.7 列表容器接管可见性');
    ok(!$('#famView').classList.contains('visible'), '2.8 色系容器让位');

    ev('setView("grid")');
    eq(ev('localStorage.getItem("fmDefaultView")'), 'list', '2.9 工具栏切视图不覆盖默认值');

    /* 面板开关 */
    ev('openSettings()');
    ok($('#settingsBackdrop').classList.contains('open'), '2.10 openSettings 打开设置面板');
    ok(!$('#settingsBackdrop').hasAttribute('inert'), '2.11 打开时摘掉 inert（否则 Tab 进不去）');
    ev('closeSettings()');
    ok(!$('#settingsBackdrop').classList.contains('open'), '2.12 closeSettings 关闭');
    ok($('#settingsBackdrop').hasAttribute('inert'), '2.13 关闭后回到 inert，彻底退出 Tab 序');

    /* 预置偏好的两个新实例：守「读裸字符串」这条路 */
    const wList = boot({ fmDefaultView: 'list' });
    eq(wList.eval('currentView'), 'list', '2.14 预置 list → 首屏就是列表');
    ok(wList.document.getElementById('listView').classList.contains('visible'), '2.15 预置 list 时容器正确');

    const wBad = boot({ fmDefaultView: 'xxx' });
    eq(wBad.eval('currentView'), 'fam', '2.16 预置非法值 → 回落 fam');

    /* ══════════ 三、分组与汇总 ══════════ */
    console.log('── 三、分组与汇总 ──');

    ev('data = ' + JSON.stringify(SEED) + '.map(function(o){ return normalizeItem(o); }); renderAll();');
    ev('setView("fam")');

    const G = J('famGroups(getFiltered())');
    eq(G.map(g => g.fam), ['红', '蓝', '白', '黑'], '3.1 组序按 SW_FAMILIES，空组不出现');
    const red = G.find(g => g.fam === '红');
    eq(red.qty, 6, '3.2 红组卷数 2+1+3');
    eq(red.grams, 4500, '3.3 红组克重 Σ(weight×qty)');
    eq(red.hexN, 2, '3.4 红组去重色数 2');
    eq(red.items.length, 3, '3.5 红组条目数 3');
    const white = G.find(g => g.fam === '白');
    eq([white.qty, white.grams, white.hexN], [0, 0, 1], '3.6 白组 0 卷也要成组（不能消失）');
    const black = G.find(g => g.fam === '黑');
    eq(black.low, 1, '3.7 黑组低库存计数 1（余量 4%）');
    eq(G.find(g => g.fam === '蓝').low, 0, '3.8 余量未知的卷不算低库存');

    /* 色相 → 明度：组内顺序必须与色带同序 */
    const hues = J('famGroups(getFiltered()).find(function(g){return g.fam==="红"}).items.map(function(d){return swHsl(normHex(d.color))[0]})');
    ok(hues.every((v, i) => i === 0 || v >= hues[i - 1]), '3.9 组内按色相升序（频谱感）');
    eq(G.find(g => g.fam === '红').items[0].id, 3, '3.10 色相更低的 #8A1C14 排在最前');

    /* 排序切换：没有用量记录时退化成同一顺序，不能把组打乱 */
    ev('setSortMode("usage")');
    eq(J('famGroups(getFiltered())').map(g => g.fam), ['红', '蓝', '白', '黑'], '3.11 消耗排序不影响组序');
    ev('setSortMode("default")');

    /* 脏颜色兜底 */
    eq(ev('famGroups([normalizeItem({id:99,name:"X",color:"transparent"})]).map(function(g){return g.fam})'),
      ['灰'], '3.12 非法色值被 normalizeItem 兜成 #888888 → 归灰系，不产生孤立组');

    /* ══════════ 四、实时色带 ══════════ */
    console.log('── 四、实时色带 ──');

    const redSegs = J('famGroups(getFiltered()).find(function(g){return g.fam==="红"}).segs');
    eq(redSegs.length, 2, '4.1 色带段数 = 该色系去重色数');
    eq(redSegs.map(s => s.q), [3, 3], '4.2 两段各 3 卷（#8A1C14 在 1/2/3 里共 3 卷）');
    const whiteSegs = J('famGroups(getFiltered()).find(function(g){return g.fam==="白"}).segs');
    eq(whiteSegs.map(s => s.q), [0], '4.3 0 卷的色保留 q=0（渲染时 0.35 兜底露出）');

    /* 色带只在面板头渲染（卡头 315px 里只剩 40–70px，只会露出 1–2 段，零信息量），
       所以这里直接验渲染函数的输出 —— DOM 断言放在第五章「面板头有实时色带」。 */
    const ribOf = fam => ev('famRibbonHtml(famGroups(getFiltered()).find(function(g){return g.fam==="'
      + fam + '"}))');
    const redRib = ribOf('红');
    eq((redRib.match(/fam-ribbon-seg/g) || []).length, 2, '4.4 红组色带 2 段');
    ok(/width:30px/.test(redRib), '4.5 段宽按卷数自然排（3 卷 = 30px，不撑满整行）');
    ok(/#8A1C14/i.test(redRib), '4.6 段用真实 hex 上色');
    ok(redRib.indexOf('3 卷') > 0, '4.7 每段带「hex · N 卷」的原生提示');
    ok(/width:8px/.test(ribOf('白')), '4.8 0 卷的段留 8px（有这个色、但没货）');

    /* ══════════ 五、瀑布流砖墙：不截断、不留洞 ══════════ */
    console.log('── 五、瀑布流砖墙 ──');

    const hd = () => grp('红').querySelector('.fam-hd');

    eq($$('#famView .fam-wall').length, 1, '5.0 砖墙容器 .fam-wall 只有一个');
    eq($$('#famView .fam-wall > .fam-grp').length, 4, '5.1 每个色系一块砖（夹具里 4 个）');

    /* 核心：砖身永远渲染全量。红组 3 条 → 3 格，一条都不许藏 */
    eq(grp('红').querySelectorAll('.spool-chip').length, 3, '5.2 红组 3 条全渲染（没有截断）');
    eq($$('#famView .spool-chip').length, SEED.length, '5.3 全库 6 条 = 6 格，一格不少');
    eq($$('#famView .fam-more').length, 0, '5.4 没有「还有 N 卷」这种半截按钮');

    /* 砖头不可点：没有第二层可展开，做成按钮就是假入口 */
    eq(grp('红').querySelector('.fam-hd').tagName, 'H3', '5.5 砖头是 <h3> 而不是 <button>');
    ok(!hd().hasAttribute('aria-expanded'), '5.6 砖头不声明 aria-expanded（无展开态）');
    ok(!hd().hasAttribute('aria-controls'), '5.7 砖头不声明 aria-controls');
    ok(!$('#famView').innerHTML.includes('fam-caret'), '5.8 折角图标已删除（没有可折的东西）');

    /* 打包入口：renderFam 末尾同步调用（不能延到 rAF，否则先闪一帧竖排） */
    ok(/function packFamWall/.test(SRC), '5.9 packFamWall 存在');
    ok(/el\.innerHTML = bar \+ [\s\S]{0,200}\n\s*packFamWall\(\);/.test(SRC),
      '5.10 renderFam 在 innerHTML 之后**同步**打包');

    /* 打包算法的三条判据都必须在源码里（jsdom 量不出布局，只能验形状） */
    ok(/const FAM_ASPECT = \{ mini: 1\.6, card: 2\.0 \}/.test(SRC),
      '5.11 高宽比上限按密度分档（mini 1.6 / card 2.0）');
    ok(/h <= w \* limit/.test(SRC), '5.12 超上限就加宽（加宽 = 砖内格子从 2 列变 4 列 → 变矮）');
    ok(/const score = top \+ hole/.test(SRC),
      '5.13 落位分 = top + 空洞（只看 top 会把横砖压在高低差 400px 的两列上）');
    ok(/narrow\.top \+ it\.h1 <= spot\.top \+ it\.hS \+ 1/.test(SRC),
      '5.14 留洞不可避免且竖放不会把墙顶更高时，退回 1 列（不把所有横砖叠在同一对列上）');

    /* 降级路径：没打包前砖块走普通文档流，脚本挂了也只是竖排，不会叠成一坨 */
    ok(/\.fam-wall\.is-packed > \.fam-grp \{ position: absolute; \}/.test(SRC),
      '5.15 绝对定位只在 .is-packed 之后生效（未打包时是普通流）');
    ok(!$('#famWall').classList.contains('is-packed'),
      '5.16 jsdom 下 clientWidth=0 → packFamWall 直接返回，不写半套坐标');
    eq($$('#famView .fam-grp[data-span="2"]').length, 0,
      '5.17 没打包时所有砖都还是 1 列（data-span 初值为 1）');

    /* 统计按钮：只剩密度两档 */
    eq($$('#famView .fam-bar .folder-bar-btn').map(b => b.textContent).join('/'), '迷你/卡片',
      '5.18 顶栏只剩「迷你 / 卡片」（紧凑-标准两档随截断一起删除）');

    /* ══════════ 六、颜色筛选与统计页跳转 ══════════ */
    console.log('── 六、颜色筛选与统计页跳转 ──');

    ev('toggleColorFam("红")');
    eq($$('#famView .fam-grp').length, 1, '6.1 按红筛选后墙上只剩一块砖');
    eq(grp('红') && grp('红').dataset.fam, '红', '6.2 留下的是红组');
    ev('toggleColorFam("红")');
    eq($$('#famView .fam-grp').length, 4, '6.3 解除筛选后 4 块砖全部回来');

    ev('stJump("family", "红")');
    eq($$('#famView .fam-grp').length, 1, '6.4 统计页点色系 → 跳库存且只筛出这一组');
    ok(grp('红').classList.contains('is-hit'),
      '6.5 该砖带 .is-hit 描边脉冲（砖身本来就全量摊开，不需要「展开」，只要一个落点提示）');
    ok(/function famFlash[\s\S]{0,400}classList\.remove\('is-hit'\)/.test(SRC),
      '6.6 连点同一个色系也要重闪（去 class → 强制重排 → 再挂）');
    ev('toggleColorFam("红")');

    /* ══════════ 七、编辑模式与勾选联动 ══════════ */
    console.log('── 七、编辑模式与勾选联动 ──');

    ok(!$('#famView').classList.contains('edit-mode'), '7.1 默认不在编辑模式');
    ev('toggleEditMode()');
    ok($('#famView').classList.contains('edit-mode'), '7.2 编辑模式下 #famView 也挂 edit-mode');
    /* 编辑模式下 chip 变成多选按钮：aria-pressed，且不再声称自己是 dialog 触发器 */
    const chip1 = () => $('#famView .spool-chip[data-id="1"]');
    ok(chip1().hasAttribute('aria-pressed'), '7.3 编辑模式下 chip 有 aria-pressed');
    ok(!chip1().hasAttribute('aria-haspopup'), '7.4 编辑模式下 chip 不再挂 aria-haspopup');

    ev('renderAll(); toggleSelect(4)');
    const famChip = $('#famView .spool-chip[data-id="4"]');
    const gridCard = $('#gridView .filament-card[data-id="4"]');
    ok(!!famChip && famChip.classList.contains('selected'), '7.5 迷你卷跟着勾选');
    ok(!!gridCard && gridCard.classList.contains('selected'), '7.6 网格视图卡片同步');
    eq(famChip.getAttribute('aria-pressed'), 'true', '7.7 迷你卷 aria-pressed 同步');

    /* 顶栏「全选」只走 updateAllVisuals —— 漏了它就是数字跳了但一格都不变色 */
    ev('toggleSelectAll()');
    eq($$('#famView .spool-chip.selected').length, SEED.length, '7.8 全选后所有迷你卷都点亮');
    ev('clearSelection()');
    eq($$('#famView .spool-chip.selected').length, 0, '7.9 取消选择后全部熄灭');
    ev('toggleEditMode()');

    /* 非编辑模式下 chip 是「打开详情」按钮 */
    ok(chip1().hasAttribute('aria-haspopup'), '7.10 平时 chip 声明自己弹 dialog');
    eq(chip1().getAttribute('aria-expanded'), 'false', '7.11 平时 chip 的 aria-expanded 初值 false');

    /* 同一组 10 条：砖身全量渲染是这次重构的核心承诺，编辑模式与否都必须 10 格。
       （旧版靠 cap 截断，于是「全选」会出现「计数 10、一格都不亮」的失败态。） */
    ev('data = Array.from({length:10}, function(_,i){ return normalizeItem({id:100+i,name:"红X"+i,color:"#C12E1F",weight:1000,qty:1}); }); renderAll()');
    eq($$('#famView .spool-chip').length, 10, '7.12 10 条全渲染（不截断，用户不用点开才看得全）');
    eq($$('#famView .fam-more').length, 0, '7.13 没有「还有 N 卷」');
    ev('toggleEditMode()');
    eq($$('#famView .spool-chip').length, 10, '7.14 编辑模式同样是 10 格（本来就没有截断，全选不会漏格）');
    ev('toggleSelectAll()');
    eq($$('#famView .spool-chip.selected').length, 10, '7.15 10 条全选中后 10 格全亮');
    ev('clearSelection(); toggleEditMode()');
    ev('data = ' + JSON.stringify(SEED) + '.map(function(o){return normalizeItem(o)}); renderAll()');

    /* ══════════ 八、迷你卷详情浮层 ══════════ */
    console.log('── 八、迷你卷详情浮层 ──');

    const pop = () => $('#spoolPop');
    const clickChip = id => $(`#famView .spool-chip[data-id="${id}"]`)
      .dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

    ok(!!pop(), '8.0 #spoolPop 存在于 #famView 之外（renderFam 整体重建也不会抹掉它）');
    eq(pop().parentElement === $('#famView'), false, '8.1 浮层不是 #famView 的子节点');
    ok(pop().hidden, '8.2 初始隐藏');

    clickChip(1);
    ok(!pop().hidden, '8.3 点迷你卷 → 浮层出现');
    eq($('#spoolPop .sp-head-name').textContent, '红A', '8.4 头部标题是耗材名');
    eq($('#spoolPop .sp-head-sub').textContent.indexOf('PLA') >= 0, true, '8.5 头部副标题带材质');
    const keys = $$('#spoolPop .sp-k').map(e => e.textContent);
    ok(keys.indexOf('余量') >= 0 && keys.indexOf('用量') >= 0, '8.6 键值行含余量 / 用量');
    eq($$('#spoolPop .sp-btn').map(e => e.textContent).join('/'), '编辑/标记用完', '8.7 底部是编辑 + 标记用完');
    eq(chip1().getAttribute('aria-expanded'), 'true', '8.8 打开时 chip 的 aria-expanded 同步');
    eq(w.document.activeElement && w.document.activeElement.id, 'spoolPop', '8.9 焦点进入浮层（非模态 dialog，tabindex=-1）');

    clickChip(1);
    ok(pop().hidden, '8.10 再点同一格 = 收起（开关语义）');
    eq(chip1().getAttribute('aria-expanded'), 'false', '8.11 收起时 aria-expanded 复位');

    clickChip(1);
    clickChip(4);
    eq($('#spoolPop .sp-head-name').textContent, '蓝A', '8.12 点别的格 → 直接换内容，不闪');
    eq(chip1().getAttribute('aria-expanded'), 'false', '8.13 旧锚点的 aria-expanded 被复位');

    /* 关闭路径：外部 pointerdown / 内部 pointerdown 不关 / 滚动 / Esc / renderAll */
    $('.sp-btn').dispatchEvent(new w.MouseEvent('pointerdown', { bubbles: true }));
    ok(!pop().hidden, '8.14 浮层内部 pointerdown 不关闭（否则按钮点不动）');
    $('#famView .spool-chip[data-id="4"]').dispatchEvent(new w.MouseEvent('pointerdown', { bubbles: true }));
    ok(!pop().hidden, '8.15 点在迷你卷上的 pointerdown 不关闭（交给 click 决定，否则会闪）');
    w.document.body.dispatchEvent(new w.MouseEvent('pointerdown', { bubbles: true }));
    ok(pop().hidden, '8.16 外部 pointerdown → 关闭');

    clickChip(1);
    w.document.dispatchEvent(new w.Event('scroll', { bubbles: true }));
    ok(pop().hidden, '8.17 页面滚动 → 关闭（锚点位置已失效）');

    clickChip(1);
    w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    ok(pop().hidden, '8.18 Esc → 关闭');
    eq(w.document.activeElement && w.document.activeElement.dataset.id, '1', '8.19 关闭后焦点回到锚点迷你卷');

    clickChip(1);
    ev('renderAll()');
    ok(pop().hidden, '8.20 renderAll（搜索防抖 / 同步）前会先关浮层，不留孤儿');

    /* 零卷条目：标题按钮文案翻转 */
    clickChip(5);
    eq($$('#spoolPop .sp-btn').map(e => e.textContent).join('/'), '编辑/恢复一卷', '8.21 0 卷时按钮变「恢复一卷」');
    ev('closeSpoolPop()');

    /* 砖内的 chip 也能开浮层；砖被重建时浮层必须跟着收 */
    clickChip(3);
    ok(!pop().hidden, '8.22a 砖内的迷你卷也能开详情浮层');
    ev('renderAll()');
    ok(pop().hidden, '8.22 重建砖墙时浮层一起收（锚点是砖内的 button，重建后就成了孤儿）');

    /* ══════════ 九、密度切换 ══════════ */
    console.log('── 九、密度切换 ──');

    ev('setFamDensity("card")');
    eq(ev('famDensity'), 'card', '9.0 setFamDensity 写入内存');
    eq(ev('localStorage.getItem("fmFamDensity")'), 'card', '9.1 落盘是裸字符串 fmFamDensity');
    eq($('#famView').getAttribute('data-density'), 'card', '9.2 data-density 同步');
    eq($$('#famView .filament-card').length, SEED.length, '9.3 卡片密度同样是全量（6 条 = 6 张，不封顶）');
    eq($$('#famView .spool-chip').length, 0, '9.4 卡片密度下没有迷你卷');
    ok($('#famView').innerHTML.indexOf('card-edit-overlay') >= 0, '9.5 卡片模板没被抽坏');
    eq($('#famView .fam-bar [data-famdens].on').textContent, '卡片', '9.6 密度分段控件高亮当前档');
    eq($$('#famView .fam-bar .folder-bar-btn.on').length, 1,
      '9.6b 顶栏只有一组分段控件（行档那组随截断一起删除）');

    ev('setFamDensity("mini")');
    eq($$('#famView .spool-chip').length, SEED.length, '9.7 切回迷你密度');
    eq($$('#famView .filament-card').length, 0, '9.8 迷你密度下完全不渲染整卡（省掉整套卡片字符串）');
    ev('setFamDensity("xxx")');
    eq(ev('famDensity'), 'mini', '9.9 setFamDensity 拒非法值');

    const wDense = boot({ fmFamDensity: 'card' });
    eq(wDense.eval('famDensity'), 'card', '9.10 预置 fmFamDensity=card → 首屏就是卡片密度');
    const wDenseBad = boot({ fmFamDensity: 'xxx' });
    eq(wDenseBad.eval('famDensity'), 'mini', '9.11 预置非法值 → 回落迷你');

    /* 行档已随截断一起删除：残留的旧键既不读也不崩（老用户升级过来时 localStorage 里可能还有） */
    const wRows = boot({ fmFamRows: 'compact' });
    eq(wRows.eval('typeof famRows'), 'undefined', '9.12 famRows 变量已删除（不读旧键）');
    eq(wRows.eval('typeof famCap'), 'undefined', '9.13 famCap / FAM_CAP 已删除（不存在「每卡几条」这个概念）');
    eq(wRows.eval('document.querySelectorAll("#famView .fam-more").length'), 0,
      '9.14 带旧 fmFamRows 键启动也不截断（连「还有 N 卷」都不存在）');

    /* ══════════ 十、老视图不被拖坏 ══════════ */
    console.log('── 十、老视图回归 ──');

    let threw = null;
    try { ev('renderAll()'); } catch (e) { threw = e && e.message; }
    eq(threw, null, '10.1 renderAll 在色系视图下不抛错');

    eq($$('#gridView .filament-card').length, SEED.length, '10.2 网格视图照常渲染全部条目');
    ok($('#gridView').innerHTML.indexOf('card-edit-overlay') >= 0, '10.3 网格卡片模板没被抽坏');
    ev('renderList(data)');
    eq($$('#listView .list-row').length, SEED.length, '10.4 renderList 仍是单参、可独立调用');
    ok(!!$('#listView .list-header'), '10.5 列表表头没被覆盖掉');

    /* 空库：三个视图都不能崩 */
    ev('data = []; renderAll();');
    eq($('#famView').innerHTML, '', '10.6 空库时色系视图清空（不抛错）');
    ok($('#emptyState').classList.contains('visible'), '10.7 空态照常出现');

    /* ══════════ 十一、卡片墙结构 ══════════ */
    console.log('── 十一、卡片墙结构 ──');

    ev('data = ' + JSON.stringify(SEED) + '.map(function(o){ return normalizeItem(o); }); renderAll();');
    ev('setView("fam")');

    /* —— 主题偏好：整页一个键，裸字符串，设备本地 —— */
    eq(ev('document.documentElement.getAttribute("data-theme")'), 'dark', '11.1 默认主题是暗色');
    eq(ev('themeOk("light")'), 'light', '11.2 themeOk 认 light');
    eq(ev('themeOk("xxx")'), null, '11.3 themeOk 拒非法值');
    eq(ev('fmPrefRaw("fmTheme")'), null, '11.4 首次打开没存过主题');

    ev('setTheme("light")');
    eq(ev('localStorage.getItem("fmTheme")'), 'light', '11.5 setTheme 写的是裸字符串');
    eq(ev('document.documentElement.getAttribute("data-theme")'), 'light', '11.6 html[data-theme] 立即切到 light');
    eq($('#settingsBackdrop [data-theme-opt="light"]').getAttribute('aria-checked'), 'true', '11.7 亮白色选项 aria-checked=true');
    eq($('#settingsBackdrop [data-theme-opt="dark"]').getAttribute('aria-checked'), 'false', '11.8 暗色选项 aria-checked=false');

    grp('红').setAttribute('data-mark', 'keep');
    ev('setTheme("dark")');
    eq(grp('红').getAttribute('data-mark'), 'keep', '11.9 切主题只改属性，不重建 DOM');
    grp('红').removeAttribute('data-mark');

    const wLight = boot({ fmTheme: 'light' });
    eq(wLight.document.documentElement.getAttribute('data-theme'), 'light', '11.10 预置 light → 首屏就是亮色');
    const wBadTheme = boot({ fmTheme: 'xxx' });
    eq(wBadTheme.document.documentElement.getAttribute('data-theme'), 'dark', '11.11 预置非法值 → 回落暗色');

    /* —— 每块砖的结构：族色左轨 / 系名 / 卷色重 / 色带 / 内容网格 —— */
    eq($$('#famView .fam-grp').length, 4, '11.12 4 个色系各一块砖');
    ok($$('#famView .fam-grp').every(g => g.querySelector('.fam-hd .fam-rail')), '11.13 每块砖头都有族色左轨');
    ok($$('#famView .fam-grp').every(g => g.querySelector('.fam-hd .fam-ribbon')),
      '11.14 色带在砖头里（1 列宽时由 [data-span="1"] 规则隐藏，宽砖才拿出来读调子）');
    ok(/\.fam-grp\[data-span="1"\] \.fam-ribbon[\s\S]{0,80}display:\s*none/.test(SRC),
      '11.14b 1 列宽的砖不显示色带（315px 里只剩 40–70px，切出来只有 1–2 段，零信息量）');
    ok($$('#famView .fam-grp').every(g => /卷/.test(g.querySelector('.folder-meta').textContent)),
      '11.15 每块砖头都有卷数');
    ok($$('#famView .fam-grp').every(g => /色/.test(g.querySelector('.folder-meta').textContent)),
      '11.16 砖头同时给出色数（旧版只有面板头有，面板没了就得回到砖头）');
    ok($$('#famView .fam-grp').every(g => !g.querySelector('.fam-hd .fam-caret')),
      '11.17 砖头没有折角（没有可折叠的第二层）');
    ok($$('#famView .fam-grp').every(g => g.querySelector('.fam-cards')), '11.18 每块砖都有内容网格');

    /* —— 单容器：所有砖都是 .fam-wall 的直接子元素 —— */
    eq($$('#famView .fam-wall').length, 1, '11.19 砖墙容器 .fam-wall 只有一个');
    ok($$('#famView .fam-list').length === 0, '11.19b 旧的 .fam-list 单列容器已删除');
    ok($$('#famView .fam-wall > .fam-grp').length === $$('#famView .fam-grp').length,
      '11.19c 所有砖都是 .fam-wall 的直接子元素（打包时按 children 遍历，多一层就漏砖）');

    /* —— 低库存族在砖头里直接标出来 —— */
    ok(/1 低/.test(grp('黑').querySelector('.folder-meta').textContent), '11.20 黑组（余量 4%）砖头标出「1 低」');
    ok(!grp('蓝').querySelector('.fam-low'), '11.21 无低库存的组不显示该标记');

    /* —— 砖头汇总 + 顶栏 —— */
    eq($('#famView .fam-grp[data-fam="红"] .folder-name').textContent, '红色系', '11.22 砖头系名');
    const footMeta = $('#famView .fam-grp[data-fam="红"] .folder-meta').textContent.replace(/\s+/g, ' ');
    ok(/6/.test(footMeta) && /2 色/.test(footMeta) && /4\.50/.test(footMeta),
      '11.23 砖头给出卷数 / 色数 / 克重三件（4.5kg 的旧红组）');
    const barNums = $$('#famView .fam-bar .folder-stat b').map(e => e.textContent);
    eq(barNums, ['4', '5', '9', '7.50'], '11.24 顶栏汇总 = 色系 / 颜色 / 卷 / 克重');
    eq($$('#famView .fam-bar .folder-bar-btn').map(b => b.textContent).join('/'), '迷你/卡片',
      '11.25 顶栏两档：迷你 / 卡片');

    /* —— 空库：顶栏 + 列表一并消失 —— */
    ev('data = []; renderAll();');
    eq($('#famView').innerHTML, '', '11.26 空库时整个色系视图清空');

    /* ══════════ 十二、静态断言（防后人改回去） ══════════ */
    console.log('── 十二、静态断言 ──');

    const famCss = SRC.slice(SRC.indexOf('.fam-view { display: none'), SRC.indexOf('.list-item {'));

    /* 砖墙：相对定位的坐标系 + 打包后才绝对定位 */
    ok(/\.fam-wall\s*\{[^}]*position:\s*relative/.test(SRC), '12.1 .fam-wall 是 relative 坐标系（高度由 JS 写）');
    ok(/\.fam-wall\.is-packed > \.fam-grp\s*\{\s*position:\s*absolute/.test(SRC),
      '12.2 只有 .is-packed 之后砖才绝对定位（未打包时是普通流，脚本挂了只是竖排）');
    ok(!/\.fam-wall\s*\{[^}]*display:\s*grid/.test(SRC),
      '12.3 .fam-wall 不再是 grid（行高会拉齐同排的砖，矮砖下方必留空洞）');
    ok(/\.fam-grp\s*\{[^}]*border-radius:\s*12px/.test(SRC),
      '12.4 砖壳自带圆角与描边（砖头不再自带边框，否则双线）');
    ok(!/\.fam-hd:focus-visible/.test(SRC) && /<h3 class="fam-hd">/.test(SRC),
      '12.5 砖头是 <h3>（无展开动作，不该给键盘用户一个假按钮）');
    ok(!/\.fam-body/.test(SRC), '12.6 折叠体 .fam-body 已删除（砖身没有折叠态）');
    ok(!/visibility:\s*hidden/.test(famCss), '12.7 不靠 visibility:hidden 藏内容');

    /* hover 机制彻底删除 */
    ok(!/famPointerUpdate|famPointerInBoard|famHitTest|famSchedule|famBindPointer|bindFamHover/.test(SRC),
      '12.8 指针命中/静置判定那套已彻底删除');
    ok(!/FAM_HOVER_IN|FAM_SETTLE_PX|FAM_PAD_X/.test(SRC), '12.9 hover 常量已删除');
    ok(!/addEventListener\('pointermove'/.test(SRC), '12.10 没有 pointermove 驱动展开的监听');
    ok(!/famLocked|lockFam|syncFamLockBadge|famAnimate/.test(SRC), '12.11 点击锁定态与动画标记已删除');
    ok(!/\.folder-h::after/.test(SRC), '12.12 halo 抖动缓冲已删除');
    ok(!/\.folder-face|\.folder-tab|\.folder-strips|\.folder-low|perspective:\s*900px|rotateX\(-94deg\)/.test(SRC),
      '12.13 标签耳 / 马赛克封面 / 3D 翻盖 / 死代码 .folder-low 全部删除');
    ok(!/folderCardIn/.test(SRC), '12.14 卡片阶梯入场动画已删除（默认全摊开时会让 200 张同时播）');
    ok(!/folderCols|\.folder-cols/.test(SRC), '12.14b 瀑布流列测算（folderCols / .folder-cols）已删除');
    ok(!/_famResizeObserver/.test(SRC), '12.14c 旧 ResizeObserver 全局残留已删除（现在用 window resize + rAF）');

    /* 打包与砖内网格 */
    ok(/\.fam-rail\s*\{/.test(famCss), '12.15 .fam-rail 族色左轨存在');
    ok(/\.fam-ribbon\s*\{/.test(famCss), '12.16 .fam-ribbon 实时色带存在（宽砖的砖头里）');
    ok(/\.spool-chip\s*\{/.test(famCss), '12.17 .spool-chip 迷你卷存在');
    ok(/\.fam-hd\s*\{[^}]*height:\s*52px/.test(famCss),
      '12.18 砖头 52px 常驻高度（1.02rem 主名上下各留 6px 呼吸，46px 会读成「挤」）');
    ok(!/\.fam-hd:hover\s*\{[^}]*transform/.test(famCss), '12.19 砖头 hover 不做位移（整块砖会跟着晃）');

    /* 砖头 = 色系标牌（12.18a–12.18g）：这是「色系名称不明显 / 不同色系区分不明显」的修复锚点。
       旧版砖头只有一根 3×20px 的族色细线 + 0.9rem/0.12em 字距的标题，
       12 块砖又共用同一个中性底与同一种淡边框，扫视时糊成一片白卡。 */
    ok(/\.fam-hd\s*\{[^}]*background:\s*color-mix\(in oklch, var\(--fam\) 16%, var\(--bg-2\)\)/.test(famCss),
      '12.18a 砖头底色是族色 16% 混进砖身底 —— 12 块砖头部因此是 12 个不同色调（11% 在近白底上量不出差异，实测 oklch L 全在 0.94–0.98）');
    ok(/\.fam-hd\s*\{[^}]*box-shadow:\s*inset 0 3px 0 var\(--fam\)/.test(famCss),
      '12.18b 砖头顶部压一道 3px 族色线（inset shadow 会跟随外壳圆角，不用额外元素；2px 缩略时看不见）');
    ok(/\.fam-grp\s*\{[^}]*border:\s*1px solid color-mix\(in oklch, var\(--fam\) 24%, var\(--border\)\)/.test(famCss),
      '12.18c 砖的外轮廓染族色 —— 扫视靠外轮廓，统一中性描边会让整面墙糊在一起');
    ok(/\.fam-rail\s*\{[^}]*width:\s*5px[^}]*height:\s*26px/.test(famCss),
      '12.18d 族色色标 5×26（旧版 3×20，在 52px 高的砖头里细到看不见）');
    ok(/\.folder-name\s*\{[^}]*font-size:\s*1\.02rem[^}]*font-weight:\s*700/.test(famCss),
      '12.18e 系名 1.02rem/700');
    ok(!/\.folder-name\s*\{[^}]*letter-spacing:\s*0\.12em/.test(famCss),
      '12.18f 系名不再用 0.12em 字距 —— 中文字距拉开只是把标题稀释成几根散开的笔画');
    ok(/\.fam-suffix\s*\{/.test(famCss) && /<i class="fam-suffix">色系<\/i>/.test(SRC),
      '12.18g 「色系」二字降成小号后缀，主名才抓得住眼睛（拼起来仍是「红色系」，朗读口径不变）');
    ok(((SRC.match(/g\.fam === FAM_UNSET\s*\?\s*`([^`]*)`/) || [, ''])[1] || '').indexOf('fam-suffix') < 0,
      '12.18h 「未设色」不挂「色系」后缀（否则读成「未设色色系」）');
    ok(/\.fam-cards\s*\{[^}]*minmax\(min\(100%,\s*132px\),\s*1fr\)/.test(SRC),
      '12.20 砖内格子 132px 起自动排 → 窄砖 2 列、宽砖 4 列（加宽即变矮，不用第二套列数计算）');
    ok(/\.fam-view\[data-density="card"\] \.fam-cards\s*\{[^}]*minmax\(min\(100%,\s*220px\),\s*1fr\)/.test(SRC),
      '12.21 卡片密度格子 220px 起（整卡内部布局不用重算）');
    ok(/\.fam-view\.edit-mode \.spool-chip::before/.test(SRC), '12.22 编辑模式勾选态用伪元素画（chip 内不能再嵌 button）');
    ok(/function spoolChipClick/.test(SRC), '12.23 迷你卷有独立点击处理器');
    ok(/if \(e\.target\.tagName === 'BUTTON'\) return/.test(SRC), '12.24 handleCardClick 仍拒绝 BUTTON 目标（所以 chip 不能复用它）');
    ok(/function openSpoolPop[\s\S]{0,4000}preventScroll: true/.test(SRC), '12.25 浮层聚焦带 preventScroll（否则滚页面 → 触发滚动关闭）');
    ok(/#spoolPop \{[^}]*position:\s*fixed/.test(SRC) && /#spoolPop \{[^}]*z-index:\s*150/.test(SRC),
      '12.26 浮层 fixed + z-index:150（压过 header 100，低于模态 200）');
    ok(/function closeSpoolPop/.test(SRC) && /function placeSpoolPop/.test(SRC), '12.27 浮层有独立的关闭与定位入口');
    ok(/function renderAll\(\) \{[\s\S]{0,400}closeSpoolPop\(\);[\s\S]{0,200}prnUsageMapReset\(\)/.test(SRC),
      '12.28 renderAll 开头先关浮层（一次覆盖 20+ 调用点，含三条异步路径）');
    ok(/\.fam-view:not\(\.edit-mode\) \.card-action-btn\.edit-only/.test(SRC), '12.29 色系视图的 edit-only 隐藏规则保留（卡片密度仍在用）');
    ok(SRC.indexOf('id="viewFam"') > 0 && SRC.indexOf('id="viewList"') > 0, '12.30 三个视图按钮都在');

    /* 打包器本身：用 window resize + rAF，不给砖挂 ResizeObserver（会自激） */
    ok(/window\.addEventListener\('resize', scheduleFamPack/.test(SRC), '12.31 窗口 resize 触发重新打包');
    ok(/function scheduleFamPack[\s\S]{0,300}requestAnimationFrame/.test(SRC),
      '12.32 连续 resize 用 rAF 合并（拖窗口每秒几十次事件）');
    ok(!/packFamWall[\s\S]{0,80}ResizeObserver/.test(SRC), '12.33 打包器里没有 ResizeObserver（重排会再次触发它 → 自激）');

    /* 偏好键：设备本地，不进同步 / 备份 / 服务端 */
    const syncBody = SRC.slice(SRC.indexOf('const SYNC = ['), SRC.indexOf('];', SRC.indexOf('const SYNC = [')));
    ok(syncBody.indexOf('fmDefaultView') < 0, '12.34 fmDefaultView 不进 FM.SYNC（设备本地偏好）');
    ok(syncBody.indexOf('fmFamDensity') < 0, '12.35 fmFamDensity 不进 FM.SYNC');
    const dmBody = SRC.slice(SRC.indexOf('const DM_STORE_KEYS'), SRC.indexOf('\n];', SRC.indexOf('const DM_STORE_KEYS')));
    ok(dmBody.indexOf('fmDefaultView') < 0, '12.36 fmDefaultView 不进备份清单');
    ok(dmBody.indexOf('fmFamDensity') < 0, '12.37 fmFamDensity 不进备份清单');
    const srvBody = fs.readFileSync(path.join(__dirname, '..', 'server', 'printer-store.js'), 'utf8');
    ok(srvBody.indexOf('fmDefaultView') < 0, '12.38 服务端 SYNC_KEYS 没有 fmDefaultView');
    ok(srvBody.indexOf('fmFamDensity') < 0, '12.39 服务端 SYNC_KEYS 没有 fmFamDensity');
    ok(/swViewMode\s*=\s*localStorage\.getItem\('swView'\)/.test(SRC), '12.40 swView 那条老路没被顺手改坏（仍是裸 getItem）');
    ok(/function fmPrefRaw[\s\S]{0,200}localStorage\.getItem/.test(SRC), '12.41 偏好走裸 getItem，不走 lsGet(JSON.parse)');
    ok(/lsSet\(FAM_DENSITY_KEY/.test(SRC), '12.42 密度写入走 lsSet（非 SYNC 键不会排 PUT）');

    /* —— 防复活：折叠状态机、截断 + 行内面板一概不许回来 —— */
    ok(!/famCollapsed|isFamOpen|applyFamOpen|famCollapseAll|famExpandAll|toggleFam\(/.test(SRC),
      '12.43 折叠状态机（Set + 五个函数）没有复活');
    ok(!/grid-template-rows:\s*0fr/.test(SRC), '12.44 折叠高度动画已删（砖墙没有折叠态）');
    ok(!/\.fam-body-clip/.test(SRC), '12.45 三层折叠结构（.fam-body-clip）已删');
    ok(!/@supports not \(grid-template-rows/.test(SRC),
      '12.46 旧引擎降级块已删（留着会让不支持 fr 过渡的引擎上内容永久消失）');
    ok(!/famCap|FAM_CAP|famRows|setFamRows|FAM_ROWS_KEY/.test(SRC),
      '12.47 「每卡露几行」那一整套已删除（截断是这次要根除的东西）');
    ok(!/famPanel|openFamPanel|toggleFamPanel|\.fam-more|is-expanded/.test(SRC),
      '12.48 行内面板与「还有 N 卷」已删除（全量摊开后它们没有存在理由）');
    ok(/const maxSpan = \(famDensity !== 'card' && cols >= 3\) \? Math\.min\(cols, FAM_SPAN_LIMIT\) : 1/.test(SRC),
      '12.49 加宽只在「迷你 + 3 列以上」生效（卡片密度加宽会让卡宽跟着变，同一面墙两种卡宽就是乱）');

    /* —— 吸顶栈：header → 页签 → 页面工作台 —— */
    ok(/\.page-tabs\s*\{[^}]*position:\s*sticky[^}]*top:\s*var\(--chrome-h\)/.test(SRC),
      '12.50 页签吸顶，且 top 取实测的 header 高度（写死 60px 会在窄屏被 header 盖住）');
    ok(/\.pinned\s*\{[^}]*position:\s*sticky[^}]*top:\s*calc\(var\(--chrome-h\) \+ var\(--tabs-h\) \+ var\(--tabs-gap\)\)/.test(SRC),
      '12.51 工作台叠在页签下面（三层 sticky 各自相加，全写 top:0 会挤在一处）');
    ok(/\.pinned\s*\{[^}]*background:\s*var\(--bg\)/.test(SRC),
      '12.52 吸顶工作台有不透明底（否则内容从它背后透出来）');
    ok(/--chrome-h:\s*60px/.test(SRC) && /--tabs-h:\s*44px/.test(SRC),
      '12.53 两个高度变量都有首帧兜底值（避免加载瞬间跳到错误位置）');
    ok(/function paintChrome\(\)[\s\S]{0,400}--chrome-h[\s\S]{0,400}--tabs-h/.test(SRC),
      '12.54 paintChrome 用实测高度覆盖变量');
    ok(/new ResizeObserver\(\(\)\s*=>\s*\{\s*paintChrome\(\)/.test(SRC),
      '12.55 ResizeObserver 盯 header（换行变高时 resize 事件不会触发）');
    ok(!/\.pinned\s*\{[^}]*overflow/.test(SRC),
      '12.56 .pinned 不能有 overflow —— 祖先有 overflow 会让 sticky 直接失效');

    /* —— 紧凑态 ——
       这里守的是「可动画」：display 一旦在两种状态间切换，高度就没法过渡，
       切换那一帧会瞬移几十像素 —— 用户报的「顶部闪 / 很僵硬」就是那个。 */
    ok(/@media \(min-width: 901px\)[\s\S]{0,1200}is-tight \.stat-card\s*\{\s*padding:/.test(SRC),
      '12.57 紧凑态靠缩内边距与字号实现，且只在桌面生效');
    ok(!/is-tight \.stat-card\s*\{[^}]*display:\s*(flex|grid)/.test(SRC) &&
      !/is-tight \.stats-bar\s*\{[^}]*display:/.test(SRC),
      '12.57a 紧凑态不许改 display（改了就没法插值，高度只能瞬跳）');
    ok(/\.pinned \.stats-bar\s*\{[^}]*transition:[^}]*gap/.test(SRC) &&
      /\.pinned \.stat-card\s*\{[^}]*transition:[^}]*padding/.test(SRC) &&
      /\.pinned \.stat-label\s*\{[^}]*transition:[^}]*font-size/.test(SRC) &&
      /\.pinned \.stat-value\s*\{[^}]*transition:\s*font-size/.test(SRC),
      '12.57b 四层（条 / 卡 / 标签 / 数值）都挂了过渡，高度才会连续变化');
    ok(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.pinned \.stats-bar, \.pinned \.stat-card, \.pinned \.stat-label, \.pinned \.stat-value\s*\{\s*transition:\s*none/.test(SRC),
      '12.57c 减少动态效果时关掉这层收缩动效');
    ok(/is-tight \.stat-label\s*\{[^}]*text-transform:\s*none/.test(SRC),
      '12.58 紧凑态的标签不做全大写（小字全大写就是噪音）');
    ok(/@media \(max-width: 900px\)\s*\{\s*\.pinned\s*\{\s*position:\s*static/.test(SRC),
      '12.59 窄屏不冻工作台（手机 header 已占 110px，再叠 200px 就只剩半屏看内容）');

    /* —— 回到顶部 —— */
    ok(/id="toTop"/.test(SRC) && /function jumpTop\(\)/.test(SRC), '12.60 回到顶部按钮 + jumpTop 都在');
    ok(/\.to-top\s*\{[^}]*visibility:\s*hidden/.test(SRC) && /\.to-top\.show\s*\{[^}]*visibility:\s*visible/.test(SRC),
      '12.61 隐藏用 visibility 而非 display（display 会在获得焦点时突然蹦出来）');
    ok(/prefers-reduced-motion[\s\S]{0,200}\.to-top/.test(SRC) && /behavior:\s*reduce \? 'auto' : 'smooth'/.test(SRC),
      '12.62 减少动态效果时不做平滑滚动');
    ok(/\.to-top\s*\{[^}]*z-index:\s*120/.test(SRC),
      '12.63 按钮 z-index 高于吸顶栈（60/70）低于浮层（150）与模态（200）');

    /* —— 紧凑态阈值：迟滞 + 回顶冻结 ——
       单阈值会在滚到 120px 附近时自激：紧凑态改 .pinned 高度 → 滚动锚定补偿 scrollY
       → 判定翻回去 → 再改回来，肉眼就是回顶时「闪两下」。 */
    ok(/const PIN_TIGHT_ON = 120/.test(SRC) && /let pinDelta = \d+/.test(SRC),
      '12.63a 进入阈值与实测高度差是两个独立的量（单阈值会自激）');
    ok(/const off = Math\.max\(0, PIN_TIGHT_ON - pinDelta - \d+\)/.test(SRC),
      '12.63b 退出阈值 = 进入阈值 − 实测高度差 − 余量：迟滞宽度必须跨过高度差');
    ok(/tight = pinTight \? y > off : y > PIN_TIGHT_ON/.test(SRC),
      '12.63c 阈值判定带记忆（pinTight 是迟滞状态，不是每帧重算的纯函数）');
    ok(/const d = Math\.abs\(pinLooseH - pinTightH\)/.test(SRC) && /if \(d >= 8\) pinDelta = Math\.min\(\d+, d\)/.test(SRC),
      '12.63d 高度差 = 两种状态的高度各量一次相减；差值过小（该页没有紧凑态）不许覆盖已知值');
    ok(/page\.id !== pinMeasurePage/.test(SRC),
      '12.63d1 测量按页面隔离 —— 色卡库/统计页的 .pinned 高度差不能混进来');
    ok(/setTimeout\(measurePinHeights, \d+\)/.test(SRC) && !/if \(h0 && h1\)/.test(SRC),
      '12.63d2 高度差是过渡落定后延时量的，不是改完 class 当场读的');
    ok(/pinFreeze = pinTight/.test(SRC) && /if \(pinFreeze !== null && y <= 1\)/.test(SRC),
      '12.63e 回顶动画期间冻结紧凑态，落地（y<=1）才解冻');
    ok(/PIN_FREEZE_OFF_EVENTS\.forEach\(t => \{[\s\S]{0,200}removeEventListener/.test(SRC) &&
      /'scrollend'/.test(SRC),
      '12.63f 冻结必须能被「滚动停止 / 用户动手」打断，否则会卡在紧凑态');
    ok(/if \(landed\) window\.scrollTo\(0, 0\)/.test(SRC),
      '12.63g 落地展开会把内容推下 65px，锚定顺势顶回 scrollY —— 必须钉回 0');

    /* —— 结构：工作台把该冻的东西包住 —— */
    ok(/<div class="pinned" id="invPinned">[\s\S]{0,3000}id="statsBar"[\s\S]{0,12000}id="colorActiveBar"[\s\S]{0,400}<\/div><!-- \/#invPinned/.test(SRC),
      '12.64 库存页：统计卡 + 工具栏 + 已选色条都进了 #invPinned');
    ok(/<div class="pinned" id="swPinned">[\s\S]{0,4000}id="swActiveBar"[\s\S]{0,200}<\/div><!-- \/#swPinned/.test(SRC),
      '12.65 色卡库：搜索 + 筛选进了 #swPinned（hero 是介绍文案，跟着滚走）');

    /* —— 工具栏瘦身：高频留在一行，其余进抽屉 —— */
    const pinnedHtml = (SRC.match(/<div class="pinned" id="invPinned">([\s\S]*?)<!-- \/#invPinned/) || [])[1] || '';
    ok(pinnedHtml.length > 1000, '12.66 能切出 #invPinned 的内容（切不出来后面的断言全是空转）');
    ok(!/id="brandFilters"/.test(pinnedHtml.split('id="filterDrawer"')[0]),
      '12.67 品牌筛选不在工具栏主行（它和材质/标签一起收进抽屉，否则要占第二行）');
    ok(/id="filterDrawer"[\s\S]{0,4000}id="brandFilters"[\s\S]{0,800}id="materialFilters"[\s\S]{0,800}id="tagFilters"/.test(pinnedHtml),
      '12.68 抽屉里依次是品牌 / 材质 / 标签');
    ok(/\.fd-panel\s*\{[^}]*position:\s*absolute/.test(SRC),
      '12.69 抽屉是绝对定位 —— 展开时不推内容、不改吸顶高度（换成 in-flow 就又变回两层）');
    ok(/\.fd-panel\s*\{[^}]*max-height:/.test(SRC) && /overflow-y:\s*auto/.test(SRC),
      '12.70 抽屉限高可滚（品牌多到几十个时不能撑出屏幕）');
    ok(/function toggleFilterDrawer\(\)/.test(SRC) && /function closeFilterDrawer\(\)/.test(SRC),
      '12.71 抽屉能开能关，Esc 与外部点击都接上了');
    ok(/function moreFilterCount\(\)[\s\S]{0,600}sortMode !== 'default'[\s\S]{0,200}amsFilter[\s\S]{0,120}usedFilter/.test(SRC),
      '12.72 徽标统计抽屉里的 6 个条件（颜色不算 —— 它自己就带徽标；排序任意档位都算生效）');

    /* —— 统计卡可下钻 —— */
    ok(/<button type="button" class="stat-card" onclick="statJump\('total'\)"/.test(SRC),
      '12.73 统计卡是 <button>（键盘可聚焦、回车可点），不是 div 假按钮');
    ok(/function statJump\(k\)[\s\S]{0,400}resetInvFilters\(\)/.test(SRC),
      '12.74 点「耗材总数」= 清空筛选（只切状态不清其它维度，数字会对不上）');
    ok(/function resetInvFilters\(\)[\s\S]{0,700}clearColorFilter\(\)[\s\S]{0,300}flushSearch\(\)/.test(SRC),
      '12.75 重置同时清颜色与搜索框（只清筛选不清搜索是最常见的「点了我以为变了」）');

    /* —— 危险操作归位 —— */
    ok(/id="clearFinishedBtn"/.test(SRC) && !/filter-group[\s\S]{0,300}id="clearFinishedBtn"/.test(pinnedHtml),
      '12.76 「清理用完」已离开筛选行（它原来是红色危险按钮，紧挨着「已用完」两像素）');
    ok(/st-card danger[\s\S]{0,1600}id="clearFinishedBtn"/.test(SRC),
      '12.77 它落在数据管理的「危险操作」卡里，和另外两个破坏性操作并列');

    /* —— 批量条吸底 —— */
    ok(/\.batch-bar\s*\{[^}]*position:\s*fixed[^}]*bottom:/.test(SRC),
      '12.78 批量条吸底（原来插在统计卡下面，进编辑模式把内容整体下推 76px，选中第 50 条时早就滚没了）');
    ok(/body\.batch-on main\s*\{\s*padding-bottom:/.test(SRC),
      '12.79 批量条出现时给 main 垫底（否则最后一排永远被它压住）');
    ok(/body\.batch-on \.to-top\s*\{\s*bottom:/.test(SRC),
      '12.80 同屏时回到顶部按钮抬高让位（两个都贴右下角会叠在一起）');
    ok(!/id="invPinned"[\s\S]{0,400}id="batchBar"/.test(SRC),
      '12.81 批量条已脱离 #invPinned（否则它会跟着 sticky 一起停在半空）');

    /* —— 切页回顶 —— */
    ok(/function switchPage\(p\)[\s\S]*?window\.scrollTo\(0, 0\);\s*\n\s*paintPinnedH\(\);\s*\n\s*paintPinned\(\);/.test(SRC),
      '12.82 切页就回顶（停在上一页中段看新页面的中段，等于没有上下文）');

    /* —— 卡片底栏换成两个会变的数字 —— */
    ok(/class="cf-k">库存</.test(SRC) && /class="cf-k">90天</.test(SRC),
      '12.83 卡片底栏是「库存 kg / 90 天 g」两个会变的数字');
    ok(/const kg = \(\(Number\(d\.weight\) \|\| 0\) \* \(Number\(d\.qty\) \|\| 0\)\) \/ 1000;/.test(SRC),
      '12.84 库存重量按「卷数 × 单卷规格」算（规格本身只在 title 里）');
    ok(!/class="weight-display"/.test(SRC) && !/class="spool-status/.test(SRC),
      '12.85 「1 ×1000g · 有料盘」那行已删（规格是常量，有料盘是默认态，都不产生决策）');
    ok(/class="no-spool-badge"/.test(SRC),
      '12.86 「无料盘」仍是左上角红色角标 —— 有料盘不标，默认态不该占地方说话');
    ok(/const keepY = window\.pageYOffset/.test(SRC)
      && /if \(keepY > 0 && \(window\.pageYOffset \|\| 0\) < keepY - 1\)/.test(SRC),
      '12.87 renderAll 记得补回滚动位置（innerHTML 清空瞬间页面塌高，scrollY 会被永久夹到 0）');

    /* ══════════════════════════════════════════════════
       十三、其它标签页（色卡库 / 统计 / 数据管理 / 打印机）
    ══════════════════════════════════════════════════ */
    console.log('── 十三、其它标签页结构 ──');

    /* —— 色卡库：分组 + 折叠 —— */
    ok(/const SW_GROUP_PREVIEW = 12;/.test(SRC),
      '13.1 色卡库每组默认只摊开 12 张（692 张全铺 = 30227px）');
    ok(/function swGroupsHtml\(\)/.test(SRC) && /function swGroupHtml\(fam, items, forceOpen, noHead\)/.test(SRC),
      '13.2 网格视图按色系分组渲染');
    ok(/const fams = \[\.\.\.buckets\.keys\(\)\]\.sort\(\(a, b\) => SW_FAM_ORDER\.indexOf\(a\) - SW_FAM_ORDER\.indexOf\(b\)\)/.test(SRC),
      '13.3 组的顺序按色相固定，换排序方式时组不会整体乱跳');
    ok(/const forceOpen = swKeyword\.length > 0;/.test(SRC),
      '13.4 搜索时全部展开（已经在缩小范围了，不该再藏）');
    ok(/function swToggleGroup\(fam\)/.test(SRC) && /swGroupOpen\.has\(fam\)/.test(SRC),
      '13.5 展开/收起是逐组状态');
    ok(/\.sw-group-hd \{[\s\S]{0,420}?position: sticky/.test(SRC)
      && /top: calc\(var\(--chrome-h\) \+ var\(--tabs-h\) \+ var\(--tabs-gap\) \+ var\(--pinned-h, 0px\)\)/.test(SRC),
      '13.6 组标题吸在吸顶工作台下面（--pinned-h 实测，不写死）');
    ok(/function paintPinnedH\(\)/.test(SRC)
      && /document\.querySelectorAll\('\.pinned'\)\.forEach\(p => roPin\.observe\(p\)\)/.test(SRC),
      '13.7 --pinned-h 由 ResizeObserver 跟着 pinned 高度变（筛选胶囊条一出现就长高）');
    ok(!/`<span class="sw-chip2">\$\{swFamily\(it\.hex\)\}<\/span>`/.test(SRC),
      '13.8 卡片不再重复写色系（组标题已经说了，692 张卡各写一遍是纯冗余）');

    /* —— 色卡库：品牌名录从页面底部搬到首屏 —— */
    ok(/id="swBrandModal"/.test(SRC) && /function openSwBrands\(\)/.test(SRC),
      '13.9 品牌名录是弹层，入口在 hero 里');
    ok(!/class="sw-brands"/.test(SRC),
      '13.10 页面底部那块常驻品牌网格已移除（它原来在 y≈29800）');
    ok(/swBrandPrevFocus/.test(SRC),
      '13.11 弹层开合管焦点（关掉后焦点不能丢给 body）');

    /* —— 统计页：KPI 不再重复 —— */
    ok(/if \(stScope !== 'remain'\) \{/.test(SRC) && /l:'当前口径合计'/.test(SRC),
      '13.12 「当前口径合计」只在含已用完时出现（默认范围和「库存卷数」是同一个数）');
    ok(/class="st-kpi-sub" title="\$\{stEsc\(it\.s\)\}"/.test(SRC),
      '13.13 KPI 副标省略后能 hover 看全文');

    /* —— 统计页：吸顶控制条 —— */
    ok(/<div class="pinned" id="stPinned">/.test(SRC),
      '13.14 统计页的口径/范围条也吸顶（原来翻到交叉表就只能滚回顶部）');
    ok(/#stPinned \.st-ctrl \{ margin-bottom: 0; \}/.test(SRC),
      '13.15 吸顶时那 16px 外边距交给 .pinned 管，不跟着冻在屏幕上');

    /* —— 统计页：交叉表与配色 —— */
    ok(/class="cell \$\{v \? 'has' : 'zero'\}"/.test(SRC),
      '13.16 交叉表格子分有值/零值两种（零值不再画「–」）');
    ok(/--heat:\$\{p\}%;--heat-d:\$\{Math\.round\(p \* 0\.38\)\}%/.test(SRC),
      '13.17 热度同时给亮/暗两档强度（深色 accent 更亮，同样比例会糊住数字）');
    ok(!/background:rgba\(77,217,192/.test(SRC),
      '13.18 交叉表不再硬编码青色 rgba（暗色主题下会把数字淹掉）');
    ok(/function stNameIdx\(name\)/.test(SRC) && /: stNameColor\(x\.name\)/.test(SRC),
      '13.19 品牌/材质按名字定色，不再是排序位次（换个口径颜色就换人）');
    ok(/const ST_MAT_ORDER = \['PLA','PETG','ABS','TPU','ASA'/.test(SRC),
      '13.20 材质走固定枚举顺序取色，哈希只做兜底（5 个名字落 16 槽会撞）');

    /* —— 数据管理页 —— */
    ok(/const used  = all\.filter\(r => r\.n > 0\)\.sort\(\(a, b\) => b\.n - a\.n\);/.test(SRC)
      && /其余 \$\{empty\.length\} 项为空/.test(SRC),
      '13.21 存储占用只列非空项，空的收进「其余 N 项为空」');
    ok(/function dmToggleEmptyKeys\(\)/.test(SRC),
      '13.22 空项可以展开看（不是删掉，是收起来）');
    ok(/<!-- 危险操作：从整行挪进右栏。/.test(SRC) && /class="st-card danger dm-danger"/.test(SRC),
      '13.23 危险操作落在右栏底部，两栏高度齐平且在一屏内');
    ok(!/border-bottom: 1px solid oklch\(24% 0\.012 240\)/.test(SRC),
      '13.24 存储明细与 TOP10 的分隔线改用 --border（原来硬编码暗色，浅色主题下是一条深灰）');

    /* —— 打印机页 —— */
    ok(/<div id="prnOfflineData" hidden>/.test(SRC) && /<div id="prnDataArea">/.test(SRC),
      '13.25 四张流水卡收进 #prnDataArea，离线换成 #prnOfflineData');
    ok(/dataArea\.hidden = !printerOnline;/.test(SRC) && /offData\.hidden = printerOnline;/.test(SRC),
      '13.26 离线态不再摆 4 张「暂无记录」+ 4 个点不出东西的刷新按钮');
    ok(/refreshBtn\.hidden = !printerOnline;/.test(SRC),
      '13.27 离线时 hero 的「刷新」按钮藏起来（点了什么也不会变）');
    ok(/function prnRecheckAgent\(\)/.test(SRC) && /toast\(ok \? '本地服务已连接'/.test(SRC),
      '13.28 「重新检测服务」有反馈（静默重探等于让用户再点一次）');
    ok(/class="prn-sec"><span>设备与连接<\/span>/.test(SRC) && /class="prn-sec"><span>对账与流水<\/span>/.test(SRC),
      '13.29 打印机页分成「设备与连接 / 对账与流水」两段');
    ok(!/class="st-card" style="margin-top:16px"/.test(SRC),
      '13.30 卡片间距不再靠 9 处内联 margin-top，统一在容器层');

    /* —— 全站一致性 —— */
    ok(/color: var\(--text-2\); transition: color 0\.18s var\(--ease-out\)/.test(SRC)
      && !/font-weight: 600;\s*\n\s*color: var\(--text-3\); transition: color 0\.18s/.test(SRC),
      '13.31 未选中页签用 --text-2（深色下 48% 灰压 11% 底只有 3.4:1）');
    ok(!/class="sw-hero"/.test(SRC) && !/\.sw-hero-title/.test(SRC),
      '13.32 色卡库 hero 并入 .st-hero，四个页面标题字号一致');

    /* ══════════ 十四、卡片色块洪水（单例 canvas） ══════════ */
    console.log('── 十四、卡片色块洪水 ──');

    ok(/function fxEnter\(/.test(SRC) && /function fxPark\(/.test(SRC) && /function fxDraw\(/.test(SRC),
      '14.1 洪水模块自成一套 enter/park/draw，没有塞进 filamentCardHtml');
    eq((SRC.match(/createElement\('canvas'\)/g) || []).length, 1,
      '14.2 全文件只有一处创建 canvas（单例池化）');
    eq((SRC.match(/getContext\('webgl'/g) || []).length, 1,
      '14.3 只有一处 getContext("webgl")（每卡一个上下文会撞浏览器 16 个的上限）');
    ok(!/<canvas/.test(SRC),
      '14.4 卡片模板里没有 canvas 标签（200 卡 × 2 视图 = 400 个节点，只能是运行时单例）');
    ok(/\.card-fx \{[\s\S]{0,240}?position: absolute; inset: 0;[\s\S]{0,240}?z-index: 0; pointer-events: none;/.test(SRC),
      '14.5 .card-fx 绝对定位、z-index 0、不吃指针（否则会挡住编辑/用完/删除）');
    ok(/\.card-fx \{[\s\S]{0,200}?width: 100%; height: 100%;/.test(SRC),
      '14.6 canvas 显式写死 100%/100%（replaced element 光靠 inset:0 撑不满，只盖左上角）');
    ok(/uniform float uProg/.test(SRC) && /uProg <= 0\.0005/.test(SRC) && /gl_FragColor = vec4\(0\.0\); return;/.test(SRC),
      '14.7 uProg=0 时片元直接输出 vec4(0)：静止态与改造前逐像素一致');
    ok(/smoothstep\(edge - 0\.16, edge, dist\)/.test(SRC) && !/smoothstep\(edge, edge -/.test(SRC),
      '14.8 smoothstep 一律升序传参（edge0>=edge1 在 GLSL ES 里是未定义行为）');
    ok(/function cardFxAfterRender\(/.test(SRC) && /cardFxAfterRender\(\);/.test(SRC),
      '14.9 renderAll 末尾有 cardFxAfterRender 兜底（20+ 条渲染路径的唯一收敛点）');
    ok(/document\.elementFromPoint/.test(SRC),
      '14.10 重建后用 elementFromPoint 找回卡片（鼠标不动时不会再发 pointerover）');
    ok(/addEventListener\('pointerover'/.test(SRC) && /addEventListener\('pointerout'/.test(SRC)
      && /relatedTarget/.test(SRC),
      '14.11 用会冒泡的 pointerover/pointerout 委托，靠 relatedTarget 判卡内移动');
    ok(!/addEventListener\('pointermove'/.test(SRC),
      '14.12 不新增全局 pointermove（坐标只挂在被悬停的那张卡上，与 12.10 同一条纪律）');
    ok(/\(prefers-reduced-motion: reduce\)/.test(SRC) && /\(hover: none\)/.test(SRC),
      '14.13 动效受 prefers-reduced-motion 与 (hover:none) 双重约束');
    ok(/preserveDrawingBuffer: !!s\.debug/.test(SRC) && !/preserveDrawingBuffer: true/.test(SRC),
      '14.14 默认不开 preserveDrawingBuffer（每帧多一次全画布拷贝），只给 ?cardfx=1 探针用');

    const dmaxOf = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
    const cw = J('fxColors("#FFFFFF")');
    const cb = J('fxColors("#101014")');
    const cg = J('fxColors("#808080")');
    const cr = J('fxColors("#C12E1F")');
    ok(Math.max(dmaxOf(cw.base, cw.hi), dmaxOf(cw.base, cw.lo)) > 0.10,
      '14.15 纯白也拉得出可见的三色（L 到顶就靠冷色相淡彩，不靠亮度）');
    ok(Math.max(dmaxOf(cb.base, cb.hi), dmaxOf(cb.base, cb.lo)) > 0.10,
      '14.16 近黑也拉得出可见的三色（提亮封顶 +0.26，不会跨成另一个色系）');
    ok(Math.max(dmaxOf(cg.base, cg.hi), dmaxOf(cg.base, cg.lo)) > 0.15
      && (cg.hi[2] - cg.hi[0]) > 0.02,
      '14.17 灰色注入冷色相后明度与彩度都分得开（否则白/灰卡就是三条灰糊成一片）');
    ok(Math.max(dmaxOf(cr.base, cr.hi), dmaxOf(cr.base, cr.lo)) > 0.25,
      '14.18 高饱和色仍然有足够明暗差（洪水靠厚度而不是换色相）');
    ok(J('fxParseColor("#abc")').length === 3
      && Math.abs(J('fxParseColor("rgb(74,144,217)")')[0] - 0.2902) < 0.01,
      '14.19 解析器兼容 #RGB 与 rgb()（入口不设防会埋雷）');

    /* 前面的用例可能已经把 data 清空，这里重新灌一份再验降级路径 */
    ev('data = ' + JSON.stringify(SEED) + '.map(normalizeItem); renderAll();');
    const fxCard = w.document.querySelector('#gridView .filament-card') || w.document.querySelector('.filament-card');
    let fxThrew = false;
    try {
      const ev2 = new w.Event('pointerover', { bubbles: true });
      fxCard.dispatchEvent(ev2);
      fxCard.querySelector('.card-swatch').dispatchEvent(new w.Event('pointerover', { bubbles: true }));
    } catch (e) { fxThrew = true; }
    ok(!fxThrew, '14.20 没有 WebGL 的环境里悬停不抛错（getContext 返回 null 即静默降级）');
    eq(w.document.querySelectorAll('canvas').length, 1,
      '14.21 无论数据多少，文档里恒为 1 个 canvas');

    /* ══════════ 十五、入库时间排序 ══════════ */
    console.log('── 十五、入库时间排序 ──');

    /* 静态：这几条是「别在后续重构里把时间排序悄悄摘掉」的护栏 */
    ok(/let sortMode = 'default';[^\n]*'new'[^\n]*'old'/.test(SRC),
      '15.1 sortMode 的取值域里写明了 new / old 两档');
    ok(/function setSortMode\(v\)\s*\{\s*sortMode = \(v === 'usage' \|\| v === 'new' \|\| v === 'old'\)/.test(SRC),
      '15.2 setSortMode 走白名单（随便传字符串不能被当成合法档位）');
    ok(/else if \(sortIsTime\(\)\) \{\s*\n\s*out\.sort\(invTimeCmp\);/.test(SRC),
      '15.3 getFiltered 的排序分支里有时间排序');
    ok(/if \(ta === null\) return tb === null \? 0 : 1;/.test(SRC)
      && /if \(tb === null\) return -1;/.test(SRC),
      '15.4 未知入库时间一律沉底（升序时也不许它们冒到顶部）');
    ok(/id="sortTimeBtn"[^>]*onclick="toggleTimeSort\(\)"/.test(SRC),
      '15.5 抽屉里有「入库时间」按钮，且它是独立的方向切换（不是三档单选）');
    ok(/if \(sortMode !== 'default'\) n\+\+;/.test(SRC),
      '15.6 抽屉徽标把时间排序也算作生效条件（否则排序换了徽标不动）');
    ok(/sortDefaultBtn'\)\.classList\.toggle\('active', sortMode === 'default'\)/.test(SRC),
      '15.7 「默认顺序」的选中态只认 default（原来写 !== usage，时间排序时它也亮）');
    ok(/\.card-when \{/.test(SRC) && /sortIsTime\(\) \? invDateLabel\(d\.createdAt\) : ''/.test(SRC),
      '15.8 卡片上有入库日期标，但只在时间排序时渲染');
    ok(/else if \(sortIsTime\(\)\) g\.items\.sort\(invTimeCmp\);/.test(SRC),
      '15.9 色系墙组内也按时间排（组序仍按色相，那是索引）');
    ok(/\.list-when \{/.test(SRC) && /list-when/.test(SRC),
      '15.10 列表视图的品牌行也带日期，两种视图口径一致');

    /* 行为：真的排一遍。时间戳刻意一会早一会晚、还夹两条拿不到时间的 */
    ev(`data = [
      {id:901,name:'C-九月',brand:'T',material:'PLA',color:'#C12E1F',weight:1000,qty:1,createdAt:'2026-09-14T10:00:00.000Z'},
      {id:902,name:'A-十月',brand:'T',material:'PLA',color:'#4A90D9',weight:1000,qty:1,createdAt:'2026-10-20T08:00:00.000Z'},
      {id:903,name:'X-无时间',brand:'T',material:'PLA',color:'#FFFFFF',weight:1000,qty:1},
      {id:904,name:'B-去年',brand:'T',material:'PLA',color:'#101014',weight:1000,qty:1,createdAt:'2025-03-02T08:00:00.000Z'},
      {id:905,name:'Y-坏时间',brand:'T',material:'PLA',color:'#F5761A',weight:1000,qty:1,createdAt:'not-a-date'},
      {id:906,name:'D-十月末',brand:'T',material:'PLA',color:'#5BD6A8',weight:1000,qty:1,createdAt:'2026-10-28T23:00:00.000Z'}
    ].map(normalizeItem); renderAll();`);
    const order = () => J('getFiltered().map(d => d.name)');

    ev("setSortMode('new')");
    eq(order(), ['D-十月末', 'A-十月', 'C-九月', 'B-去年', 'X-无时间', 'Y-坏时间'],
      '15.11 入库新→旧');
    eq(w.document.getElementById('sortTimeBtn').textContent, '入库 新→旧',
      '15.12 按钮文案写着当前方向（新→旧）');
    ok(w.document.getElementById('sortTimeBtn').classList.contains('active')
      && !w.document.getElementById('sortDefaultBtn').classList.contains('active'),
      '15.13 时间排序时「入库」亮、「默认顺序」灭');

    ev("toggleTimeSort()");
    eq(order(), ['B-去年', 'C-九月', 'A-十月', 'D-十月末', 'X-无时间', 'Y-坏时间'],
      '15.14 再点一次翻成旧→新，两条未知时间仍然沉底');
    eq(w.document.getElementById('sortTimeBtn').textContent, '入库 旧→新',
      '15.15 文案跟着翻成旧→新');

    eq(w.document.querySelectorAll('#gridView .card-when').length, 4,
      '15.16 时间排序下 4 条有时间戳的卡片显示日期（2 条无时间的没有标）');
    ok(/^(\d{2}-)?\d{1,2}-\d{1,2}$/.test((w.document.querySelector('#gridView .card-when') || {}).textContent || ''),
      '15.17 日期是 M-D（今年省年份），跨年才补两位年份 —— 不是一坨 ISO 串');

    ev("setSortMode('default')");
    eq(order(), ['C-九月', 'A-十月', 'X-无时间', 'B-去年', 'Y-坏时间', 'D-十月末'],
      '15.18 切回默认顺序 = 原样（data 数组序，不是被时间排过的残序）');
    eq(w.document.querySelectorAll('#gridView .card-when').length, 0,
      '15.19 默认顺序下卡片上不出现日期标（平时不占位置）');

    eq(w.eval('invDateLabel(new Date(2024, 2, 5).toISOString())'), '24-3-5',
      '15.20 跨年补两位年份，免得把去年的 3-5 看成今年');
    eq(w.eval('invDateLabel("")') + '|' + w.eval('invDateLabel("nope")'), '|',
      '15.21 空值/坏值返回空串，不抛错也不显示 1970');

    /* 同一毫秒（批量导入）应当保原序 —— 依赖 ES2019 的稳定排序 */
    ev(`data = [
      {id:911,name:'同批1',brand:'T',material:'PLA',color:'#C12E1F',weight:1000,qty:1,createdAt:'2026-10-01T00:00:00.000Z'},
      {id:912,name:'同批2',brand:'T',material:'PLA',color:'#C12E1F',weight:1000,qty:1,createdAt:'2026-10-01T00:00:00.000Z'},
      {id:913,name:'同批3',brand:'T',material:'PLA',color:'#C12E1F',weight:1000,qty:1,createdAt:'2026-10-01T00:00:00.000Z'}
    ].map(normalizeItem); renderAll(); setSortMode('new');`);
    eq(order(), ['同批1', '同批2', '同批3'], '15.22 同一时刻入库的保录入原序（稳定排序）');

    /* 色系墙组内 */
    ev("setSortMode('old')");
    eq(J("famGroups(getFiltered())[0].items.map(d => d.name)"), ['同批1', '同批2', '同批3'],
      '15.23 色系墙组内在时间排序下也是这一套比较器');

    ev('resetInvFilters()');
    eq(ev('sortMode'), 'default', '15.24 重置全部筛选把排序一起收回默认');
    eq(w.document.getElementById('sortTimeBtn').textContent, '入库 新→旧',
      '15.25 重置后按钮文案回到新→旧（下次点它就是最近的在前）');

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
}, 150);
