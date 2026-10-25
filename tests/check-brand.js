/* check-brand.js — 品牌库 / 色名库 / 材质关键词 完整性
   运行：node tests/check-brand.js
   不联网，fetch 永不 resolve（agent 视为离线）。

   覆盖：锐造新材（RUIZAO）品牌识别、在售系列色名、表面工艺→材质反推、
         以及「新增品牌时最容易踩的三个坑」：
         ① colorDB 字面量里重复声明同名键 → JS 静默覆盖，色值被悄悄改掉
         ② brandDB 别名过短（如两字母）→ includes 误命中任意字符串
         ③ materialKeywords 顺序写反 → 复合料规则变死代码（'PLA-CF' 被 'PLA' 抢先命中）
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
  if (sa === sb) pass++; else { fail++; fails.push(n + '  得到 ' + sa + ' 期望 ' + sb); console.log('  ✗ ' + n + '  得到 ' + sa + ' 期望 ' + sb); }
}

/* 锐造新材在售产品线对应的色名。
   本清单即断言源：谁把其中一条删了/改名了，这里立刻红。 */
const RZ_COLORS = [
  // PLA 哑光 matte（主力系列）
  '哑光浅灰', '哑光中灰', '哑光深灰', '哑光黑灰', '哑光米灰',
  '哑光豆沙红', '哑光桃粉', '哑光西柚', '哑光柠檬', '哑光抹茶',
  '哑光松石绿', '哑光松绿', '哑光雾霾紫', '哑光薰衣草', '哑光浅蓝',
  '哑光燕麦色', '哑光奶咖', '哑光焦糖', '哑光橄榄',
  // PLA 丝绸 silk（单色）
  '丝绸金', '丝绸银', '丝绸铜', '丝绸白', '丝绸黑', '丝绸红', '丝绸蓝',
  '丝绸绿', '丝绸紫', '丝绸粉', '丝绸橙', '丝绸灰', '丝绸香槟',
  // PLA 大理石 marble（含高速专线）
  '大理石黑', '大理石灰', '大理石绿', '大理石蓝', '大理石粉', '大理石棕', '高速大理石白',
  // PLA 木粉 wood（同一色收录「枫木」「枫木色」两种 SKU 写法）
  '枫木', '枫木色', '樱桃木', '樱桃木色', '黑胡桃', '黑胡桃木',
  '红木', '红木色', '檀木', '竹木', '竹木色',
  // PLA 夜光 glow
  '夜光白', '夜光橙', '夜光青', '夜光红',
  // 肤色 skin
  '深肤色', '自然肤色', '小麦色', '粉肤色',
  // 特殊效果
  '闪银', '星钻',
];

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
/* 顶层 let/const 不挂 window，且跨 realm 的对象原型不同
   → 一律 JSON 序列化后再取，避免 Array.isArray / instanceof 判定翻车 */
const J = c => JSON.parse(ev('JSON.stringify(' + c + ')'));

setTimeout(() => {
  try {
    /* ══════════ 一、库结构（静态解析，不依赖运行时） ══════════ */
    console.log('── 一、库结构 ──');

    const bStart = SRC.indexOf('const brandDB = [');
    const bBody = SRC.slice(bStart, SRC.indexOf('\n];', bStart));
    const cStart = SRC.indexOf('const colorDB = {');
    const cBody = SRC.slice(cStart, SRC.indexOf('\n};', cStart));

    // 别名清单（静态：只认 aliases:[...] 里的引号字符串）
    const aliasRows = [];
    bBody.replace(/\{\s*canonical\s*:\s*'([^']*)'\s*,\s*aliases\s*:\s*\[([^\]]*)\]/g, (m, canon, inner) => {
      const als = [];
      inner.replace(/'([^']*)'/g, (m2, a) => { als.push(a); return m2; });
      aliasRows.push({ canon, als });
      return m;
    });
    ok(aliasRows.length >= 41, '1.1 brandDB 解析到 ' + aliasRows.length + ' 个品牌（≥41）');
    ok(aliasRows.every(r => r.als.length > 0), '1.2 每个品牌都有别名');
    // detectBrand 内部会 toLowerCase + 去空格，这里必须用同一口径比对
    // （R3D / eSUN / Prusa 这类大小写不同的 canonical 是合法的）
    const norm = s => String(s).toLowerCase().replace(/\s+/g, '');
    ok(aliasRows.every(r => r.als.map(norm).includes(norm(r.canon))), '1.3 canonical 必须出现在自己的别名里（否则 detectBrand 选不中自己）');

    const canons = aliasRows.map(r => r.canon);
    ok(new Set(canons).size === canons.length, '1.4 canonical 全局唯一');

    // 别名归一化后不得跨品牌共享
    const owner = new Map();
    const cross = [];
    aliasRows.forEach(r => r.als.forEach(a => {
      const k = a.toLowerCase().replace(/\s+/g, '');
      if (owner.has(k) && owner.get(k) !== r.canon) cross.push(k + '(' + owner.get(k) + '/' + r.canon + ')');
      else owner.set(k, r.canon);
    }));
    eq(cross, [], '1.5 别名归一化后不跨品牌冲突');

    // 别名过短会误命中：两汉字/两字母以上才允许
    const tooShort = [];
    aliasRows.forEach(r => r.als.forEach(a => { if (a.trim().length < 2) tooShort.push(r.canon + ':' + a); }));
    eq(tooShort, [], '1.6 没有长度 <2 的别名');

    // colorDB 字面量里同名键出现两次 = 后者静默覆盖前者
    const keyCount = Object.create(null);
    cBody.replace(/(?:'([^']+)'|([A-Za-z_$][\w$]*))\s*:/g, (m, q, bare) => {
      const k = q || bare;
      keyCount[k] = (keyCount[k] || 0) + 1;
      return m;
    });
    const dupKeys = Object.keys(keyCount).filter(k => keyCount[k] > 1);
    eq(dupKeys, [], '1.7 colorDB 无重复键（重复声明会静默覆盖色值）');

    const cdb = J('colorDB');
    const badHex = Object.keys(cdb).filter(k => !/^#[0-9A-Fa-f]{6}$/.test(cdb[k]));
    eq(badHex, [], '1.8 colorDB 全部为合法 #RRGGBB');
    ok(Object.keys(cdb).length >= 505, '1.9 colorDB 至少 505 条（当前 ' + Object.keys(cdb).length + '）');

    /* ══════════ 二、锐造新材品牌识别 ══════════ */
    console.log('── 二、锐造新材品牌识别 ──');
    ok(J('brandDB.map(b=>b.canonical)').includes('锐造新材'), '2.1 brandDB 含「锐造新材」');
    const rz = J('brandDB.filter(b=>b.canonical==="锐造新材")[0]');
    ok(!!rz, '2.2 能取到锐造新材条目');
    const rzAlias = (rz && rz.aliases) || [];
    ['锐造新材', '锐造', 'ruizao', '锐造新材旗舰店'].forEach(a => ok(rzAlias.includes(a), '2.3 别名单包含 ' + a));

    eq(ev('detectBrand("锐造新材 PLA 哑光 白色 1KG/无线盘")'), '锐造新材', '2.4 全称 + 空格标题');
    eq(ev('detectBrand("锐造 PLA Basic 黑色")'), '锐造新材', '2.5 品牌简称');
    eq(ev('detectBrand("RUIZAO PETG 夜光 透明")'), '锐造新材', '2.6 大写英文名');
    eq(ev('detectBrand("Ruizao New Material PLA 丝绸金")'), '锐造新材', '2.7 英文全称（大小写混排）');
    eq(ev('detectBrand("ruizao 高速大理石 白")'), '锐造新材', '2.8 纯小写拼音');
    eq(ev('detectBrand("锐造新材旗舰店 木粉 枫木色")'), '锐造新材', '2.9 带店铺名');
    eq(ev('detectBrand("中山锐造 夜光 绿")'), '锐造新材', '2.10 产地前缀写法');

    // 反例：不能被别的品牌串走，也不能把别的品牌串成锐造
    eq(ev('detectBrand("三绿 PLA 白色")'), '三绿', '2.11 三绿不回归');
    eq(ev('detectBrand("兰博 PB 0001")'), '兰博', '2.12 兰博不回归');
    eq(ev('detectBrand("拓竹 PLA Basic 白色")'), '拓竹', '2.13 拓竹不回归');
    eq(ev('detectBrand("阿米阿米 哑光玉石白")'), '阿米阿米', '2.14 阿米阿米不回归');
    eq(ev('detectBrand("PLA 白色 1KG")'), null, '2.15 无品牌关键词返回 null（不是锐造）');
    eq(ev('detectBrand("")'), null, '2.16 空串返回 null');

    /* ══════════ 三、锐造新材色名 ══════════ */
    console.log('── 三、锐造新材色名（' + RZ_COLORS.length + ' 条） ──');
    const missColor = RZ_COLORS.filter(k => !(k in cdb));
    eq(missColor, [], '3.1 清单内色名全部存在于 colorDB');
    ok(new Set(RZ_COLORS).size === RZ_COLORS.length, '3.2 清单自身无重复');
    ok(RZ_COLORS.length >= 60, '3.3 覆盖 ≥60 条（当前 ' + RZ_COLORS.length + '）');

    // 每条都必须能自识别（长词优先表里没被更长的键抢走）
    const selfMiss = RZ_COLORS.filter(k => {
      const hit = J('detectColor(' + JSON.stringify(k) + ') || null');
      return !hit || hit.name !== k;
    });
    eq(selfMiss, [], '3.4 每条色名都能被 detectColor 命中自己（长词优先生效）');

    // 组合标题里也要能捞到正确色名
    const cname = s => { const r = J('detectColor(' + JSON.stringify(s) + ') || null'); return r ? r.name : null; };
    eq(cname('锐造新材 PLA哑光 哑光肤色 1KG'), '哑光肤色', '3.5 组合标题命中「哑光肤色」');
    eq(cname('锐造新材 高速大理石白 1KG'), '高速大理石白', '3.6 「高速大理石白」不被「大理石白」截断');
    eq(cname('锐造新材 黑胡桃木 1KG'), '黑胡桃木', '3.7 「黑胡桃木」不被「胡桃木」截断');
    eq(cname('锐造新材 大理石黑 1KG'), '大理石黑', '3.8 「大理石黑」不被「大理石」截断（旧行为会返回白色）');
    eq(cname('锐造新材 丝绸香槟 1KG'), '丝绸香槟', '3.9 丝绸单色系列');
    eq(cname('锐造新材 木粉 樱桃木色'), '樱桃木色', '3.10 木粉系列「X木色」写法');

    // 色值不能是同一个占位值敷衍（同系列色相要有区分度）
    const silkHex = ['丝绸金', '丝绸银', '丝绸蓝', '丝绸绿', '丝绸红'].map(k => cdb[k]);
    ok(new Set(silkHex).size === silkHex.length, '3.11 丝绸系列各色色值互不相同');
    const matteHex = ['哑光浅灰', '哑光中灰', '哑光深灰'].map(k => cdb[k]);
    ok(new Set(matteHex).size === 3, '3.12 哑光灰阶三档互不相同');

    /* ══════════ 四、材质识别 ══════════ */
    console.log('── 四、材质识别 ──');
    eq(ev('detectMaterial("锐造新材 PLA 哑光 白色")'), 'PLA', '4.1 标题含 PLA');
    eq(ev('detectMaterial("锐造新材 PLA Basic 黑色")'), 'PLA', '4.2 PLA Basic');
    eq(ev('detectMaterial("锐造新材 丝绸金 1KG")'), 'PLA', '4.3 只写工艺「丝绸」→ 反推 PLA');
    eq(ev('detectMaterial("锐造新材 高速大理石 白色")'), 'PLA', '4.4 只写「高速大理石」→ 反推 PLA');
    eq(ev('detectMaterial("锐造新材 木粉 枫木色")'), 'PLA', '4.5 只写「木粉」→ 反推 PLA');
    eq(ev('detectMaterial("锐造新材 夜光 绿")'), 'PLA', '4.6 只写「夜光」→ 反推 PLA');
    eq(ev('detectMaterial("锐造新材 PETG 夜光 透明")'), 'PETG', '4.7 工艺词不得抢走 PETG');
    eq(ev('detectMaterial("锐造新材 哑光 PETG 白色")'), 'PETG', '4.8 哑光 PETG 仍是 PETG');
    eq(ev('detectMaterial("锐造新材 ABS 黑色")'), 'ABS', '4.9 ABS');
    eq(ev('detectMaterial("锐造新材 TPU 95A")'), 'TPU', '4.10 TPU');
    // 复合料：修复前 'PLA-CF' 被前面的 'PLA' 抢先命中，这条规则是死代码
    eq(ev('detectMaterial("锐造新材 PLA-CF 黑色")'), 'CF 碳纤维', '4.11 PLA-CF 命中碳纤维（顺序修复）');
    eq(ev('detectMaterial("PETG-CF")'), 'CF 碳纤维', '4.12 PETG-CF 命中碳纤维');
    eq(ev('detectMaterial("ABS-GF 黑色")'), 'CF 碳纤维', '4.13 ABS-GF 命中增强料');
    eq(ev('detectMaterial("PA6-GF")'), 'CF 碳纤维', '4.14 PA6-GF 命中增强料');
    eq(ev('detectMaterial("PLA MAX")'), 'PLA', '4.15 PLA MAX');
    eq(ev('detectMaterial("PC 透明")'), 'PC', '4.16 PC 不回归');
    eq(ev('detectMaterial("尼龙 白色")'), '其他', '4.17 尼龙归「其他」');
    eq(ev('detectMaterial("完全无关的字符串")'), null, '4.18 无材质词返回 null');

    // 材质口径归一：'CF' 与 'CF 碳纤维' 必须收敛成一个值，否则统计分组会拆成两组、下拉框回显不上
    eq(ev('matCanon("CF")'), 'CF 碳纤维', '4.19 matCanon 把 CF 归一为「CF 碳纤维」');
    eq(ev('matCanon("cf")'), 'CF 碳纤维', '4.20 matCanon 大小写不敏感');
    eq(ev('matCanon("")'), 'PLA', '4.21 空材质兜底 PLA');
    eq(ev('matCanon(null)'), 'PLA', '4.22 null 材质兜底 PLA（Number(null)===0 的老坑）');
    eq(ev('matCanon("PETG")'), 'PETG', '4.23 其他材质原样返回，不做大小写强转');
    eq(J('normalizeItem({ material: "CF" })').material, 'CF 碳纤维', '4.24 normalizeItem 落库前归一 CF');

    // 下拉框 option value 必须与规范值一致（曾是 value="CF"，选不中 'CF 碳纤维' 的数据）
    const fmSel = SRC.slice(SRC.indexOf('<select id="fMaterial">'), SRC.indexOf('</select>', SRC.indexOf('<select id="fMaterial">')));
    const fmVals = [];
    fmSel.replace(/<option value="([^"]*)"/g, (m, v) => { fmVals.push(v); return m; });
    ok(fmVals.includes('CF 碳纤维'), '4.25 材质下拉含 value="CF 碳纤维"');
    ok(!fmVals.includes('CF'), '4.26 材质下拉不再有孤立的 value="CF"');
    ok(SRC.includes("'SILK', 'CF 碳纤维', '其他'"), '4.27 从 AMS 槽新建时的材质白名单同步为「CF 碳纤维」');

    /* ══════════ 五、端到端：批量解析一条锐造 SKU ══════════ */
    console.log('── 五、端到端批量解析 ──');
    const names = [
      '锐造新材 PLA哑光 哑光肤色 1KG/无线盘',
      'RUIZAO 丝绸金 1KG',
      '锐造新材 PETG 夜光 透明 1KG',
    ];
    const box = w.document.getElementById('batchNames');
    ok(!!box, '5.1 批量输入框存在');
    box.value = names.join('\n');
    ev('goBatchStep2()');
    const parsed = J('batchParsed');
    eq(parsed.length, 3, '5.2 解析出 3 条');
    eq(parsed[0] && parsed[0].brand, '锐造新材', '5.3 第 1 条品牌');
    eq(parsed[0] && parsed[0].material, 'PLA', '5.4 第 1 条材质');
    eq(parsed[0] && parsed[0].color, cdb['哑光肤色'], '5.5 第 1 条颜色取「哑光肤色」色值');
    eq(parsed[1] && parsed[1].brand, '锐造新材', '5.6 第 2 条品牌（纯英文名）');
    eq(parsed[1] && parsed[1].material, 'PLA', '5.7 第 2 条材质由「丝绸」反推');
    eq(parsed[1] && parsed[1].color, cdb['丝绸金'], '5.8 第 2 条颜色取「丝绸金」色值');
    eq(parsed[2] && parsed[2].material, 'PETG', '5.9 第 3 条 PETG 未被工艺词带偏');
    ok(parsed.every(p => /^#[0-9A-Fa-f]{6}$/.test(p.color)), '5.10 三条都拿到合法色值');
    ev('typeof closeBatchStep2 === "function" && closeBatchStep2()');

    /* ══════════ 六、回归：老品牌老色名不受影响 ══════════ */
    console.log('── 六、回归 ──');
    eq(cname('拓竹 PLA Basic 白色'), '白色', '6.1 白色仍取「白色」');
    eq(cname('哑光红 PLA'), '哑光红', '6.2 哑光红不被新键截断');
    eq(cname('樱花粉 PLA'), '樱花粉', '6.3 樱花粉不变');
    eq(cname('大理石白'), '大理石白', '6.4 原有「大理石白」仍在');
    eq(cname('原木色 PLA'), '原木色', '6.5 原木色不被「原木」截断');
    eq(cname('胡桃木 PLA'), '胡桃木', '6.6 胡桃木不被「黑胡桃木」影响');
    eq(cname('兰博 宝石蓝'), '宝石蓝', '6.7 宝石蓝不变');
    // 注：等长键按 colorDB 插入序命中（'米白色' 会先撞到 '白色'），这是既有行为，
    // 所以这里用不带「色」后缀的写法验「新键没把老键挤掉」
    eq(cname('米白 1KG'), '米白', '6.8 旧键「米白」仍可命中，未被新键「哑光米灰」影响');

    /* ══════════ 七、色卡页 UI 层真的能看到 ══════════ */
    console.log('── 七、色卡页 UI 层 ──');
    // 色卡页是懒初始化：不切页时品牌名录/统计条都是空的（别误判成渲染坏了）
    ev('switchPage("swatch")');
    const grid = w.document.getElementById('swBrandGrid');
    ok(!!grid, '7.1 品牌名录容器存在');
    ok(grid && grid.textContent.includes('锐造新材'), '7.2 色卡页品牌名录出现「锐造新材」');
    const brandBtns = grid ? grid.querySelectorAll('.sw-brand').length : 0;
    eq(brandBtns, J('brandDB.length'), '7.3 品牌名录按钮数 == brandDB 条数');
    const statTxt = (w.document.getElementById('swStats') || {}).textContent || '';
    ok(statTxt.includes('品牌'), '7.4 统计条已渲染');
    const swTotal = J('swAll.length');
    ok(statTxt.includes(String(swTotal)), '7.5 统计条「色卡合计」与 buildSwatches 一致（' + swTotal + '）');
    ok(swTotal >= 600, '7.5b 色卡合计 ≥600（拓竹官方卡 + 通用色库去重后）');
    const swAll = J('buildSwatches().map(x=>x.zh)');
    ok(swAll.includes('丝绸金'), '7.6 色卡库含「丝绸金」');
    ok(swAll.includes('星钻'), '7.7 色卡库含「星钻」');
    ok(swAll.includes('高速大理石白'), '7.8 色卡库含「高速大理石白」');
    ok(swAll.length >= 600, '7.9 色卡库总量 ≥600（当前 ' + swAll.length + '）');

    /* ══════════ 八、性能：色名键序缓存 ══════════ */
    console.log('── 八、性能 ──');
    const t0 = Date.now();
    ev('(()=>{for(let i=0;i<3000;i++)detectColor("锐造新材 PLA哑光 哑光浅灰 1KG");return 1})()');
    const cost = Date.now() - t0;
    ok(cost < 800, '7.1 3000 次 detectColor 耗时 ' + cost + 'ms（键序已缓存，阈值 800ms）');

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
}, 120);
