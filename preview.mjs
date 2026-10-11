#!/usr/bin/env node
/* 打印一次工具调用的完整输出，用于人工检查质量与写材料。用法：node preview.mjs <tool> '<json args>' */
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [tool, argstr] = process.argv.slice(2);
const args = argstr ? JSON.parse(argstr) : {};
const child = spawn(process.execPath, [path.join(HERE, 'server.mjs')], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    if (m.id === 2) {
      console.log(((m.result && m.result.content) || []).map((c) => c.text).join(''));
      child.kill();
      process.exit(0);
    }
  }
});
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }) + '\n');
setTimeout(() => {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } }) + '\n');
}, 120);
setTimeout(() => { console.error('超时'); child.kill(); process.exit(1); }, 8000);
