/* ══════════════════════════════════════════════════════════════
   printer-slice.js — 从打印机 FTPS 取 3mf，解析切片用量

   为什么要它：第三方料盘没有 RFID 芯片，AMS 物理上测不出余量，
   MQTT 报文里也没有任何克重字段。唯一与 RFID 无关的用量来源，
   是切片文件里记录的 used_g。

   设计要点：
   - 全程「失败只降级」：任何异常都返回 {ok:false,reason}，绝不抛给主链路
   - 单飞：同一 pid 同时只有一个抓取在飞，避免 FTPS 连接数竞争
   - 路径自动探测：不同固件把 3mf 放在 /cache、/data、/sdcard、/ 都有可能，
     逐个候选目录找，不写死
   - TLS 强制 1.2：拓竹 vsftpd 只支持 1.2，且要求数据连接复用控制连接 session
     （basic-ftp 会做，见 tlsSessionStore）

   依赖：basic-ftp、fflate
   ══════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const ftp = require('basic-ftp');
const { unzipSync, strFromU8 } = require('fflate');
const M = require('./printer-3mf');

const FTP_PORT = 990;
const FTP_USER = 'bblp';
const TIMEOUT_MS = 12000;          // 单次连接/传输超时
const MAX_BYTES = 200 * 1024 * 1024;  // 单个 3mf 上限，超过放弃（防内存打爆）

/* 候选目录：按命中概率排序。Bambu 各型号/固件差异很大，靠遍历兜底 */
const DIR_CANDIDATES = ['/cache', '/data', '/', '/sdcard', '/model', '/usb'];

/* ══════════════ 纯工具 ══════════════ */

function is3mf(name) { return /\.3mf$/i.test(String(name || '')); }

/* 从文件名里剥掉 .gcode.3mf / .3mf 得到基名 */
function baseName(name) {
  return String(name || '').replace(/\.gcode\.3mf$/i, '').replace(/\.3mf$/i, '');
}

/* 在候选文件里挑最可能是本次任务的那个 */
function pickRemoteFile(files, hint) {
  const list = (files || []).filter(f => is3mf(f.name));
  if (!list.length) return null;
  const h = hint || {};
  const want = String(h.taskName || '').trim();
  const wantBase = baseName(want).toLowerCase();

  /* 1) 文件名与任务名完全一致 */
  if (wantBase) {
    const exact = list.find(f => baseName(f.name).toLowerCase() === wantBase);
    if (exact) return Object.assign({}, exact, { matchedBy: 'name' });
  }

  /* 2) 文件名包含任务名（任务名常带中文与后缀，反向包含更宽松） */
  if (wantBase) {
    const loose = list.find(f => {
      const b = baseName(f.name).toLowerCase();
      return b && (b.indexOf(wantBase) >= 0 || wantBase.indexOf(b) >= 0);
    });
    if (loose) return Object.assign({}, loose, { matchedBy: 'name-loose' });
  }

  /* 3) 修改时间落在任务时间窗内的最新一个（拿不到 startAt 时放宽到 24h） */
  const t0 = h.startAt ? Date.parse(h.startAt) : (Date.now() - 24 * 3600 * 1000);
  const t1 = Date.now() + 5 * 60000;
  const inWindow = list.filter(f => {
    const t = f.mtime ? Date.parse(f.mtime) : 0;
    return t && t >= t0 - 15 * 60000 && t <= t1;
  });
  if (inWindow.length) {
    inWindow.sort((a, b) => Date.parse(b.mtime) - Date.parse(a.mtime));
    return Object.assign({}, inWindow[0], { matchedBy: 'mtime' });
  }

  /* 4) 兜底：最新的一个 */
  list.sort((a, b) => (Date.parse(b.mtime) || 0) - (Date.parse(a.mtime) || 0));
  return Object.assign({}, list[0], { matchedBy: 'latest' });
}

/* ══════════════ FTPS ══════════════ */

async function withClient(printer, fn) {
  const c = new ftp.Client(TIMEOUT_MS);
  try {
    await c.access({
      host: printer.host,
      port: FTP_PORT,
      user: FTP_USER,
      password: printer.accessCode,
      secure: 'implicit',
      secureOptions: {
        rejectUnauthorized: false,
        /* 拓竹 vsftpd 只支持 TLS1.2；不锁版本时 Node 可能尝试 1.3 被拒，
           且 1.3 的 ticket 复用机制在部分 Node 版本上不生效，会导致数据连接 522 */
        minVersion: 'TLSv1.2',
        maxVersion: 'TLSv1.2',
      },
    });
    return await fn(c);
  } finally {
    try { c.close(); } catch (e) { /* 忽略 */ }
  }
}

/* 扫一遍候选目录，把所有 .3mf 收集起来 */
async function scan3mf(client) {
  const out = [];
  const seenDir = new Set();
  for (const dir of DIR_CANDIDATES) {
    if (seenDir.has(dir)) continue;
    seenDir.add(dir);
    let list;
    try {
      list = await client.list(dir);
    } catch (e) {
      continue;                       // 目录不存在/无权限：静默跳过
    }
    (list || []).forEach(x => {
      const isDir = x.type === 2 || (x.isDirectory && x.isDirectory());
      if (isDir) return;
      if (!is3mf(x.name)) return;
      out.push({
        dir: dir === '/' ? '' : dir,
        name: x.name,
        size: x.size,
        mtime: x.modifiedAt || null,
      });
    });
  }
  /* 去重（同一文件可能在多个候选里被列到） */
  const uniq = new Map();
  out.forEach(f => uniq.set(f.dir + '/' + f.name, f));
  return [...uniq.values()];
}

/* ══════════════ 主流程 ══════════════ */

/* 抓一次。返回 {ok, reason, data}
   reason: NO_POOL | AUTH | NET | NO_FILE | NO_ENTRY | PARSE | TOO_BIG | DISABLED */
async function fetchOnce(printer, hint) {
  const started = Date.now();
  try {
    return await withClient(printer, async client => {
      const files = await scan3mf(client);
      if (!files.length) {
        return { ok: false, reason: 'NO_FILE', scanned: DIR_CANDIDATES.length };
      }
      const target = pickRemoteFile(files, hint);
      if (!target) return { ok: false, reason: 'NO_FILE' };
      if (target.size > MAX_BYTES) return { ok: false, reason: 'TOO_BIG', size: target.size };

      const remote = target.dir + '/' + target.name;
      const local = path.join(os.tmpdir(), 'bbl-slice-' + process.pid + '-' + Date.now() + '.3mf');
      try {
        await client.downloadTo(local, remote);
      } catch (e) {
        return { ok: false, reason: 'NET', detail: e && e.message };
      }

      let buf;
      try { buf = fs.readFileSync(local); }
      catch (e) { return { ok: false, reason: 'NET', detail: e && e.message }; }
      finally { try { fs.unlinkSync(local); } catch (e) { /* 清理失败不影响 */ } }

      let entries;
      try {
        entries = unzipSync(new Uint8Array(buf), {
          filter: f => /(^|\/)slice_info\.config$/i.test(f.name),
        });
      } catch (e) {
        return { ok: false, reason: 'PARSE', detail: 'unzip: ' + (e && e.message) };
      }
      const key = Object.keys(entries)[0];
      if (!key) return { ok: false, reason: 'NO_ENTRY' };

      const xml = strFromU8(entries[key]);
      const parsed = M.parseSliceInfoConfig(xml);
      if (!parsed.plates.length) return { ok: false, reason: 'PARSE', detail: 'no plate' };

      const picked = M.pickPlate(parsed.plates, {
        plateIdx: hint && hint.plateIdx,
        gcodeFile: hint && hint.gcodeFile,
      });
      const plate = picked.plate;
      if (!plate) return { ok: false, reason: 'PARSE', detail: 'pickPlate null' };

      /* sum(used_g) 与 plate 声明重量不符时按比例校正（防御性，官方通常严格相等） */
      const v = M.verifyPlate(plate);
      let filaments = plate.filaments.slice();
      let scaled = false;
      if (v.declared && !v.ok && v.sum > 0) {
        const k = v.declared / v.sum;
        filaments = filaments.map(f => Object.assign({}, f, {
          usedG: Math.round(f.usedG * k * 100) / 100,
          usedM: Math.round(f.usedM * k * 100) / 100,
        }));
        scaled = true;
      }

      return {
        ok: true,
        data: {
          src: '3mf',
          file: remote,
          fileSize: target.size,
          fileMtime: target.mtime ? new Date(target.mtime).toISOString() : null,
          matchedBy: target.matchedBy,
          plate: plate.index,
          plates: parsed.plates.map(p => p.index),
          plateAmbiguous: !!picked.ambiguous,
          pickReason: picked.reason,
          plateWeightG: v.declared,
          scaled: scaled,
          filaments: filaments,
          totalG: M.sumGrams(filaments),
          fetchedAt: new Date().toISOString(),
          durMs: Date.now() - started,
        },
      };
    });
  } catch (e) {
    const msg = String((e && e.message) || e);
    /* 认证失败与网络失败给不同 reason，前端诊断能区分 */
    const reason = /530|login|authentication/i.test(msg) ? 'AUTH'
      : /ECONN|ETIMEDOUT|EHOSTUNREACH|ENOTFOUND|timeout/i.test(msg) ? 'NET'
        : 'NET';
    return { ok: false, reason: reason, detail: msg };
  }
}

/* 诊断：列出所有候选目录里的 .3mf（打印机页「抓取诊断」按钮用） */
async function probe(printer) {
  const started = Date.now();
  try {
    return await withClient(printer, async client => {
      const dirs = [];
      for (const dir of DIR_CANDIDATES) {
        let list = null, err = null;
        try { list = await client.list(dir); } catch (e) { err = (e && e.message) || 'list failed'; }
        const files = (list || [])
          .filter(x => !(x.type === 2 || (x.isDirectory && x.isDirectory())))
          .map(x => ({
            name: x.name,
            size: x.size,
            mtime: x.modifiedAt ? new Date(x.modifiedAt).toISOString() : null,
          }));
        dirs.push({ dir: dir, ok: !!list, error: err, files: files.slice(0, 50), count: files.length });
      }
      const total = dirs.reduce((s, d) => s + d.files.filter(f => is3mf(f.name)).length, 0);
      return {
        ok: true,
        reachable: true,
        m3mfCount: total,
        dirs: dirs,
        durMs: Date.now() - started,
      };
    });
  } catch (e) {
    return { ok: false, reachable: false, detail: String((e && e.message) || e) };
  }
}

/* ══════════════ 调度器：单飞 + 预算 + 写回 ══════════════ */

class SliceFetcher {
  /* opts: { getPrinter(pid), store:{setSliced,patchTask}, log(fn,msg), cloud:BambuCloud } */
  constructor(opts) {
    this.opts = opts || {};
    this.cloud = this.opts.cloud || null;   // 可选：本地 3mf 拿不到时的兜底数据源
    this.inflight = new Map();       // pid -> Promise
    this.pending = new Map();        // pid -> {state, tried}
    this.lastFail = new Map();       // pid -> {at, reason}（日志节流用）
  }

  _log(msg) {
    const f = this.opts.log;
    if (typeof f === 'function') f(msg);
  }

  _printerOf(pid) {
    const f = this.opts.getPrinter;
    return typeof f === 'function' ? f(pid) : null;
  }

  _store() { return this.opts.store || {}; }

  /* 从 state 里抽出本次任务的线索 */
  _hint(state, extra) {
    const p = (state && state.print) || {};
    return Object.assign({
      taskName: p.taskName || '',
      gcodeFile: p.gcodeFile || null,
      plateIdx: p.plateIdx || null,
      startAt: p.startAt || null,
      taskId: p.taskId || null,          // 云端任务匹配的最硬线索
    }, extra || {});
  }

  /* ── 双数据源解析 ──
     云优先条件：已登录 且 MQTT 给了 taskId（说明是云端下发的任务，
     本地 FTPS 上注定没有 3mf，白连一次要 1 秒，不如直接问云）。
     其余情况本地优先，本地失败再退回云。 */
  async _resolve(printer, state, hint) {
    const cloudReady = !!(this.cloud && this.cloud.isLoggedIn() && printer && printer.serial);
    const localReady = !!(printer && printer.host && printer.accessCode);

    if (!cloudReady && !localReady) return { ok: false, reason: 'DISABLED' };

    const local = () => fetchOnce(printer, hint)
      .catch(e => ({ ok: false, reason: 'NET', detail: String((e && e.message) || e) }));

    if (cloudReady && hint && hint.taskId) {
      const c = await this._cloudFetch(printer, hint);
      if (c.ok) return c;
      if (localReady) {
        const l = await local();
        return (l && l.ok) ? l : c;      // 云也没数据时，报云的原因更准确
      }
      return c;
    }

    let l = null;
    if (localReady) {
      l = await local();
      if (l && l.ok) return l;
    }
    if (cloudReady) {
      const c = await this._cloudFetch(printer, hint);
      if (c.ok) return c;
      return l || c;                     // 两边都空时优先报本地的（更常见）
    }
    return l || { ok: false, reason: 'DISABLED' };
  }

  async _cloudFetch(printer, hint) {
    if (!this.cloud || !this.cloud.isLoggedIn()) return { ok: false, reason: 'NOAUTH' };
    const serial = printer && printer.serial;
    if (!serial) return { ok: false, reason: 'NOSERIAL', detail: '打印机配置缺少序列号' };
    try {
      const r = await this.cloud.fetchSliced(serial, hint);
      if (r.ok) return { ok: true, data: r.data };
      return {
        ok: false,
        reason: 'CLOUD_' + String((r && r.reason) || 'FAIL'),
        detail: (r && r.message) || null,
      };
    } catch (e) {
      return { ok: false, reason: 'CLOUD_NET', detail: String((e && e.message) || e) };
    }
  }

  /* 任务开始：抓一次（此时文件一定已在盘上），fire-and-forget */
  start(pid, state) {
    return this._kick(pid, state, 'start');
  }

  /* 任务进行中：只需累积线索，不发起网络请求（每条 MQTT 报文都会调，必须极轻） */
  note(pid, state) {
    const p = (state && state.print) || {};
    const cur = this.pending.get(pid) || { state: null, tried: 0 };
    cur.state = p;
    this.pending.set(pid, cur);
  }

  /* 任务结束：若 start 那次已成功（closeTask 已把它并进 rec）则直接复用；
     否则补抓一次并 patch 到任务记录上 */
  afterClose(pid, rec, state) {
    if (!rec) return Promise.resolve(null);
    const store = this._store();
    if (rec.sliced && Array.isArray(rec.sliced.filaments)) {
      return Promise.resolve({ ok: true, data: rec.sliced });
    }
    const done = hit => {
      if (hit && hit.ok && typeof store.patchTask === 'function') {
        store.patchTask(rec.id, { sliced: hit.data, slicedState: 'ok' });
      }
      return hit;
    };
    const inFlight = this.inflight.get(pid);
    if (inFlight) return inFlight.then(done);
    return this._kick(pid, state, 'close').then(done);
  }

  _kick(pid, state, why) {
    const prev = this.inflight.get(pid);
    if (prev) return prev;                      // 单飞

    const printer = this._printerOf(pid);
    const canLocal = !!(printer && printer.host && printer.accessCode);
    const canCloud = !!(this.cloud && this.cloud.isLoggedIn() && printer && printer.serial);
    if (!canLocal && !canCloud) {
      return Promise.resolve({ ok: false, reason: 'DISABLED' });
    }
    const hint = this._hint(state);
    const p = this._resolve(printer, state, hint)
      .catch(e => ({ ok: false, reason: 'NET', detail: String((e && e.message) || e) }))
      .then(hit => {
        this.inflight.delete(pid);
        if (hit && hit.ok) {
          const store = this._store();
          if (typeof store.setSliced === 'function') store.setSliced(pid, hit.data);
          this.pending.delete(pid);
        } else {
          this._noteFail(pid, hit);
        }
        return hit;
      });
    this.inflight.set(pid, p);
    return p;                                   // 调用方不 await
  }

  /* 失败日志节流：每 pid 每 10 分钟最多一条，避免打印机离线时刷屏 */
  _noteFail(pid, hit) {
    const last = this.lastFail.get(pid) || { at: 0, reason: null };
    const now = Date.now();
    if (last.reason !== (hit && hit.reason) || now - last.at > 600000) {
      this.lastFail.set(pid, { at: now, reason: hit && hit.reason });
      this._log('[slice] ' + pid + ' 抓取失败：' + (hit && hit.reason) +
        (hit && hit.detail ? ' (' + hit.detail + ')' : ''));
    }
    const store = this._store();
    if (typeof store.setSlicedState === 'function') {
      store.setSlicedState(pid, (hit && hit.reason) || 'NET');
    }
  }

  /* 手动重抓（打印机页诊断按钮） */
  refetch(pid, state) {
    this.inflight.delete(pid);
    return this._kick(pid, state || (this.pending.get(pid) || {}).state || {}, 'manual');
  }

  /* 强制只走云端（诊断按钮用：本地 3mf 注定拿不到时不用等它超时） */
  async cloudOnly(pid, state) {
    const printer = this._printerOf(pid);
    const hit = await this._cloudFetch(printer, this._hint(state || {}));
    if (hit && hit.ok) {
      const store = this._store();
      if (typeof store.setSliced === 'function') store.setSliced(pid, hit.data);
      this.pending.delete(pid);
    }
    return hit;
  }
}

/* afterClose 用不到全局快照表了——回收 open[pid].sliced 由 closeTask 负责 */

module.exports = {
  SliceFetcher,
  fetchOnce,
  probe,
  scan3mf,
  pickRemoteFile,
  DIR_CANDIDATES,
  is3mf,
};
