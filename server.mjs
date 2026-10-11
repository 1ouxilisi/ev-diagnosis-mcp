#!/usr/bin/env node
/**
 * ev-diagnosis MCP server  v1.1.0
 * 新能源汽车维修诊断数据服务（中文）。纯本地数据，不联网、不调模型。
 *
 * 工具（7）：
 *   lookup_fault_code  故障码查询（146 条中文维修库）
 *   lookup_dtc         标准故障码查询（896 条三电/高压，ModelScope 开源数据集）
 *   search_experience  老师傅实战经验检索（190 条）
 *   list_model_issues  车型通病（44 条）
 *   symptom_to_codes   现象反查故障码（40 条）
 *   diagnose_full      一次出结构化诊断结论（原因概率排序 / 检查顺序 / 报价 / 车主白话）
 *   kb_stats           数据规模与来源溯源
 *
 * 协议：MCP over stdio，JSON-RPC 2.0，一行一条 JSON。零第三方依赖。
 * 运行：node server.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = path.join(HERE, 'assets');
const VERSION = '1.1.0';

const load = (f, fb) => {
  try { return JSON.parse(fs.readFileSync(path.join(A, f), 'utf8')); }
  catch (e) { return fb; }
};

const FAULTS = load('faults.json', []);
const EXP = load('experience.json', []);
const MI = load('model_issues.json', []);
const SYMS = load('symptoms.json', []);
const MODELS = load('models.json', []);
const PARTS = load('parts.json', []);
const DTCBOX = load('dtc.json', { items: [] });
const DTC = DTCBOX.items || [];
const PROV = load('provenance.json', { datasets: [] });

/* ---------------- 英文故障码定义 → 中文术语对照 ----------------
 * 规则映射，非人工逐条翻译。用于 lookup_dtc 的辅助理解，可能有偏差。 */
const TERMS = [
  ['Hybrid Battery Pack', '动力电池包'], ['Hybrid battery pack', '动力电池包'],
  ['Battery Energy Control Module', '电池能量控制模块'],
  ['Battery Management System', '电池管理系统'],
  ['Drive Motor', '驱动电机'], ['Motor Electronics', '电机电子'],
  ['Inverter', '逆变器'], ['Converter', '转换器'], ['Contactor', '接触器'],
  ['Coolant Temperature Sensor', '冷却液温度传感器'],
  ['Temperature Sensor', '温度传感器'], ['Temperature', '温度'],
  ['Insulation', '绝缘'], ['Interlock', '互锁'], ['Coolant', '冷却液'],
  ['Cooling', '冷却'], ['Thermistor', '热敏电阻'], ['Sensor', '传感器'],
  ['Actuator', '执行器'], ['Relay', '继电器'], ['Fuse', '保险丝'],
  ['Harness', '线束'], ['Connector', '连接器'], ['Circuit', '电路'],
  ['Voltage', '电压'], ['Current', '电流'], ['Resistance', '电阻'],
  ['Range/Performance', '范围/性能'], ['Range', '范围'], ['Performance', '性能'],
  ['Stuck', '卡滞'], ['Open', '断路'], ['Short', '短路'], ['Low', '过低'],
  ['High', '过高'], ['Input', '输入'], ['Output', '输出'], ['Signal', '信号'],
  ['Communication', '通信'], ['Control Module', '控制模块'], ['Module', '模组'],
  ['Battery', '电池'], ['Cell', '电芯'], ['Pack', '电池包'], ['Charger', '充电机'],
  ['Charging', '充电'], ['Charge', '充电'], ['Discharge', '放电'],
  ['Thermal', '热管理'], ['Fan', '风扇'], ['Pump', '水泵'], ['Valve', '阀'],
  ['Motor', '电机'], ['Generator', '发电机'], ['Engine', '发动机'],
  ['Transmission', '变速器'], ['Position', '位置'], ['Switch', '开关'],
  ['Lost Communication', '通信丢失'], ['Bus', '总线'], ['Data', '数据'],
  ['Failure', '故障'], ['Fault', '故障'], ['Malfunction', '失效'],
  ['Over Temperature', '过温'], ['Over Current', '过流'],
  ['Over Voltage', '过压'], ['Under Voltage', '欠压'],
  ['Unknown', '未知'], ['System', '系统'], ['A', 'A'], ['B', 'B']
];

function zhGloss(en) {
  if (!en) return '';
  let s = ` ${en} `;
  for (const [k, v] of TERMS) {
    s = s.replace(new RegExp(`\\b${k.replace(/[/]/g, '\\/')}\\b`, 'gi'), ` ${v} `);
  }
  return s.replace(/\s+/g, ' ').replace(/(\S)\s+(\S)/g, (m, a, b) => {
    // 中文之间不留空格
    return /[一-龥]/.test(a) && /[一-龥]/.test(b) ? a + b : `${a} ${b}`;
  }).trim();
}

/* ---------------- 检索 ---------------- */

const KW = ['电池', '续航', '充电', '充不进', '空调', '暖风', '异响', '刹车', '漏',
  '高温', '动力', '顿挫', '上不了电', '掉电', '报警', '灯亮', '绝缘', '涉水',
  '均衡', '模组', '温控', '互锁', '高压', '快充', '慢充', '跳枪', '水', '雨',
  '冬天', '低温', '衰减', '压差', 'SOC', '均衡', '继电器', '接触器', '预充'];

function findFaults(q, limit = 5) {
  const s = String(q || '').trim().toUpperCase();
  if (!s) return [];
  let r = FAULTS.filter((f) => f.c === s);
  if (!r.length) r = FAULTS.filter((f) => f.c.startsWith(s));
  if (!r.length) r = FAULTS.filter((f) => (f.d || '').includes(q) || (f.s || '').includes(q));
  return r.slice(0, limit);
}

function fmtFault(f) {
  const L = [];
  L.push(`${f.c}  ${f.d || ''}`);
  if (f.s) L.push(`系统：${f.s}`);
  if (f.sv) L.push(`严重度：${f.sv}`);
  if (f.cu) L.push(`可能原因：${f.cu}`);
  if (f.ds) L.push(`诊断步骤：${f.ds}`);
  if (f.fx) L.push(`维修方案：${f.fx}`);
  if (f.lh) L.push(`工时：${f.lh}`);
  if (f.pr) L.push(`报价区间：${f.pr}`);
  if (f.pt) L.push(`配件：${f.pt}`);
  if (f.es) L.push(`经验：${f.es}`);
  (f.ex || []).forEach((e) => L.push(`补充经验：${e}`));
  if (f.tp) L.push(`避坑：${f.tp}`);
  return L.join('\n');
}

function searchExp(query, limit = 8) {
  const text = String(query || '');
  if (!text) return [];
  const words = KW.filter((k) => text.includes(k))
    .concat(text.split(/[\s,，。、；;]+/).filter((w) => w.length >= 2).slice(0, 12));
  const all = Array.from(new Set(words));
  if (!all.length) return [];
  return EXP
    .map((it) => {
      const t = `${it.c} ${it.d} ${it.s} ${it.e}`.toLowerCase();
      return [all.reduce((n, w) => n + (t.includes(String(w).toLowerCase()) ? 1 : 0), 0), it];
    })
    .filter((x) => x[0] > 0)
    .sort((a, b) => b[0] - a[0])
    .slice(0, limit)
    .map((x) => x[1]);
}

function modelIssues(brand, model, limit = 10) {
  let r = MI.filter((x) => x.b === brand && (!model || x.m === model));
  if (!r.length && brand) r = MI.filter((x) => x.b === brand);
  if (!r.length && !brand) r = MI.slice();
  return r.slice(0, limit);
}

function fmtIssue(x) {
  const L = [`${x.b} ${x.m}${x.y ? ' ' + x.y : ''}`];
  L.push(`${x.c}  ${x.d || ''}`);
  if (x.cu) L.push(`可能原因：${x.cu}`);
  if (x.fx) L.push(`维修方案：${x.fx}`);
  if (x.lh) L.push(`工时：${x.lh}`);
  if (x.pr) L.push(`报价：${x.pr}`);
  if (x.e) L.push(`经验：${x.e}`);
  if (x.tp) L.push(`避坑：${x.tp}`);
  return L.join('\n');
}

function symptomCodes(q, limit = 6) {
  const s = String(q || '').trim();
  if (!s) return [];
  const hit = SYMS.filter((x) => (x.sy || '').includes(s) || s.includes(x.sy));
  if (!hit.length) {
    return SYMS.filter((x) => s.split('').some((ch) => (x.sy || '').includes(ch))).slice(0, 3);
  }
  return hit.slice(0, limit);
}

function lookupDtc(code, limit = 5) {
  const s = String(code || '').trim().toUpperCase();
  if (!s) return [];
  let r = DTC.filter((d) => d.code === s);
  if (!r.length) r = DTC.filter((d) => d.code.startsWith(s));
  if (!r.length) {
    const kw = s.toLowerCase();
    r = DTC.filter((d) => (d.en || '').toLowerCase().includes(kw));
  }
  return r.slice(0, limit);
}

function fmtDtc(d) {
  const local = FAULTS.find((f) => f.c === d.code);
  const L = [`${d.code}（${d.mf || 'Generic'}）`];
  L.push(`定义：${d.en || ''}`);
  const zh = zhGloss(d.en);
  if (zh && zh !== d.en) L.push(`中文对照：${zh}（术语规则映射，可能有偏差）`);
  if (local) {
    L.push(`本库有中文维修条目：${local.d}｜系统 ${local.s || '-'}｜报价 ${local.pr || '-'}`);
    L.push(`  → 用 lookup_fault_code("${d.code}") 取完整原因/步骤/方案`);
  } else {
    L.push('本库暂无该码的中文维修条目（可用车型/现象走 diagnose_full）。');
  }
  return L.join('\n');
}

/* ---------------- diagnose_full：一次出结构化结论 ---------------- */

const SPLIT = /[;；,，、]/;

/** 原因串切分：优先按分号；分号切不开再按顿号逗号，并丢掉过短的碎片，避免切出「快充口」这种残句 */
function splitCauses(s) {
  const raw = String(s || '').trim();
  if (!raw) return [];
  let parts = raw.split(/[;；]/).map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2) {
    const soft = raw.split(/[、,，]/).map((x) => x.trim()).filter((x) => x.length >= 4);
    if (soft.length >= 2) parts = soft;
  }
  return parts.length ? parts : [raw];
}

/** 命中条目与现象的相关性：关键词命中 + 二元组重叠，用来剔掉明显不搭的码 */
function relScore(f, text) {
  const t = `${f.c} ${f.d || ''} ${f.s || ''} ${f.cu || ''} ${f.ds || ''}`;
  let n = 0;
  KW.forEach((k) => { if (text.includes(k) && t.includes(k)) n += 2; });
  const s = String(text || '');
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    if (/[一-龥]{2}/.test(g) && t.includes(g)) n += 0.4;
  }
  return n;
}

function parseMoneyRange(pr) {
  if (!pr) return [];
  const out = [];
  const re = /(\d+(?:\.\d+)?)\s*[-~到至]\s*(\d+(?:\.\d+)?)/g;
  let m;
  while ((m = re.exec(String(pr))) !== null) out.push([parseFloat(m[1]), parseFloat(m[2])]);
  if (!out.length) {
    const n = String(pr).match(/(\d+(?:\.\d+)?)/);
    if (n) out.push([parseFloat(n[1]), parseFloat(n[1])]);
  }
  return out;
}

/** 从一段报价文本里取出「标签 + 区间」，如「换密封件 500-2000元」 */
function moneyTiers(pr) {
  if (!pr) return [];
  const out = [];
  String(pr).split(/[;；]/).forEach((seg) => {
    seg = seg.trim();
    if (!seg) return;
    const r = parseMoneyRange(seg);
    if (!r.length) return;
    const label = seg.replace(/[\d.]+\s*[-~到至]\s*[\d.]+\s*元?/g, '').replace(/[（(].*?[）)]/g, '').trim() || '维修';
    out.push({ label, lo: r[0][0], hi: r[0][1] });
  });
  return out;
}

/** 启发式概率排序：原因在经验/通病里被佐证的排前；未佐证按原始顺序递减。
 *  明确标注非统计概率。 */
function rankCauses(causes, ctxText) {
  const uniq = Array.from(new Set(causes.map((c) => c.trim()).filter(Boolean)));
  if (!uniq.length) return [];
  const low = String(ctxText || '');
  const scored = uniq.map((c, i) => {
    let score = Math.max(8, 100 - i * 6);          // 原始顺序递减，保底不为负
    // 经验/通病文本中出现该原因的核心词 → 加分
    const core = c.split(/[;；,，。]/)[0].slice(0, 12);
    if (core.length >= 2 && low.includes(core)) score += 25;
    if (/进水|密封|连接器|线束|接触不良|插头/.test(c) && /水|雨|涉水|潮/.test(low)) score += 30;
    if (/软件|标定|升级|重置/.test(c)) score += 12;   // 低成本先排查
    return { c, score };
  }).sort((a, b) => b.score - a.score);
  // 只在展示出来的前 6 个候选里归一化：读作「这几个原因之间的相对可能性」
  const top = scored.slice(0, 6);
  const total = top.reduce((n, x) => n + x.score, 0);
  return top.map((x) => ({ cause: x.c, pct: Math.max(3, Math.round((x.score / total) * 100)) }));
}

function diagnoseFull(a) {
  const brand = (a.brand || '').trim();
  const model = (a.model || '').trim();
  const symptom = (a.symptom || '').trim();
  const code = (a.code || '').trim().toUpperCase();
  const extra = (a.extra || '').trim();

  if (!code && !symptom && !brand) {
    return '至少给一个线索：故障码（code）、故障现象（symptom）或品牌车型（brand/model）。';
  }

  const ctxText = `${brand} ${model} ${symptom} ${extra}`;
  const L = [];
  L.push('# 诊断结论（辅助参考，非维修判定）');
  L.push(`车辆：${brand || '未填'} ${model || ''}｜现象：${symptom || '未填'}｜故障码：${code || '未读码'}`);
  if (extra) L.push(`补充：${extra}`);
  L.push('');

  // 1. 命中条目
  let hits = [];
  if (code) hits = findFaults(code, 3);
  if (!hits.length && symptom) {
    const sc = symptomCodes(symptom, 2);
    sc.forEach((x) => {
      (String(x.rc || '').split(/[,\s]+/).filter(Boolean)).forEach((c) => {
        const f = FAULTS.find((z) => z.c === c);
        if (f && !hits.find((h) => h.c === f.c)) hits.push(f);
      });
    });
  }
  if (!hits.length && symptom) hits = findFaults(symptom, 2);
  // 剔掉跟现象明显不搭的码（例如「洗车后无法上电」里的电池衰减码），但至少留一条
  if (symptom && hits.length > 1) {
    const scoredHits = hits.map((f) => [relScore(f, `${symptom} ${extra} ${code}`), f]);
    const kept = scoredHits.filter((x) => x[0] >= 1.6).sort((a, b) => b[0] - a[0]).map((x) => x[1]);
    if (kept.length) hits = kept;
  }
  hits = hits.slice(0, 5);

  // 2. 车型通病
  const issues = brand ? modelIssues(brand, model, 3) : [];

  // 3. 经验
  const exps = searchExp(`${symptom} ${code} ${brand} ${model} ${extra}`, 5);

  // 汇总上下文（用于原因加权）
  const aggCtx = [hits.map((f) => `${f.c} ${f.d} ${f.cu || ''}`).join(' '),
    issues.map((x) => `${x.c} ${x.d} ${x.cu || ''} ${x.e || ''}`).join(' '),
    exps.map((x) => x.e).join(' '), ctxText].join(' ');

  // 4. 可能原因排序
  let causes = [];
  hits.forEach((f) => splitCauses(f.cu).forEach((c) => causes.push(c.trim())));
  issues.forEach((x) => splitCauses(x.cu).forEach((c) => causes.push(c.trim())));
  if (!causes.length && exps.length) causes = exps.map((x) => x.d || x.s).filter(Boolean);
  const ranked = rankCauses(causes, aggCtx).slice(0, 6);

  if (hits.length) {
    L.push('## 命中的故障码');
    hits.forEach((f) => {
      L.push(`- ${f.c} ${f.d || ''}｜系统 ${f.s || '-'}｜严重度 ${f.sv || '-'}｜报价 ${f.pr || '-'}｜工时 ${f.lh || '-'}`);
    });
    L.push('');
  }

  if (ranked.length) {
    L.push('## 可能原因（按概率排序，启发式估计，非统计值）');
    ranked.forEach((r, i) => L.push(`${i + 1}. ${r.cause} — 约 ${r.pct}%`));
    L.push('');
  }

  // 5. 检查顺序：先零成本排查，后花钱维修
  const clean = (s) => s.replace(/^\s*\d+\s*[.、)）]+\s*/, '').trim();
  const STEP_SPLIT = /[;；]/;                       // 步骤只按分号切，避免把括号里的顿号切断
  const checkSteps = [];
  const fixSteps = [];
  hits.forEach((f) => {
    (f.ds || '').split(STEP_SPLIT).map(clean).filter(Boolean).forEach((s) => checkSteps.push({ s, cost: 0 }));
    (f.fx || '').split(STEP_SPLIT).map(clean).filter(Boolean).forEach((s, i) => {
      const tiers = moneyTiers(f.pr);
      const t = tiers[Math.min(i, tiers.length - 1)];
      fixSteps.push({ s, cost: t ? t.lo : 9999, tag: t ? `${t.label} ${t.lo}-${t.hi} 元` : '' });
    });
  });
  const hitCodes = new Set(hits.map((f) => f.c));
  issues.forEach((x) => {
    if (!hitCodes.has(x.c)) return;
    (x.fx || '').split(STEP_SPLIT).map(clean).filter(Boolean).forEach((s) => {
      const t = moneyTiers(x.pr)[0];
      fixSteps.push({ s, cost: t ? t.lo : 9999, tag: t ? `${t.label} ${t.lo}-${t.hi} 元` : '' });
    });
  });
  const dedup = (arr) => {
    const seen = new Set(); const out = [];
    arr.forEach((x) => { if (!seen.has(x.s)) { seen.add(x.s); out.push(x); } });
    return out;
  };
  const cs = dedup(checkSteps).slice(0, 5);
  const fs = dedup(fixSteps).sort((a, b) => a.cost - b.cost).slice(0, 5);
  if (cs.length || fs.length) {
    L.push('## 检查与处理顺序（先不花钱的，后花钱的）');
    let n = 0;
    cs.forEach((x) => { n++; L.push(`${n}. [排查·几乎不花钱] ${x.s}`); });
    fs.forEach((x) => { n++; L.push(`${n}. [维修${x.tag ? '·' + x.tag : ''}] ${x.s}`); });
    L.push('');
  }

  // 6. 报价分档（只取命中码及其车型关联，避免把不相关的换电池包价混进来）
  let tiers = [];
  hits.forEach((f) => { tiers = tiers.concat(moneyTiers(f.pr)); });
  issues.forEach((x) => { if (hitCodes.has(x.c)) tiers = tiers.concat(moneyTiers(x.pr)); });
  // 同名档位合并（不同故障码给出同一类维修时只保留一个区间）
  const merged = new Map();
  tiers.forEach((t) => {
    const old = merged.get(t.label);
    if (old) merged.set(t.label, { label: t.label, lo: Math.min(old.lo, t.lo), hi: Math.max(old.hi, t.hi) });
    else merged.set(t.label, { ...t });
  });
  tiers = Array.from(merged.values()).sort((a, b) => a.lo - b.lo);
  const ranges = tiers.map((t) => [t.lo, t.hi]);
  if (tiers.length) {
    L.push('## 报价分档');
    tiers.slice(0, 5).forEach((t) => L.push(`- ${t.label}：${t.lo} - ${t.hi} 元`));
    const lo = Math.min(...ranges.map((r) => r[0]));
    const hi = Math.max(...ranges.map((r) => r[1]));
    L.push(`合计区间参考：${lo} - ${hi} 元（行业通行区间，按车型年款与实际工位校准）`);
    L.push('');
  }

  // 7. 老师傅经验
  if (exps.length) {
    L.push('## 老师傅经验（这是通用模型里没有的部分）');
    exps.slice(0, 4).forEach((x) => L.push(`- ${x.c}：${x.e}`));
    L.push('');
  }
  if (issues.length) {
    L.push('## 该车型高发关联');
    issues.forEach((x) => L.push(`- ${x.b} ${x.m} ${x.c} ${x.d || ''}｜${x.pr || '报价未标注'}`));
    L.push('');
  }

  // 8. 车主白话
  const top = ranked[0];
  const owner = [];
  owner.push(`您这车${symptom ? '出现「' + symptom + '」' : '报了 ' + code}，` +
    `最常见的原因是${top ? top.cause.replace(/[（(].*?[)）]/g, '') : '还需要进一步检测才能确定'}，` +
    `大概 ${top ? top.pct + '%' : '—'} 的可能性（经验排序，不是统计值）。`);
  if (cs.length) owner.push(`处理上会先${cs[0].s}，这一步基本不花钱；确认不了再往下查。`);
  if (tiers.length) {
    const lo = Math.min(...tiers.map((t) => t.lo));
    const hi = Math.max(...tiers.map((t) => t.hi));
    owner.push(`费用大概 ${lo} 到 ${hi} 元${tiers.length > 1 ? '，具体看坏在哪一档' : ''}，修之前会跟您确认。`);
  }
  owner.push('高压部分要断电验电后再动，我们自己不会带电操作。');
  L.push('## 可以直接发给车主的一段话');
  L.push(owner.join(''));
  L.push('');
  L.push('---');
  L.push('数据来源：本地维修库（等级 B，结构化整理）+ ModelScope 开源数据集（等级 A）。概率为启发式排序，不是统计值。用 kb_stats 看完整溯源。');

  return L.join('\n');
}

/* ---------------- kb_stats ---------------- */

function kbStats() {
  const real = {
    faults: FAULTS.filter((f) => f.source === 'real_workorder').length,
    experience: EXP.filter((f) => f.source === 'real_workorder').length,
    model_issues: MI.filter((f) => f.source === 'real_workorder').length
  };
  const L = [];
  L.push('# 数据规模与来源');
  L.push('');
  (PROV.datasets || []).forEach((d) => {
    L.push(`- ${d.name}：${d.count} 条｜等级 ${d.grade}｜来源：${d.source}`);
  });
  L.push('');
  L.push(`真实工单导入条目：故障码 ${real.faults} / 经验 ${real.experience} / 车型通病 ${real.model_issues}（等级 A）`);
  L.push('');
  L.push('等级说明：A=公开数据集或真实工单，可追溯；B=结构化整理，未逐条实车验证；C=样例数据。');
  L.push(`服务版本 ${VERSION}｜协议 2024-11-05｜零依赖，不联网。`);
  return L.join('\n');
}

/* ---------------- 工具定义 ---------------- */

const TOOLS = [
  {
    name: 'lookup_fault_code',
    description: '查询新能源汽车故障码（中文维修库，146 条）。支持精确匹配、前缀匹配和中文关键词。返回描述、系统、严重度、可能原因、诊断步骤、维修方案、工时、报价区间、配件、老师傅经验和避坑提示。',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '故障码，如 P0A7F、P0AA6、B1000；也支持中文关键词如「电池衰减」「充不进电」' },
        limit: { type: 'number', description: '返回条数，默认 5' }
      },
      required: ['code']
    }
  },
  {
    name: 'lookup_dtc',
    description: '查询新能源汽车标准故障码定义（896 条三电/高压码，来自 ModelScope 开源数据集，Apache 2.0）。返回英文原文定义 + 术语级中文对照 + 制造商，并提示本库是否有对应的中文维修条目。',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '标准故障码，如 P0A00、P0AA6、U0100；支持前缀，如 P0A' },
        limit: { type: 'number', description: '返回条数，默认 5' }
      },
      required: ['code']
    }
  },
  {
    name: 'diagnose_full',
    description: '一次输入车型 + 故障现象 + 故障码，直接出结构化诊断结论：可能原因按概率排序、检查顺序（先便宜后贵）、报价区间、该车型高发关联、老师傅经验、一段能直接发给车主的白话。这是本服务的核心能力，给的是成品判断而不是原始数据表。',
    inputSchema: {
      type: 'object',
      properties: {
        brand: { type: 'string', description: '品牌，如 比亚迪、特斯拉、小鹏、蔚来、理想、极氪、广汽埃安、哪吒' },
        model: { type: 'string', description: '车型，如 汉EV、Model 3、P7、ES6' },
        symptom: { type: 'string', description: '故障现象，如「涉水后无法上电」「冬天续航掉得快」「快充跳枪」' },
        code: { type: 'string', description: '已读到的故障码，可留空' },
        extra: { type: 'string', description: '补充信息：里程、天气、是否刚修过、故障是否偶发等' }
      },
      required: []
    }
  },
  {
    name: 'search_experience',
    description: '检索老师傅实战经验（190 条中文新能源维修经验，通用大模型语料里没有）。例如「雨季涉水后绝缘故障高发，多数源于连接器进水而非电池本体，优先查线束与接口」。按关键词匹配，不限故障码。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '查询描述，如「涉水后无法上电」「冬天续航掉得快」「快充跳枪」' },
        limit: { type: 'number', description: '返回条数，默认 8' }
      },
      required: ['query']
    }
  },
  {
    name: 'list_model_issues',
    description: '查询某品牌或车型的新能源通病记录（车型 × 故障码关联，44 条）。覆盖比亚迪汉EV、特斯拉Model 3、蔚来ES6、理想ONE、小鹏P7、极氪001 等车型。',
    inputSchema: {
      type: 'object',
      properties: {
        brand: { type: 'string', description: '品牌，如 比亚迪、特斯拉、小鹏、蔚来、理想、极氪、广汽埃安、哪吒' },
        model: { type: 'string', description: '车型，可留空表示查该品牌全部' },
        limit: { type: 'number', description: '返回条数，默认 10' }
      },
      required: ['brand']
    }
  },
  {
    name: 'symptom_to_codes',
    description: '由故障现象反查可能的故障码（40 条现象到故障码的映射）。例如「仪表显示高压系统故障无法上电」→ P0AA6 / P0A0D / P0A0F / P0AA1。',
    inputSchema: {
      type: 'object',
      properties: {
        symptom: { type: 'string', description: '故障现象描述，如「充不进电」「续航掉得快」「无法上电」' },
        limit: { type: 'number', description: '返回条数，默认 6' }
      },
      required: ['symptom']
    }
  },
  {
    name: 'kb_stats',
    description: '查看本服务的数据规模、每条数据集的来源与真实性等级（A 公开/真实可追溯，B 结构化整理，C 样例），以及已导入的真实工单条数。用来判断某条结论能信几分。',
    inputSchema: { type: 'object', properties: {}, required: [] }
  }
];

function callTool(name, args) {
  const a = args || {};
  switch (name) {
    case 'lookup_fault_code': {
      const r = findFaults(a.code, a.limit || 5);
      if (!r.length) return `没查到「${a.code}」。可以试试只输前缀（如 P0A7），或换个中文关键词；也可以试 lookup_dtc 查标准码定义。`;
      return r.map(fmtFault).join('\n\n---\n\n');
    }
    case 'lookup_dtc': {
      const r = lookupDtc(a.code, a.limit || 5);
      if (!r.length) return `标准码库里没查到「${a.code}」。库里是三电/高压相关的 896 条（P0A/P0B/P1A/U0 等），车身/底盘码可能不在其中。`;
      return r.map(fmtDtc).join('\n\n---\n\n');
    }
    case 'diagnose_full':
      return diagnoseFull(a);
    case 'search_experience': {
      const r = searchExp(a.query, a.limit || 8);
      if (!r.length) return `没检索到与「${a.query}」相关的经验。换个说法试试，比如只说「涉水」「续航」「跳枪」。`;
      return `匹配到 ${r.length} 条老师傅经验：\n\n` +
        r.map((x) => `- ${x.c}（${x.d || x.s || ''}）：${x.e}`).join('\n');
    }
    case 'list_model_issues': {
      const r = modelIssues(a.brand, a.model, a.limit || 10);
      if (!r.length) {
        const brands = Array.from(new Set(MI.map((x) => x.b))).join('、');
        return `没有「${a.brand || '空'}」的通病记录。目前有数据的品牌：${brands}。`;
      }
      return `找到 ${r.length} 条车型通病记录：\n\n` + r.map(fmtIssue).join('\n\n---\n\n');
    }
    case 'symptom_to_codes': {
      const r = symptomCodes(a.symptom, a.limit || 6);
      if (!r.length) return `没匹配到「${a.symptom}」这个现象。可以直接用 diagnose_full，输车型和现象也能出结论。`;
      const out = [];
      r.forEach((x) => {
        const codes = (x.rc || '').split(/[,\s]+/).filter(Boolean);
        out.push(`现象：${x.sy}`);
        if (x.ps) out.push(`可能系统：${x.ps}`);
        out.push(`关联故障码：${codes.join('、')}`);
        codes.slice(0, 2).forEach((c) => {
          const f = FAULTS.find((z) => z.c === c);
          if (f) out.push(`  ${f.c} = ${f.d}${f.pr ? '（报价 ' + f.pr + '）' : ''}`);
        });
        out.push('');
      });
      return out.join('\n');
    }
    case 'kb_stats':
      return kbStats();
    default:
      throw new Error('未知工具：' + name);
  }
}

/* ---------------- resources ---------------- */

const RESOURCES = [
  { uri: 'kb://datasets', name: '数据集清单', mimeType: 'text/markdown', description: '各数据集的条数、来源、真实性等级' },
  { uri: 'kb://provenance', name: '数据溯源文件', mimeType: 'application/json', description: 'provenance.json 原文' },
  { uri: 'kb://fault-codes', name: '中文故障码一览', mimeType: 'text/plain', description: '146 条故障码的 code / 描述 / 系统 / 报价' },
  { uri: 'kb://dtc-index', name: '标准故障码索引', mimeType: 'text/plain', description: '896 条三电/高压标准码（ModelScope）' },
  { uri: 'kb://experience', name: '老师傅经验全文', mimeType: 'text/plain', description: '190 条中文实战经验' }
];

function readResource(uri) {
  switch (uri) {
    case 'kb://datasets':
      return { text: kbStats(), mimeType: 'text/markdown' };
    case 'kb://provenance':
      return { text: JSON.stringify(PROV, null, 2), mimeType: 'application/json' };
    case 'kb://fault-codes':
      return { text: FAULTS.map((f) => `${f.c}\t${f.d || ''}\t${f.s || ''}\t${f.pr || ''}`).join('\n'), mimeType: 'text/plain' };
    case 'kb://dtc-index':
      return { text: DTC.map((d) => `${d.code}\t${d.mf || ''}\t${d.en || ''}`).join('\n'), mimeType: 'text/plain' };
    case 'kb://experience':
      return { text: EXP.map((x) => `${x.c}\t${x.d || ''}\t${x.e || ''}`).join('\n'), mimeType: 'text/plain' };
    default:
      return null;
  }
}

/* ---------------- prompts ---------------- */

const PROMPTS = [
  {
    name: 'diagnose_intake',
    title: '接车问诊结论',
    description: '给定车型、故障现象和故障码，输出面向维修技师的结构化诊断结论：原因概率排序、检查顺序、报价区间、避坑提示。',
    arguments: [
      { name: 'brand', description: '品牌', required: false },
      { name: 'model', description: '车型', required: false },
      { name: 'symptom', description: '故障现象', required: true },
      { name: 'code', description: '故障码', required: false }
    ]
  },
  {
    name: 'owner_explain',
    title: '车主白话解释',
    description: '把诊断结论翻译成车主听得懂的一段话：是什么毛病、为什么要这样查、大概多少钱、会不会有风险。',
    arguments: [
      { name: 'diagnosis', description: '诊断结论文本', required: true }
    ]
  }
];

function getPrompt(name, args) {
  const a = args || {};
  if (name === 'diagnose_intake') {
    return {
      description: '接车问诊结论',
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `你是新能源汽修老师傅。车辆：${a.brand || '未填'} ${a.model || ''}，现象：${a.symptom || '未填'}，故障码：${a.code || '未读码'}。\n` +
            '先用 diagnose_full 取结构化结论，再输出四段：1 可能原因（按概率排序，写清楚为什么这个排第一）2 检查顺序（先便宜后贵，每步花多少钱）3 报价区间（分档）4 避坑提示。\n' +
            '把经验化成你自己的判断，不要照抄句子，不要写「根据经验」。不确定就明说不确定。'
        }
      }]
    };
  }
  if (name === 'owner_explain') {
    return {
      description: '车主白话解释',
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `把下面这段诊断结论翻译成车主听得懂的话，一段不超过 200 字。说清：什么毛病、为什么这么查、大概多少钱、有没有安全风险。不要堆术语，不要吓唬人。\n\n${a.diagnosis || ''}`
        }
      }]
    };
  }
  return null;
}

/* ---------------- MCP over stdio ---------------- */

const PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18'];
const DEFAULT_PROTOCOL = '2024-11-05';
let buffer = '';

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    const want = (params && params.protocolVersion) || DEFAULT_PROTOCOL;
    send({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: PROTOCOLS.includes(want) ? want : DEFAULT_PROTOCOL,
        capabilities: {
          tools: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
          prompts: { listChanged: false },
          logging: {}
        },
        serverInfo: { name: 'ev-diagnosis', title: '新能源汽车维修诊断', version: VERSION },
        instructions: '新能源汽车维修诊断数据服务。先调 kb_stats 看数据规模与来源等级；查码用 lookup_fault_code（中文库）或 lookup_dtc（标准码）；要结论用 diagnose_full。输出均为维修辅助参考，高压作业须按整车厂手册执行。'
      }
    });
    return;
  }
  if ((method || '').startsWith('notifications/')) return;
  if (method === 'ping') { send({ jsonrpc: '2.0', id, result: {} }); return; }
  if (method === 'tools/list') { send({ jsonrpc: '2.0', id, result: { tools: TOOLS } }); return; }
  if (method === 'resources/list') { send({ jsonrpc: '2.0', id, result: { resources: RESOURCES } }); return; }
  if (method === 'resources/read') {
    const uri = params && params.uri;
    const r = readResource(uri);
    if (!r) {
      send({ jsonrpc: '2.0', id, error: { code: -32602, message: '没有这个资源：' + uri } });
      return;
    }
    send({ jsonrpc: '2.0', id, result: { contents: [{ uri, mimeType: r.mimeType, text: r.text }] } });
    return;
  }
  if (method === 'prompts/list') { send({ jsonrpc: '2.0', id, result: { prompts: PROMPTS } }); return; }
  if (method === 'prompts/get') {
    const name = params && params.name;
    const p = getPrompt(name, params && params.arguments);
    if (!p) {
      send({ jsonrpc: '2.0', id, error: { code: -32602, message: '没有这个提示词：' + name } });
      return;
    }
    send({ jsonrpc: '2.0', id, result: p });
    return;
  }
  if (method === 'tools/call') {
    const name = params && params.name;
    try {
      const text = callTool(name, (params && params.arguments) || {});
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: false } });
    } catch (e) {
      send({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: '调用出错：' + (e && e.message) }], isError: true }
      });
    }
    return;
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: '不支持的方法：' + method } });
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); }
    catch (e) {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: '解析失败：' + e.message } });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
