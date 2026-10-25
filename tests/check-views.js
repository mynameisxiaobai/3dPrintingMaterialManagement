/* check-views.js — 三种视图（网格 / 列表 / 色系墙）+ 默认视图偏好
   运行：node tests/check-views.js
   不联网，fetch 永不 resolve（agent 视为离线）。

   覆盖：首屏默认视图、fmDefaultView 的读写（裸字符串，不能走 lsGet）、
         色系分组的汇总数字（卷数 / 色数 / 克重 / 低库存）、色带段数与权重、
         卡片墙结构（4 列网格 / 卡内截断 / 「还有 N 卷」）、
         行内展开面板（toggleFamPanel，插入位置与焦点）、
         颜色筛选与统计页跳转、编辑模式与勾选联动（含迷你卷，且编辑模式不截断）、
         密度与行档两组偏好、迷你卷详情浮层（锚定浮层 #spoolPop）、
         以及「不许退回 hover 展开」「不许复活折叠状态机」的防回退断言。
   两个必须绕开的坑见 check-match.js 头部注释（http:// url、w.eval）。
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
    eq($$('#famView .fam-body[hidden]').length + $$('#famView .fam-grp.is-expanded').length, 0,
      '1.13 首屏没有隐藏内容、没有展开中的卡片');
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

    /* ══════════ 五、卡片墙与行内展开面板 ══════════ */
    console.log('── 五、卡片墙与行内展开面板 ──');

    const hd = () => grp('红').querySelector('.fam-hd');
    const body = () => grp('红').querySelector('.fam-body');
    const panel = () => $('#famPanel');

    eq($$('#famView .fam-wall').length, 1, '5.0 卡片墙容器 .fam-wall 只有一个');
    eq($$('#famView .fam-wall > .fam-grp').length, 4, '5.1 每个色系一张卡（夹具里 4 个）');
    eq(hd().getAttribute('aria-expanded'), 'false', '5.2 卡片初始 aria-expanded=false');
    ok(!hd().hasAttribute('aria-controls'), '5.3 未展开的卡不挂 aria-controls（13 个控件不能都声称控制同一元素）');

    ev('toggleFamPanel("红")');
    ok(!!panel(), '5.4 点卡 → 插入行内面板 #famPanel');
    ok(panel().parentElement === $('#famView .fam-wall'), '5.5 面板是 .fam-wall 的直接子元素');
    ok(panel().classList.contains('fam-panel'), '5.6 面板挂 .fam-panel（grid-column:1/-1 占满整行）');
    eq(panel().dataset.fam, '红', '5.7 面板记住自己属于哪一组');
    eq(hd().getAttribute('aria-expanded'), 'true', '5.8 展开态 aria-expanded=true');
    eq(hd().getAttribute('aria-controls'), 'famPanel', '5.9 只有展开的那张卡指向 famPanel');
    ok(grp('红').classList.contains('is-expanded'), '5.10 卡片进 .is-expanded（外壳染族色边）');
    ok(body().hasAttribute('hidden'), '5.11 卡内内容让位（内容已进面板，留个空框只会碍眼）');
    eq($$('#famPanel .spool-chip').length, 3, '5.12 面板里是该组全部 3 条（不受卡内截断影响）');
    eq($$('#famPanel .fam-ribbon').length, 1, '5.13 面板头有实时色带（卡头放不下，这里才成立）');
    eq(w.document.activeElement && w.document.activeElement.id, 'famPanel',
      '5.14 焦点进入面板（DOM 上它隔了 3 张卡，按 Tab 走不到）');

    ev('toggleFamPanel("红")');
    ok(!panel(), '5.15 再点同一张卡 → 面板移除（开关语义）');
    eq(hd().getAttribute('aria-expanded'), 'false', '5.16 aria-expanded 复位');
    ok(!hd().hasAttribute('aria-controls'), '5.17 aria-controls 摘掉');
    ok(!body().hasAttribute('hidden'), '5.18 卡内内容恢复');
    eq(w.document.activeElement && w.document.activeElement.className, 'fam-hd', '5.19 关闭后焦点回到卡头');

    /* 换卡：先收旧的再开新的，页面上只允许有一个面板 */
    ev('toggleFamPanel("红"); toggleFamPanel("蓝")');
    eq($$('#famPanel').length, 1, '5.20 换卡时只保留一个面板');
    eq(panel().dataset.fam, '蓝', '5.21 面板换成蓝组');
    ok(!grp('红').classList.contains('is-expanded'), '5.22 旧卡片退出展开态');
    ev('closeFamPanel()');
    ok(!panel(), '5.23 closeFamPanel 直接调用也能收');

    /* Esc 逐层关闭 */
    ev('openFamPanel("红")');
    w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    ok(!panel(), '5.24 Esc → 关闭面板');
    eq(w.document.activeElement && w.document.activeElement.className, 'fam-hd', '5.25 Esc 后焦点回到卡头');

    /* 切视图不能把面板留在原地：renderAll 在非 fam 视图下不重建 #famView */
    ev('openFamPanel("红")');
    ev('setView("grid")');
    ok(!panel(), '5.26 切到网格视图 → 面板被收掉（否则切回来还悬在那儿）');
    ev('setView("fam")');

    /* 插入位置：必须在该卡所在行的下一行行首 —— 插在行中间会把同排后两张甩到面板下方。
       jsdom 没有布局（offsetTop 恒 0），几何验收在 visual-spoolpop.js 里做，这里只验代码形状。 */
    ok(/function openFamPanel[\s\S]{0,1600}insertBefore\(panel, below \|\| null\)/.test(SRC),
      '5.27 面板插到「下一行第一个卡」之前，不是紧跟被点卡');
    ok(/function openFamPanel[\s\S]{0,1200}Math\.round\(el\.offsetTop\)/.test(SRC),
      '5.28 行判定用 offsetTop（getBoundingClientRect 含 transform：入场动画期间同行能差 6px）');

    /* ══════════ 六、颜色筛选与统计页跳转 ══════════ */
    console.log('── 六、颜色筛选与统计页跳转 ──');

    ev('toggleColorFam("红")');
    eq($$('#famView .fam-grp').length, 1, '6.1 按红筛选后墙上只剩一张卡');
    eq(grp('红') && grp('红').dataset.fam, '红', '6.2 留下的是红组');
    ev('toggleColorFam("红")');
    eq($$('#famView .fam-grp').length, 4, '6.3 解除筛选后 4 张卡全部回来');

    ev('stJump("family", "红")');
    ok(!!panel(), '6.4 统计页点色系跳库存 → 自动摊开该组面板（不摊开等于没跳到位）');
    eq(panel().dataset.fam, '红', '6.5 面板落在红组');
    ev('toggleColorFam("红"); closeFamPanel()');

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

    /* 截断不能影响编辑模式：toggleSelectAll 会选中全部条目，若只渲染前 N 条，
       就会出现「计数 10、一格都不亮」的失败态（updateAllVisuals 只遍历 DOM 里的 chip）。 */
    ev('famRows = "compact"');
    ev('data = Array.from({length:10}, function(_,i){ return normalizeItem({id:100+i,name:"红X"+i,color:"#C12E1F",weight:1000,qty:1}); }); renderAll()');
    eq($$('#famView .spool-chip').length, 4, '7.12 非编辑模式按紧凑档截断（10 条只露 4 条）');
    eq($('#famView .fam-grp .fam-more').textContent, '还有 6 卷', '7.13 「还有 N 卷」按卷数算，不按记录条数');
    ev('toggleEditMode()');
    eq($$('#famView .spool-chip').length, 10, '7.14 编辑模式一律不截断（否则全选会「数字跳了、一格都不亮」）');
    eq($$('#famView .fam-more').length, 0, '7.15 编辑模式下没有「还有 N 卷」按钮');
    ev('toggleEditMode()');
    ev('famRows = "default"; data = ' + JSON.stringify(SEED) + '.map(function(o){return normalizeItem(o)}); renderAll()');

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

    /* 面板里的 chip 也能开浮层；关面板时浮层必须跟着收 —— 否则锚点被移除，浮层会悬在半空 */
    ev('openFamPanel("红")');
    $('#famPanel .spool-chip[data-id="3"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    ok(!pop().hidden, '8.22a 面板里的迷你卷也能开详情浮层');
    ev('closeFamPanel()');
    ok(pop().hidden, '8.22 关闭面板时浮层一起收（锚点就在面板里，否则变成孤儿）');

    /* ══════════ 九、密度切换 ══════════ */
    console.log('── 九、密度切换 ──');

    ev('setFamDensity("card")');
    eq(ev('famDensity'), 'card', '9.0 setFamDensity 写入内存');
    eq(ev('localStorage.getItem("fmFamDensity")'), 'card', '9.1 落盘是裸字符串 fmFamDensity');
    eq($('#famView').getAttribute('data-density'), 'card', '9.2 data-density 同步');
    eq($$('#famView .filament-card').length, 5, '9.3 卡片密度每卡封顶 2 张（红组 3 条只露 2 张）');
    eq($$('#famView .spool-chip').length, 0, '9.4 卡片密度下没有迷你卷');
    ok($('#famView').innerHTML.indexOf('card-edit-overlay') >= 0, '9.5 卡片模板没被抽坏');
    eq($('#famView .fam-bar [data-famdens].on').textContent, '卡片', '9.6 密度分段控件高亮当前档');
    eq($$('#famView .fam-bar .folder-bar-btn.on').length, 2,
      '9.6b 两组分段控件各高亮一个（密度 + 行档）—— 都挂 .on 时 querySelector 会命中错的那个');
    eq($('#famView .fam-bar [data-famrows].on').textContent, '标准', '9.6c 行档分段控件高亮「标准」');

    ev('setFamDensity("mini")');
    eq($$('#famView .spool-chip').length, SEED.length, '9.7 切回迷你密度');
    eq($$('#famView .filament-card').length, 0, '9.8 迷你密度下完全不渲染整卡（省掉整套卡片字符串）');
    ev('setFamDensity("xxx")');
    eq(ev('famDensity'), 'mini', '9.9 setFamDensity 拒非法值');

    const wDense = boot({ fmFamDensity: 'card' });
    eq(wDense.eval('famDensity'), 'card', '9.10 预置 fmFamDensity=card → 首屏就是卡片密度');
    const wDenseBad = boot({ fmFamDensity: 'xxx' });
    eq(wDenseBad.eval('famDensity'), 'mini', '9.11 预置非法值 → 回落迷你');

    /* —— 行档：紧凑 / 标准，同样是设备本地裸字符串 —— */
    eq(ev('famRows'), 'default', '9.12 默认行档是「标准」');
    eq(ev('famCap()'), 8, '9.13 标准档迷你卷每卡 8 条（2 列 × 4 行）');
    ev('setFamRows("compact")');
    eq(ev('famRows'), 'compact', '9.14 setFamRows 写入内存');
    eq(ev('localStorage.getItem("fmFamRows")'), 'compact', '9.15 落盘是裸字符串 fmFamRows');
    eq(ev('famCap()'), 4, '9.16 紧凑档每卡 4 条（2 列 × 2 行）');
    ev('setFamDensity("card")');
    eq(ev('famCap()'), 1, '9.17 卡片密度 + 紧凑档 = 每卡 1 张（两套独立映射，不能共用一个行数）');
    ev('setFamRows("default")');
    eq(ev('famCap()'), 2, '9.18 卡片密度标准档 = 每卡 2 张（3 张会到 810px，墙就散了）');
    ev('setFamDensity("mini")');
    ev('setFamRows("xxx")');
    eq(ev('famRows'), 'default', '9.19 setFamRows 拒非法值');
    const wRows = boot({ fmFamRows: 'compact' });
    eq(wRows.eval('famRows'), 'compact', '9.20 预置 fmFamRows=compact → 首屏就是紧凑档');

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

    /* —— 每张卡的结构：族色左轨 / 系名 / 卷数 / 折角 / 内容网格 —— */
    eq($$('#famView .fam-grp').length, 4, '11.12 4 个色系各一张卡');
    ok($$('#famView .fam-grp').every(g => g.querySelector('.fam-hd .fam-rail')), '11.13 每张卡头都有族色左轨');
    ok($$('#famView .fam-grp').every(g => !g.querySelector('.fam-hd .fam-ribbon')),
      '11.14 卡头**不放**色带（315px 里只剩 40–70px，只会露出 1–2 段，零信息量）');
    ok($$('#famView .fam-grp').every(g => g.querySelector('.folder-name')), '11.15 每张卡头都有系名');
    ok($$('#famView .fam-grp').every(g => /卷/.test(g.querySelector('.folder-meta').textContent)),
      '11.16 每张卡头都有卷数（色数/克重挪进面板头）');
    ok($$('#famView .fam-grp').every(g => g.querySelector('.fam-caret')), '11.17 每张卡头都有折角');
    ok($$('#famView .fam-grp').every(g => g.querySelector('.fam-cards')), '11.18 每张卡都有内容网格');

    /* —— 4 列网格：不再是瀑布流列 —— */
    eq($$('#famView .fam-wall').length, 1, '11.19 卡片墙容器 .fam-wall 只有一个');
    ok($$('#famView .fam-list').length === 0, '11.19b 旧的 .fam-list 单列容器已删除');
    ok($$('#famView .fam-wall > .fam-grp').length === $$('#famView .fam-grp').length,
      '11.19c 所有卡片都是 .fam-wall 的直接子元素（面板插入时才不会算错行）');

    /* —— 低库存族在标题行里直接标出来 —— */
    ok(/1 低/.test(grp('黑').querySelector('.folder-meta').textContent), '11.20 黑组（余量 4%）标题行标出「1 低」');
    ok(!grp('蓝').querySelector('.fam-low'), '11.21 无低库存的组不显示该标记');

    /* —— 底脚汇总 + 顶栏 —— */
    eq($('#famView .fam-grp[data-fam="红"] .folder-name').textContent, '红色系', '11.22 标题行系名');
    const footMeta = $('#famView .fam-grp[data-fam="红"] .folder-meta').textContent;
    ok(/6/.test(footMeta) && !/色/.test(footMeta), '11.23 卡头只留卷数（色数/克重进面板头）');
    const barNums = $$('#famView .fam-bar .folder-stat b').map(e => e.textContent);
    eq(barNums, ['4', '5', '9', '7.50'], '11.24 顶栏汇总 = 色系 / 颜色 / 卷 / 克重');
    eq($$('#famView .fam-bar .folder-bar-btn').map(b => b.textContent).join('/'), '迷你/卡片/紧凑/标准',
      '11.25 顶栏四档：迷你 / 卡片 / 紧凑 / 标准');

    /* —— 空库：顶栏 + 列表一并消失 —— */
    ev('data = []; renderAll();');
    eq($('#famView').innerHTML, '', '11.26 空库时整个色系视图清空');

    /* ══════════ 十二、静态断言（防后人改回去） ══════════ */
    console.log('── 十二、静态断言 ──');

    const famCss = SRC.slice(SRC.indexOf('.fam-view { display: none'), SRC.indexOf('.list-item {'));

    /* 卡片墙：4 列网格 + 卡片外壳 + 卡头焦点环 */
    ok(/\.fam-wall\s*\{[^}]*display:\s*grid/.test(SRC), '12.1 .fam-wall 是网格卡片墙');
    ok(/\.fam-wall\s*\{[^}]*repeat\(auto-fill,\s*minmax\(min\(100%,\s*292px\),\s*1fr\)\)/.test(SRC),
      '12.2 4 列自适应（292px 下限 → 1304px 内容宽正好落 4 列）');
    ok(/\.fam-grp\s*\{[^}]*border-radius:\s*12px/.test(SRC),
      '12.3 卡片外壳自带圆角与描边（卡头不再自带边框，否则双线）');
    ok(/\.fam-hd:focus-visible\s*\{[^}]*outline-offset:\s*-2px/.test(SRC),
      '12.4 卡头焦点环用 -2px（overflow:hidden 会把外扩的环整圈裁掉）');
    ok(!/\.fam-body\s*\{[^}]*position:\s*absolute/.test(SRC), '12.5 已删除绝对定位浮层抽屉（不再遮挡下方色系）');
    ok(!/\.fam-body\s*\{[^}]*display:\s*grid/.test(SRC),
      '12.5b .fam-body 没有 display:grid（作者样式会盖掉 UA 的 [hidden]{display:none}，内容就收不起来了）');
    ok(!/visibility:\s*hidden/.test(famCss), '12.6 不靠 visibility:hidden 藏内容');

    /* hover 机制彻底删除 */
    ok(!/famPointerUpdate|famPointerInBoard|famHitTest|famSchedule|famBindPointer|bindFamHover/.test(SRC),
      '12.7 指针命中/静置判定那套已彻底删除');
    ok(!/FAM_HOVER_IN|FAM_SETTLE_PX|FAM_PAD_X/.test(SRC), '12.8 hover 常量已删除');
    ok(!/addEventListener\('pointermove'/.test(SRC), '12.9 没有 pointermove 驱动展开的监听');
    ok(!/famLocked|lockFam|syncFamLockBadge|famAnimate/.test(SRC), '12.10 点击锁定态与动画标记已删除');
    ok(!/\.folder-h::after/.test(SRC), '12.11 halo 抖动缓冲已删除');
    ok(!/\.folder-face|\.folder-tab|\.folder-strips|\.folder-low|perspective:\s*900px|rotateX\(-94deg\)/.test(SRC),
      '12.12 标签耳 / 马赛克封面 / 3D 翻盖 / 死代码 .folder-low 全部删除');
    ok(!/folderCardIn/.test(SRC), '12.13 卡片阶梯入场动画已删除（默认全展开时会让 200 张同时播）');
    ok(!/folderCols|\.folder-cols/.test(SRC), '12.14 瀑布流列测算（folderCols / .folder-cols）已删除');
    ok(!/_famResizeObserver/.test(SRC), '12.14b ResizeObserver 重排列的全局残留已删除');

    /* 新结构的存在性 */
    ok(/\.fam-panel\s*\{[^}]*grid-column:\s*1 \/ -1/.test(famCss),
      '12.15 .fam-panel 用 grid-column:1/-1 占满整行（内容本身是 .fam-wall 的直接子元素）');
    ok(/\.fam-rail\s*\{/.test(famCss), '12.16 .fam-rail 族色左轨存在');
    ok(/\.fam-ribbon\s*\{/.test(famCss), '12.17 .fam-ribbon 实时色带存在');
    ok(/\.spool-chip\s*\{/.test(famCss), '12.18 .spool-chip 迷你卷存在');
    ok(/\.fam-hd\s*\{[^}]*height:\s*46px/.test(famCss), '12.19 标题行 46px 常驻高度');
    ok(!/\.fam-hd:hover\s*\{[^}]*transform/.test(famCss), '12.20 标题行 hover 不做位移（整组内容会跟着晃）');
    ok(/\.fam-cards\s*\{[^}]*repeat\(2,\s*minmax\(0,\s*1fr\)\)/.test(SRC),
      '12.21 卡内固定 2 列（固定列数才能让 JS 按「2 列 × N 行」精确算截断条数）');
    ok(/\.fam-panel \.fam-cards\s*\{[^}]*minmax\(min\(100%,\s*196px\),\s*1fr\)\)/.test(SRC),
      '12.21b 面板网格 196px 起（整行宽时才排得下 6 列）');
    ok(/\.fam-view\[data-density="card"\] \.fam-cards/.test(SRC), '12.22 卡片密度有独立的列宽规则');
    ok(/\.fam-view\.edit-mode \.spool-chip::before/.test(SRC), '12.23 编辑模式勾选态用伪元素画（chip 内不能再嵌 button）');
    ok(/function spoolChipClick/.test(SRC), '12.24 迷你卷有独立点击处理器');
    ok(/if \(e\.target\.tagName === 'BUTTON'\) return/.test(SRC), '12.25 handleCardClick 仍拒绝 BUTTON 目标（所以 chip 不能复用它）');
    ok(/function openSpoolPop[\s\S]{0,4000}preventScroll: true/.test(SRC), '12.26 浮层聚焦带 preventScroll（否则滚页面 → 触发滚动关闭）');
    ok(/#spoolPop \{[^}]*position:\s*fixed/.test(SRC) && /#spoolPop \{[^}]*z-index:\s*150/.test(SRC),
      '12.27 浮层 fixed + z-index:150（压过 header 100，低于模态 200）');
    ok(/function closeSpoolPop/.test(SRC) && /function placeSpoolPop/.test(SRC), '12.28 浮层有独立的关闭与定位入口');
    ok(/closeSpoolPop\(\);[\s\S]{0,400}closeFamPanel\(\);[\s\S]{0,300}prnUsageMapReset\(\)/.test(SRC),
      '12.29 renderAll 开头先关浮层与面板（一次覆盖 20+ 调用点，含三条异步路径）');
    ok(/\.fam-view:not\(\.edit-mode\) \.card-action-btn\.edit-only/.test(SRC), '12.30 折叠视图的 edit-only 隐藏规则保留（卡片密度仍在用）');
    ok(SRC.indexOf('id="viewFam"') > 0 && SRC.indexOf('id="viewList"') > 0, '12.31 三个视图按钮都在');

    /* 偏好键：设备本地，不进同步 / 备份 / 服务端 */
    const syncBody = SRC.slice(SRC.indexOf('const SYNC = ['), SRC.indexOf('];', SRC.indexOf('const SYNC = [')));
    ok(syncBody.indexOf('fmDefaultView') < 0, '12.32 fmDefaultView 不进 FM.SYNC（设备本地偏好）');
    ok(syncBody.indexOf('fmFamDensity') < 0, '12.33 fmFamDensity 不进 FM.SYNC');
    ok(syncBody.indexOf('fmFamRows') < 0, '12.33b fmFamRows 不进 FM.SYNC');
    const dmBody = SRC.slice(SRC.indexOf('const DM_STORE_KEYS'), SRC.indexOf('\n];', SRC.indexOf('const DM_STORE_KEYS')));
    ok(dmBody.indexOf('fmDefaultView') < 0, '12.34 fmDefaultView 不进备份清单');
    ok(dmBody.indexOf('fmFamDensity') < 0, '12.35 fmFamDensity 不进备份清单');
    ok(dmBody.indexOf('fmFamRows') < 0, '12.35b fmFamRows 不进备份清单');
    const srvBody = fs.readFileSync(path.join(__dirname, '..', 'server', 'printer-store.js'), 'utf8');
    ok(srvBody.indexOf('fmDefaultView') < 0, '12.36 服务端 SYNC_KEYS 没有 fmDefaultView');
    ok(srvBody.indexOf('fmFamDensity') < 0, '12.37 服务端 SYNC_KEYS 没有 fmFamDensity');
    ok(srvBody.indexOf('fmFamRows') < 0, '12.37b 服务端 SYNC_KEYS 没有 fmFamRows');
    ok(/swViewMode\s*=\s*localStorage\.getItem\('swView'\)/.test(SRC), '12.38 swView 那条老路没被顺手改坏（仍是裸 getItem）');
    ok(/function fmPrefRaw[\s\S]{0,200}localStorage\.getItem/.test(SRC), '12.39 偏好走裸 getItem，不走 lsGet(JSON.parse)');
    ok(/lsSet\(FAM_DENSITY_KEY/.test(SRC), '12.40 密度写入走 lsSet（非 SYNC 键不会排 PUT）');
    ok(/lsSet\(FAM_ROWS_KEY/.test(SRC), '12.40b 行档写入同样走 lsSet');

    /* —— 防复活：折叠状态机与它的三层结构一概不许回来 —— */
    ok(!/famCollapsed|isFamOpen|applyFamOpen|famCollapseAll|famExpandAll|toggleFam\(/.test(SRC),
      '12.41 折叠状态机（Set + 五个函数）没有复活');
    ok(!/grid-template-rows:\s*0fr/.test(SRC), '12.42 折叠高度动画已删（卡片墙没有折叠态）');
    ok(!/\.fam-body-clip/.test(SRC), '12.43 三层折叠结构（.fam-body-clip）已删');
    ok(!/@supports not \(grid-template-rows/.test(SRC),
      '12.44 旧引擎降级块已删（留着会让不支持 fr 过渡的引擎上内容永久消失）');

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
