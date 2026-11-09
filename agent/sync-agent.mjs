#!/usr/bin/env node
// agent/sync-agent.mjs — 设备端同步代理（Node.js >= 18，零依赖）
//
// 用法：
//   node agent/sync-agent.mjs push  --server http://host:8787 --token <t> --file 会话导出.json [--device 设备名]
//   node agent/sync-agent.mjs pull  --server http://host:8787 --token <t> --out ./本地副本 [--with-files]
//   node agent/sync-agent.mjs status --server http://host:8787 --token <t>
//
// push 的会话导出 JSON 格式：
// {
//   "session":  { "id": "可选-固定ID", "title": "...", "tags": [], "summary": "...", "source": "..." },
//   "messages": [ { "id": "可选", "role": "user|assistant|system|tool", "content": "...", "ts": 1762672463000, "meta": {} } ],
//   "memories": [ { "id": "可选", "scope": "global|session", "key": "...", "content": "..." } ],
//   "files":    [ { "path": "/本地/文件路径", "name": "显示名.txt", "op_id": "可选-幂等键" } ]
// }
// 重复 push 同一文件（op_id 不变）是幂等的：服务端去重，不会产生重复数据。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const uuid = () => crypto.randomUUID();

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else args[key] = true;
    } else args._.push(a);
  }
  return args;
}

async function api(server, token, method, urlPath, body, headers = {}) {
  const opt = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Device': encodeURIComponent(args.device || `${os.hostname()}`),
      'X-Device-Platform': encodeURIComponent(`${os.type()} ${os.arch()}`),
      ...headers,
    },
  };
  if (body !== undefined && !(body instanceof Buffer) && !(body instanceof Uint8Array)) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  } else if (body !== undefined) {
    opt.body = body;
  }
  const r = await fetch(server.replace(/\/$/, '') + urlPath, opt);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${data.message || data.error || r.statusText}`);
  return data;
}

/* ---------------- push ---------------- */
async function cmdPush(args) {
  const { server, token, file } = args;
  if (!server || !token || !file) {
    console.error('用法: push --server <url> --token <t> --file <会话导出.json> [--device 名]');
    process.exit(2);
  }
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!payload.session?.title) {
    console.error('导出文件缺少 session.title');
    process.exit(2);
  }
  const sessionId = payload.session.id || uuid();
  const device = args.device || os.hostname();

  // 1) 上传文件（幂等：op_id 固定）
  const fileResults = [];
  for (const f of payload.files || []) {
    const buf = fs.readFileSync(f.path);
    const opId = f.op_id || `file-${sessionId}-${path.basename(f.path)}`;
    const r = await api(server, token, 'POST', '/api/files', buf, {
      'Content-Type': f.mime || 'application/octet-stream',
      'X-Session-Id': sessionId,
      'X-File-Name': encodeURIComponent(f.name || path.basename(f.path)),
      'X-Op-Id': opId,
      'X-File-Id': opId,
    });
    fileResults.push(r.file);
    console.log(`  📎 文件已上传: ${r.file.name} (${r.file.size} B, sha256=${r.file.sha256.slice(0, 12)}…)`);
  }

  // 2) 组装操作批次
  const ops = [];
  ops.push({
    op_id: `session-${sessionId}`,
    device,
    entity: 'session',
    id: sessionId,
    data: { ...payload.session, id: sessionId },
  });
  let seq = 0;
  for (const m of payload.messages || []) {
    ops.push({
      op_id: m.op_id || `msg-${sessionId}-${m.id || ++seq}`,
      device,
      entity: 'message',
      id: m.id || uuid(),
      data: { ...m, session_id: sessionId, seq_in_session: m.seq_in_session || ++seq },
    });
  }
  for (const mem of payload.memories || []) {
    ops.push({
      op_id: mem.op_id || `mem-${sessionId}-${mem.id || mem.key || uuid()}`,
      device,
      entity: 'memory',
      id: mem.id || uuid(),
      data: { ...mem, session_id: mem.scope === 'session' ? sessionId : mem.session_id || null },
    });
  }

  const r = await api(server, token, 'POST', '/api/sync/push', { device, ops });
  console.log(`✅ 推送完成: 新应用 ${r.applied} 条 / 重复跳过 ${r.skipped} 条 · 会话 ${sessionId}`);
  if (r.errors?.length) {
    console.error('⚠️ 部分操作失败:');
    for (const e of r.errors) console.error(`   - ${e.op_id}: ${e.message}`);
    process.exit(1);
  }
  console.log(`   服务器当前序列: ${r.max_seq}`);
}

/* ---------------- pull ---------------- */
async function cmdPull(args) {
  const { server, token, out } = args;
  if (!server || !token || !out) {
    console.error('用法: pull --server <url> --token <t> --out <目录> [--with-files]');
    process.exit(2);
  }
  fs.mkdirSync(out, { recursive: true });
  const stateFile = path.join(out, '.sync-state.json');
  const opsFile = path.join(out, 'ops.jsonl');
  let lastSeq = 0;
  if (fs.existsSync(stateFile)) lastSeq = JSON.parse(fs.readFileSync(stateFile, 'utf8')).last_seq || 0;

  let total = 0;
  let maxSeq = lastSeq;
  // 分页拉取
  for (;;) {
    const r = await api(server, token, 'GET', `/api/sync/pull?since_seq=${lastSeq}&limit=2000`);
    if (r.ops.length) {
      fs.appendFileSync(opsFile, r.ops.map((o) => JSON.stringify(o)).join('\n') + '\n');
      total += r.ops.length;
      lastSeq = r.ops[r.ops.length - 1].seq;
    }
    maxSeq = r.max_seq;
    if (!r.has_more) break;
  }

  // 本地物化：重放 ops 得到每实体最新状态
  const state = { session: {}, message: {}, memory: {}, file: {} };
  if (fs.existsSync(opsFile)) {
    for (const line of fs.readFileSync(opsFile, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const op = JSON.parse(line);
        if (op.action === 'delete') delete state[op.entity][op.id];
        else state[op.entity][op.id] = { ...op.data, id: op.id };
        if (op.entity === 'session' && op.action === 'delete' && op.dependents) {
          for (const mid of op.dependents.messages || []) delete state.message[mid];
          for (const mid of op.dependents.memories || []) delete state.memory[mid];
          for (const fid of op.dependents.files || []) delete state.file[fid];
        }
      } catch {}
    }
  }
  fs.writeFileSync(
    path.join(out, 'state.json'),
    JSON.stringify(
      {
        pulled_at: new Date().toISOString(),
        last_seq: lastSeq,
        sessions: Object.values(state.session),
        messages: Object.values(state.message),
        memories: Object.values(state.memory),
        files: Object.values(state.file),
      },
      null,
      2
    )
  );
  fs.writeFileSync(stateFile, JSON.stringify({ last_seq: lastSeq, server: server }));

  console.log(`✅ 拉取完成: 新增 ${total} 条操作 · 本地水位 seq=${lastSeq} / 服务器 ${maxSeq}`);
  console.log(`   本地副本: ${path.resolve(out)}/state.json`);

  // 可选：下载文件内容
  if (args['with-files']) {
    const filesDir = path.join(out, 'files');
    fs.mkdirSync(filesDir, { recursive: true });
    let n = 0;
    for (const f of Object.values(state.file)) {
      const dest = path.join(filesDir, f.sha256);
      if (fs.existsSync(dest)) continue;
      const r = await fetch(`${server.replace(/\/$/, '')}/files/${f.id}?token=${encodeURIComponent(token)}`);
      if (!r.ok) {
        console.error(`   ⚠️ 文件下载失败: ${f.name}`);
        continue;
      }
      fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
      n++;
    }
    console.log(`   📎 新下载文件 ${n} 个（内容寻址存于 files/）`);
  }
}

/* ---------------- status ---------------- */
async function cmdStatus(args) {
  const { server, token } = args;
  if (!server || !token) {
    console.error('用法: status --server <url> --token <t>');
    process.exit(2);
  }
  const st = await api(server, token, 'GET', '/api/status');
  console.log('📊 SessionSync 服务器状态');
  console.log(`   全局序列 max_seq : ${st.max_seq}`);
  console.log(`   累计操作         : ${st.op_count}`);
  console.log(`   会话 / 消息      : ${st.sessions} / ${st.messages}`);
  console.log(`   全局记忆 / 文件  : ${st.memories} / ${st.files}`);
  if (st.devices.length) {
    console.log('   接入设备:');
    for (const d of st.devices) {
      const lag = st.max_seq - (d.last_sync_seq || 0);
      console.log(`     - ${d.name} (${d.platform || '?'}) 水位=${d.last_sync_seq || 0} ${lag > 0 ? `落后 ${lag}` : '✅ 最新'} 最后在线 ${new Date(d.last_seen).toLocaleString()}`);
    }
  }
}

/* ---------------- main ---------------- */
const args = parseArgs(process.argv.slice(2));
const cmd = args._[0] || args.command;
try {
  if (cmd === 'push') await cmdPush(args);
  else if (cmd === 'pull') await cmdPull(args);
  else if (cmd === 'status') await cmdStatus(args);
  else {
    console.log('SessionSync 设备同步代理\n\n用法:');
    console.log('  push  --server <url> --token <t> --file <会话导出.json> [--device 名]');
    console.log('  pull  --server <url> --token <t> --out <目录> [--with-files]');
    console.log('  status --server <url> --token <t>');
  }
} catch (e) {
  console.error('❌ 失败:', e.message);
  process.exit(1);
}
