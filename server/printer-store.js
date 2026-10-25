/* ══════════════════════════════════════════════════════════════
   printer-store.js — 库存数据的服务端存储（容器部署 / 本地 agent 共用）
   ──────────────────────────────────────────────────────────────
   前端原本把 13 个键存在浏览器 localStorage 里，换设备就换一份数据。
   跑起 agent 之后改由本模块持有权威副本，浏览器侧退化为缓存。

   ── 落盘布局（v2：一个键一个文件，直接可读）──
     data/
       store/
         _meta.json          {schema,rev,initialized,keys:{k:{v,at}}}  ← 只有版本号，没有数据
         filaments.json      库存数组（打开就能改，不用解嵌套的转义字符串）
         savedTags.json
         swFavs.json
         ...
       app-store.json        v1 旧格式，仅首次启动时被迁移，之后改名 .migrated-<ts>

   v1 把 13 个键塞进一个 app-store.json，值是二次转义后的字符串
   （`{"keys":{"filaments":{"val":"[{\"id\":1,...}]"}}}`），人能读但没有意义。
   v2 拆成一键一文件后：备份只拷 store/、手改库存只动 filaments.json、
   Git/Syncthing 这类工具能按文件做 diff，NAS 上也能用文件管理器直接看。

   ── 对外接口 ──
     GET  /api/store             全量快照（页面注入用）
     GET  /api/store?meta=1      只回每键版本号（轮询用，几 KB）
     GET  /api/store?info=1      存储位置 / 文件清单 / 字节数（排障与迁移用）
     PUT  /api/store             {base:{k:v}, keys:{k:rawString}}

   并发策略是「脏键 + 每键版本号」，不是全量覆盖：
     - 跨键永远不会互相覆盖（A 改 filaments 不会带旧 prnCalibLog 上去）
     - 同键冲突返回 409 并把服务端现值带回去，前端提示「另一端也改了」
       —— 绝不静默吞掉，宁可见冲突也不要悄悄丢数据

   一致性边界（必须知道）：一个键一个文件，**跨键写入不是事务**。
   put() 一次提交多个键时先写全部 .tmp、再逐个 rename、最后写 _meta.json。
   写 .tmp 阶段失败（磁盘满 / 只读）会整体回滚，不会留下半套数据；
   只有 rename 阶段被外力打断才可能出现「A 键新、B 键旧」。
   顺序刻意是「先数据、后 meta」：meta 落后只会让版本号偏小，
   反过来（meta 先涨）则客户端会以为磁盘上已经是新值。

   文件坏了只降级不抛错：MQTT 监控比库存数据更要紧，仓库文件
   损坏不能把整个 agent 带下去（改名备份 + 空库启动 + health 标 degraded）。
   ══════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');

const SCHEMA = 2;
const STORE_SUBDIR = 'store';
const META_NAME = '_meta.json';
const LEGACY_NAME = 'app-store.json';

/* 可同步的键。刻意排除三个：
   - printerCfg：printers 来自 /api/printers，同源下 agentUrl 无意义，
     且每轮刷新都会被重写，同步纯属制造写放大
   - printerUsage：/api/usage 的缓存镜像，权威在 agent 侧的 printer-history.json
   - swView：设备本地偏好（grid/list），A 切列表视图不该把 B 也切了
   另外 swView 存的是裸字符串不是 JSON，混进来会让统一校验失效 */
const SYNC_KEYS = [
  'filaments', 'savedTags', 'swFavs', 'trash', 'lowStockCfg',
  'prnTagBind', 'prnTagArc', 'prnCalibLog', 'prnSlotHist', 'prnSlicedApply',
  'prnSlotMatch', 'prnSlicedSeen', 'filamentLog',
];

const LIMIT_BODY = 8 * 1024 * 1024;    // 单次 PUT 请求体上限
const LIMIT_KEY = 1024 * 1024;         // 单个键上限
const LIMIT_TOTAL = 8 * 1024 * 1024;   // 整库上限

function isSyncKey(k) { return SYNC_KEYS.indexOf(String(k)) >= 0; }

/* 原子写 + fsync：先写 .tmp，flush 到盘，再 rename。
   不加 fsync 时断电可能丢最后一次写（rename 已经保证不会写出半个文件）。 */
function writeDurable(file, text) {
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function emptyDb() {
  return { schema: SCHEMA, rev: 0, initialized: false, keys: {} };
}

/* 键名要拼进文件名，必须挡住 ../ 和路径分隔符。
   白名单已经挡住未知键，这里是第二道闸（防止以后有人放宽白名单时出事）。 */
function safeKeyName(k) {
  const s = String(k);
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(s)) return null;
  return s;
}

class AppStore {
  /* opts: { dir, log } */
  constructor(opts) {
    this.opts = opts || {};
    /* 默认跟 agent 一致：<项目根>/data（容器里由 PRINTER_AGENT_DIR 传 /data）。
       模块在 server/ 下，所以上一级才是项目根。 */
    this.dir = this.opts.dir || process.env.PRINTER_AGENT_DIR || path.join(__dirname, '..', 'data');
    this.storeDir = path.join(this.dir, STORE_SUBDIR);
    this.metaFile = path.join(this.storeDir, META_NAME);
    this.legacyFile = path.join(this.dir, LEGACY_NAME);
    this.log = typeof this.opts.log === 'function' ? this.opts.log : () => {};
    this.degraded = false;
    this.migrated = false;
    this.db = emptyDb();
    this.load();
  }

  keyFile(k) {
    const n = safeKeyName(k);
    return n ? path.join(this.storeDir, n + '.json') : null;
  }

  /* ── 启动加载：新格式 → 无 meta 重建 → v1 迁移 → 空库 ── */
  load() {
    if (fs.existsSync(this.metaFile)) return this._loadV2();
    /* store/ 下有数据文件却没有 meta：用户手工删了 meta，或 meta 写到一半断电。
       重建比清空安全得多 —— 数据文件还在。 */
    if (fs.existsSync(this.storeDir)) {
      const rebuilt = this._rebuildFromFiles();
      if (rebuilt) return this.db;
    }
    if (fs.existsSync(this.legacyFile)) return this._migrateLegacy();
    this.db = emptyDb();
    return this.db;
  }

  _loadV2() {
    let meta = null;
    try {
      meta = JSON.parse(fs.readFileSync(this.metaFile, 'utf8'));
    } catch (e) {
      meta = null;
    }
    if (!meta || typeof meta !== 'object' || !meta.keys || typeof meta.keys !== 'object') {
      /* meta 坏了但数据文件可能都好好的：备份坏 meta，再按文件重建。
         绝不 rename 整个 store/ —— 那才是真的丢数据。 */
      this.degraded = true;
      const bak = this.metaFile + '.corrupt-' + Date.now();
      try { fs.renameSync(this.metaFile, bak); } catch (_) { /* 备份失败也继续 */ }
      this.log('[store] _meta.json 解析失败，已备份为 ' + path.basename(bak) + '，按数据文件重建索引');
      return this._rebuildFromFiles() || this.db;
    }
    const db = emptyDb();
    db.rev = Number(meta.rev) > 0 ? Math.floor(Number(meta.rev)) : 0;
    db.initialized = meta.initialized === true;
    const lost = [];
    Object.keys(meta.keys).forEach(k => {
      if (!isSyncKey(k)) return;                       // 白名单外的历史脏数据直接丢弃
      const e = meta.keys[k];
      if (!e || typeof e !== 'object') return;
      const file = this.keyFile(k);
      if (!file) return;
      let val = null;
      try { val = fs.readFileSync(file, 'utf8'); } catch (_) { val = null; }
      if (val == null) { lost.push(k); return; }        // 单个键文件丢了：其他键照常服务
      /* 内容不是合法 JSON：改名备份 + 跳过这个键。
         绝不能把坏内容原样喂给前端 —— 前端 readJson 解析失败会退到 DEFAULT_DATA，
         接着一保存就把示例数据盖掉了，等于把「一个文件坏了」放大成「这个键的数据没了」。 */
      try {
        JSON.parse(val);
      } catch (_) {
        this.degraded = true;
        const bak = file + '.corrupt-' + Date.now();
        try { fs.renameSync(file, bak); } catch (_) { /* 备份失败也继续 */ }
        this.log('[store] ' + k + '.json 不是合法 JSON，已备份为 ' + path.basename(bak) + '，该键按空处理');
        lost.push(k);
        return;
      }
      db.keys[k] = {
        v: Number(e.v) > 0 ? Math.floor(Number(e.v)) : 0,
        at: typeof e.at === 'string' ? e.at : null,
        val: val,
      };
      if (db.keys[k].v > db.rev) db.rev = db.keys[k].v;
    });
    if (lost.length) {
      this.degraded = true;
      this.log('[store] 以下键的数据文件缺失，已跳过：' + lost.join(', '));
    }
    this.db = db;
    return db;
  }

  /* 没有 meta 时扫描 store/*.json 重建（版本号从 0 起）。
     有文件就说明曾经有数据，重建后 rev=0，客户端首轮 base 会不匹配 → 走 409 + 人工确认，
     不会静默覆盖。 */
  _rebuildFromFiles() {
    let names = [];
    try { names = fs.readdirSync(this.storeDir); } catch (e) { return null; }
    const db = emptyDb();
    let n = 0;
    names.forEach(f => {
      if (!/\.json$/.test(f) || f === META_NAME) return;
      const k = f.slice(0, -5);
      if (!isSyncKey(k)) return;
      let val = null;
      try { val = fs.readFileSync(path.join(this.storeDir, f), 'utf8'); } catch (_) { return; }
      if (!val) return;
      try { JSON.parse(val); } catch (_) { return; }   // 坏文件不进索引，前端不会拿到非法 JSON
      db.keys[k] = { v: 0, at: null, val: val };
      n++;
    });
    if (!n) return null;
    this.db = db;
    this.degraded = true;                                // 索引是推断出来的，health 里要看得见
    this.log('[store] 缺少 _meta.json，已按 store/ 下 ' + n + ' 个数据文件重建索引（版本号归零）');
    try { this.save(); } catch (e) { /* 重建失败就先在内存里服务 */ }
    return db;
  }

  /* v1（单文件 app-store.json）→ v2（store/ 一键一文件） */
  _migrateLegacy() {
    let raw = null;
    try {
      raw = fs.readFileSync(this.legacyFile, 'utf8');
    } catch (e) {
      this.db = emptyDb();
      return this.db;
    }
    let j = null;
    try {
      j = JSON.parse(raw);
    } catch (e) {
      /* 文件损坏（位翻转 / 手工编辑 / 断电半写）：改名备份，空库启动。
         绝不 throw —— MQTT 监控不能因为库存文件坏了就不工作。 */
      this.degraded = true;
      const bak = this.legacyFile + '.corrupt-' + Date.now();
      try { fs.renameSync(this.legacyFile, bak); } catch (_) { /* 备份失败也继续 */ }
      this.log('[store] app-store.json 解析失败，已备份为 ' + path.basename(bak) + '，以空库启动');
      this.db = emptyDb();
      return this.db;
    }
    this.db = this._normalizeLegacy(j);
    const n = Object.keys(this.db.keys).length;
    try {
      this.save();
      this.migrated = true;
      if (n) {
        /* 迁移成功才改名。留着旧文件会让下次启动又走一遍迁移分支，
           而且两份数据不一致时排障极容易被误导。 */
        const bak = this.legacyFile + '.migrated-' + Date.now();
        try { fs.renameSync(this.legacyFile, bak); } catch (_) { /* 改不了名就算了，数据已经写新格式 */ }
        this.log('[store] 已把 app-store.json 迁移为 store/ 目录（' + n + ' 个键，旧文件改名 ' + path.basename(bak) + '）');
      } else {
        this.log('[store] app-store.json 是空库，已按新格式初始化 store/ 目录');
        try { fs.renameSync(this.legacyFile, this.legacyFile + '.migrated-' + Date.now()); } catch (_) { /* 忽略 */ }
      }
    } catch (e) {
      /* 新格式写不进去（只读挂载 / 磁盘满）：继续用解析出来的内存数据服务，
         别把 agent 拖下去。下次启动还会重试迁移。 */
      this.degraded = true;
      this.log('[store] 迁移到 store/ 失败，暂以内存副本服务：' + ((e && e.message) || e));
    }
    return this.db;
  }

  _normalizeLegacy(j) {
    const db = emptyDb();
    if (!j || typeof j !== 'object') return db;
    db.rev = Number(j.rev) > 0 ? Math.floor(Number(j.rev)) : 0;
    db.initialized = j.initialized === true;
    const keys = (j.keys && typeof j.keys === 'object' && !Array.isArray(j.keys)) ? j.keys : {};
    Object.keys(keys).forEach(k => {
      if (!isSyncKey(k)) return;
      const e = keys[k];
      if (!e || typeof e !== 'object') return;
      if (typeof e.val !== 'string') return;
      db.keys[k] = {
        v: Number(e.v) > 0 ? Math.floor(Number(e.v)) : 0,
        at: typeof e.at === 'string' ? e.at : null,
        val: e.val,
      };
      if (db.keys[k].v > db.rev) db.rev = db.keys[k].v;
    });
    return db;
  }

  _ensureDir() {
    if (!fs.existsSync(this.storeDir)) fs.mkdirSync(this.storeDir, { recursive: true });
  }

  _metaText() {
    const keys = {};
    Object.keys(this.db.keys).forEach(k => {
      keys[k] = { v: this.db.keys[k].v, at: this.db.keys[k].at };
    });
    return JSON.stringify({ schema: SCHEMA, rev: this.db.rev, initialized: this.db.initialized, keys: keys }, null, 0);
  }

  /**
   * 落盘。changed 为空时写全部键（迁移 / 重建用）。
   * 顺序：写全部 .tmp → 逐个 rename → 写 _meta.json。
   * 前两步任何一步抛错都向上抛（调用方负责回滚内存并回 503）。
   */
  save(changed) {
    this._ensureDir();
    const names = (changed && changed.length ? changed : Object.keys(this.db.keys))
      .filter(k => this.db.keys[k]);
    const tmps = [];
    try {
      /* 阶段一：全部写成 .tmp。这一步失败（磁盘满 / 只读）最容易发生，
         此时磁盘上还没有任何文件被替换，回滚成本为零。 */
      names.forEach(k => {
        const file = this.keyFile(k);
        if (!file) return;
        const tmp = file + '.tmp';
        tmps.push(tmp);
        const fd = fs.openSync(tmp, 'w');
        try {
          fs.writeSync(fd, this.db.keys[k].val);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      });
      /* 阶段二：逐个 rename。同一个目录内 rename 是原子的。 */
      names.forEach(k => {
        const file = this.keyFile(k);
        if (!file) return;
        fs.renameSync(file + '.tmp', file);
      });
    } catch (e) {
      tmps.forEach(t => { try { fs.unlinkSync(t); } catch (_) { /* 忽略 */ } });
      throw e;
    }
    /* 阶段三：最后写 meta。meta 落后只会让版本号偏小，反过来会骗客户端。 */
    writeDurable(this.metaFile, this._metaText());
  }

  /* 全量快照，给页面注入和首屏 hydrate 用 */
  snapshot() {
    return {
      schema: this.db.schema,
      rev: this.db.rev,
      initialized: this.db.initialized,
      keys: this.db.keys,
    };
  }

  /* 只有版本号，几 KB，给前端轮询「别的设备有没有改」 */
  meta() {
    const m = { rev: this.db.rev, initialized: this.db.initialized, keys: {} };
    Object.keys(this.db.keys).forEach(k => { m.keys[k] = this.db.keys[k].v; });
    return m;
  }

  /* 存储位置自描述：用户在 NAS 上要能一眼看出数据到底落在哪个目录 */
  info() {
    const files = Object.keys(this.db.keys).map(k => {
      const file = this.keyFile(k);
      let bytes = null;
      try { bytes = fs.statSync(file).size; } catch (_) { bytes = null; }
      return {
        key: k, file: path.relative(this.dir, file).split(path.sep).join('/'),
        bytes: bytes, v: this.db.keys[k].v, at: this.db.keys[k].at,
      };
    }).sort((a, b) => a.key.localeCompare(b.key));
    return {
      schema: SCHEMA,
      dir: this.dir,
      subdir: STORE_SUBDIR,
      meta: STORE_SUBDIR + '/' + META_NAME,
      degraded: this.degraded,
      migrated: this.migrated,
      files: files,
      totalBytes: this.totalBytes(),
      legacyPresent: fs.existsSync(this.legacyFile),
    };
  }

  totalBytes() {
    let n = 0;
    Object.keys(this.db.keys).forEach(k => { n += Buffer.byteLength(this.db.keys[k].val, 'utf8'); });
    return n;
  }

  /**
   * base: {key: 客户端上次看到的服务端版本号}
   * keys: {key: 原始字符串}
   * 返回 {ok:true, rev, keys:{k:newVersion}}
   *   或 {ok:false, status:409, conflict:{k:{v,at,val}}, meta}
   */
  put(base, keys) {
    if (!keys || typeof keys !== 'object' || Array.isArray(keys)) {
      return { ok: false, status: 400, error: 'keys 必须是对象' };
    }
    const names = Object.keys(keys);
    if (!names.length) return { ok: true, rev: this.db.rev, keys: {} };
    if (names.length > SYNC_KEYS.length) {
      return { ok: false, status: 400, error: '一次提交的键过多' };
    }

    const clean = {};
    for (const k of names) {
      if (!isSyncKey(k)) return { ok: false, status: 400, error: '不接受的键：' + k };
      if (!this.keyFile(k)) return { ok: false, status: 400, error: '非法的键名：' + k };
      const val = keys[k];
      if (typeof val !== 'string') return { ok: false, status: 400, error: '键 ' + k + ' 的值必须是字符串' };
      const bytes = Buffer.byteLength(val, 'utf8');
      if (bytes > LIMIT_KEY) {
        return { ok: false, status: 413, error: '键 ' + k + ' 超过 1MB 上限' };
      }
      clean[k] = val;
    }

    /* 逐键比对 base：只挡真正冲突的键，不影响同一次提交里其他安全的键 */
    const conflict = {};
    const b = (base && typeof base === 'object' && !Array.isArray(base)) ? base : {};
    for (const k of Object.keys(clean)) {
      const cur = this.db.keys[k] ? this.db.keys[k].v : 0;
      /* base 里【没有】这个键 = 客户端明确不做版本校验（如首次导入、脚本写入），跳过。
         注意必须用 hasOwnProperty 区分「没给」和「给了 0」：
         把「没给」当成 0 会让任何不带 base 的 PUT 在已有数据时全部 409。 */
      if (!Object.prototype.hasOwnProperty.call(b, k)) continue;
      const seen = b[k] == null || b[k] === '' ? 0 : Number(b[k]);
      if (!Number.isFinite(seen)) continue;
      if (seen !== cur) {
        conflict[k] = this.db.keys[k]
          ? { v: this.db.keys[k].v, at: this.db.keys[k].at, val: this.db.keys[k].val }
          : { v: 0, at: null, val: null };
      }
    }
    if (Object.keys(conflict).length) {
      return { ok: false, status: 409, conflict: conflict, meta: this.meta() };
    }

    /* 总量保护：算上本次新增后再判，避免把卷写满 */
    let projected = 0;
    Object.keys(this.db.keys).forEach(k => {
      if (!Object.prototype.hasOwnProperty.call(clean, k)) {
        projected += Buffer.byteLength(this.db.keys[k].val, 'utf8');
      }
    });
    Object.keys(clean).forEach(k => { projected += Buffer.byteLength(clean[k], 'utf8'); });
    if (projected > LIMIT_TOTAL) {
      return { ok: false, status: 413, error: '库存数据总大小超过 8MB 上限' };
    }

    const out = {};
    const at = new Date().toISOString();
    /* 先记旧状态：save() 可能因为磁盘满 / 权限 / 只读挂载而抛错，
       那时内存里的 rev 和键已经变了、磁盘没变。不回滚的话服务端会一直认为
       「版本已经是 N+1」，而重启后又退回 N —— 之后每次 PUT 都被判 409，
       用户看到的是「另一端也改了」，实际是写盘根本没成功。 */
    const prevRev = this.db.rev;
    const prevInit = this.db.initialized;
    const prevKeys = {};
    for (const k of Object.keys(clean)) {
      prevKeys[k] = this.db.keys[k] ? Object.assign({}, this.db.keys[k]) : undefined;
    }
    for (const k of Object.keys(clean)) {
      const v = this.db.rev + 1;
      this.db.rev = v;
      this.db.keys[k] = { v: v, at: at, val: clean[k] };
      out[k] = v;
    }
    this.db.initialized = true;
    try {
      this.save(Object.keys(clean));
    } catch (e) {
      this.db.rev = prevRev;
      this.db.initialized = prevInit;
      for (const k of Object.keys(prevKeys)) {
        if (prevKeys[k] === undefined) delete this.db.keys[k];
        else this.db.keys[k] = prevKeys[k];
      }
      /* 磁盘可能已经换掉了一部分文件（rename 阶段被中断），尽力用旧值写回去。
         写不回去也不能再抛 —— 内存已经回滚，返回 503 让客户端知道没成功。 */
      try { this.save(Object.keys(prevKeys)); } catch (_) { /* 尽力而为 */ }
      this.log('[store] 落盘失败，已回滚本次写入：' + ((e && e.message) || e));
      return { ok: false, status: 503, error: '库存数据落盘失败（磁盘空间或权限）' };
    }
    return { ok: true, rev: this.db.rev, keys: out, initialized: true };
  }

  /* 整库导出（备份用，包含应用内「导出 JSON」覆盖不到的几个键） */
  exportBundle() {
    const out = {};
    Object.keys(this.db.keys).forEach(k => {
      try { out[k] = JSON.parse(this.db.keys[k].val); } catch (e) { out[k] = this.db.keys[k].val; }
    });
    return {
      app: 'filament-manager', kind: 'server-store', schema: this.db.schema,
      exportedAt: new Date().toISOString(), rev: this.db.rev, keys: out,
    };
  }
}

module.exports = {
  AppStore, SYNC_KEYS, isSyncKey, writeDurable, safeKeyName,
  LIMIT_BODY, LIMIT_KEY, LIMIT_TOTAL, SCHEMA, STORE_SUBDIR, META_NAME, LEGACY_NAME,
};
