/* ══════════════════════════════════════════════════════════════
   printer-cloud.js — 拓竹云 API 客户端（取每次打印的分槽用量）

   为什么必须有这一层（三条硬事实，别再重复调研）：
     1) MQTT pushall 报文里**没有任何克重字段**，只有百分比与层数
     2) 第三方无 RFID 料盘固件恒报 tray_weight="0" / remain=-1 /
        tag_uid 全 0，物理上无法从机器读到余量
     3) 本地 FTPS 的 3mf 只在「局域网发送」的任务里存在；云端下发的
        分板任务（MQTT 报文里带 task_id / profile_id / plate_idx）
        文件在拓竹云上，本地一个字节都没有

   云端数据来源（一个接口就够）：
     GET /v1/user-service/my/tasks?offset=&limit=&startTime=&endTime=
       hits[].id                  任务 ID，可与 MQTT 的 task_id 精确对上
       hits[].weight              整板估算克重（含擦料）
       hits[].amsDetailMapping[]  每槽克重，ams = 全局 tray 索引
       hits[].deviceId            打印机序列号
       hits[].plateIndex          板序号，可与 MQTT 的 plate_idx 互校

   产出结构与 printer-slice.js 的 data **同构**（src 换成 'cloud'），
   前端扣减内核只认一种形状，不用分支。

   只持久化 accessToken，不落密码。密码仅在 login() 调用期间存在于内存。
   ══════════════════════════════════════════════════════════════ */
'use strict';

const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const REGIONS = {
  cn: 'https://api.bambulab.cn',
  global: 'https://api.bambulab.com',
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

/* tray 索引的两枚哨兵值（拓竹约定） */
const TRAY_NONE = 255;      // 该耗材未参与本次打印
const TRAY_EXTERNAL = 254;  // 外挂料盘（不走 AMS）

const TOKEN_FILE = 'bambu-cloud.json';
const HTTP_TIMEOUT = 15000;

/* ── 小工具 ── */

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/* 云端颜色是 RRGGBBAA / #RRGGBBAA；统一成 #RRGGBB。全透明或全 0 返回 null */
function normColor(v) {
  let s = String(v == null ? '' : v).trim().toUpperCase().replace(/^#/, '');
  if (!/^[0-9A-F]{6,8}$/.test(s)) return null;
  if (s.length === 8) {
    if (s.slice(6) === '00') return null;      // alpha=00 → 未设置
    if (s === '00000000') return null;
    s = s.slice(0, 6);
  }
  if (s === '000000') return null;
  return '#' + s;
}

/* ── 极简 https JSON 客户端（不用 fetch：本机 undici 有坑，走核心模块更稳） ── */

function request(method, url, opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (e) {
      return resolve({ ok: false, reason: 'URL', message: '非法 URL：' + url });
    }

    const payload = o.body == null ? null : Buffer.from(JSON.stringify(o.body), 'utf8');
    const headers = Object.assign({
      'User-Agent': UA,
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip, deflate, br',
    }, o.headers || {});
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(payload.length);
    }

    let req;
    try {
      req = https.request({
        method: method,
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        headers: headers,
        timeout: o.timeout || HTTP_TIMEOUT,
      }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          let buf = Buffer.concat(chunks);
          const enc = String(res.headers['content-encoding'] || '').toLowerCase();
          try {
            if (enc === 'gzip') buf = zlib.gunzipSync(buf);
            else if (enc === 'deflate') buf = zlib.inflateSync(buf);
            else if (enc === 'br') buf = zlib.brotliDecompressSync(buf);
          } catch (e) { /* 解压失败就当原文，下面解析会报 PARSE */ }

          const text = buf.toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch (e) { /* 非 JSON（如 502 页面） */ }

          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            json: json,
            text: json ? null : text.slice(0, 400),
          });
        });
      });
    } catch (e) {
      return resolve({ ok: false, reason: 'NET', message: String((e && e.message) || e) });
    }

    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', e => {
      resolve({ ok: false, reason: 'NET', message: String((e && e.message) || e) });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

/* ══════════════ 任务 DTO → 统一 sliced 结构 ══════════════ */

/**
 * 把云端 BambuTaskDTO 压成与 3mf 同构的结构。
 *
 * filaments[].slot 是云端独有的优势：ams 就是全局 tray 索引，
 * 不用像 3mf 那样靠色距去猜槽位。3mf 那条路 slot 恒为 null。
 */
function toSliced(task, hint) {
  if (!task || typeof task !== 'object') return null;
  const h = hint || {};

  const rows = Array.isArray(task.amsDetailMapping) ? task.amsDetailMapping : [];
  const filaments = [];

  for (const a of rows) {
    if (!a || typeof a !== 'object') continue;
    /* Number(null) === 0 —— 不显式排除就会把「ams 缺失」错当槽位 0 */
    const rawAms = a.ams;
    if (rawAms === null || rawAms === undefined || rawAms === '') continue;
    const tray = Number(rawAms);
    if (!Number.isFinite(tray) || tray === TRAY_NONE) continue;
    if (tray === TRAY_EXTERNAL) continue;              // 外挂料盘不归 AMS 槽，交给手动
    const g = round2(a.weight);
    if (!(g > 0)) continue;                            // 该槽本次没出料
    filaments.push({
      id: tray + 1,                                    // 1-based，跟 3mf 的 filament.id 语义对齐
      slot: tray,                                      // 全局 tray 索引，前端可直接落到槽位
      type: String(a.filamentType || '').trim().toUpperCase(),
      colorHex: normColor(a.targetColor) || normColor(a.sourceColor),
      trayInfoIdx: a.filamentId || null,
      usedG: g,
      usedM: 0,
    });
  }

  filaments.sort((x, y) => x.slot - y.slot);

  const sumG = round2(filaments.reduce((s, f) => s + f.usedG, 0));
  const declared = Number(task.weight) > 0 ? round2(task.weight) : null;

  return {
    src: 'cloud',
    taskId: task.id != null ? String(task.id) : null,
    title: task.title || null,
    deviceId: task.deviceId || null,
    deviceModel: task.deviceModel || null,
    plate: Number(task.plateIndex) > 0 ? Number(task.plateIndex) : (h.plateIdx || null),
    plateName: task.plateName || null,
    profileId: task.profileId != null ? String(task.profileId) : null,
    status: task.status != null ? Number(task.status) : null,
    startTime: task.startTime || null,
    endTime: task.endTime || null,
    costSec: Number(task.costTime) > 0 ? Number(task.costTime) : null,
    /* declared 是拓竹给整板估算重（含擦料）；sumG 是各槽之和。
       flushG = 差值，即擦料/清洗损耗，归不到具体槽，单独暴露。 */
    plateWeightG: declared,
    flushG: declared != null && declared > sumG ? round2(declared - sumG) : 0,
    totalG: sumG,
    filaments: filaments,
    matchedBy: h.matchedBy || null,
    fetchedAt: new Date().toISOString(),
  };
}

/* ══════════════ 客户端 ══════════════ */

class BambuCloud {
  /**
   * opts: {
   *   dir:      token 落盘目录（一般是 PRINTER_AGENT_DIR）
   *   region:   'cn' | 'global'
   *   log:      fn(msg)
   * }
   */
  constructor(opts) {
    const o = opts || {};
    /* 默认存到 <项目根>/data，与 agent / store 同一处；容器里传 /data */
    this.dir = o.dir || process.env.PRINTER_AGENT_DIR || path.join(__dirname, '..', 'data');
    this.region = REGIONS[o.region] ? o.region : 'cn';
    this._log = typeof o.log === 'function' ? o.log : () => {};
    this.token = null;         // { accessToken, refreshToken, expiresAt, account, region }
    this.inflight = new Map(); // deviceId -> Promise（单飞）
    this.lastError = null;
    this._load();
  }

  /* ── token 持久化 ── */

  get _file() { return path.join(this.dir, TOKEN_FILE); }

  _load() {
    try {
      const raw = fs.readFileSync(this._file, 'utf8');
      const j = JSON.parse(raw);
      if (j && j.accessToken) {
        this.token = j;
        if (j.region && REGIONS[j.region]) this.region = j.region;
      }
    } catch (e) { /* 没登录过 */ }
  }

  _save() {
    try {
      if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
      const body = JSON.stringify(this.token || {}, null, 2);
      fs.writeFileSync(this._file, body, { encoding: 'utf8', mode: 0o600 });
      try { fs.chmodSync(this._file, 0o600); } catch (e) { /* Windows 上无效，无害 */ }
    } catch (e) {
      this._log('[cloud] token 落盘失败：' + ((e && e.message) || e));
    }
  }

  /* ── 状态 ── */

  get baseUrl() { return REGIONS[this.region] || REGIONS.cn; }

  isLoggedIn() {
    return !!(this.token && this.token.accessToken);
  }

  /* 剩余有效秒数；-1 表示未登录 */
  ttlSec() {
    if (!this.isLoggedIn()) return -1;
    const at = Number(this.token.expiresAt) || 0;
    if (!at) return -1;
    return Math.max(0, Math.floor((at - Date.now()) / 1000));
  }

  status() {
    return {
      loggedIn: this.isLoggedIn(),
      account: this.token && this.token.account ? String(this.token.account) : null,
      region: this.region,
      ttlSec: this.ttlSec(),
      expiresAt: this.token && this.token.expiresAt
        ? new Date(this.token.expiresAt).toISOString() : null,
      lastError: this.lastError,
    };
  }

  logout() {
    this.token = null;
    this.lastError = null;
    try { fs.unlinkSync(this._file); } catch (e) { /* 本来就没有 */ }
  }

  /* ── 登录 ── */

  _absorb(res, account) {
    if (!res.ok) {
      const msg = (res.json && (res.json.message || res.json.error || res.json.msg))
        || res.text || ('HTTP ' + res.status);
      this.lastError = String(msg).slice(0, 200);
      return {
        ok: false,
        reason: res.status === 401 || res.status === 403 ? 'AUTH' : 'NET',
        status: res.status,
        message: this.lastError,
      };
    }
    const j = res.json || {};
    /* 密码模式遇到 2FA / 异地登录保护时，不返回 token 只返回 loginType */
    if (j.loginType === 'verifyCode' || j.loginType === 'tfa') {
      return {
        ok: false,
        needCode: true,
        loginType: j.loginType,
        tfaKey: j.tfaKey || null,
        message: '该账号需要验证码（二次验证），请改用验证码登录',
      };
    }
    const token = j.accessToken || j.token;
    if (!token) {
      this.lastError = '响应里没有 accessToken';
      return { ok: false, reason: 'AUTH', message: this.lastError, raw: j };
    }
    const ttl = Number(j.expiresIn) > 0 ? Number(j.expiresIn) : 30 * 24 * 3600;
    this.token = {
      accessToken: String(token),
      refreshToken: j.refreshToken ? String(j.refreshToken) : null,
      expiresAt: Date.now() + ttl * 1000,
      account: account || (j.username || null),
      region: this.region,
      savedAt: new Date().toISOString(),
    };
    this.lastError = null;
    this._save();
    this._log('[cloud] 登录成功，token 有效 ' + Math.round(ttl / 86400) + ' 天');
    return { ok: true, status: this.status() };
  }

  /** 账号密码登录。密码只在本次调用内使用，不落盘。 */
  async login(account, password) {
    if (!account || !password) {
      return { ok: false, reason: 'PARAM', message: '账号和密码都不能为空' };
    }
    const res = await request('POST', this.baseUrl + '/v1/user-service/user/login', {
      body: { account: String(account), password: String(password) },
    });
    return this._absorb(res, account);
  }

  /** 验证码登录（code 由 sendEmailCode / sendSmsCode 触发后用户输入） */
  async loginWithCode(account, code) {
    if (!account || !code) {
      return { ok: false, reason: 'PARAM', message: '账号和验证码都不能为空' };
    }
    const res = await request('POST', this.baseUrl + '/v1/user-service/user/login', {
      body: { account: String(account), code: String(code) },
    });
    return this._absorb(res, account);
  }

  async sendEmailCode(email) {
    const res = await request('POST', this.baseUrl + '/v1/user-service/user/sendemail/code', {
      body: { email: String(email), type: 'codeLogin' },
    });
    return res.ok
      ? { ok: true }
      : { ok: false, status: res.status, message: (res.json && (res.json.message || res.json.error)) || res.text || 'HTTP ' + res.status };
  }

  async sendSmsCode(phone) {
    const res = await request('POST', this.baseUrl + '/v1/user-service/user/sendsmscode', {
      body: { phone: String(phone), type: 'codeLogin' },
    });
    return res.ok
      ? { ok: true }
      : { ok: false, status: res.status, message: (res.json && (res.json.message || res.json.error)) || res.text || 'HTTP ' + res.status };
  }

  /* ── 任务查询 ── */

  async getTaskList(o) {
    const q = o || {};
    if (!this.isLoggedIn()) {
      return { ok: false, reason: 'NOAUTH', message: '未登录拓竹云' };
    }
    const url = this.baseUrl + '/v1/user-service/my/tasks'
      + '?offset=' + (Number(q.offset) || 0)
      + '&limit=' + (Number(q.limit) || 100)
      + '&startTime=' + (Number(q.startTime) || 0)
      + '&endTime=' + (Number(q.endTime) || 0);
    const res = await request('GET', url, {
      headers: { Authorization: 'Bearer ' + this.token.accessToken },
    });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        this.lastError = 'token 已失效，请重新登录';
        return { ok: false, reason: 'AUTH', message: this.lastError };
      }
      return {
        ok: false, reason: 'NET', status: res.status,
        message: (res.json && (res.json.message || res.json.error)) || res.text || ('HTTP ' + res.status),
      };
    }
    const j = res.json || {};
    const hits = Array.isArray(j.hits) ? j.hits : (Array.isArray(j.list) ? j.list : []);
    return { ok: true, hits: hits, total: Number(j.total) || hits.length };
  }

  /**
   * 找出某台打印机最近的那条任务。
   *
   * 匹配优先级（越靠前越可信）：
   *   1) taskId 与 MQTT 的 task_id 精确相等 —— 最硬
   *   2) deviceId 相等 + plateIndex 也相等
   *   3) deviceId 相等 + startTime 落在本次任务窗口内
   *   4) deviceId 相等的最近一条
   */
  async findTask(deviceId, hint) {
    const h = hint || {};
    const list = await this.getTaskList({ limit: 100 });
    if (!list.ok) return list;

    let hits = list.hits;
    if (!hits.length) {
      return { ok: false, reason: 'EMPTY', message: '云账号下没有任何打印记录' };
    }

    /* 1) taskId 精确匹配（最高优先，且不受 deviceId 过滤影响） */
    if (h.taskId != null && String(h.taskId) !== '' && String(h.taskId) !== '0') {
      const want = String(h.taskId);
      const hit = hits.find(t => t && String(t.id) === want);
      if (hit) return { ok: true, task: hit, matchedBy: 'taskId' };
    }

    /* 之后的策略都要求 deviceId */
    if (deviceId) {
      const mine = hits.filter(t => t && String(t.deviceId) === String(deviceId));
      if (mine.length) {
        const byTime = t => {
          const s = t.startTime ? Date.parse(String(t.startTime).replace(' ', 'T')) : 0;
          return Number.isFinite(s) ? s : 0;
        };

        /* 2) deviceId + plateIndex */
        if (Number(h.plateIdx) > 0) {
          const hit = mine.filter(t => Number(t.plateIndex) === Number(h.plateIdx))
            .sort((a, b) => byTime(b) - byTime(a))[0];
          if (hit) return { ok: true, task: hit, matchedBy: 'device+plate' };
        }

        /* 3) deviceId + 时间窗口（任务起点前后 12 小时） */
        const start = h.startAt ? Date.parse(String(h.startAt)) : 0;
        if (Number.isFinite(start) && start > 0) {
          const hit = mine.filter(t => {
            const s = byTime(t);
            return s > 0 && Math.abs(s - start) < 12 * 3600 * 1000;
          }).sort((a, b) => Math.abs(byTime(a) - start) - Math.abs(byTime(b) - start))[0];
          if (hit) return { ok: true, task: hit, matchedBy: 'device+time' };
        }

        /* 4) deviceId 最近一条 */
        const hit = mine.slice().sort((a, b) => byTime(b) - byTime(a))[0];
        if (hit) return { ok: true, task: hit, matchedBy: 'device+latest' };
      }
    }

    return { ok: false, reason: 'NOFILE', message: '云上没有匹配到这次打印的任务' };
  }

  /**
   * 主入口：给定打印机序列号与任务线索，返回与 3mf 同构的 sliced。
   * hint: { taskId, plateIdx, startAt }
   */
  async fetchSliced(deviceId, hint) {
    if (!this.isLoggedIn()) {
      return { ok: false, reason: 'NOAUTH', message: '未登录拓竹云' };
    }
    const found = await this.findTask(deviceId, hint);
    if (!found.ok) return found;

    const data = toSliced(found.task, {
      matchedBy: found.matchedBy,
      plateIdx: (hint && hint.plateIdx) || null,
    });
    if (!data || !data.filaments.length) {
      return {
        ok: false, reason: 'EMPTY',
        message: '云任务里没有分槽用量（可能是单色外挂料盘或数据未生成）',
      };
    }
    return { ok: true, data: data };
  }
}

module.exports = {
  BambuCloud,
  toSliced,
  normColor,
  REGIONS,
  TRAY_NONE,
  TRAY_EXTERNAL,
};
