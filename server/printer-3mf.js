/* ══════════════════════════════════════════════════════════════
   printer-3mf.js — 3mf 内 Metadata/slice_info.config 的纯函数解析层

   零 I/O、零依赖：输入 XML 字符串，输出结构化的每耗材用量。
   与传输层（printer-slice.js 负责 FTPS 下载与解压）解耦，便于单测。

   官方结构（Bambu Lab 文档）：
     <config>
       <plate>
         <metadata key="index"  value="1"/>
         <metadata key="weight" value="126.48"/>
         <filament id="1" tray_info_idx="GFA00" type="PLA"
                   color="#FFFFFFFF" used_m="41.2" used_g="124.29"/>
       </plate>
     </config>

   约定：
   - filament.id 从 1 开始，255 = 该耗材未被使用（过滤掉）
   - used_g 单位克，used_m 单位米
   - 同一 plate 内 sum(used_g) 应等于该 plate 的 weight（官方实测严格相等）
   ══════════════════════════════════════════════════════════════ */
'use strict';

/* ── primitive helpers ── */

function toNum(v) {
  const n = Number(String(v == null ? '' : v).trim());
  return Number.isFinite(n) ? n : 0;
}

/* 从一段属性串里取某个属性的值，兼容单/双引号与 &quot; */
function attrOf(attrs, name) {
  if (!attrs) return null;
  const re = new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i');
  const m = String(attrs).match(re);
  if (!m) return null;
  const raw = m[1] != null ? m[1] : (m[2] != null ? m[2] : m[3]);
  return String(raw).replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}

/* 3mf 里的颜色是 #RRGGBB 或 #RRGGBBAA / RRGGBBAA；统一成 #RRGGBB，异常返回 null */
function colorHex(v) {
  const s = String(v == null ? '' : v).trim().toUpperCase().replace(/^#/, '');
  if (/^[0-9A-F]{8}$/.test(s)) return '#' + s.slice(0, 6);
  if (/^[0-9A-F]{6}$/.test(s)) return '#' + s;
  return null;
}

/* ── plate 级解析 ── */

/* 从 <plate> 体内取某个 <metadata key="x" value="y"/> 的 value */
function metaOf(body, key) {
  const re = new RegExp(
    '<metadata\\b[^>]*\\bkey\\s*=\\s*["\']' + key + '["\'][^>]*>', 'i');
  const m = body.match(re);
  if (m) return attrOf(m[0].replace(/^<metadata\b/i, ''), 'value');
  /* 属性顺序反过来的写法也兜一下 */
  const re2 = new RegExp(
    '<metadata\\b[^>]*\\bvalue\\s*=\\s*["\']([^"\']*)["\'][^>]*\\bkey\\s*=\\s*["\']' + key + '["\']', 'i');
  const m2 = body.match(re2);
  return m2 ? m2[1] : null;
}

/* 解析出一个 plate 里的 filament 列表（已过滤 255 与非法 id） */
function parseFilaments(body) {
  const out = [];
  const seen = new Map();
  const re = /<filament\b([^>]*?)\/?>/gi;
  let m;
  while ((m = re.exec(body))) {
    const a = m[1];
    const id = toNum(attrOf(a, 'id'));
    if (!(id > 0) || id === 255) continue;          // 255 = 未使用
    const f = {
      id: id,
      type: String(attrOf(a, 'type') || '').trim().toUpperCase(),
      colorHex: colorHex(attrOf(a, 'color')),
      trayInfoIdx: attrOf(a, 'tray_info_idx') || null,
      usedG: toNum(attrOf(a, 'used_g')),
      usedM: toNum(attrOf(a, 'used_m')),
    };
    if (seen.has(id)) {                             // 同 id 重复出现 → 累加，不覆盖
      const prev = seen.get(id);
      prev.usedG += f.usedG;
      prev.usedM += f.usedM;
    } else {
      seen.set(id, f);
      out.push(f);
    }
  }
  return out;
}

/* 输入 slice_info.config 的 XML 文本，输出 {plates:[...]} */
function parseSliceInfoConfig(xml) {
  const src = String(xml == null ? '' : xml);
  const plates = [];
  const chunks = src.split(/<plate\b/i).slice(1);
  chunks.forEach((chunk, i) => {
    const body = chunk.split(/<\/plate>/i)[0];
    const openTag = body.slice(0, Math.max(0, body.indexOf('>')));
    /* index 可能是 <plate index="N"> 也可能是 <metadata key="index" value="N"/> */
    let index = toNum(attrOf(openTag, 'index')) || toNum(metaOf(body, 'index')) || (i + 1);
    const weightG = toNum(metaOf(body, 'weight'));
    const filaments = parseFilaments(body);
    plates.push({
      index: index,
      weightG: weightG,
      filaments: filaments,
      sumG: sumGrams(filaments),
    });
  });
  return { plates: plates };
}

function sumGrams(filaments) {
  return Math.round((filaments || []).reduce((s, f) => s + (Number(f.usedG) || 0), 0) * 100) / 100;
}

/* 校验 sum(used_g) 与 plate 声明重量是否一致（官方实测严格相等，偏差大概率是我解析错了） */
function verifyPlate(plate) {
  const declared = plate && Number(plate.weightG) > 0 ? Number(plate.weightG) : null;
  const sum = plate ? sumGrams(plate.filaments) : 0;
  if (declared == null) return { declared: null, sum: sum, diff: null, ok: true };
  const diff = Math.abs(sum - declared);
  return { declared: declared, sum: sum, diff: Math.round(diff * 1000) / 1000, ok: diff <= 0.05 };
}

/* ── 选板 ──
   hint: { plateIdx, gcodeFile, weightG }
   返回 { plate, ambiguous, reason }
   只有唯一确定时才 ambiguous=false；否则交给上层走「待确认」，不自动扣。 */
function pickPlate(plates, hint) {
  const list = (plates || []).filter(p => p && p.filaments && p.filaments.length);
  if (!list.length) return { plate: null, ambiguous: false, reason: 'empty' };
  if (list.length === 1) return { plate: list[0], ambiguous: false, reason: 'single' };

  const h = hint || {};

  /* 1) 显式 plate 序号（MQTT 的 plate_idx / plate_id） */
  if (Number(h.plateIdx) > 0) {
    const hit = list.find(p => p.index === Number(h.plateIdx));
    if (hit) return { plate: hit, ambiguous: false, reason: 'plateIdx' };
  }

  /* 2) gcode_file 里的 plate_N（如 /data/Metadata/plate_6.gcode） */
  const gm = String(h.gcodeFile || '').match(/plate[_-]?(\d+)/i);
  if (gm) {
    const n = Number(gm[1]);
    const hit = list.find(p => p.index === n);
    if (hit) return { plate: hit, ambiguous: false, reason: 'gcodeFile' };
  }

  /* 3) 只有一个板有实际用量 → 其余都是空板 */
  const withUse = list.filter(p => sumGrams(p.filaments) > 0.05);
  if (withUse.length === 1) return { plate: withUse[0], ambiguous: false, reason: 'onlyOneUsed' };

  /* 4) 多板都有用量且无法判定 → 不猜 */
  return {
    plate: withUse[0] || list[0],
    ambiguous: true,
    reason: 'multiPlate',
    candidates: list.map(p => ({ index: p.index, sumG: sumGrams(p.filaments) })),
  };
}

/* 供打印机页「抓取诊断」用：把解析结果压成一行摘要 */
function summarize(plate) {
  if (!plate) return '';
  const parts = (plate.filaments || []).map(f =>
    (f.type || '?') + ' ' + f.usedG.toFixed(1) + 'g' + (f.colorHex ? ' ' + f.colorHex : ''));
  return 'plate#' + plate.index + ' · ' + parts.join(' / ');
}

module.exports = {
  parseSliceInfoConfig,
  parseFilaments,
  sumGrams,
  verifyPlate,
  pickPlate,
  summarize,
  colorHex,
  attrOf,
};
