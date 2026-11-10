// test/smoke.mjs — 零依赖冒烟测试：起服务 → 全链路验证 → 关闭
// 运行：node test/smoke.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const PORT = 18787;
const TOKEN = 'smoke-test-token';
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionsync-smoke-'));
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
const ok = (name, extra = '') => { results.push(`  ✅ ${name}${extra ? ' — ' + extra : ''}`); };
const fail = (name, msg) => { results.push(`  ❌ ${name} — ${msg}`); throw new Error(`${name}: ${msg}`); };
const assert = (cond, name, msg = '断言失败') => (cond ? ok(name) : fail(name, msg));

const hdr = (extra = {}) => ({ Authorization: `Bearer ${TOKEN}`, 'X-Device': 'smoke-test', ...extra });
const j = async (r) => { const d = await r.json().catch(() => ({})); return { status: r.status, d }; };

const srv = spawn(process.execPath, ['server.mjs'], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, ACCESS_TOKEN: TOKEN },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stdout.on('data', () => {});
srv.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

async function waitReady(tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${BASE}/api/status`, { headers: hdr() });
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('服务未在 10 秒内就绪');
}

function shutdown(code) {
  try { srv.kill('SIGTERM'); } catch {}
  setTimeout(() => {
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
    process.exit(code);
  }, 600);
}

try {
  await waitReady();
  ok('服务启动');

  // 1. 认证
  const noAuth = await fetch(`${BASE}/api/status`);
  assert(noAuth.status === 401, '无令牌拒绝访问');

  // 2. 创建会话
  const created = await j(await fetch(`${BASE}/api/sessions`, {
    method: 'POST', headers: hdr({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ title: '冒烟测试会话', tags: ['测试'], space: 'CICD' }),
  }));
  assert(created.status === 201 && created.d.session?.id, '创建会话');
  const sid = created.d.session.id;

  // 3. 写入消息（中文）
  const post = await j(await fetch(`${BASE}/api/sessions/${sid}/messages`, {
    method: 'POST', headers: hdr({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ messages: [
      { role: 'user', content: '帮我设计一个安全审计工具的测试框架' },
      { role: 'assistant', content: '已完成框架设计，包含覆盖率统计模块' },
      { role: 'user', content: '把它接入持续集成流水线' },
    ] }),
  }));
  assert(post.status === 201 && post.d.count === 3, '写入 3 条消息');

  // 4. 中文检索（bigram）
  const search = await j(await fetch(`${BASE}/api/search?q=${encodeURIComponent('审计框架')}`, { headers: hdr() }));
  assert(search.status === 200 && search.d.total > 0, '中文关键词检索', `命中 ${search.d.total} 条`);

  // 5. 空间聚合与过滤
  const spaces = await j(await fetch(`${BASE}/api/spaces`, { headers: hdr() }));
  assert(spaces.d.items?.some((x) => x.name === 'CICD'), '空间聚合');
  const bySpace = await j(await fetch(`${BASE}/api/sessions?space=CICD`, { headers: hdr() }));
  assert(bySpace.d.total === 1, '按空间过滤');

  // 6. 幂等推送
  const op = { op_id: 'smoke-dup-1', entity: 'memory', id: 'smoke-mem-1', data: { scope: 'global', key: '幂等', content: '只生效一次' } };
  const push1 = await j(await fetch(`${BASE}/api/sync/push`, { method: 'POST', headers: hdr({ 'Content-Type': 'application/json' }), body: JSON.stringify({ device: 'smoke', ops: [op] }) }));
  const push2 = await j(await fetch(`${BASE}/api/sync/push`, { method: 'POST', headers: hdr({ 'Content-Type': 'application/json' }), body: JSON.stringify({ device: 'smoke', ops: [op] }) }));
  assert(push1.d.applied === 1 && push2.d.skipped === 1, 'op_id 幂等去重');

  // 7. 文件上传下载回环
  const content = Buffer.from(`smoke test ${Date.now()}\n`);
  const localSha = crypto.createHash('sha256').update(content).digest('hex');
  const up = await j(await fetch(`${BASE}/api/files`, {
    method: 'POST',
    headers: hdr({ 'Content-Type': 'text/plain', 'X-Session-Id': sid, 'X-File-Name': encodeURIComponent('测试文件.txt') }),
    body: content,
  }));
  assert(up.status === 201 && up.d.file?.sha256 === localSha, '文件上传（sha256 一致）');
  const dl = await fetch(`${BASE}/files/${up.d.file.id}?token=${TOKEN}`);
  const dlSha = crypto.createHash('sha256').update(Buffer.from(await dl.arrayBuffer())).digest('hex');
  assert(dl.ok && dlSha === localSha, '文件下载回环');

  // 8. 上下文包
  const ctx = await j(await fetch(`${BASE}/api/sessions/${sid}/context?full=1`, { headers: hdr() }));
  assert(ctx.d.total_messages === 3 && ctx.d.files.length === 1, '续接上下文包', `${ctx.d.total_messages} 消息 / ${ctx.d.files.length} 文件`);

  // 9. 增量拉取
  const pull = await j(await fetch(`${BASE}/api/sync/pull?since_seq=0`, { headers: hdr() }));
  assert(pull.d.ops.length >= 5 && pull.d.max_seq >= 5, '增量拉取 ops', `${pull.d.ops.length} 条`);

  // 10. 级联删除
  const del = await fetch(`${BASE}/api/sessions/${sid}`, { method: 'DELETE', headers: hdr() });
  const after = await fetch(`${BASE}/api/sessions/${sid}`, { headers: hdr() });
  assert(del.ok && after.status === 404, '删除会话并级联');

  console.log('\n冒烟测试结果：');
  console.log(results.join('\n'));
  console.log(`\n✅ 全部通过（${results.length} 项）`);
  shutdown(0);
} catch (e) {
  console.log('\n冒烟测试结果：');
  console.log(results.join('\n'));
  console.error('\n❌ 失败:', e.message);
  shutdown(1);
}
