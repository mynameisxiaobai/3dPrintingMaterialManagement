/* ══════════════════════════════════════════════════════════════
   printer-agent.js — Bambu Lab 局域网打印机代理 + 耗材用量监控
   ──────────────────────────────────────────────────────────────
   作用：拓竹局域网控制走 MQTT over TLS（8883，自签证书），
        浏览器无法直连；本服务在本地替页面连打印机，并通过
        HTTP API 把 AMS 余量 / 打印状态 / 任务用量提供给页面。

   运行（Node 22 / 24，依赖装在隔离目录，经 NODE_PATH 引入）：
     NODE_PATH="C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules" node printer-agent.js
   或直接双击 start-printer-agent.bat

   安全约束：HTTP 只监听 127.0.0.1，绝不监听 0.0.0.0；
            日志不打印 accessCode。
   ══════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const dgram = require('dgram');
const zlib = require('zlib');
const mqtt = require('mqtt');

/* ── 目录约定（2026-10-18 重排，改布局只需动这一处）──────────────────
     项目根/                 docker-compose.yml、package.json、.dockerignore
       server/               本文件 + printer-cloud / printer-slice / printer-3mf / printer-store
       web/                  单文件应用 filament-manager.html（由本服务托管）
       data/                 本地运行期状态：配置、历史、云 token、库存快照
                             （容器里 PRINTER_AGENT_DIR=/data，语义完全一致）
     服务端代码在 server/ 下，所以「项目根」是 __dirname 的上一级。  */
const ROOT = path.join(__dirname, '..');
const WEB_PATH = path.join(ROOT, 'web', 'filament-manager.html');
/* PRINTER_AGENT_DIR 优先：容器传 /data，测试传临时目录，都不写进项目里 */
const DIR = process.env.PRINTER_AGENT_DIR || path.join(ROOT, 'data');
const CFG_PATH = path.join(DIR, 'printer.config.json');
const HIST_PATH = path.join(DIR, 'printer-history.json');
const AGENT_VERSION = 4;   // v4：退避重连（1s→60s）+ 断线 30min 自动结账 + 错误日志降频
                           // v2：新增 3mf 切片用量（features: ['slice3mf']）

/* ══════════════════════ config ══════════════════════ */

function defaultConfig() {
  return {
    port: 8787,
    pollSeconds: 60,          // 周期性 pushall 间隔（秒），兼作快照节流
    historyKeepDays: 90,      // 任务用量保留天数
    historyMaxBytes: 2097152, // printer-history.json 体积上限（2MB）
    lowStock: { mode: 'both', percent: 20, grams: 100 },
    printers: [],             // [{id,name,host,serial,accessCode}]
  };
}

function loadConfig(file) {
  const def = defaultConfig();
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(file || CFG_PATH, 'utf8'));
  } catch (e) {
    return def;               // 文件不存在或损坏 → 用默认值，服务仍可启动
  }
  if (!raw || typeof raw !== 'object') return def;
  const cfg = Object.assign({}, def, raw);
  cfg.lowStock = Object.assign({}, def.lowStock, raw.lowStock || {});
  cfg.printers = Array.isArray(raw.printers) ? raw.printers : [];
  cfg.port = Number(cfg.port) || def.port;
  cfg.pollSeconds = Math.max(30, Number(cfg.pollSeconds) || def.pollSeconds);
  return cfg;
}

/* 原子写：先写 .tmp 再 rename，避免中途断电把配置写坏 */
function atomicWrite(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

/* 生成不重复的打印机 id（p1 / p2 …），删除后再添加不会撞号 */
function nextPrinterId(printers) {
  let n = 0;
  (printers || []).forEach(p => {
    const m = String(p.id || '').match(/^p(\d+)$/);
    if (m) n = Math.max(n, Number(m[1]));
  });
  return 'p' + (n + 1);
}

/* ══════════════════════ 解析层（传输与解析解耦，便于测试） ══════════════════════ */

/* 拓竹 tray_color 是 8 位 RGBA（如 FFFFFFFF），转 #RRGGBB；异常返回 null */
function rgba8ToHex(c) {
  const s = String(c == null ? '' : c).trim().toUpperCase().replace(/^#/, '');
  if (!/^[0-9A-F]{8}$/.test(s)) return null;
  return '#' + s.slice(0, 6);
}

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

/* 槽位是否装了料。固件有新旧两套编码：
   旧版 0-3（低两位：bit0=有盘 bit1=元数据已就绪），新版在其上 OR 更多标志位
   （8=硬空、9=有盘无元数据、10=无盘但有缓存元数据、11=有盘且已配置、
   27=0x1B，低两位同样是 3 = 有盘且已配置）。
   所以只能用低两位判定，写死 ===11 会漏掉 27 这类合法有料状态。 */
function trayLoaded(state) {
  const n = Number(state);
  return Number.isFinite(n) && (n & 0x03) === 0x03;
}

/* tag_uid 全 0（或缺失）= 没读到 NFC 芯片（第三方料盘）。
   官方 RFID 料盘才有余量数据，此时固件报 remain=-1、tray_weight="0"——
   那是「不知道」，不是「空了」。 */
function hasRfid(tagUid) {
  return !!tagUid && !/^0+$/.test(String(tagUid));
}

/* 单个料槽（AMS tray 或 vt_tray 通用）。
   ⚠ 三个重量字段的语义（2026-10-18 纠正，之前这里是错的）：
     tray_weight = 整卷「标称净重」，1kg 盘恒为 1000（固件按 250g 档位给），不是剩余量；
     remain      = 剩余「百分比」，官方 RFID 盘才有，-1 = 未知；
     remain_g    = 剩余「克重」，只有固件/Studio 手工改过才有值，通常缺失。
   所以剩余克重只能自己算：remain_g 优先，否则 tray_weight × remain%。
   旧写法直接把 tray_weight 当剩余克重 → 料用掉 90% 仍显示 1000g（用户看到的那个 bug），
   而且「剩 10% + 1000g」自相矛盾、绑定/新建库存卷时把余量写成 1000。 */
function parseTray(t, slot) {
  if (!t || typeof t !== 'object') return null;
  const tagUid = t.tag_uid ? String(t.tag_uid) : null;
  const rfid = hasRfid(tagUid);
  const rawRemain  = Number(t.remain);        // 百分比；-1 = 固件不提供
  const rawTotal   = Number(t.tray_weight);   // 标称总重（1kg 盘 = 1000）
  const rawRemainG = Number(t.remain_g);      // 剩余克重；-1 = 固件不提供
  /* 未知一律 null，绝不落到 0——否则「不知道」会被显示成 0% 并误报低库存 */
  const pct    = (Number.isFinite(rawRemain) && rawRemain >= 0) ? clamp(rawRemain, 0, 100) : null;
  const totalG = (Number.isFinite(rawTotal) && rawTotal > 0) ? rawTotal : null;
  let remainG  = (Number.isFinite(rawRemainG) && rawRemainG > 0) ? rawRemainG : null;
  if (remainG == null && totalG != null && pct != null) remainG = Math.round(totalG * pct / 100);
  return {
    slot: slot,
    state: Number(t.state) || 0,
    material: String(t.tray_type || '').trim(),
    subBrand: String(t.tray_sub_brands || '').trim(),
    colorHex: rgba8ToHex(t.tray_color),
    remainPct: pct,
    /* weightG 沿用旧字段名（前端 / 历史快照都在用），语义统一为「剩余克重」 */
    weightG: remainG,
    /* 新增：整卷标称净重，用于显示「剩 100g / 共 1000g」 */
    totalG: totalG,
    tagUid: tagUid,
    hasRfid: rfid,
    diameter: String(t.tray_diameter || '1.75'),
  };
}

/* print.ams.ams[] → [{amsId, slots:[]}]；ams_id 可能是稀疏值（如 128） */
function parseAms(ams) {
  if (!ams || !Array.isArray(ams.ams)) return [];
  return ams.ams
    .filter(u => u && typeof u === 'object')
    .map((u, i) => ({
      amsId: String(u.ams_id != null ? u.ams_id : i),
      slots: (Array.isArray(u.tray) ? u.tray : []).map((t, j) => parseTray(t, j)).filter(Boolean),
    }));
}

/* 把 state 拍平成 { "amsId-slot": grams }，外部料盘记作 "vt" */
function slotWeights(state) {
  const m = {};
  (state.ams || []).forEach(u =>
    u.slots.forEach(s => { m[u.amsId + '-' + s.slot] = s.weightG; }));
  if (state.vtTray && trayLoaded(state.vtTray.state)) m.vt = state.vtTray.weightG;
  return m;
}

/* 把 state 拍平成 { "amsId-slot": tagUid }（RFID 标签号），外部料盘记作 "vt"。
   只收录真的有 tagUid 的槽——老料盘/第三方卷没有 RFID，缺项即判空跳过。
   全 0 的 tag_uid 是「读不到芯片」的占位值，不是标签号，必须一起滤掉
   （否则所有无芯片料盘共用 0000000000000000，归属会互相覆盖）。
   与 slotWeights 平行但独立，不并入 slots，避免破坏 closeTask/snapshots 既有结构。 */
function slotTags(state) {
  const m = {};
  const real = t => t && !/^0+$/.test(String(t));
  (state.ams || []).forEach(u =>
    u.slots.forEach(s => {
      if (real(s.tagUid)) m[u.amsId + '-' + s.slot] = s.tagUid;
    }));
  if (state.vtTray && real(state.vtTray.tagUid)) m.vt = state.vtTray.tagUid;
  return m;
}

/* 把 state 拍平成「每个槽长什么样」的数组，随任务一起落库（tasks[].amsState）。
   前端判「这个槽当时有没有 RFID」必须靠它：实时状态只在打印机页轮询时活着，
   刷新页面后就是空的，靠实时状态判断会让官方 RFID 卷被切片再扣一遍。 */
function slotSnap(state) {
  const st = state || {};
  const out = [];
  const one = (amsId, s) => {
    if (!s) return;
    out.push({
      amsId: String(amsId),
      slot: s.slot,
      material: s.material || null,
      colorHex: s.colorHex || null,
      tagUid: s.tagUid || null,
      hasRfid: !!hasRfid(s.tagUid),
      state: s.state,
      remainPct: s.remainPct == null ? null : s.remainPct,
      totalG: s.totalG == null ? null : s.totalG,
      weightG: s.weightG == null ? null : s.weightG,
    });
  };
  (st.ams || []).forEach(u => (u.slots || []).forEach(s => one(u.amsId, s)));
  if (st.vtTray) one('vt', st.vtTray);
  return out;
}

/* 反查某个 key 的材质/颜色，用于任务用量明细 */function slotMeta(state, key) {
  if (key === 'vt') {
    return { material: (state.vtTray || {}).material, colorHex: (state.vtTray || {}).colorHex };
  }
  const idx = String(key).split('-');
  const u = (state.ams || []).find(x => x.amsId === idx[0]);
  const t = u && u.slots[Number(idx[1])];
  return t ? { material: t.material, colorHex: t.colorHex } : { material: '', colorHex: null };
}

/* 低库存判定：percent / grams / both（任一满足）
   两个量都未知时不告警——「无法测量」不等于「快用完了」 */
function isLow(remainPct, weightG, low) {
  const mode = (low && low.mode) || 'both';
  if (remainPct == null && weightG == null) return false;
  const byPct = remainPct != null && remainPct <= (low && low.percent != null ? low.percent : 20);
  const byGram = weightG != null && weightG <= (low && low.grams != null ? low.grams : 100);
  if (mode === 'percent') return byPct;
  if (mode === 'grams') return byGram;
  return byPct || byGram;
}

/* ══════════════════════ 历史用量存储 ══════════════════════ */

class HistoryStore {
  constructor(file, cfg) {
    this.file = file;
    this.cfg = cfg;
    this.load();
  }
  load() {
    let ok = false;
    try {
      const db = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (db && typeof db === 'object') {
        this.db = {
          version: AGENT_VERSION,
          tasks: Array.isArray(db.tasks) ? db.tasks : [],
          open: (db.open && typeof db.open === 'object') ? db.open : {},
          snapshots: (db.snapshots && typeof db.snapshots === 'object') ? db.snapshots : {},
        };
        ok = true;
      }
    } catch (e) { /* 落到下面重建 */ }
    if (!ok) {
      /* 损坏不退出：旧文件改名备份，重建空库继续跑 */
      let hadFile = false;
      try { hadFile = fs.existsSync(this.file); } catch (e) { /* 忽略 */ }
      try {
        if (hadFile) fs.renameSync(this.file, this.file + '.corrupt-' + Date.now());
      } catch (e) { /* 改名失败也无所谓，下面会覆盖 */ }
      this.db = { version: AGENT_VERSION, tasks: [], open: {}, snapshots: {} };
      this.flush();
      if (hadFile)
        console.warn('[printer-agent] 历史文件损坏，已备份并重建：' + path.basename(this.file));
    }
  }
  pushSnapshot(pid, slots) {
    const arr = this.db.snapshots[pid] || (this.db.snapshots[pid] = []);
    arr.push({ at: new Date().toISOString(), slots });
    if (arr.length > 100) arr.splice(0, arr.length - 100);   // 环形保留最近 100 条
    this.flush();
  }
  openTask(pid, taskName, slots, tags, extra) {
    /* tags 是任务开始瞬间的 RFID 快照；旧调用/旧数据缺省为 {}，closeTask 判空即兼容。
       extra 是 2026-10-17 新增的切片用量线索（gcodeFile / taskId），同样缺省即兼容。 */
    const startAt = new Date().toISOString();
    const x = extra || {};
    this.db.open[pid] = {
      taskName: taskName,
      startAt: startAt,
      slots,
      tags: tags || {},
      /* 快照重量语义版本。1/缺失 = 旧的「tray_weight 标称总重」，2 = 「剩余克重」。
         跨版本升级仍在跑的任务不能相减（1000 − 100 会算出 900g 假消耗）。 */
      wv: 2,
      /* ── 切片用量：与 slots/tags 平行，不并入它们，旧数据判空即可 ── */
      taskKey: pid + '|' + startAt,
      gcodeFile: x.gcodeFile || null,
      taskId: x.taskId || null,
      sliced: null,                 // 3mf 解析结果，由 SliceFetcher 异步回填
      slicedState: 'pending',       // pending|ok|NO_FILE|AUTH|NET|PARSE|...
    };
    this.flush();
  }
  /* 切片抓取成功：写到当前 open 任务上；任务已结束则交给 patchTask */
  setSliced(pid, data) {
    const o = this.db.open[pid];
    if (!o || !data) return false;
    o.sliced = data;
    o.slicedState = 'ok';
    this.flush();
    return true;
  }
  setSlicedState(pid, reason) {
    const o = this.db.open[pid];
    if (!o) return false;
    o.slicedState = reason || 'pending';
    this.flush();
    return true;
  }
  /* 补写已落库任务的字段（start 抓取晚于 close 时用） */
  patchTask(id, patch) {
    if (!id || !patch) return false;
    const rec = this.db.tasks.find(t => t && t.id === id);
    if (!rec) return false;
    Object.assign(rec, patch);
    this.flush();
    return true;
  }
  getOpen(pid) { return this.db.open[pid] || null; }
  closeTask(pid, endSlots, result, state) {
    const t = this.db.open[pid];
    if (!t) return null;
    delete this.db.open[pid];
    const consumed = [];
    /* 版本不同不能相减：旧快照的 weightG 是标称总重（1000），新的是剩余克重（100）。
       这种任务只丢一次 AMS 差值（切片用量那条路仍然照常），好过记 900g 假消耗。 */
    const wvOk = t.wv === 2;
    Object.keys(t.slots).forEach(k => {
      if (!wvOk) return;
      const end = endSlots[k] != null ? endSlots[k] : t.slots[k];
      const used = t.slots[k] - end;
      /* 只计正值：换卷会让余量上升，那不是消耗 */
      if (used > 0.5) {
        const meta = slotMeta(state, k);
        consumed.push({
          key: k,
          material: meta.material || '',
          colorHex: meta.colorHex || null,
          grams: Math.round(used * 10) / 10,
          /* RFID 标签号——HTML 侧据此把消耗归属到具体某一卷（旧任务无此字段为 null） */
          tagUid: (t.tags && t.tags[k]) || null,
        });
      }
    });
    const total = consumed.reduce((s, c) => s + c.grams, 0);
    const rec = {
      id: 't_' + Date.now().toString(36),
      printerId: pid,
      taskName: t.taskName,
      startAt: t.startAt,
      endAt: new Date().toISOString(),
      result: result,
      totalGrams: Math.round(total * 10) / 10,
      consumed: consumed,
      /* ── 切片用量（平行字段）：无 RFID 料盘的唯一用量来源。
         consumed 保持只装「AMS 实测差值」，两者绝不混装 ── */
      taskKey: t.taskKey || (pid + '|' + t.startAt),
      gcodeFile: t.gcodeFile || null,
      taskId: t.taskId || null,
      sliced: t.sliced || null,
      slicedState: t.sliced ? 'ok' : (t.slicedState || 'pending'),
      /* ── 任务时刻的槽位快照（2026-10-22）──
         amsState 是任务结束时每个槽的完整状态；endTags 是当时各槽的芯片号。
         前端用它判「这个槽当时有没有 RFID」，不依赖实时 printerState
         （刷新页面后实时状态是空的，H5 会静默失效 → RFID 卷被切片重复扣减）。 */
      endTags: slotTags(state || {}),
      amsState: slotSnap(state),
    };
    this.db.tasks.push(rec);
    this.prune();
    this.flush();
    return rec;
  }
  prune() {
    const keepDays = this.cfg.historyKeepDays || 90;
    const cut = Date.now() - keepDays * 864e5;
    /* 时间解析不出来时**保留**而不是丢弃：`Date.parse(0)` 是 NaN，
       `NaN >= cut` 为 false，等于把「字段损坏但数据还在」的任务静默删掉。
       体积上限在下面还有一层兜底，多留几条比丢数据好。 */
    this.db.tasks = this.db.tasks.filter(t => {
      const ts = Date.parse(t.endAt || t.startAt || '');
      return Number.isFinite(ts) ? ts >= cut : true;
    });
    const max = this.cfg.historyMaxBytes || 2097152;
    let guard = 0;
    while (this.db.tasks.length > 10 && JSON.stringify(this.db).length > max && guard++ < 50)
      this.db.tasks.splice(0, Math.ceil(this.db.tasks.length * 0.3));   // 超体积丢最旧 30%
  }
  usage(days) {
    const d = Number(days) || 90;
    const cut = Date.now() - d * 864e5;
    return this.db.tasks
      .filter(t => {
        const ts = Date.parse(t.endAt || t.startAt || '');
        return Number.isFinite(ts) ? ts >= cut : false;   // 时间不明的任务不进用量列表
      })
      .slice(-200)
      .reverse();
  }
  flush() { atomicWrite(this.file, this.db); }
}

/* ══════════════════════ 重连退避 & 日志降频 ══════════════════════ */

/* 打印机断电后可能几小时不在线。mqtt.js 的 reconnectPeriod 只能是**固定数字**
   （v5.16 源码里是 `options.reconnectPeriod > 0` 直接 setInterval），既不会递增
   也没有次数上限：1 秒一轮、每轮一条 warn，实测约 1 万条 / 1MB 每天。
   所以这里传 reconnectPeriod: 0 关掉它自带的自动重连，自己调度：
   1s → 2s → 4s → 8s → 16s → 32s → 60s 封顶，连上立刻归零。 */
const BAMBU_BACKOFF_MIN = 1000;
const BAMBU_BACKOFF_MAX = 60000;
function bambuBackoffDelay(attempt) {
  const n = Math.max(0, Math.floor(Number(attempt) || 0));
  return Math.min(BAMBU_BACKOFF_MAX, BAMBU_BACKOFF_MIN * Math.pow(2, Math.min(n, 6)));
}

/* 同一条错误只在首次、以及每 5 分钟各打一次，中间只累计次数。
   断电整夜不该把 10MB 的日志轮转写满三轮（那会把真正的报错挤掉）。 */
const LOG_REPEAT_MS = 5 * 60 * 1000;
const logSeen = new Map();
function logThrottled(key, msg, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const r = logSeen.get(key);
  if (!r) { logSeen.set(key, { at: now, n: 0 }); console.warn(msg); return true; }
  /* 被压掉的只计数，不动 at —— 否则一直报错会把窗口一直往后推，永远不再打 */
  if (now - r.at < LOG_REPEAT_MS) { r.n++; return false; }
  const extra = r.n > 0 ? '（同类错误另重复 ' + r.n + ' 次）' : '';
  r.at = now; r.n = 0;
  console.warn(msg + extra);
  return true;
}
function logThrottledReset() { logSeen.clear(); }

/* ══════════════════════ 拓竹客户端 ══════════════════════ */

class BambuClient {
  constructor(printerCfg, hooks) {
    this.cfg = printerCfg;      // {id,name,host,serial,accessCode}
    this.hooks = hooks;         // {onState, onStateArgs?, cfg}
    this.seq = 1;
    this.client = null;
    this.retry = 0;             // 连续失败次数，connect 成功即归零
    this.retryTimer = null;     // 退避定时器（自己调度，不用 mqtt 的）
    this.stopped = false;       // 主动 disconnect 之后不再自动重连
    this.lastMessageAt = 0;     // 最后一次收到 report 的时刻；断线结账用它
    this.state = {
      ams: [], vtTray: null,
      print: {},
      online: false, lastSeen: null, lastError: null, reconnects: 0,
      retryIn: null,            // 距离下次重连还有多少毫秒（给前端 / 排障用）
    };
  }
  connect() {
    if (this.client || this.stopped) return;
    this.retryTimer = null;
    this.state.retryIn = null;
    let c;
    try {
      c = mqtt.connect('mqtts://' + this.cfg.host + ':8883', {
        username: 'bblp',
        password: this.cfg.accessCode,
        rejectUnauthorized: false,   // 拓竹用自签证书；访问码才是认证因子
        reconnectPeriod: 0,          // 关掉 mqtt.js 自带的固定 1s 重连，改走本类的退避
        connectTimeout: 8000,
        clientId: 'filament-agent-' + Math.random().toString(16).slice(2, 10),
      });
    } catch (e) {
      this.state.lastError = String((e && e.message) || e);
      this.scheduleReconnect();
      return;
    }
    this.client = c;
    /* 下面每个回调都先判 this.client !== c：disconnect / 重连之后，旧 client 的
       迟到事件必须被丢掉，否则会把新连接的状态改回离线。 */
    c.on('connect', () => { if (this.client === c) this._onConnect(); });
    c.on('message', (topic, buf) => {
      if (this.client !== c) return;
      let msg;
      try { msg = JSON.parse(buf.toString('utf8')); } catch (e) { return; }
      if (!msg || typeof msg.print !== 'object' || !msg.print) return;
      this.ingest(msg.print);
    });
    c.on('error', e => {
      if (this.client !== c) return;
      this.state.lastError = String((e && e.message) || e);
      /* 降频：断电期间的 ECONNREFUSED / ETIMEDOUT 每次重连都会来一条 */
      logThrottled('conn:' + this.cfg.id + ':' + this.state.lastError,
        '[printer-agent] ' + this.cfg.name + ' 连接错误：' + this.state.lastError);
    });
    c.on('close', () => {
      if (this.client !== c) return;
      this.client = null;
      this.state.online = false;
      this.emit();
      try { c.end(true); } catch (e) { /* 已关闭 */ }
      this.scheduleReconnect();
    });
  }
  /* MQTT 握手成功。抽成方法是为了测试能直接驱动，不必真连一台打印机。 */
  _onConnect() {
    this.retry = 0;
    this.state.retryIn = null;
    this.state.online = true;
    this.state.lastError = null;
    if (this.client) {
      this.client.subscribe('device/' + this.cfg.serial + '/report', { qos: 0 }, () => this.pushAll());
    }
    this.emit();
    console.log('[printer-agent] 已连接打印机 ' + this.cfg.name + ' (' + this.cfg.host + ')');
  }
  /* 排下一次重连。用 setTimeout 而不是 setInterval：间隔要逐次变长。 */
  scheduleReconnect() {
    if (this.stopped || this.retryTimer) return;
    const d = bambuBackoffDelay(this.retry++);
    this.state.reconnects++;
    this.state.retryIn = d;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.state.retryIn = null;
      this.connect();
    }, d);
    /* 别让退避定时器吊住进程退出（SIGTERM / 测试结束时必须能立刻走） */
    if (this.retryTimer && typeof this.retryTimer.unref === 'function') this.retryTimer.unref();
  }
  /* 用户手动点「刷新 / 重连」时用：把退避清零，立刻再试一次。
     否则最坏要等满 60 秒，看起来像「点了没反应」。 */
  retryNow() {
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.state.retryIn = null;
    this.retry = 0;
    this.connect();
    return !!(this.client || this.retryTimer);
  }
  pushAll() {
    this.publish({ pushing: { sequence_id: String(this.seq++), command: 'pushall' } });
  }
  publish(obj) {
    if (this.client && this.client.connected) {
      this.client.publish('device/' + this.cfg.serial + '/request', JSON.stringify(obj));
    }
  }
  disconnect() {
    this.stopped = true;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    const c = this.client;
    this.client = null;
    if (c) { try { c.end(true); } catch (e) { /* 忽略 */ } }
    this.state.online = false;
    this.state.retryIn = null;
  }
  /* 把一条 report 的 print 对象合并进 state。公开出来是为了测试能绕过 MQTT 直喂 */
  ingest(rep) {
    if (!rep || typeof rep !== 'object') return;
    this.lastMessageAt = Date.now();     // 「打印机还活着」的唯一硬证据
    this.state.lastSeen = new Date().toISOString();
    this.state.print = {
      gcodeState: rep.gcode_state || null,
      percent: clamp(Number(rep.mc_percent) || 0, 0, 100),
      remainingMin: rep.mc_remaining_time != null ? Number(rep.mc_remaining_time) : null,
      taskName: rep.subtask_name || '',
      layer: Number(rep.layer_num) || 0,
      totalLayer: Number(rep.total_layer_num) || 0,
      activeAms: rep.ams_id != null ? String(rep.ams_id) : null,
      activeTray: rep.tray_now != null ? String(rep.tray_now) : null,
      /* ── 切片用量线索：这几个字段一直都有，之前没解析，现在留作定位 3mf 用 ── */
      gcodeFile: rep.gcode_file ? String(rep.gcode_file) : (rep.file ? String(rep.file) : null),
      taskId: rep.task_id != null ? String(rep.task_id) : null,
      projectId: rep.project_id != null ? String(rep.project_id) : null,
      profileId: rep.profile_id != null ? String(rep.profile_id) : null,
      plateIdx: Number(rep.plate_idx) || null,
      plateCnt: Number(rep.plate_cnt) || null,
      sdcard: rep.sdcard === true,
    };
    const ams = parseAms(rep.ams);
    if (rep.ams) this.state.ams = ams;                 // 显式空 AMS 报告不清空缓存
    const vt = parseTray(rep.vt_tray, 'vt');
    if (vt) this.state.vtTray = vt;
    this.emit();
  }
  /* 第三个参数把 client 自己交给钩子：handleState 判「断线多久了」要用 lastMessageAt */
  emit() { if (this.hooks && this.hooks.onState) this.hooks.onState(this.cfg.id, this.state, this); }
  lowStock() {
    const low = this.hooks.cfg.lowStock;
    const out = [];
    (this.state.ams || []).forEach(u => u.slots.forEach(s => {
      if (trayLoaded(s.state) && isLow(s.remainPct, s.weightG, low))
        out.push({ printerId: this.cfg.id, printerName: this.cfg.name, amsId: u.amsId, slot: s.slot,
          material: s.material, colorHex: s.colorHex, remainPct: s.remainPct,
          weightG: s.weightG, reason: low.mode });
    }));
    if (this.state.vtTray && trayLoaded(this.state.vtTray.state)
        && isLow(this.state.vtTray.remainPct, this.state.vtTray.weightG, low))
      out.push({ printerId: this.cfg.id, printerName: this.cfg.name, amsId: 'vt', slot: 0,
        material: this.state.vtTray.material, colorHex: this.state.vtTray.colorHex,
        remainPct: this.state.vtTray.remainPct, weightG: this.state.vtTray.weightG, reason: low.mode });
    return out;
  }
  snapshot() {
    return {
      id: this.cfg.id, name: this.cfg.name, host: this.cfg.host,
      connection: {
        online: this.state.online,
        lastSeen: this.state.lastSeen,
        lastError: this.state.lastError,
        reconnects: this.state.reconnects,
        /* 断电排障用：还要等多久重连、最后一次听到打印机说话是什么时候 */
        retryInMs: this.state.retryIn,
        lastMessageAt: this.lastMessageAt ? new Date(this.lastMessageAt).toISOString() : null,
        silentMin: this.lastMessageAt ? Math.round((Date.now() - this.lastMessageAt) / 6000) / 10 : null,
      },
      print: this.state.print,
      ams: this.state.ams,
      vtTray: this.state.vtTray,
      lowStock: this.lowStock(),
      updatedAt: new Date().toISOString(),
    };
  }
}

/* ══════════════════════ 局域网发现（SSDP NOTIFY 被动监听） ══════════════════════ */

/* 拓竹打印机每约 5 秒发一条 NOTIFY 公告；实测抓包确认实际承载端口是 2021
   （报文里 Host: 239.255.255.250:1990 只是传统 SSDP 字样，旧文档误把它当端口）。
   被动收听即可，不向外发包。自定义头形如 DevName.bambu.com，key 大小写不敏感。
   注意：SSDP 拿不到访问码 —— 发现只解决 IP / 序列号 / 名称。 */
const SSDP_MCAST = '239.255.255.250';
const SSDP_PORT = 2021;          // 现役固件实际端口
const SSDP_PORT_LEGACY = 1990;   // 旧固件兼容通道，被占用就静默跳过
const BAMBU_NT = 'urn:bambulab-com:device:3dprinter:1';

/* 端口允许环境变量覆盖（与 PRINTER_AGENT_DIR/PORT 一样的自测钩子）：
   Bambu Studio 运行时独占 2021，自测需要换空闲端口跑正向用例 */
const ssdpPort = () => Number(process.env.PRINTER_AGENT_SSDP_PORT) || SSDP_PORT;
const ssdpPortLegacy = () => Number(process.env.PRINTER_AGENT_SSDP_PORT_LEGACY) || SSDP_PORT_LEGACY;

function isIPv4(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(s || ''));
  return !!m && m.slice(1).every(o => Number(o) <= 255);
}

/* 解析一条 NOTIFY 报文（Buffer 或字符串）。非拓竹公告 / 畸形 → null。
   byebye 公告也会被解析出来（nts 字段），由调用方决定移除。 */
function parseSsdpNotify(msg) {
  let text;
  try { text = Buffer.isBuffer(msg) ? msg.toString('utf8') : String(msg == null ? '' : msg); }
  catch (e) { return null; }
  if (!text || text.length > 4096) return null;
  const lines = text.split(/\r?\n/);
  if (!/^NOTIFY\s+\S+\s+HTTP\/1\.[01]/i.test(String(lines[0] || '').trim())) return null;
  const h = {};
  for (let i = 1; i < lines.length; i++) {
    const idx = lines[i].indexOf(':');
    if (idx > 0) h[lines[i].slice(0, idx).trim().toLowerCase()] = lines[i].slice(idx + 1).trim();
  }
  const keys = Object.keys(h);
  if (h['nt'] !== BAMBU_NT && !keys.some(k => k.slice(-10) === '.bambu.com')) return null;
  const ip = h['location'] || '';
  if (!isIPv4(ip)) return null;
  const serial = String(h['usn'] || '').slice(0, 64);
  if (!serial) return null;
  return {
    serial: serial,
    name: String(h['devname.bambu.com'] || '').slice(0, 64),
    model: String(h['devmodel.bambu.com'] || '').slice(0, 32),
    ip: ip,
    connect: String(h['devconnect.bambu.com'] || '').slice(0, 16),
    bind: String(h['devbind.bambu.com'] || '').slice(0, 16),
    seclink: String(h['devseclink.bambu.com'] || '').slice(0, 16),
    interface: String(h['devinf.bambu.com'] || '').slice(0, 16),
    firmware: String(h['devversion.bambu.com'] || '').slice(0, 32),
    nts: String(h['nts'] || '').slice(0, 32),
  };
}

/* 防并发：扫描期间再次调用直接复用同一 Promise（第二次点「重新搜索」
   拿到同一批结果，比返回 409 友好；扫描最长 15s，timeout 差异可忽略）。 */
let discoverInFlight = null;

function discover(timeoutMs) {
  if (discoverInFlight) return discoverInFlight;
  const p = discoverOnce(timeoutMs).finally(() => { discoverInFlight = null; });
  discoverInFlight = p;
  return p;
}

/* discover 永不 reject：绑定失败也以 {error, hint} 正常返回，路由层好处理 */
function bindErrorResult(e) {
  const code = e && e.code;
  const port = ssdpPort();
  return code === 'EADDRINUSE'
    ? { error: 'PORT_BUSY', hint: 'UDP ' + port + ' 被其他程序占用：桌面上的 Bambu Studio / OrcaSlicer，' +
        '或 NAS 上别的容器/服务正占着这个端口。关掉后重试，或用 PRINTER_AGENT_SSDP_PORT 换一个端口' }
    : { error: 'BIND_FAILED', hint: '无法监听 UDP ' + port + '：' + String((e && e.message) || e) };
}

function discoverOnce(rawMs) {
  return new Promise(resolve => {
    const ms = clamp(Number(rawMs) || 8000, 3000, 15000);
    const t0 = Date.now();
    const found = new Map();                 // serial -> 记录，保留最新
    const sockets = [];
    let settled = false;
    let primaryBound = false;
    let timer = null;

    function finish(result) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      sockets.forEach(s => { try { s.close(); } catch (e) { /* 忽略 */ } });
      resolve(result);
    }
    function onMessage(raw) {
      let rec = null;
      try { rec = parseSsdpNotify(raw); } catch (e) { return; }
      if (!rec) return;                       // 非拓竹公告（M-SEARCH、其它 UPnP 设备）
      if (rec.nts === 'ssdp:byebye') { found.delete(rec.serial); return; }
      found.set(rec.serial, rec);             // 同一台重复公告 → 保留最新
    }
    function joinMulticast(sock) {
      try {
        sock.setBroadcast(true);              // 兼容广播发包的固件
        const ifaces = os.networkInterfaces();
        Object.keys(ifaces).forEach(n => (ifaces[n] || []).forEach(it => {
          if (it && it.family === 'IPv4' && !it.internal) {
            try { sock.addMembership(SSDP_MCAST, it.address); }
            catch (e) { /* 单张网卡失败不影响其他（VMware/VBox 虚拟网卡常见） */ }
          }
        }));
      } catch (e) { /* 加入多播失败不致命：打印机也可能广播发包 */ }
    }

    const primary = dgram.createSocket('udp4');
    sockets.push(primary);
    primary.on('message', onMessage);
    primary.on('error', e => {
      if (settled) return;
      if (!primaryBound) return finish(bindErrorResult(e));
      console.warn('[printer-agent] 发现监听错误：' + String((e && e.message) || e));
    });
    /* 注意：部分 Node 版本 bind 失败时只调回调不抛 'error' 事件，两条路都接 */
    primary.bind(ssdpPort(), err => {
      if (err && !primaryBound) { finish(bindErrorResult(err)); return; }
      primaryBound = true;
      joinMulticast(primary);
      /* 旧固件可能仍在 1990；占用即静默跳过，不影响主通道 */
      const legacy = dgram.createSocket('udp4');
      sockets.push(legacy);
      legacy.on('message', onMessage);
      legacy.on('error', () => { /* 兼容通道，静默 */ });
      legacy.bind(ssdpPortLegacy(), () => joinMulticast(legacy));
    });

    timer = setTimeout(() => finish({
      ok: true,
      printers: [...found.values()].map(r => ({
        serial: r.serial, name: r.name, model: r.model, ip: r.ip,
        connect: r.connect, bind: r.bind, firmware: r.firmware, interface: r.interface,
      })),
      scannedMs: Date.now() - t0,
    }), ms);
  });
}

/* ══════════════════════ 状态回流（任务边界 + 快照节流） ══════════════════════ */

/* 每次遥测到达时调用。抽成独立函数是为了让自测能不起 MQTT 直接验证。
   lastSnap 是调用方持有的 {printerId: ms} 对象，函数会往里写节流时间戳。 */
/* 残留 open 判僵尸的时限。打印任务本身很少超过这个数，超了还挂在 open 上
   基本就是「服务重启 / MQTT 断线期间任务结束，状态迁移没被收到」。 */
const STALE_OPEN_MS = 30 * 60 * 1000;

/* 「还在同一单里」的状态。暂停 / 预热准备都不能算任务结束：
   一次换料暂停或隔夜暂停超过 30 分钟，旧的 `gs !== 'RUNNING'` 判据就会把它
   结账掉，恢复打印后又新开一条 → 同一单被拆成两条（用量总数对，但账很乱）。 */
const ACTIVE_PRINT_STATES = new Set(['RUNNING', 'PAUSE', 'PREPARE', 'SLICING']);

function handleState(history, pid, state, lastSnap, pollSeconds, ctx) {
  const gs = state.print.gcodeState;
  const now = Date.now();
  let opened = false, closed = null;
  if (gs === 'RUNNING' && !history.db.open[pid]) {
    history.openTask(pid, state.print.taskName || '未命名任务', slotWeights(state), slotTags(state), {
      gcodeFile: state.print.gcodeFile,
      taskId: state.print.taskId,
    });
    opened = true;
  }
  if ((gs === 'FINISH' || gs === 'FAILED') && history.db.open[pid]) {
    closed = history.closeTask(pid, slotWeights(state), gs, state);
  }
  /* ── 残留 open 自愈（v3，v3.1 补了「断线静默」判据）──
     服务重启 / MQTT 断线期间结束的任务会永远挂在 open 上：
     ① 同一任务不会被重开（上面被 !open 守卫挡住）；
     ② 切片抓取还在往这条僵尸任务上写；
     ③ /api/usage 永远看不到它 → 前端永远不结账。

     两条判据，满足其一 + 挂满 30 分钟就按 STALE 结账：
     A. 状态已经不是「进行中」（FINISH/FAILED/IDLE…）；
     B. **打印机已经 30 分钟没说过话**（ctx.lastMessageAt）。
        这条是必须的：打印机直接断电时 gcodeState 会永久冻在 RUNNING
        （close 事件只改 online，不清 state，只有新 report 才会覆盖），
        只靠 A 的话断电那条任务永远自愈不了，来电后新单的用量会继续累到它身上。

     没抓到切片数据的标 slicedState='stale'：明说「这次抓不到了」，
     比一直 pending 让用户以为「还在等」要好。 */
  if (!closed && history.db.open[pid]) {
    const o = history.db.open[pid];
    const started = Date.parse(o.startAt || '');
    /* lastMessageAt 为 0 = 从来没收到过任何 report（刚加进来 / 还没连上），
       这种情况不能算「静默太久」，否则会拿 1970 当起点误杀 */
    const lastMsg = ctx && Number.isFinite(ctx.lastMessageAt) && ctx.lastMessageAt > 0
      ? ctx.lastMessageAt : null;
    const silentTooLong = lastMsg != null && (now - lastMsg) > STALE_OPEN_MS;
    const notActive = !ACTIVE_PRINT_STATES.has(gs);
    /* startAt 缺失或非法时**绝不能**退回 0 当基准：`NaN || 0` 得 0，
       age 就变成「从 1970 年至今」，每次轮询都会立刻把这条任务判成 stale 结账。
       宁可这一轮不动它，等下一轮拿到正常状态或由人工处理。 */
    if ((notActive || silentTooLong) && Number.isFinite(started) && now - started > STALE_OPEN_MS) {
      closed = history.closeTask(pid, slotWeights(state), 'STALE', state);
      if (closed && !closed.sliced) {
        closed.slicedState = 'stale';
        history.patchTask(closed.id, { slicedState: 'stale' });
      }
    }
  }
  if (!lastSnap[pid] || now - lastSnap[pid] >= (pollSeconds || 60) * 1000) {
    lastSnap[pid] = now;
    history.pushSnapshot(pid, slotWeights(state));
  }
  /* 返回值给 onState 挂钩子用；老调用方忽略返回值，零破坏 */
  return { opened: opened, closed: closed };
}

/* ══════════════════════ HTTP 层 ══════════════════════ */

/* 访问令牌：容器部署（FM_AUTH=on）时生成并落盘，桌面本地用法保持 null。
   一旦有值，所有 /api/* （除 health）都要求 X-FM-Token，且不再放行跨源。 */
let AUTH_TOKEN = null;

/* file:// 打开的页面 origin 是 null，不放行 fetch 会被浏览器直接拦掉。
   注意：CORS 预检（OPTIONS）响应也必须带这些头，否则浏览器连真正的
   POST/DELETE 都不会发，前端只看到 "Failed to fetch"（curl 测不到这条路径）。 */
function corsHeaders() {
  /* 开了鉴权就不再放行任何跨源请求。
     在 LAN 上裸奔时，任意网页都能 POST /api/printers（填个任意 host 就是内网 SSRF）、
     DELETE 掉打印机、读全量用量 —— 以前靠「只监听 127.0.0.1」兜底，容器部署后这层没了。
     同源请求本来就不需要 CORS 头，所以这里返回空对象即可。 */
  if (AUTH_TOKEN) return {};
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-FM-Token',
  };
}

function sendJson(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  }, corsHeaders()));
  res.end(s);
}

/* 读 JSON 请求体，带字节级上限。所有 POST 都必须走这里，不要自己写
   `req.on('data')` 累加字符串 —— 那样有两个坑：
   ① b += d 按字符累加，b.length 是 UTF-16 码元数，8MB 中文实际可能是 24MB；
   ② 超限时 req.destroy() 既不回包也不 settle Promise，客户端收到的是连接重置，
      看起来像「服务挂了」，但其实是参数问题。这里改成先回 413 再排空。 */
function readJsonBody(req, maxBytes) {
  const limit = Number(maxBytes) > 0 ? Number(maxBytes) : 2 * 1024 * 1024;
  return new Promise(resolve => {
    const chunks = [];
    let size = 0, done = false;
    const finish = r => { if (done) return; done = true; resolve(r); };
    req.on('data', d => {
      if (done) return;
      size += d.length;                       // Buffer 的 length 就是字节数
      if (size > limit) {
        finish({ ok: false, status: 413, error: '请求体过大（上限 ' + Math.round(limit / 1048576 * 10) / 10 + 'MB）' });
        try { req.resume(); } catch (e) { /* 排空剩余数据，不要 destroy */ }
        return;
      }
      chunks.push(d);
    });
    req.on('end', () => {
      const txt = Buffer.concat(chunks).toString('utf8');
      if (!txt.trim()) return finish({ ok: true, data: {} });
      let v = null;
      try { v = JSON.parse(txt); } catch (e) {
        return finish({ ok: false, status: 400, error: 'JSON 解析失败' });
      }
      if (!v || typeof v !== 'object' || Array.isArray(v)) {
        return finish({ ok: false, status: 400, error: '请求体必须是 JSON 对象' });
      }
      finish({ ok: true, data: v });
    });
    req.on('error', () => finish({ ok: false, status: 400, error: '请求读取失败' }));
  });
}

/* 网络模式：容器 bridge 下 Docker 不会把局域网组播泛洪进 veth，
   SSDP 被动监听会「成功但空」（不报错，比 PORT_BUSY 更难排查），
   所以用环境变量显式声明，前端据此给提示，不做运行时探测
   （bind 成功不代表组播能通，探测结果本身会骗人）。 */
function netMode() {
  const v = String(process.env.FM_NET_MODE || '').toLowerCase();
  if (v === 'bridge' || v === 'host') return v;
  return 'local';
}

/* 监听地址：默认仍只监听回环（桌面用法零变化）；
   容器里设 PRINTER_AGENT_HOST=0.0.0.0 才能被端口映射进来。 */
function listenHost() {
  return process.env.PRINTER_AGENT_HOST || '127.0.0.1';
}

/* ══════════════════════ 静态托管（容器部署时页面由本服务直出） ══════════════════════ */

const HTML_PATH = WEB_PATH;   // web/filament-manager.html（由文件头部的 ROOT 推导）
const HTML_PLACEHOLDER = '/*__FM_BOOTSTRAP__*/';

/* 按 store 版本号缓存：页面里注入了库存快照，rev 一变内容就变，
   所以不能「启动时压缩一次」，否则永远发旧数据。
   gzip 产物约 100KB，460KB 文本压缩一次十几毫秒，只在 rev 变化后的首次请求付这个成本。 */
let staticCache = { rev: -1, body: null, gz: null, etag: null };

function buildStatic(rev, bootstrap) {
  if (staticCache.rev === rev && staticCache.body) return staticCache;
  let html;
  try { html = fs.readFileSync(HTML_PATH, 'utf8'); } catch (e) { return null; }
  /* 只替换第一处（字符串参数版本的 replace 就是只换第一个）。
     用 split/join 会把注释里提到的占位符也一起换掉，那样注入的 JS 会落进注释里。 */
  if (bootstrap) html = html.replace(HTML_PLACEHOLDER, bootstrap);
  const body = Buffer.from(html, 'utf8');
  let gz = null;
  try { gz = zlib.gzipSync(body, { level: 6 }); } catch (e) { gz = null; }
  /* ETag 必须含 rev：否则设备 B 拿旧 ETag 命中 304，页面里是旧快照，
     表现为「改了没反应」且刷新也修不好（ETag 没变）—— 最难排查的一类 bug。 */
  const etag = '"fm-' + AGENT_VERSION + '-' + rev + '-' + body.length.toString(16) + '"';
  staticCache = { rev: rev, body: body, gz: gz, etag: etag };
  return staticCache;
}

/* 首屏同步快照：把 store 内容内联进页面，让脚本里 L2885 的
   lsGet('filaments') 第一次就读到服务端数据 —— 不需要 reload、不需要遮罩、
   也没有「异步拉回来之前内存里已经是示例数据」的竞态。

   FM_NO_INJECT=1 可关掉注入（排查「是注入把页面弄坏了还是别的原因」时用）。 */
function buildBootstrap(store) {
  if (!store || process.env.FM_NO_INJECT === '1') return null;
  const s = store.snapshot();
  const payload = { rev: s.rev, initialized: s.initialized, degraded: !!store.degraded, keys: {} };
  Object.keys(s.keys || {}).forEach(k => {
    payload.keys[k] = { v: s.keys[k].v, val: s.keys[k].val };
  });
  return 'window.__FM_STORE__=' + inlineJson(payload) + ';window.__FM_SERVER__=1;' +
         (AUTH_TOKEN ? 'window.__FM_TOKEN__=' + JSON.stringify(AUTH_TOKEN) + ';' : '');
}

/* 内联进 <script> 的 JSON 必须转义 <，否则耗材名/备注里出现 </script>
   会提前闭合脚本块，整页白屏（check_syntax 的正则也会被这个字符串截断）。
   U+2028/2029 在旧引擎里是非法换行，一并转掉。 */
function inlineJson(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/* 只认精确路径。绝不做 path.join(dir, decodeURIComponent(p))，那就是目录穿越。 */
function isStaticPath(p) {
  return p === '/' || p === '/index.html' || p === '/filament-manager.html';
}

function sendStatic(req, res, bootstrap, rev) {
  const c = buildStatic(rev, bootstrap);
  if (!c) return sendJson(res, 500, { error: 'web/filament-manager.html 未找到（镜像/目录结构不完整）' });
  const useGz = !!c.gz && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
  const body = useGz ? c.gz : c.body;
  const h = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache',
    'ETag': c.etag,
    'Vary': 'Accept-Encoding',            // 不写会被中间缓存把 gzip 版发给不支持的客户端
    'X-Content-Type-Options': 'nosniff',
  };
  const inm = req.headers['if-none-match'];
  if (inm && inm === c.etag && (req.method === 'GET' || req.method === 'HEAD')) {
    res.writeHead(304, h);
    return res.end();
  }
  if (useGz) h['Content-Encoding'] = 'gzip';
  h['Content-Length'] = body.length;      // Buffer 字节数，不是 String.length（满页中文）
  res.writeHead(200, h);
  if (req.method === 'HEAD') return res.end();
  res.end(body);
}

/* ══════════════════════ 主装配 ══════════════════════ */

function main() {
  /* 测试钩子：PRINTER_AGENT_DIR / PRINTER_AGENT_PORT 可把配置、历史、端口
     指到别处，避免自测污染项目目录。正常使用不设置即可。 */
  /* dir 已在文件头部按 PRINTER_AGENT_DIR 解析好（本地默认 <项目根>/data，容器为 /data） */
  const dir = DIR;
  /* 首次运行（仓库里还没有 data/）自动建目录，否则写 printer.config.json 会 ENOENT */
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* 只读挂载等场景忽略 */ }
  const cfgPath = path.join(dir, 'printer.config.json');
  const histPath = path.join(dir, 'printer-history.json');
  const cfg = loadConfig(cfgPath);
  if (process.env.PRINTER_AGENT_PORT)
    cfg.port = Number(process.env.PRINTER_AGENT_PORT) || cfg.port;
  const history = new HistoryStore(histPath, cfg);
  const clients = new Map();     // serial -> BambuClient
  const lastSnap = {};           // printerId -> ms

  /* 鉴权：容器部署在 compose 里设 FM_AUTH=on；桌面本地用法不设，
     保持「只监听 127.0.0.1 + 无需 token」的老行为。
     值既不是 on 也不是 off 时，直接当作令牌内容（高级用法：自己指定固定令牌）。 */
  const authCfg = String(process.env.FM_AUTH || '').trim();
  if (authCfg && authCfg.toLowerCase() !== 'off') {
    if (authCfg.toLowerCase() !== 'on') {
      AUTH_TOKEN = authCfg;
      console.log('[printer-agent] 使用环境变量指定的访问令牌');
    } else {
      const tf = path.join(dir, 'agent-token');
      try { AUTH_TOKEN = String(fs.readFileSync(tf, 'utf8')).trim() || null; } catch (e) { AUTH_TOKEN = null; }
      if (!AUTH_TOKEN) {
        AUTH_TOKEN = require('crypto').randomBytes(24).toString('hex');
        try {
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(tf, AUTH_TOKEN, { encoding: 'utf8', mode: 0o600 });
          console.log('[printer-agent] 已生成访问令牌并落盘：' + tf + '（权限 0600）');
        } catch (e) {
          console.warn('[printer-agent] 令牌落盘失败，重启后会变：' + (e && e.message));
        }
      }
    }
  }

  /* 切片用量抓取器：懒加载。两个数据源各自独立降级 ——
     缺 basic-ftp/fflate 只废掉「本地 3mf」这条路，
     没装或没登录拓竹云只废掉「云端任务」那条路，
     MQTT 主链路永远照常工作，最差退回「手动校准」老路径。 */
  let bambuCloud = null;
  try {
    const CL = require('./printer-cloud');
    bambuCloud = new CL.BambuCloud({
      dir: dir,
      region: cfg.bambuRegion || 'cn',
      log: msg => console.log(msg),
    });
    if (bambuCloud.isLoggedIn()) {
      const d = Math.round(bambuCloud.ttlSec() / 86400);
      console.log('[cloud] 已载入拓竹云登录态（剩余 ' + d + ' 天）');
    }
  } catch (e) {
    console.warn('[printer-agent] 拓竹云功能不可用（' + (e && e.message) + '）');
  }

  let sliceFetcher = null;
  try {
    const SL = require('./printer-slice');
    sliceFetcher = new SL.SliceFetcher({
      getPrinter: pid => (cfg.printers || []).find(p => p.id === pid) || null,
      store: history,                       // 复用 setSliced / setSlicedState / patchTask
      cloud: bambuCloud,                    // 本地 3mf 拿不到时的兜底
      log: msg => console.log(msg),
    });
  } catch (e) {
    console.warn('[printer-agent] 切片用量功能不可用（' + (e && e.message) + '），仅 AMS/手动校准可用');
  }

  /* 服务端库存存储：容器部署时前端 localStorage 退化为缓存，这里才是权威副本。
     同样懒加载 —— 缺了只让页面回到「浏览器本地存储」的老行为，不影响 MQTT 监控。 */
  let appStore = null, storeModule = null;
  try {
    storeModule = require('./printer-store');
    appStore = new storeModule.AppStore({ dir: dir, log: msg => console.log(msg) });
    /* 启动就把数据目录打出来：NAS 上要看/备份数据时不用再猜是命名卷还是宿主目录 */
    console.log('[printer-agent] 库存数据目录 ' + appStore.storeDir +
      '（' + Object.keys(appStore.db.keys).length + ' 个键' +
      (appStore.degraded ? '，索引已降级' : '') +
      (appStore.migrated ? '，已从 app-store.json 迁移' : '') + '）');
  } catch (e) {
    console.warn('[printer-agent] 服务端存储不可用（' + (e && e.message) + '），页面回退到浏览器 localStorage');
  }

  /* ── 云端补录 ──
     有些任务在「云还没登录」或「网络抖动」时结束，afterClose 那一次没抓到用量，
     会永久停在 slicedState:'pending'。这里按需补抓一次。
     节流 90s、每次最多 8 条、单条最多试 3 次，全在后台跑，绝不影响接口响应。 */
  let backfillAt = 0;
  let backfillBusy = false;
  function backfillCloudSliced() {
    if (!bambuCloud || !bambuCloud.isLoggedIn() || backfillBusy) return;
    const now = Date.now();
    if (now - backfillAt < 90000) return;
    backfillAt = now;

    /* 补录窗口默认 30 天，必须 ≥ 前端 prnSlicedSweep 的切片窗口（printerCfg.sliceWindowDays）。
       以前这里写死 7 天、前端 7 天、agent 留 90 天，三套窗口各说各话：
       用户隔 10 天再开页面时，任务还在 agent 里，补录却已经放弃，前端也就永远拿不到。 */
    const backfillDays = Math.max(1, Number(process.env.FM_BACKFILL_DAYS) || 30);
    const cut = now - backfillDays * 864e5;
    /* 只补有 taskId 的。没有 taskId 时 findTask 会退到「同设备最近一条」，
       会把 A 板的用量套到 B 板的任务上 —— 错配比没数据更糟，一律不补。 */
    const todo = (history.db.tasks || []).filter(t => t && !t.sliced
      && t.slicedState !== 'ok' && t.slicedState !== 'none'
      && t.taskId != null && String(t.taskId) !== ''
      && (t.backfillTries || 0) < 3
      && (() => { const ts = Date.parse(t.endAt || t.startAt || ''); return Number.isFinite(ts) && ts >= cut; })());
    if (!todo.length) return;

    backfillBusy = true;
    (async () => {
      /* 从**最新**的任务开始补（tasks 是 push 进去的，末尾最新）。
         反着取会永远先试最旧的那 8 条，新任务一直排在队尾轮不到。 */
      for (const t of todo.slice(-8).reverse()) {
        const pc = (cfg.printers || []).find(x => x.id === t.printerId);
        if (!pc || !pc.serial) continue;
        try {
          const hit = await bambuCloud.fetchSliced(pc.serial, {
            taskId: t.taskId || null,
            plateIdx: t.plateIdx || null,
            startAt: t.startAt || null,
          });
          if (hit && hit.ok) {
            /* 双保险：任务侧和用量侧的板号都有值时必须一致 */
            const p1 = Number(t.plateIdx) || null;
            const p2 = (hit.data && Number(hit.data.plate)) || null;
            if (p1 && p2 && p1 !== p2) {
              history.patchTask(t.id, { slicedState: 'none' });
              console.log('[cloud] 补录板号不符（任务 ' + p1 + ' / 用量 ' + p2 + '），丢弃：'
                + String(t.taskName || t.id).slice(0, 24));
            } else {
              history.patchTask(t.id, { sliced: hit.data, slicedState: 'ok' });
              console.log('[cloud] 补录用量成功：' + String(t.taskName || t.id).slice(0, 32));
            }
          } else {
            const tries = (t.backfillTries || 0) + 1;
            /* 云上明确没有这条（EMPTY/NOFILE）且已试满 3 次 → 标 none，不再重试 */
            const giveUp = tries >= 3 && hit && (hit.reason === 'EMPTY' || hit.reason === 'NOFILE');
            history.patchTask(t.id, {
              backfillTries: tries,
              slicedState: giveUp ? 'none' : 'pending',
            });
          }
        } catch (e) { /* 单条失败不影响其他 */ }
      }
    })().catch(() => {}).finally(() => { backfillBusy = false; });
  }

  /* 状态回流：判定任务边界 + 节流落快照 */
  function onState(pid, state, client) {
    /* ctx.lastMessageAt 让 handleState 能判「打印机多久没说话了」。
       断电时 gcodeState 会冻在 RUNNING，只看状态永远等不到结账。 */
    const ev = handleState(history, pid, state, lastSnap, cfg.pollSeconds, {
      lastMessageAt: client ? client.lastMessageAt : null,
      online: !!(client && client.state && client.state.online),
    }) || {};
    /* 切片抓取：全部 fire-and-forget，绝不 await，绝不抛错到 MQTT 回调里 */
    const sf = sliceFetcher;
    if (!sf) return;
    if (ev.opened) sf.start(pid, state);
    else if (state.print.gcodeState === 'RUNNING') sf.note(pid, state);
    if (ev.closed) sf.afterClose(pid, ev.closed, state);
  }

  function addClient(p) {
    if (clients.has(p.serial)) return clients.get(p.serial);
    const c = new BambuClient(p, { onState: onState, cfg: cfg });
    clients.set(p.serial, c);
    c.connect();
    return c;
  }
  function clientById(id) {
    for (const c of clients.values()) if (c.cfg.id === id) return c;
    return null;
  }
  function persistCfg() { atomicWrite(cfgPath, cfg); }

  cfg.printers.forEach(addClient);

  /* 周期性 pushall：长连接可能静默丢事件，兜底全量刷新 */
  setInterval(() => clients.forEach(c => { if (c.state.online) c.pushAll(); }),
              (cfg.pollSeconds || 60) * 1000);

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const p = u.pathname;
    /* CORS 预检：必须原样带回 Allow-* 头，浏览器才会放行后续真正的请求 */
    if (req.method === 'OPTIONS') { res.writeHead(204, corsHeaders()); res.end(); return; }
    /* 令牌校验：health 例外（Docker HEALTHCHECK 和前端探活都要能通） */
    if (AUTH_TOKEN && p.indexOf('/api/') === 0 && p !== '/api/health'
        && String(req.headers['x-fm-token'] || '') !== AUTH_TOKEN)
      return sendJson(res, 401, { error: '缺少或错误的 X-FM-Token', reason: 'NOAUTH', needToken: true });
    try {
      if (p === '/api/health')
        return sendJson(res, 200, { ok: true, version: AGENT_VERSION,
          uptimeSec: Math.round(process.uptime()), printerCount: clients.size,
          /* 前端据此判断这个 agent 支持哪些用量数据源（v1 一个都没有） */
          features: [].concat(sliceFetcher ? ['slice3mf'] : [], bambuCloud ? ['cloud'] : [],
                              appStore ? ['store'] : []),
          /* store: ok / degraded（文件损坏已降级空库）/ off（模块没装上） */
          store: appStore ? (appStore.degraded ? 'degraded' : 'ok') : 'off',
          /* 容器 bridge 网络收不到 SSDP 组播，前端据此给「请手动填 IP」的提示 */
          net: { mode: netMode(), ssdp: netMode() === 'bridge' ? 'degraded' : 'ok', ssdpPort: ssdpPort() },
          cloud: bambuCloud ? bambuCloud.status() : { loggedIn: false, region: 'cn' } });

      /* ── 拓竹云：登录态与凭据管理 ──
         密码只在 login 请求体内出现一次，换出 accessToken 后立即丢弃，
         磁盘上只有 token（bambu-cloud.json，权限 600）。 */
      if (p === '/api/bambu/status' && req.method === 'GET') {
        if (!bambuCloud) return sendJson(res, 503, { error: '拓竹云模块未加载' });
        return sendJson(res, 200, Object.assign({ ok: true }, bambuCloud.status()));
      }

      if (p.indexOf('/api/bambu/') === 0) {
        if (!bambuCloud) return sendJson(res, 503, { error: '拓竹云模块未加载' });
        let b = {};
        if (req.method === 'POST') {
          const rb = await readJsonBody(req, 64 * 1024);
          if (!rb.ok) return sendJson(res, rb.status, { error: rb.error });
          b = rb.data;
        }

        if (p === '/api/bambu/login' && req.method === 'POST') {
          const r = await bambuCloud.login(String(b.account || '').trim(), String(b.password || ''));
          return sendJson(res, r.ok ? 200 : (r.needCode ? 409 : 401), r);
        }

        if (p === '/api/bambu/login-code' && req.method === 'POST') {
          const r = await bambuCloud.loginWithCode(String(b.account || '').trim(), String(b.code || '').trim());
          return sendJson(res, r.ok ? 200 : 401, r);
        }

        if (p === '/api/bambu/send-code' && req.method === 'POST') {
          const account = String(b.account || '').trim();
          if (!account) return sendJson(res, 400, { error: '请填写账号' });
          const kind = b.kind === 'sms' ? 'sms' : 'email';
          const r = kind === 'sms'
            ? await bambuCloud.sendSmsCode(account)
            : await bambuCloud.sendEmailCode(account);
          return sendJson(res, r.ok ? 200 : 400, r);
        }

        if (p === '/api/bambu/logout' && req.method === 'POST') {
          bambuCloud.logout();
          return sendJson(res, 200, { ok: true });
        }

        if (p === '/api/bambu/region' && req.method === 'POST') {
          const rg = String(b.region || '');
          if (!require('./printer-cloud').REGIONS[rg])
            return sendJson(res, 400, { error: '区域只能是 cn 或 global' });
          bambuCloud.region = rg;
          cfg.bambuRegion = rg;
          persistCfg();
          /* 换区后旧 token 无效，直接清掉免得混用 */
          bambuCloud.logout();
          return sendJson(res, 200, { ok: true, region: rg });
        }

        /* 诊断：把云上最近的任务摊平给前端看，确认任务与 MQTT 的 taskId 能对上 */
        if (p === '/api/bambu/tasks' && req.method === 'GET') {
          const lim = Math.min(50, Math.max(1, Number(u.searchParams.get('limit')) || 10));
          const r = await bambuCloud.getTaskList({ limit: lim });
          if (!r.ok) return sendJson(res, r.reason === 'NOAUTH' ? 401 : 502, r);
          return sendJson(res, 200, { ok: true, total: r.total, hits: r.hits.map(t => ({
            id: t.id, title: t.title, deviceId: t.deviceId, plateIndex: t.plateIndex,
            weight: t.weight, status: t.status, startTime: t.startTime, endTime: t.endTime,
            slots: (t.amsDetailMapping || []).map(a => ({
              ams: a.ams, type: a.filamentType, color: a.targetColor, weight: a.weight,
            })),
          })) });
        }

        return sendJson(res, 404, { error: '接口不存在：' + p });
      }

      /* ── 服务端库存存储（容器部署时前端退化为缓存） ──
         脏键推送 + 每键版本号：跨键永不互相覆盖，同键冲突回 409 并带服务端现值。 */
      const stm = p.match(/^\/api\/store(?:\/(export))?$/);
      if (stm) {
        if (!appStore)
          return sendJson(res, 503, { error: '服务端存储不可用', reason: 'STORE_DOWN' });
        if (stm[1] === 'export') {
          if (req.method !== 'GET') return sendJson(res, 405, { error: '只支持 GET' });
          return sendJson(res, 200, appStore.exportBundle());
        }
        if (req.method === 'GET') {
          /* info=1：数据到底落在哪个目录、有哪些文件。NAS 上迁移/备份时要能自己查，
             不用去翻容器里的 docker inspect。 */
          if (u.searchParams.get('info') === '1') return sendJson(res, 200, appStore.info());
          return sendJson(res, 200, u.searchParams.get('meta') === '1' ? appStore.meta() : appStore.snapshot());
        }
        if (req.method === 'PUT' || req.method === 'POST') {
          const rb = await readJsonBody(req, storeModule ? storeModule.LIMIT_BODY : 8388608);
          if (!rb.ok) return sendJson(res, rb.status, { error: rb.error });
          const r = appStore.put(rb.data.base, rb.data.keys);
          return sendJson(res, r.ok ? 200 : (r.status || 400), r);
        }
        return sendJson(res, 405, { error: '只支持 GET / PUT' });
      }

      if (p === '/api/printers' && req.method === 'GET')
        return sendJson(res, 200, cfg.printers.map(pc => {
          const c = clientById(pc.id);
          return { id: pc.id, name: pc.name, host: pc.host, serial: pc.serial,
            online: !!(c && c.state.online), lastSeen: c && c.state.lastSeen,
            printing: !!(c && c.state.print.gcodeState === 'RUNNING'),
            taskName: c && c.state.print.taskName };
        }));

      if (p === '/api/printers' && req.method === 'POST') {
        const rb = await readJsonBody(req, 64 * 1024);
        if (!rb.ok) return sendJson(res, rb.status, { error: rb.error });
        const b = rb.data;
        const host = String(b.host || '').trim();
        const serial = String(b.serial || '').trim();
        const accessCode = String(b.accessCode || '').trim();
        if (!host || !serial || !accessCode)
          return sendJson(res, 400, { error: 'host / serial / accessCode 均为必填' });
        if (cfg.printers.some(x => x.serial === serial))
          return sendJson(res, 409, { error: '该序列号已存在，请勿重复添加' });
        const pc = { id: nextPrinterId(cfg.printers),
          name: String(b.name || '').trim() || host, host, serial, accessCode };
        cfg.printers.push(pc);
        persistCfg();
        addClient(pc);
        return sendJson(res, 200, { ok: true, printer: { id: pc.id, name: pc.name } });
      }

      /* 必须注册在下面 /api\/printers\/([^/]+) 通配之前，
         否则 "discover" 会被当成打印机 id 吞掉返回 404 */
      if (p === '/api/printers/discover' && req.method === 'GET') {
        const r = await discover(u.searchParams.get('timeout'));
        if (r.error) return sendJson(res, 409, { error: r.error, hint: r.hint });
        const out = { ok: true, printers: r.printers, scannedMs: r.scannedMs };
        /* bridge 网络下「搜到 0 台」几乎一定是组播进不来，不是打印机没开。
           纯增量字段，旧前端不认识就忽略；新前端据此换一段排障文案。 */
        if (!r.printers.length && netMode() === 'bridge')
          out.reason = 'MULTICAST_UNAVAILABLE';
        return sendJson(res, 200, out);
      }

      /* 切片用量诊断与手动重抓 —— 同样必须在下面通配正则之前注册，
         否则 "sliced" 会被当成打印机 id 吞掉（和 discover 踩过同一个坑） */
      const sm = p.match(/^\/api\/printers\/([^/]+)\/sliced(?:\/(probe|fetch))?$/);
      if (sm) {
        const pid = decodeURIComponent(sm[1]);
        const pc = (cfg.printers || []).find(x => x.id === pid);
        if (!pc) return sendJson(res, 404, { error: '打印机不存在' });
        if (sm[2] === 'probe') {
          if (!sliceFetcher) return sendJson(res, 503, { error: '切片功能未启用（缺少依赖）' });
          const SL = require('./printer-slice');
          return sendJson(res, 200, await SL.probe(pc));
        }
        if (sm[2] === 'fetch') {
          if (!sliceFetcher) return sendJson(res, 503, { error: '切片功能未启用（缺少依赖）' });
          const c = clientById(pid);
          const src = u.searchParams.get('src');
          const hit = src === 'cloud'
            ? await sliceFetcher.cloudOnly(pid, c ? c.state : null)
            : await sliceFetcher.refetch(pid, c ? c.state : null);
          return sendJson(res, 200, hit || { ok: false, reason: 'UNKNOWN' });
        }
        /* GET /api/printers/:id/sliced → 当前开着的任务的切片状态 */
        const o = history.getOpen(pid);
        return sendJson(res, 200, {
          taskName: o ? o.taskName : null,
          taskId: o ? o.taskId : null,
          slicedState: o ? o.slicedState : null,
          sliced: o ? o.sliced : null,
          cloud: bambuCloud ? bambuCloud.status() : null,
        });
      }

      /* POST /api/printers/:id/task/close —— 主动结账（v3）
         前端在「AMS 已停在 FINISH/FAILED 但 agent 没收到状态迁移」时兜底调用，
         不用等下一次 MQTT 上报。没有 open 任务时回 409，前端静默忽略即可。
         必须注册在下面 /api/printers/([^/]+)(?:/(state|refresh))? 通配之前。 */
      const cm = p.match(/^\/api\/printers\/([^/]+)\/task\/close$/);
      if (cm && req.method === 'POST') {
        const pid = decodeURIComponent(cm[1]);
        const pc = cfg.printers.find(x => x.id === pid);
        if (!pc) return sendJson(res, 404, { error: '打印机不存在' });
        const body = await readJsonBody(req, 8192);
        const want = body.ok && body.data ? String(body.data.result || '').toUpperCase() : '';
        const result = (want === 'FAILED' || want === 'STALE') ? want : 'FINISH';
        const c = clientById(pid);
        const st = (c && c.state && c.state.online) ? c.state : null;
        /* 拿不到实时状态时 endSlots 传空：closeTask 会退回 open 里的起始重量，
           差值算出来是 0 → 只丢这次 AMS 差值，切片那条路照常，不会写坏余量。 */
        const rec = history.closeTask(pid, slotWeights(st || {}), result, st || {});
        if (!rec) return sendJson(res, 409, { error: '当前没有进行中的任务' });
        return sendJson(res, 200, { ok: true, task: rec });
      }

      const m = p.match(/^\/api\/printers\/([^/]+)(?:\/(state|refresh))?$/);
      if (m) {
        const pc = cfg.printers.find(x => x.id === m[1]);
        if (!pc) return sendJson(res, 404, { error: '打印机不存在' });
        const c = clientById(pc.id);
        if (req.method === 'DELETE') {
          if (c) c.disconnect();
          clients.delete(pc.serial);
          cfg.printers = cfg.printers.filter(x => x.id !== pc.id);
          persistCfg();
          return sendJson(res, 200, { ok: true });
        }
        if (m[2] === 'refresh') {
          /* 离线时先清掉退避、立刻再试一次，再回 409 —— 否则用户最坏要等 60 秒
             才等到下一次重连，看起来像「点了没反应」。 */
          if (!c || !c.state.online) {
            if (c) c.retryNow();
            return sendJson(res, 409, { error: '打印机未连接（离线或正在重连）' });
          }
          c.pushAll();
          return sendJson(res, 200, { ok: true });
        }
        const snap = c ? c.snapshot()
          : { id: pc.id, name: pc.name, host: pc.host,
              connection: { online: false, lastSeen: null, lastError: '未连接', reconnects: 0 },
              print: {}, ams: [], vtTray: null, lowStock: [], updatedAt: new Date().toISOString() };
        /* 当前挂着的 open 任务（v3）：刷新页面后前端靠它恢复「本次任务」上下文，
           不用再从 prnLastGcode 猜。没在跑时为 null。 */
        const o = history.getOpen(pc.id);
        snap.open = o ? {
          taskName: o.taskName, startAt: o.startAt, taskId: o.taskId,
          gcodeFile: o.gcodeFile, slicedState: o.slicedState,
        } : null;
        return sendJson(res, 200, snap);
      }

      if (p === '/api/usage') {
        /* 每次前端来取用量就顺带推进一次补录（内部节流 90s，不阻塞本次响应）。
           补回来的数据下一轮刷新就能被前端扣减命中。 */
        backfillCloudSliced();
        return sendJson(res, 200, history.usage(u.searchParams.get('days')));
      }

      if (p === '/api/lowstock')
        return sendJson(res, 200, [...clients.values()].flatMap(c => c.lowStock()));

      /* 静态页面：必须是最后一道，且只认精确路径。
         不能把 /api 的未知路径也返 HTML —— 前端 r.json() 会报
         "Unexpected token <"，把「接口拼错了」伪装成「数据解析炸了」。 */
      if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
      if (isStaticPath(p) && (req.method === 'GET' || req.method === 'HEAD')) {
        return sendStatic(req, res, buildBootstrap(appStore), appStore ? appStore.db.rev : 0);
      }

      sendJson(res, 404, { error: '接口不存在：' + p });
    } catch (e) {
      sendJson(res, 500, { error: String((e && e.message) || e) });
    }
  });

  server.on('error', e => {
    if (e && e.code === 'EADDRINUSE') {
      console.error('[printer-agent] 端口 ' + cfg.port + ' 已被占用。');
      console.error('  请修改 printer.config.json 里的 "port"，或先关掉占用该端口的程序再启动。');
      process.exit(1);
    }
    console.error('[printer-agent] 服务异常：' + String((e && e.message) || e));
    process.exit(1);
  });

  const host = listenHost();
  server.listen(cfg.port, host, () => {
    const shown = host === '0.0.0.0' ? '0.0.0.0（容器/局域网可达）' : host;
    console.log('[printer-agent] 已启动：http://' + (host === '0.0.0.0' ? '127.0.0.1' : host) + ':' + cfg.port +
      ' · 监听 ' + shown +
      ' · 打印机 ' + clients.size + ' 台 · 低库存阈值 ' + cfg.lowStock.mode +
      '(' + cfg.lowStock.percent + '% / ' + cfg.lowStock.grams + 'g)');
    if (netMode() === 'bridge')
      console.log('[printer-agent] net=bridge：SSDP 组播收不到，自动搜索不可用，请在页面手动填 IP + 序列号 + 访问码');
    else if (netMode() === 'host')
      console.log('[printer-agent] net=host：直接用宿主机网卡，局域网自动搜索（SSDP UDP ' +
        ssdpPort() + '）应当可用；搜不到先确认打印机与本机同网段、且 UDP ' + ssdpPort() + ' 没被别的东西占着');
    if (!clients.size)
      console.log('[printer-agent] 尚未添加打印机。打开耗材管理页 → 打印机标签 → 添加打印机。');
  });

  /* 优雅退出：关窗口时断开 MQTT */
  function shutdown() {
    console.log('\n[printer-agent] 正在退出…');
    clients.forEach(c => c.disconnect());
    try { history.flush(); } catch (e) { /* 忽略 */ }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  /* 未捕获的 Promise 拒绝只记录不退出：切片抓取是 fire-and-forget，
     任何漏网异常都不该把整个监控服务带下去（Node 22 默认会直接退出） */
  process.on('unhandledRejection', e => {
    console.warn('[printer-agent] 未处理的异步异常（已忽略）：' + String((e && e.message) || e));
  });
}

/* 被 require 时只导出，不启动服务（供自测脚本使用） */
if (require.main === module) main();

module.exports = {
  defaultConfig, loadConfig, atomicWrite, nextPrinterId,
  rgba8ToHex, parseTray, parseAms, slotWeights, slotTags, slotMeta, slotSnap,
  isLow, trayLoaded, hasRfid,
  HistoryStore, BambuClient, sendJson, handleState,
  bambuBackoffDelay, logThrottled, logThrottledReset,
  BAMBU_BACKOFF_MIN, BAMBU_BACKOFF_MAX, STALE_OPEN_MS, ACTIVE_PRINT_STATES,
  parseSsdpNotify, discover,
};
