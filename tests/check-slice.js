/* check-slice.js — printer-3mf.js 的断言测试（纯函数，不需要真机）
   运行（在项目根）：node tests/check-slice.js */
'use strict';

const M = require('../server/printer-3mf');

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  → ' + JSON.stringify(extra) : '')); }
}
function eq(a, b, label) {
  ok(Math.abs(Number(a) - Number(b)) < 1e-6, label + ` (=${a}, 期望 ${b})`);
}

/* ── 样例 1：官方单色单板 ── */
const S1 = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <header>
    <header_item key="X-BBL-Client-Type" value="slicer"/>
  </header>
  <plate>
    <metadata key="index" value="1"/>
    <metadata key="weight" value="126.48"/>
    <filament id="1" tray_info_idx="GFA00" type="PLA" color="#FFFFFFFF" used_m="41.2" used_g="124.29"/>
    <filament id="2" tray_info_idx="GFG00" type="PETG" color="#000000FF" used_m="0.7" used_g="2.19"/>
  </plate>
</config>`;

console.log('\n1 单板双色');
{
  const r = M.parseSliceInfoConfig(S1);
  ok(r.plates.length === 1, '识别出 1 个 plate', r.plates.length);
  const p = r.plates[0];
  eq(p.index, 1, 'plate index');
  eq(p.weightG, 126.48, 'plate weight');
  ok(p.filaments.length === 2, '2 个 filament');
  eq(p.filaments[0].usedG, 124.29, 'filament1 used_g');
  ok(p.filaments[0].type === 'PLA', 'filament1 type 归一成大写', p.filaments[0].type);
  ok(p.filaments[0].colorHex === '#FFFFFF', 'filament1 颜色去掉 alpha', p.filaments[0].colorHex);
  ok(p.filaments[1].colorHex === '#000000', 'filament2 颜色去掉 alpha', p.filaments[1].colorHex);
  eq(p.sumG, 126.48, 'sum(used_g) 等于 weight');
  const v = M.verifyPlate(p);
  ok(v.ok === true, 'verifyPlate 通过', v);
}

/* ── 样例 2：id=255 未使用 + 零用量 ── */
const S2 = `<config><plate>
  <metadata key="index" value="1"/>
  <metadata key="weight" value="10.00"/>
  <filament id="1" type="PLA" color="#FF0000" used_m="3.3" used_g="10.00"/>
  <filament id="2" type="PLA" color="#00FF00" used_m="0.0" used_g="0.00"/>
  <filament id="255" type="PLA" color="#0000FF" used_m="0" used_g="0"/>
</plate></config>`;

console.log('\n2 未使用耗材过滤');
{
  const r = M.parseSliceInfoConfig(S2);
  const p = r.plates[0];
  ok(p.filaments.length === 2, 'id=255 被过滤（剩 2 个）', p.filaments.map(f => f.id));
  ok(!p.filaments.some(f => f.id === 255), '确实没有 255');
  eq(p.sumG, 10, 'sum 只算有效用量');
}

/* ── 样例 3：多板 + 用 plateIdx 选 ── */
const S3 = `<config>
  <plate><metadata key="index" value="1"/><metadata key="weight" value="50"/>
    <filament id="1" type="PLA" color="#111111" used_m="20" used_g="50"/></plate>
  <plate><metadata key="index" value="2"/><metadata key="weight" value="80"/>
    <filament id="1" type="PETG" color="#222222" used_m="30" used_g="80"/></plate>
  <plate><metadata key="index" value="6"/><metadata key="weight" value="33.5"/>
    <filament id="1" type="ABS" color="#333333" used_m="12" used_g="33.5"/></plate>
</config>`;

console.log('\n3 多板选板');
{
  const r = M.parseSliceInfoConfig(S3);
  ok(r.plates.length === 3, '3 个 plate', r.plates.length);
  const a = M.pickPlate(r.plates, { plateIdx: 6 });
  ok(a.ambiguous === false && a.plate.index === 6, 'plateIdx=6 → 选中第 6 板', a.reason);
  const b = M.pickPlate(r.plates, { gcodeFile: '/data/Metadata/plate_2.gcode' });
  ok(b.ambiguous === false && b.plate.index === 2, 'gcode_file=plate_2 → 选中第 2 板', b.reason);
  const c = M.pickPlate(r.plates, {});
  ok(c.ambiguous === true, '无任何线索且多板有量 → 标歧义，不猜', c.reason);
  ok(Array.isArray(c.candidates) && c.candidates.length === 3, '给候选列表');
}

/* ── 样例 4：只有一板有用量时自动判定 ── */
console.log('\n4 单板有量');
{
  const S4 = `<config>
    <plate><metadata key="index" value="1"/><metadata key="weight" value="0"/>
      <filament id="1" type="PLA" color="#AAAAAA" used_m="0" used_g="0"/></plate>
    <plate><metadata key="index" value="2"/><metadata key="weight" value="12.4"/>
      <filament id="1" type="PLA" color="#BBBBBB" used_m="4" used_g="12.4"/></plate>
  </config>`;
  const r = M.parseSliceInfoConfig(S4);
  const p = M.pickPlate(r.plates, {});
  ok(p.ambiguous === false && p.plate.index === 2, '只有第 2 板有量 → 自动选中', p.reason);
}

/* ── 样例 5：属性顺序不同 / 单引号 / &quot; ── */
const S5 = `<config><plate>
  <metadata value="7" key="index"/>
  <metadata key='weight' value='9.5'/>
  <filament used_g='9.5' color='#ABCDEF' type='PLA' id='1' used_m='3'/>
</plate></config>`;

console.log('\n5 格式变体容错');
{
  const r = M.parseSliceInfoConfig(S5);
  const p = r.plates[0];
  ok(p != null, '解析成功');
  eq(p.index, 7, '属性顺序颠倒的 index');
  eq(p.weightG, 9.5, '单引号的 weight');
  eq(p.filaments[0].usedG, 9.5, '属性乱序的 used_g');
  ok(p.filaments[0].colorHex === '#ABCDEF', '颜色正常', p.filaments[0].colorHex);
}

/* ── 样例 6：畸形 / 空输入不崩 ── */
console.log('\n6 畸形输入');
{
  [null, '', '<config></config>', '<config><plate></plate></config>', 'garbage<<<>>>'].forEach((s, i) => {
    let threw = false, r = null;
    try { r = M.parseSliceInfoConfig(s); } catch (e) { threw = true; }
    ok(!threw, '输入 #' + i + ' 不抛错', threw);
    ok(r && Array.isArray(r.plates), '输入 #' + i + ' 返回 plates 数组');
  });
  const empty = M.parseSliceInfoConfig('<config></config>');
  ok(M.pickPlate(empty.plates, {}).plate === null, '无 plate 时 pickPlate 返回 null');
}

/* ── 样例 7：同 id 重复出现要累加 ── */
console.log('\n7 同 id 重复');
{
  const S7 = `<config><plate><metadata key="index" value="1"/><metadata key="weight" value="30"/>
    <filament id="1" type="PLA" color="#FFFFFF" used_m="5" used_g="15"/>
    <filament id="1" type="PLA" color="#FFFFFF" used_m="5" used_g="15"/>
  </plate></config>`;
  const p = M.parseSliceInfoConfig(S7).plates[0];
  ok(p.filaments.length === 1, '同 id 合并成 1 条', p.filaments.length);
  eq(p.filaments[0].usedG, 30, '用量累加');
}

/* ── 样例 8：summarize ── */
console.log('\n8 summarize');
{
  const p = M.parseSliceInfoConfig(S1).plates[0];
  const s = M.summarize(p);
  ok(/plate#1/.test(s) && /PLA/.test(s), '摘要含板号与材质', s);
}

console.log('\n' + '─'.repeat(50));
console.log(fail === 0 ? `✓ 全部通过（${pass} 项）` : `✗ ${fail} 项失败 / ${pass} 项通过`);
process.exit(fail === 0 ? 0 : 1);
