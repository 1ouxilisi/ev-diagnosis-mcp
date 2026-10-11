#!/usr/bin/env node
/**
 * ev-diagnosis MCP server 自动测试。零依赖，node test.mjs 直接跑。
 * 覆盖：协议握手、工具清单、7 个工具实调、resources、prompts、异常输入。
 */
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, [path.join(HERE, 'server.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] });

let buf = '';
const pending = new Map();
let seq = 0;
const stderrLines = [];

child.stderr.on('data', (d) => stderrLines.push(d.toString()));
child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (e) { continue; }
    if (msg.id != null && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

function request(method, params, timeout = 8000) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${method} 超时`)), timeout);
    pending.set(id, (m) => { clearTimeout(t); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n');
  });
}

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const textOf = (r) => ((r.result && r.result.content) || []).map((c) => c.text).join('');

async function main() {
  const init = await request('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  const cap = init.result && init.result.capabilities;
  check('initialize 返回 capabilities', !!(cap && cap.tools && cap.resources && cap.prompts));
  check('initialize 返回 serverInfo', !!(init.result && init.result.serverInfo && init.result.serverInfo.name === 'ev-diagnosis'));

  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const list = await request('tools/list', {});
  const names = (list.result.tools || []).map((t) => t.name);
  check('工具清单 7 个', names.length === 7, names.join(', '));
  ['lookup_fault_code', 'lookup_dtc', 'diagnose_full', 'search_experience',
    'list_model_issues', 'symptom_to_codes', 'kb_stats'].forEach((n) => {
    check(`工具存在：${n}`, names.includes(n));
  });

  // 1 lookup_fault_code
  const r1 = await request('tools/call', { name: 'lookup_fault_code', arguments: { code: 'P0A7F' } });
  const t1 = textOf(r1);
  check('lookup_fault_code 命中 P0A7F', t1.includes('P0A7F') && !t1.includes('没查到'), t1.split('\n')[0]);
  const r1b = await request('tools/call', { name: 'lookup_fault_code', arguments: { code: 'P0A' } });
  check('lookup_fault_code 前缀匹配', textOf(r1b).includes('P0A'));
  const r1c = await request('tools/call', { name: 'lookup_fault_code', arguments: { code: 'ZZZZ99' } });
  check('lookup_fault_code 未命中给提示', textOf(r1c).includes('没查到'));

  // 2 lookup_dtc
  const r2 = await request('tools/call', { name: 'lookup_dtc', arguments: { code: 'P0A00' } });
  const t2 = textOf(r2);
  check('lookup_dtc 命中 P0A00', t2.includes('P0A00') && t2.includes('定义：'));
  check('lookup_dtc 带中文对照', t2.includes('中文对照'));
  const r2b = await request('tools/call', { name: 'lookup_dtc', arguments: { code: 'P0AA6' } });
  check('lookup_dtc 提示本库中文条目', textOf(r2b).includes('本库'));

  // 3 diagnose_full
  const r3 = await request('tools/call', {
    name: 'diagnose_full',
    arguments: { brand: '特斯拉', model: 'Model 3', symptom: '涉水后无法上电', extra: '昨晚暴雨后' }
  });
  const t3 = textOf(r3);
  check('diagnose_full 出结论', t3.includes('# 诊断结论'));
  check('diagnose_full 有原因概率', /约\s*\d+%/.test(t3));
  check('diagnose_full 有检查顺序', t3.includes('先不花钱的'));
  check('diagnose_full 有车主白话', t3.includes('可以直接发给车主'));
  check('diagnose_full 有溯源声明', t3.includes('等级'));
  const r3b = await request('tools/call', { name: 'diagnose_full', arguments: { code: 'P0A7F', brand: '比亚迪', model: '汉EV' } });
  check('diagnose_full 只给码也能跑', textOf(r3b).includes('# 诊断结论'));
  const r3c = await request('tools/call', { name: 'diagnose_full', arguments: {} });
  check('diagnose_full 空输入给引导', textOf(r3c).includes('至少给一个线索'));

  // 4 search_experience
  const r4 = await request('tools/call', { name: 'search_experience', arguments: { query: '涉水后无法上电' } });
  check('search_experience 有结果', textOf(r4).includes('匹配到'));

  // 5 list_model_issues
  const r5 = await request('tools/call', { name: 'list_model_issues', arguments: { brand: '比亚迪' } });
  check('list_model_issues 命中比亚迪', textOf(r5).includes('找到'));
  const r5b = await request('tools/call', { name: 'list_model_issues', arguments: { brand: '劳斯莱斯' } });
  check('list_model_issues 未命中给品牌清单', textOf(r5b).includes('目前有数据的品牌'));

  // 6 symptom_to_codes
  const r6 = await request('tools/call', { name: 'symptom_to_codes', arguments: { symptom: '无法上电' } });
  check('symptom_to_codes 有映射', textOf(r6).includes('关联故障码'));

  // 7 kb_stats
  const r7 = await request('tools/call', { name: 'kb_stats', arguments: {} });
  const t7 = textOf(r7);
  check('kb_stats 列出数据集', t7.includes('896') && t7.includes('190'));
  check('kb_stats 标注等级', t7.includes('等级 A') && t7.includes('等级 B'));

  // resources
  const rl = await request('resources/list', {});
  check('resources/list 返回 5 个', (rl.result.resources || []).length === 5);
  const rr = await request('resources/read', { uri: 'kb://datasets' });
  check('resources/read kb://datasets', textOf(rr).length + ((rr.result.contents?.[0]?.text) || '').length > 100);
  const rr2 = await request('resources/read', { uri: 'kb://dtc-index' });
  check('resources/read kb://dtc-index 有 896 行', ((rr2.result.contents?.[0]?.text) || '').split('\n').length === 896);
  const rr3 = await request('resources/read', { uri: 'kb://nope' });
  check('resources/read 未知 uri 报错', !!rr3.error);

  // prompts
  const pl = await request('prompts/list', {});
  check('prompts/list 返回 2 个', (pl.result.prompts || []).length === 2);
  const pg = await request('prompts/get', { name: 'diagnose_intake', arguments: { symptom: '充不进电' } });
  check('prompts/get 返回消息', !!((pg.result.messages?.[0]?.content?.text) || '').includes('充不进电'));

  // 异常
  const bad = await request('tools/call', { name: 'no_such_tool', arguments: {} });
  check('未知工具返回 isError', bad.result?.isError === true);
  const badm = await request('no/such/method', {});
  check('未知方法返回 -32601', badm.error?.code === -32601);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (stderrLines.length) console.log('server stderr:', stderrLines.join(''));
  child.kill();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('测试崩溃：', e);
  child.kill();
  process.exit(1);
});
