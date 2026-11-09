#!/usr/bin/env node
// agent/workbuddy-bridge.mjs — WorkBuddy 本地会话 → SessionSync 云端 自动同步桥
//
// 数据源：
//   ~/.workbuddy/workbuddy.db           会话元数据（sessions 表）
//   ~/.workbuddy/projects/<cwd>/<id>.jsonl  逐条消息（type=message）
// 去重：会话 op_id 含元数据哈希，消息 op_id 含文本哈希 —— 可反复运行，天然幂等、支持增量与编辑。
//
// 用法：
//   node agent/workbuddy-bridge.mjs                          # 使用 ~/.sessionsync/config.json
//   node agent/workbuddy-bridge.mjs --server http://... --token xxx
//   node agent/workbuddy-bridge.mjs --session <id>           # 只同步一个会话
//   node agent/workbuddy-bridge.mjs --dry-run --verbose      # 只看不推
//   node agent/workbuddy-bridge.mjs --force                  # 忽略文件缓存全量扫描

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.removeAllListeners('warning'); // 屏蔽 node:sqlite 实验性警告
const { DatabaseSync } = await import('node:sqlite');

const HOME = os.homedir();
const CFG_DIR = path.join(HOME, '.sessionsync');
const CFG_FILE = path.join(CFG_DIR, 'config.json');
const STATE_FILE = path.join(CFG_DIR, 'bridge-state.json');

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--dry-run' || a === '--verbose' || a === '--force' || a === '--quiet') args[a.slice(2)] = true;
  else if (a.startsWith('--')) { args[a.slice(2)] = process.argv[++i]; }
}

let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')); } catch {}
const SERVER = (args.server || cfg.server || process.env.SESSIONSYNC_SERVER || '').replace(/\/$/, '');
const TOKEN = args.token || cfg.token || process.env.SESSIONSYNC_TOKEN || '';
const DB_PATH = args.db || cfg.db || path.join(HOME, '.workbuddy', 'workbuddy.db');
const PROJECTS = args.projects || cfg.projects || path.join(HOME, '.workbuddy', 'projects');
const DEVICE = args.device || `${os.hostname()}-workbuddy-bridge`;

const log = (...xs) => { if (!args.quiet) console.log(...xs); };

/** 带重试的 fetch（针对 ECONNRESET / keep-alive 竞态） */
async function fetchRetry(url, opts, tries = 5) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fetch(url, opts);
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 800 * 2 ** i));
    }
  }
  throw lastErr;
}
const vlog = (...xs) => { if (args.verbose && !args.quiet) console.log(...xs); };

if (!SERVER || !TOKEN) {
  console.error('缺少 server/token：请在 ~/.sessionsync/config.json 配置，或传 --server/--token');
  process.exit(2);
}
if (!fs.existsSync(DB_PATH)) {
  console.error('找不到 WorkBuddy 数据库:', DB_PATH);
  process.exit(2);
}

/* ---------------- 工具 ---------------- */
const hash8 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 8);

/** cwd → 空间名（对齐 WorkBuddy 侧边栏空间；时间戳临时目录统一归类） */
function spaceName(cwd) {
  const base = path.basename(String(cwd || ''));
  if (/^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/.test(base)) return '临时工作区';
  return base || '未分类';
}

/** cwd → projects 目录名（/a/b c → a-b c） */
function encodeCwd(cwd) {
  return String(cwd || '').replace(/^\//, '').replace(/\//g, '-');
}

/** 索引所有 jsonl：sessionId -> 文件路径 */
function indexTranscripts() {
  const map = new Map();
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return map; }
  for (const d of dirs) {
    const dir = path.join(PROJECTS, d.name);
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      map.set(f.slice(0, -6), path.join(dir, f));
    }
  }
  return map;
}

/** 从用户消息中取出真实提问（剥离注入的 system-reminder 上下文） */
function cleanUserText(t) {
  const s = String(t || '');
  const m = s.match(/<user_query>([\s\S]*?)<\/user_query>/);
  if (m) return m[1].trim();
  return s.replace(/<system-reminder[\s\S]*?<\/system-reminder>/g, '').trim();
}

function textOf(o) {
  const c = o.content;
  if (typeof c === 'string') return c.trim();
  if (!Array.isArray(c)) return '';
  return c
    .map((x) => (x && (x.type === 'input_text' || x.type === 'output_text' || x.type === 'text') ? x.text || '' : ''))
    .join('\n')
    .trim();
}

/** 解析一个会话 jsonl → 可读消息列表 */
function parseTranscript(file) {
  const out = [];
  const raw = fs.readFileSync(file, 'utf8');
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'message') continue;
    if (!['user', 'assistant', 'system', 'tool'].includes(o.role)) continue;
    let text = textOf(o);
    if (o.role === 'user') text = cleanUserText(text); // 剥离系统注入上下文
    if (!text) continue; // 纯工具调用轮次不入库
    out.push({ id: o.id || `${o.role}-${o.timestamp}-${out.length}`, role: o.role, text, ts: Number(o.timestamp) || Date.now() });
  }
  return out;
}

/* ---------------- 拉取会话元数据 ---------------- */
const db = new DatabaseSync(DB_PATH, { readOnly: true });
let rows;
if (args.session) {
  rows = db.prepare(`SELECT id,title,custom_title,cwd,created_at,updated_at,status,model,mode FROM sessions WHERE id = ?`).all(args.session);
} else {
  // 只导入本机 local 会话（cloud 会话无本地正文）
  rows = db.prepare(`
    SELECT id,title,custom_title,cwd,created_at,updated_at,status,model,mode
    FROM sessions
    WHERE deleted_at IS NULL AND COALESCE(transport,'local') = 'local' AND COALESCE(is_playground,0) = 0
    ORDER BY updated_at DESC
  `).all();
}
if (args.limit) rows = rows.slice(0, Number(args.limit));
db.close();

const transcripts = indexTranscripts();
let state = {};
try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}
const newState = { ...(state.files || {}) };
const newArtState = { ...(state.artifacts || {}) };

/* ---------------- 产物文件同步（artifact-index） ---------------- */
const ART_DIR = path.join(HOME, '.workbuddy', 'artifact-index');
async function syncArtifacts(row, sessionId) {
  let uploaded = 0, skipped = 0;
  const p = path.join(ART_DIR, row.id + '.json');
  if (!fs.existsSync(p)) return { uploaded, skipped };
  let arts = [];
  try { arts = JSON.parse(fs.readFileSync(p, 'utf8')).artifacts || []; } catch { return { uploaded, skipped }; }
  const seen = new Set();
  for (const a of arts) {
    try {
      if (!a || typeof a.uri !== 'string' || !a.uri.startsWith('file://')) continue;
      const fp = decodeURIComponent(a.uri.slice(7));
      if (seen.has(fp)) continue;
      seen.add(fp);
      if (!fs.existsSync(fp)) { skipped++; continue; }
      const st = fs.statSync(fp);
      if (!st.isFile() || st.size === 0 || st.size > 50 * 1024 * 1024) { skipped++; continue; }
      const prev = (state.artifacts || {})[fp];
      if (prev && prev.mtime === st.mtimeMs && prev.size === st.size && !args['force-files']) { newArtState[fp] = prev; skipped++; continue; }
      const buf = fs.readFileSync(fp);
      const sha = crypto.createHash('sha256').update(buf).digest('hex');
      if (args['dry-run']) { uploaded++; continue; }
      const r = await fetchRetry(`${SERVER}/api/files`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${TOKEN}`,
          'Content-Type': a.mimeType || 'application/octet-stream',
          'X-Device': encodeURIComponent(DEVICE),
          'X-Session-Id': sessionId,
          'X-File-Name': encodeURIComponent(a.name || path.basename(fp)),
          'X-Op-Id': `wb2-file-${row.id}-${sha.slice(0, 16)}`,
          'X-File-Id': `wbf-${row.id}-${hash8(fp)}`,
          'X-File-Ts': String(Number(a.updatedAt) || Date.now()),
        },
        body: buf,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      newArtState[fp] = { mtime: st.mtimeMs, size: st.size, ts: Date.now() };
      uploaded++;
    } catch (e) {
      vlog(`     ⚠️ 文件同步失败 ${a?.name || ''}: ${e.message}`);
    }
  }
  return { uploaded, skipped };
}

/** 等待服务端就绪（部署后重放快照需要时间） */
async function waitReady(maxMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    try {
      const r = await fetch(`${SERVER}/api/status`, { headers: { Authorization: `Bearer ${TOKEN}` } });
      if (r.ok || r.status === 401 || r.status === 403) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

/* ---------------- 组装并推送 ---------------- */
let scanned = 0, pushed = 0, skipped = 0, errors = 0, sessionsDone = 0, filesUploaded = 0, filesSkipped = 0;
const BATCH = 300;

async function pushBatch(ops) {
  if (!ops.length) return;
  if (args['dry-run']) { log(`   [dry-run] 将推送 ${ops.length} 条`); return; }
  const r = await fetchRetry(`${SERVER}/api/sync/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}`, 'X-Device': encodeURIComponent(DEVICE) },
    body: JSON.stringify({ device: DEVICE, ops }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text().catch(() => '')}`);
  const d = await r.json();
  pushed += d.applied || 0;
  skipped += d.skipped || 0;
  if (d.errors?.length) errors += d.errors.length;
}

if (!(await waitReady())) {
  console.error('服务端未就绪（60 秒超时），请检查 NAS/网络后重试');
  process.exit(1);
}

for (const row of rows) {
  const file = transcripts.get(row.id);
  if (!file) { vlog(`跳过（无正文文件）: ${row.id}`); continue; }

  // 文件级缓存：mtime+size 未变则跳过
  let st;
  try { st = fs.statSync(file); } catch { continue; }
  const cacheKey = path.basename(file);
  const prev = (state.files || {})[cacheKey];
  if (!args.force && !args.session && prev && prev.mtime === st.mtimeMs && prev.size === st.size) {
    newState[cacheKey] = prev;
    continue;
  }
  newState[cacheKey] = { mtime: st.mtimeMs, size: st.size, ts: Date.now() };
  scanned++;

  const msgs = parseTranscript(file);
  const title = (row.custom_title || row.title || '未命名会话').toString();
  const project = path.basename(String(row.cwd || '')) || 'WorkBuddy';
  const firstUser = msgs.find((m) => m.role === 'user');
  const summary = firstUser ? firstUser.text.replace(/\s+/g, ' ').slice(0, 180) : '';
  const space = spaceName(row.cwd);
  const tags = ['WorkBuddy', space];
  if (row.mode && row.mode !== 'craft') tags.push(row.mode);
  const sessionId = `wb-${row.id}`;

  const ops = [{
    // 元数据哈希进 op_id：标题/摘要/更新时间/空间变化时自动补推
    op_id: `wb2-sess-${row.id}-${hash8(`${title}|${row.updated_at}|${summary}|${space}`)}`,
    device: DEVICE, entity: 'session', id: sessionId, ts: Number(row.updated_at) || Date.now(),
    data: {
      title, tags, summary, space,
      source: `workbuddy:${project}`,
      status: row.status === 'working' ? 'active' : (row.status || 'active'),
      created_at: Number(row.created_at) || Date.now(),
    },
  }];

  msgs.forEach((m, i) => {
    ops.push({
      // 文本+时间戳哈希进 op_id：编辑会补推新版本，时间戳修正也会重放（同 id upsert）
      op_id: `wb3-msg-${row.id}-${m.id}-${hash8(m.text + '|' + m.ts)}`,
      device: DEVICE, entity: 'message', id: `wbmsg-${m.id}`, ts: m.ts,
      data: { session_id: sessionId, seq_in_session: i + 1, role: m.role, content: m.text, meta: { wb_session: row.id } },
    });
  });

  try {
    for (let i = 0; i < ops.length; i += BATCH) await pushBatch(ops.slice(i, i + BATCH));
    // 产物文件同步（agent 生成的文件/文档）
    const af = await syncArtifacts(row, sessionId);
    filesUploaded += af.uploaded;
    filesSkipped += af.skipped;
    sessionsDone++;
    if (args.verbose && !args.quiet) log(`  ✓ ${title}（${msgs.length} 条消息${af.uploaded ? `，${af.uploaded} 个文件` : ''}）`);
  } catch (e) {
    errors++;
    delete newState[cacheKey]; // 失败不缓存，下次运行重试
    log(`  ✗ ${title}: ${e.message}${e.cause ? ` (cause: ${e.cause.code || e.cause.message || e.cause})` : ''}`);
  }
}

fs.mkdirSync(CFG_DIR, { recursive: true });
fs.writeFileSync(STATE_FILE, JSON.stringify({ last_run: Date.now(), files: newState, artifacts: newArtState }, null, 2));

if (!args.quiet) {
  console.log(`\n✅ 同步完成：扫描 ${scanned} 个会话文件，处理 ${sessionsDone} 个会话`);
  console.log(`   新应用 ${pushed} 条 · 已存在跳过 ${skipped} 条 · 错误 ${errors} 条`);
  console.log(`   文件上传 ${filesUploaded} 个 · 跳过 ${filesSkipped} 个`);
}

/* ---------------- watch 常驻模式 ---------------- */
if (args.watch) {
  const interval = Math.max(60, Number(args.interval) || 300);
  console.log(`[watch] 常驻同步已启动：每 ${interval} 秒增量同步一次（Ctrl+C 退出）`);
  setInterval(() => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--quiet'], { stdio: 'inherit' });
    child.on('exit', (code) => {
      if (code !== 0) console.error(`[watch] ${new Date().toLocaleTimeString()} 同步异常 exit=${code}`);
    });
  }, interval * 1000);
}
