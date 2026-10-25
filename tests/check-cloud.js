/* check-cloud.js — printer-cloud.js 的纯逻辑断言（不联网）
   运行（在项目根）：node tests/check-cloud.js
   覆盖：颜色归一、tray 哨兵过滤、flushG 差额、findTask 四级匹配优先级 */
'use strict';

const C = require('../server/printer-cloud');

let pass = 0, fail = 0;
const fails = [];

function ok(cond, name) {
  if (cond) { pass++; }
  else { fail++; fails.push(name); console.log('  ✗ ' + name); }
}
function eq(a, b, name) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa === sb) { pass++; }
  else { fail++; fails.push(name); console.log('  ✗ ' + name + '  得到 ' + sa + ' 期望 ' + sb); }
}

console.log('\n── normColor ──');
eq(C.normColor('FFFFFFFF'), '#FFFFFF', '8位不透明 → 6位');
eq(C.normColor('#E5B03DFF'), '#E5B03D', '带井号8位');
eq(C.normColor('2850E0'), '#2850E0', '6位裸值');
eq(C.normColor('2850E000'), null, 'alpha=00 → null');
eq(C.normColor('00000000'), null, '全0 → null');
eq(C.normColor('000000'), null, '全黑视为未设置 → null');
eq(C.normColor(''), null, '空串 → null');
eq(C.normColor(null), null, 'null → null');
eq(C.normColor('XYZ'), null, '非法 → null');

console.log('\n── toSliced 基本 ──');
const t1 = {
  id: 273266206,
  title: '胶水拼接版本',
  deviceId: '20P6BJ650601871',
  plateIndex: 6,
  profileId: 204397859,
  weight: 130.5,
  costTime: 3600,
  startTime: '2026-10-17T04:20:00Z',
  amsDetailMapping: [
    { ams: 0, filamentType: 'PLA', targetColor: '2850E0FF', weight: 100.25 },
    { ams: 2, filamentType: 'pla', targetColor: 'FFFFFFFF', weight: 20.0 },
  ],
};
const d1 = C.toSliced(t1);
eq(d1.src, 'cloud', 'src=cloud');
eq(d1.taskId, '273266206', 'taskId 转字符串');
eq(d1.plate, 6, 'plate 取 plateIndex');
eq(d1.filaments.length, 2, '两条有效槽');
eq(d1.filaments[0].slot, 0, '第一条 slot=0');
eq(d1.filaments[0].id, 1, 'id 为 slot+1');
eq(d1.filaments[0].colorHex, '#2850E0', '颜色归一');
eq(d1.filaments[0].type, 'PLA', '材质大写');
eq(d1.filaments[1].slot, 2, '第二条 slot=2');
eq(d1.totalG, 120.25, 'totalG = 各槽之和');
eq(d1.plateWeightG, 130.5, 'plateWeightG 取 task.weight');
eq(d1.flushG, 10.25, 'flushG = 声明重 - 各槽之和');

console.log('\n── 哨兵与脏数据过滤 ──');
const t2 = {
  id: 1, weight: 0,
  amsDetailMapping: [
    { ams: 255, filamentType: 'PLA', targetColor: 'FFFFFFFF', weight: 9 },   // 未使用
    { ams: 254, filamentType: 'PLA', targetColor: 'FFFFFFFF', weight: 9 },   // 外挂
    { ams: 1, filamentType: 'PLA', targetColor: 'FFFFFFFF', weight: 0 },     // 零用量
    { ams: null, filamentType: 'PLA', weight: 5 },                           // ams 缺失
    { ams: 3, filamentType: 'PETG', targetColor: 'FF0000FF', weight: 7.5 },  // 唯一有效
    null,                                                                     // 空元素
  ],
};
const d2 = C.toSliced(t2);
eq(d2.filaments.length, 1, '只剩 1 条有效');
eq(d2.filaments[0].slot, 3, 'slot=3');
eq(d2.filaments[0].type, 'PETG', 'PETG');
eq(d2.plateWeightG, null, 'weight=0 → null');
eq(d2.flushG, 0, '无声明重时 flushG=0');

console.log('\n── 排序 ──');
const t3 = {
  id: 2, weight: 10,
  amsDetailMapping: [
    { ams: 5, filamentType: 'PLA', weight: 1 },
    { ams: 0, filamentType: 'PLA', weight: 2 },
    { ams: 3, filamentType: 'PLA', weight: 3 },
  ],
};
eq(C.toSliced(t3).filaments.map(f => f.slot), [0, 3, 5], '按 slot 升序');

console.log('\n── 空与非法 ──');
eq(C.toSliced(null), null, 'null → null');
eq(C.toSliced({}), C.toSliced({}), '空对象不抛');
eq(C.toSliced({ amsDetailMapping: [] }).filaments.length, 0, '空数组');
eq(C.toSliced({ amsDetailMapping: 'x' }).filaments.length, 0, '非数组当空');

console.log('\n── findTask 四级匹配 ──');
function mock(hits) {
  const c = new C.BambuCloud({ dir: require('os').tmpdir() + '/__nofile_' + Date.now(), region: 'cn' });
  c.token = { accessToken: 'x', expiresAt: Date.now() + 3600e3 };
  c.getTaskList = async () => ({ ok: true, hits: hits });
  return c;
}

const HITS = [
  { id: 100, deviceId: 'AAA', plateIndex: 3, startTime: '2026-10-17T01:00:00Z', weight: 10, amsDetailMapping: [{ ams: 0, filamentType: 'PLA', weight: 10 }] },
  { id: 200, deviceId: 'AAA', plateIndex: 6, startTime: '2026-10-17T05:00:00Z', weight: 20, amsDetailMapping: [{ ams: 1, filamentType: 'PLA', weight: 20 }] },
  { id: 300, deviceId: 'BBB', plateIndex: 1, startTime: '2026-10-17T03:00:00Z', weight: 30, amsDetailMapping: [{ ams: 0, filamentType: 'PLA', weight: 30 }] },
];

(async () => {
  let r = await mock(HITS).findTask('AAA', { taskId: '200' });
  eq(r.matchedBy, 'taskId', '① taskId 精确匹配优先');
  eq(r.task.id, 200, '① 命中 200');

  r = await mock(HITS).findTask('AAA', { taskId: '999', plateIdx: 6 });
  eq(r.matchedBy, 'device+plate', '② taskId 未命中 → device+plate');
  eq(r.task.id, 200, '② 命中 200');

  r = await mock(HITS).findTask('AAA', { plateIdx: 9, startAt: '2026-10-17T01:10:00Z' });
  eq(r.matchedBy, 'device+time', '③ 板号不匹配 → device+time');
  eq(r.task.id, 100, '③ 命中时间最近的 100');

  r = await mock(HITS).findTask('AAA', {});
  eq(r.matchedBy, 'device+latest', '④ 无线索 → device+latest');
  eq(r.task.id, 200, '④ 命中最新 200');

  r = await mock(HITS).findTask('CCC', {});
  eq(r.ok, false, '⑤ 无此设备 → 失败');
  eq(r.reason, 'NOFILE', '⑤ reason=NOFILE');

  r = await mock([]).findTask('AAA', {});
  eq(r.reason, 'EMPTY', '⑥ 空列表 → EMPTY');

  console.log('\n── fetchSliced ──');
  const c1 = mock(HITS);
  r = await c1.fetchSliced('AAA', { taskId: '200' });
  eq(r.ok, true, '正常取到');
  eq(r.data.filaments[0].slot, 1, '数据 slot 正确');

  const c2 = mock([{ id: 1, deviceId: 'AAA', weight: 0, amsDetailMapping: [] }]);
  r = await c2.fetchSliced('AAA', {});
  eq(r.ok, false, '无分槽数据 → 失败');
  eq(r.reason, 'EMPTY', 'reason=EMPTY');

  const c3 = new C.BambuCloud({ dir: require('os').tmpdir() + '/__nofile_' + Date.now() });
  c3.token = null;
  r = await c3.fetchSliced('AAA', {});
  eq(r.reason, 'NOAUTH', '未登录 → NOAUTH');

  console.log('\n── status / ttl ──');
  const c4 = new C.BambuCloud({ dir: require('os').tmpdir() + '/__nofile_' + Date.now() });
  eq(c4.isLoggedIn(), false, '初始未登录');
  eq(c4.ttlSec(), -1, '未登录 ttl=-1');
  c4.token = { accessToken: 'a', expiresAt: Date.now() + 7200e3 };
  eq(c4.status().loggedIn, true, '注入 token 后已登录');
  ok(c4.ttlSec() > 7100 && c4.ttlSec() <= 7200, 'ttlSec 在合理区间');

  console.log('\n' + (fail === 0
    ? '✅ 全部通过：' + pass + ' / ' + pass
    : '❌ 失败 ' + fail + ' / ' + (pass + fail) + '\n   ' + fails.join('\n   ')));
  process.exit(fail === 0 ? 0 : 1);
})();
