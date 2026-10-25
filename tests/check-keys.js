/* check-keys.js — 持久键接线一致性
   运行：node tests/check-keys.js

   为什么需要这套：新增一个持久键要同时改四处清单，漏一处不会报错，
   而是「保存时整批 400」或「备份里少一个键」—— 等用户发现数据没存上
   已经是几天后了。这里用静态比对把这类漏改挡在提交前。

   四处清单：
     FM_LABELS      前端键的中文名（数据管理页展示用）
     FM.SYNC        前端决定推给服务端哪些键
     DM_STORE_KEYS  数据管理页「本地存储」列表 / 备份清单
     SYNC_KEYS      服务端接受哪些键（不在其中的键会让整次 PUT 返 400）
   另外两个键**有意不同步**：
     printerCfg     printers 来自 /api/printers，同源下 agentUrl 无意义，且每轮刷新重写
     printerUsage   是 /api/usage 的缓存镜像，权威在 agent 侧 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'web', 'filament-manager.html'), 'utf8');
const srv = fs.readFileSync(path.join(ROOT, 'server', 'printer-store.js'), 'utf8');

let pass = 0, fail = 0;
const fails = [];
function ok(c, n) { if (c) pass++; else { fail++; fails.push(n); console.log('  ✗ ' + n); } }
function eq(a, b, n) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa === sb) pass++;
  else { fail++; fails.push(n + '  得到 ' + sa + ' 期望 ' + sb); console.log('  ✗ ' + n + '  得到 ' + sa + ' 期望 ' + sb); }
}

const strings = s => (s ? (s.match(/'[A-Za-z_][\w]*'/g) || []).map(x => x.slice(1, -1)) : []);
const objKeys = s => {
  if (!s) return [];
  return Array.from(s.matchAll(/(?:^|[,{\n])\s*([A-Za-z_][\w]*)\s*:/g), m => m[1]);
};
const pick = (src, re) => { const m = re.exec(src); return m ? m[1] : ''; };

console.log('\n── 清单解析 ──');
const LABELS = objKeys(pick(html, /FM_LABELS\s*=\s*\{([\s\S]*?)\n\};/));
const SYNC = strings(pick(html, /const SYNC\s*=\s*\[([\s\S]*?)\]/));
const DM = strings(pick(html, /DM_STORE_KEYS\s*=\s*\[([\s\S]*?)\n\];/));
const SRV = strings(pick(srv, /const SYNC_KEYS = \[([\s\S]*?)\]/));

ok(LABELS.length >= 10, '1.1 解析到 FM_LABELS（' + LABELS.length + ' 项）');
ok(SYNC.length >= 10, '1.2 解析到 FM.SYNC（' + SYNC.length + ' 项）');
ok(DM.length >= 12, '1.3 解析到 DM_STORE_KEYS（' + DM.length + ' 项）');
ok(SRV.length >= 10, '1.4 解析到服务端 SYNC_KEYS（' + SRV.length + ' 项）');

console.log('\n── 一、前端推送清单必须被服务端全盘接受 ──');
const notAccepted = SYNC.filter(k => SRV.indexOf(k) < 0);
eq(notAccepted, [], '1.5 FM.SYNC 没有服务端不认的键（有则整次 PUT 400）');

console.log('\n── 二、服务端接受的键前端都要推 ──');
const notPushed = SRV.filter(k => SYNC.indexOf(k) < 0);
eq(notPushed, [], '2.1 服务端白名单里的键都在 FM.SYNC 里');

console.log('\n── 三、每个键都要有中文名 ──');
const noLabel = SYNC.filter(k => LABELS.indexOf(k) < 0);
eq(noLabel, [], '3.1 FM.SYNC 的键都有 FM_LABELS 文案');

console.log('\n── 四、备份清单覆盖所有同步键 ──');
const notInBackup = SYNC.filter(k => DM.indexOf(k) < 0);
eq(notInBackup, [], '4.1 可同步的键都进了 DM_STORE_KEYS（否则导出缺键）');

console.log('\n── 五、有意不同步的键只出现在备份里 ──');
const LOCAL_ONLY = ['printerCfg', 'printerUsage'];
LOCAL_ONLY.forEach(k => {
  ok(DM.indexOf(k) >= 0, '5.' + (LOCAL_ONLY.indexOf(k) + 1) + ' ' + k + ' 在备份清单里');
  eq(SYNC.indexOf(k), -1, '5.' + (LOCAL_ONLY.indexOf(k) + 3) + ' ' + k + ' 不进同步清单');
  eq(SRV.indexOf(k), -1, '5.' + (LOCAL_ONLY.indexOf(k) + 5) + ' ' + k + ' 不被服务端接受');
});

console.log('\n── 六、新增的匹配相关键已全链路接线 ──');
['prnSlotMatch', 'prnSlicedSeen'].forEach((k, i) => {
  ok(LABELS.indexOf(k) >= 0, '6.' + (i * 4 + 1) + ' ' + k + ' 有中文名');
  ok(SYNC.indexOf(k) >= 0, '6.' + (i * 4 + 2) + ' ' + k + ' 在同步清单');
  ok(DM.indexOf(k) >= 0, '6.' + (i * 4 + 3) + ' ' + k + ' 在备份清单');
  ok(SRV.indexOf(k) >= 0, '6.' + (i * 4 + 4) + ' ' + k + ' 服务端接受');
});

console.log('\n── 七、备份导出 / 导入都要带上这两把键 ──');
ok(/dmBackupObj[\s\S]{0,3000}prnSlotMatch/.test(html), '7.1 导出对象含 prnSlotMatch');
ok(/dmBackupObj[\s\S]{0,3000}prnSlicedSeen/.test(html), '7.2 导出对象含 prnSlicedSeen');
ok(html.indexOf('prnSlotMatchIn') > 0, '7.3 导入侧有 prnSlotMatchIn 解析');
ok(html.indexOf('prnSlicedSeenIn') > 0, '7.4 导入侧有 prnSlicedSeenIn 解析');

console.log('\n════════════════════════');
console.log((fail === 0 ? '✅ 全部通过' : '❌ 有失败') + '：' + pass + ' / ' + (pass + fail));
if (fails.length) fails.forEach(f => console.log('  · ' + f));
process.exit(fail ? 1 : 0);
