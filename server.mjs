// server.mjs — SessionSync HTTP 服务（零依赖，Node >= 18）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store } from './lib/store.mjs';
import { tokenize } from './lib/search.mjs';
import { readBody, parseJson, safeEqual, toTs, json, snippet, uuid, now, fmtTs } from './lib/util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8787;
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');

const store = new Store(DATA_DIR);
store.init();

/* ---------------------------------------------------------- 令牌管理 */
const tokensPath = path.join(DATA_DIR, 'tokens.json');

function loadTokens() {
  try {
    return JSON.parse(fs.readFileSync(tokensPath, 'utf8'));
  } catch {
    return [];
  }
}

function saveTokens(list) {
  fs.writeFileSync(tokensPath, JSON.stringify(list, null, 2));
}

let tokens = loadTokens();
if (process.env.ACCESS_TOKEN) {
  if (!tokens.some((t) => safeEqual(t.token, process.env.ACCESS_TOKEN))) {
    tokens.push({ token: process.env.ACCESS_TOKEN, name: 'env-master', created_at: now() });
    saveTokens(tokens);
  }
}
if (tokens.length === 0) {
  const t = crypto.randomBytes(24).toString('base64url');
  tokens.push({ token: t, name: 'admin', created_at: now() });
  saveTokens(tokens);
  const hint = path.join(DATA_DIR, 'initial-token.txt');
  fs.writeFileSync(hint, t + '\n');
  console.log('='.repeat(56));
  console.log('首次启动：已生成管理员访问令牌（已存至 ' + hint + '）');
  console.log('TOKEN: ' + t);
  console.log('='.repeat(56));
}

function checkAuth(req, urlObj) {
  const h = req.headers['authorization'] || '';
  const bearer = h.startsWith('Bearer ') ? h.slice(7) : null;
  const qToken = urlObj.searchParams.get('token');
  const cand = bearer || qToken;
  if (!cand) return false;
  return tokens.some((t) => safeEqual(t.token, cand));
}

/* ---------------------------------------------------------- multipart 解析 */
function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) throw new Error('缺少 multipart boundary');
  const boundary = Buffer.from('--' + (m[1] || m[2]));
  const fields = {};
  const files = [];
  let pos = buf.indexOf(boundary);
  while (pos >= 0) {
    const start = pos + boundary.length;
    // 结束标记 --boundary--
    if (buf.slice(start, start + 2).toString() === '--') break;
    const headEnd = buf.indexOf('\r\n\r\n', start);
    if (headEnd < 0) break;
    const next = buf.indexOf(boundary, headEnd);
    if (next < 0) break;
    const headText = buf.slice(start, headEnd).toString('utf8');
    const body = buf.slice(headEnd + 4, next - 2); // 去掉末尾 \r\n
    const disp = /content-disposition:\s*form-data;([^\r\n]*)/i.exec(headText);
    if (disp) {
      const nameM = /name="([^"]*)"/i.exec(disp[1]);
      const fileM = /filename="([^"]*)"/i.exec(disp[1]);
      const typeM = /content-type:\s*([^\r\n]+)/i.exec(headText);
      if (fileM) {
        files.push({
          field: nameM ? nameM[1] : 'file',
          filename: fileM[1] || 'file',
          contentType: typeM ? typeM[1].trim() : 'application/octet-stream',
          data: body,
        });
      } else if (nameM) {
        fields[nameM[1]] = body.toString('utf8');
      }
    }
    pos = next;
  }
  return { fields, files };
}

/* ---------------------------------------------------------- 工具 */
function safeDecode(v) {
  if (!v) return undefined;
  try {
    return decodeURIComponent(v);
  } catch {
    return v; // 非 percent-encoded（如 ASCII 主机名）原样返回
  }
}
function deviceOf(req) {
  return {
    name: safeDecode(req.headers['x-device']),
    platform: safeDecode(req.headers['x-device-platform']),
  };
}

function collectQ(urlObj) {
  const q = (urlObj.searchParams.get('q') || '').trim();
  return q ? [...new Set(tokenize(q))] : [];
}

/** 解析时间参数；日期-only 的 to 参数取当天结束时刻（23:59:59.999） */
function tsParam(urlObj, name, endOfDay = false) {
  const v = (urlObj.searchParams.get(name) || '').trim();
  if (!v) return null;
  let t = toTs(v);
  if (t != null && endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(v)) t += 86399999;
  return t;
}

/* ---------------------------------------------------------- 检索 */
function searchEntities(urlObj) {
  const q = (urlObj.searchParams.get('q') || '').trim();
  const type = urlObj.searchParams.get('type') || '';
  const tag = (urlObj.searchParams.get('tag') || '').trim();
  const space = (urlObj.searchParams.get('space') || '').trim();
  const sessionId = urlObj.searchParams.get('session') || '';
  const role = urlObj.searchParams.get('role') || '';
  const from = tsParam(urlObj, 'from');
  const to = tsParam(urlObj, 'to', true);
  const limit = Math.min(Number(urlObj.searchParams.get('limit')) || 20, 200);
  const offset = Number(urlObj.searchParams.get('offset')) || 0;
  const qTokens = collectQ(urlObj);

  // 标签 → 限定会话集合
  let tagSessionIds = null;
  if (tag) {
    tagSessionIds = new Set();
    for (const s of store.state.sessions.values())
      if ((s.tags || []).includes(tag)) tagSessionIds.add(s.id);
  }
  // 空间 → 限定会话集合
  let spaceSessionIds = null;
  if (space) {
    spaceSessionIds = new Set();
    for (const s of store.state.sessions.values())
      if ((s.space || '未分类') === space) spaceSessionIds.add(s.id);
  }

  const inRange = (ts) => (from == null || ts >= from) && (to == null || ts <= to);

  // 无关键词：浏览模式，返回满足过滤条件的会话 + （可选）消息
  if (!q) {
    const items = [];
    for (const s of store.state.sessions.values()) {
      const d = store.sessionDerived(s);
      if (tag && !(s.tags || []).includes(tag)) continue;
      if (sessionId && s.id !== sessionId) continue;
      if (!inRange(d.updated_at)) continue;
      items.push({ type: 'session', id: s.id, session_id: s.id, title: s.title, ts: d.updated_at, snippet: s.summary || '', tags: s.tags });
    }
    items.sort((a, b) => b.ts - a.ts);
    return { mode: 'browse', total: items.length, items: items.slice(offset, offset + limit), q_tokens: [] };
  }

  const hits = store.index.query(q); // [key, score] 降序
  const items = [];
  const seenSessions = new Set();
  for (const [key, score] of hits) {
    const [type_, id] = key.split(':');
    if (type && type_ !== type) continue;
    let item = null;
    if (type_ === 'session') {
      const s = store.state.sessions.get(id);
      if (!s) continue;
      const d = store.sessionDerived(s);
      if (tagSessionIds && !tagSessionIds.has(s.id)) continue;
      if (spaceSessionIds && !spaceSessionIds.has(s.id)) continue;
      if (sessionId && s.id !== sessionId) continue;
      if (!inRange(d.updated_at)) continue;
      item = { type: 'session', id: s.id, session_id: s.id, title: s.title, ts: d.updated_at, snippet: snippet(s.summary || s.title, qTokens), tags: s.tags, space: s.space };
    } else if (type_ === 'message') {
      const msg = store.state.messages.get(id);
      if (!msg) continue;
      if (role && msg.role !== role) continue;
      if (sessionId && msg.session_id !== sessionId) continue;
      if (tagSessionIds && !tagSessionIds.has(msg.session_id)) continue;
      if (spaceSessionIds && !spaceSessionIds.has(msg.session_id)) continue;
      if (!inRange(msg.ts)) continue;
      const s = store.state.sessions.get(msg.session_id);
      item = {
        type: 'message',
        id: msg.id,
        session_id: msg.session_id,
        session_title: s ? s.title : '',
        role: msg.role,
        title: s ? s.title : '',
        ts: msg.ts,
        snippet: snippet(msg.content, qTokens),
        tags: s ? s.tags : [],
      };
    } else if (type_ === 'memory') {
      const mem = store.state.memories.get(id);
      if (!mem) continue;
      if (sessionId && mem.session_id !== sessionId) continue;
      if (spaceSessionIds && (!mem.session_id || !spaceSessionIds.has(mem.session_id))) continue;
      if (!inRange(mem.updated_at)) continue;
      item = { type: 'memory', id: mem.id, session_id: mem.session_id, title: mem.key, ts: mem.updated_at, snippet: snippet(mem.content, qTokens) };
    } else if (type_ === 'file') {
      const f = store.state.files.get(id);
      if (!f) continue;
      if (sessionId && f.session_id !== sessionId) continue;
      if (spaceSessionIds && (!f.session_id || !spaceSessionIds.has(f.session_id))) continue;
      if (!inRange(f.ts)) continue;
      item = { type: 'file', id: f.id, session_id: f.session_id, title: f.name, ts: f.ts, snippet: `${f.name} · ${(f.size / 1024).toFixed(1)} KB` };
    }
    if (item) {
      item.score = Math.round(score * 100) / 100;
      items.push(item);
      if (item.session_id) seenSessions.add(item.session_id);
    }
  }
  return { mode: 'search', total: items.length, items: items.slice(offset, offset + limit), q_tokens: qTokens, matched_sessions: seenSessions.size };
}

/* ---------------------------------------------------------- 会话上下文包 */
function contextBundle(sessionId, full) {
  const s = store.state.sessions.get(sessionId);
  if (!s) return null;
  const msgs = store.sessionMessages(sessionId);
  const take = full ? msgs : msgs.slice(-50);
  return {
    session: store.sessionDerived(s),
    messages: take,
    truncated: take.length < msgs.length,
    total_messages: msgs.length,
    memories: [...store.state.memories.values()].filter((m) => m.session_id === sessionId || m.scope === 'global'),
    files: [...store.state.files.values()].filter((f) => f.session_id === sessionId),
    stats: {
      message_count: msgs.length,
      first_ts: msgs.length ? msgs[0].ts : s.created_at,
      last_ts: msgs.length ? msgs[msgs.length - 1].ts : s.updated_at,
      span_ms: msgs.length ? msgs[msgs.length - 1].ts - msgs[0].ts : 0,
    },
  };
}

/* ---------------------------------------------------------- SSE 在线端注册表 */
const sseClients = new Map(); // clientId -> {name, since}
let sseClientSeq = 0;

function presencePayload() {
  const clients = [...sseClients.values()].map((c) => ({ name: c.name, since: c.since }));
  const unique = new Set(clients.map((c) => c.name));
  return { online: unique.size, connections: clients.length, clients, server_time: now() };
}

/** 在线端数（按设备名去重） */
function onlineDeviceCount() {
  return new Set([...sseClients.values()].map((c) => c.name)).size;
}

function sseBroadcast(event, dataObj) {
  const line = `event: ${event}\ndata: ${JSON.stringify(dataObj)}\n\n`;
  for (const c of sseClients.values()) {
    try {
      c.res.write(line);
    } catch {}
  }
}

/* ---------------------------------------------------------- 路由 */
const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = urlObj.pathname;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,X-Device,X-Device-Platform');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  try {
    /* ------- 静态：控制台 ------- */
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
      return res.end(html);
    }
    if (p === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }

    /* ------- 认证 ------- */
    const isAuthed = checkAuth(req, urlObj);
    if (!isAuthed) {
      return json(res, 401, { error: 'unauthorized', message: '缺少或无效的访问令牌' });
    }
    const dev = deviceOf(req);
    if (dev.name) store.touchDevice(dev.name, dev.platform);

    /* ------- 令牌管理 ------- */
    if (req.method === 'POST' && p === '/api/auth/token') {
      const body = parseJson(await readBody(req)) || {};
      const name = String(body.name || 'device').slice(0, 40);
      const token = crypto.randomBytes(24).toString('base64url');
      tokens.push({ token, name, created_at: now() });
      saveTokens(tokens);
      return json(res, 200, { token, name });
    }

    /* ------- 状态 ------- */
    if (req.method === 'GET' && p === '/api/status') {
      return json(res, 200, {
        ...store.status(),
        online_clients: onlineDeviceCount(),
        online_names: [...new Set([...sseClients.values()].map((c) => c.name))],
        server_time: now(),
        uptime_ms: process.uptime() * 1000,
      });
    }

    /* ------- 最近活动动态（只读日志尾部，避免全量扫描） ------- */
    if (req.method === 'GET' && p === '/api/activity') {
      const limit = Math.min(Number(urlObj.searchParams.get('limit')) || 30, 200);
      const ops = store.tailOps(limit * 4);
      const items = ops
        .slice(-limit)
        .reverse()
        .map((op) => ({
          seq: op.seq,
          ts: op.ts,
          device: op.device,
          action: op.action,
          entity: op.entity,
          id: op.id,
          brief:
            op.entity === 'session' ? op.data?.title :
            op.entity === 'message' ? String(op.data?.content || '').slice(0, 60) :
            op.entity === 'memory' ? op.data?.key || String(op.data?.content || '').slice(0, 40) :
            op.data?.name || '',
        }));
      return json(res, 200, { items, max_seq: store.maxSeq });
    }

    /* ------- 全量导出 ------- */
    if (req.method === 'GET' && p === '/api/export') {
      return json(res, 200, {
        exported_at: now(),
        sessions: [...store.state.sessions.values()],
        messages: [...store.state.messages.values()],
        memories: [...store.state.memories.values()],
        files: [...store.state.files.values()],
      });
    }

    /* ------- 检索 ------- */
    if (req.method === 'GET' && p === '/api/search') {
      return json(res, 200, searchEntities(urlObj));
    }

    /* ------- 空间列表（对齐 WorkBuddy 侧边栏空间） ------- */
    if (req.method === 'GET' && p === '/api/spaces') {
      const agg = new Map();
      for (const s of store.state.sessions.values()) {
        const name = s.space || '未分类';
        const d = store.sessionDerived(s);
        const cur = agg.get(name) || { name, sessions: 0, messages: 0, last_ts: 0 };
        cur.sessions += 1;
        cur.messages += d.msg_count;
        cur.last_ts = Math.max(cur.last_ts, d.updated_at);
        agg.set(name, cur);
      }
      const items = [...agg.values()].sort((a, b) => b.last_ts - a.last_ts);
      return json(res, 200, { total: items.length, items });
    }

    /* ------- 会话集合 ------- */
    if (p === '/api/sessions') {
      if (req.method === 'GET') {
        const q = (urlObj.searchParams.get('q') || '').trim().toLowerCase();
        const tag = (urlObj.searchParams.get('tag') || '').trim();
        const space = (urlObj.searchParams.get('space') || '').trim();
        const from = tsParam(urlObj, 'from');
        const to = tsParam(urlObj, 'to', true);
        const limit = Math.min(Number(urlObj.searchParams.get('limit')) || 50, 500);
        const offset = Number(urlObj.searchParams.get('offset')) || 0;
        let list = [...store.state.sessions.values()].map((s) => store.sessionDerived(s));
        if (q)
          list = list.filter((s) =>
            (s.title || '').toLowerCase().includes(q) ||
            (s.summary || '').toLowerCase().includes(q) ||
            (s.tags || []).some((t) => t.toLowerCase().includes(q))
          );
        if (tag) list = list.filter((s) => (s.tags || []).includes(tag));
        if (space) list = list.filter((s) => (s.space || '未分类') === space);
        if (from != null) list = list.filter((s) => s.updated_at >= from);
        if (to != null) list = list.filter((s) => s.updated_at <= to);
        list.sort((a, b) => b.updated_at - a.updated_at);
        return json(res, 200, { total: list.length, items: list.slice(offset, offset + limit) });
      }
      if (req.method === 'POST') {
        const body = parseJson(await readBody(req)) || {};
        if (!body.title) return json(res, 400, { error: 'bad_request', message: 'title 必填' });
        const id = body.id || uuid();
        const { applied } = store.commit({
          op_id: body.op_id, device: dev.name, entity: 'session', id, ts: now(),
          data: { title: body.title, tags: body.tags || [], summary: body.summary || '', space: body.space || '', source: body.source || dev.name || 'api', status: body.status || 'active' },
        });
        return json(res, 201, { applied, session: store.sessionDerived(store.state.sessions.get(id)) });
      }
    }

    /* ------- 单会话 ------- */
    let m = /^\/api\/sessions\/([^/]+)$/.exec(p);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (req.method === 'GET') {
        const s = store.state.sessions.get(id);
        return s ? json(res, 200, store.sessionDerived(s)) : json(res, 404, { error: 'not_found' });
      }
      if (req.method === 'PATCH') {
        const s = store.state.sessions.get(id);
        if (!s) return json(res, 404, { error: 'not_found' });
        const body = parseJson(await readBody(req)) || {};
        const { applied } = store.commit({
          op_id: body.op_id, device: dev.name, entity: 'session', id, ts: now(),
          data: {
            title: body.title ?? s.title,
            tags: body.tags ?? s.tags,
            summary: body.summary ?? s.summary,
            source: body.source ?? s.source,
            space: body.space ?? s.space,
            status: body.status ?? s.status,
            created_at: s.created_at,
          },
        });
        return json(res, 200, { applied, session: store.sessionDerived(store.state.sessions.get(id)) });
      }
      if (req.method === 'DELETE') {
        const s = store.state.sessions.get(id);
        if (!s) return json(res, 404, { error: 'not_found' });
        store.commit({ op_id: uuid(), device: dev.name, entity: 'session', id, action: 'delete', ts: now() });
        return json(res, 200, { deleted: id });
      }
    }

    /* ------- 会话消息 ------- */
    m = /^\/api\/sessions\/([^/]+)\/messages$/.exec(p);
    if (m) {
      const sessionId = decodeURIComponent(m[1]);
      if (!store.state.sessions.has(sessionId)) return json(res, 404, { error: 'not_found', message: '会话不存在' });
      if (req.method === 'GET') {
        const since = Number(urlObj.searchParams.get('since')) || 0;
        const limit = Math.min(Number(urlObj.searchParams.get('limit')) || 1000, 5000);
        let msgs = store.sessionMessages(sessionId);
        if (since) msgs = msgs.filter((x) => x.ts > since);
        return json(res, 200, { total: msgs.length, items: msgs.slice(0, limit) });
      }
      if (req.method === 'POST') {
        const body = parseJson(await readBody(req)) || {};
        const list = Array.isArray(body) ? body : Array.isArray(body.messages) ? body.messages : [body];
        const existing = store.sessionMessages(sessionId);
        let seq = existing.reduce((a, x) => Math.max(a, x.seq_in_session), 0);
        const results = [];
        for (const item of list) {
          const content = String(item.content ?? '');
          if (!content) continue;
          const { applied, op } = store.commit({
            op_id: item.op_id, device: dev.name, entity: 'message', id: item.id, ts: Number(item.ts) || now(),
            data: {
              session_id: sessionId,
              seq_in_session: Number(item.seq_in_session) || ++seq,
              role: ['user', 'assistant', 'system', 'tool'].includes(item.role) ? item.role : 'user',
              content,
              meta: item.meta || {},
            },
          });
          results.push({ applied, id: op ? op.id : item.id, op_id: op ? op.op_id : item.op_id });
        }
        return json(res, 201, { results, count: results.filter((r) => r.applied).length });
      }
    }

    /* ------- 上下文包 ------- */
    m = /^\/api\/sessions\/([^/]+)\/context$/.exec(p);
    if (m && req.method === 'GET') {
      const bundle = contextBundle(decodeURIComponent(m[1]), urlObj.searchParams.get('full') === '1');
      return bundle ? json(res, 200, bundle) : json(res, 404, { error: 'not_found' });
    }

    /* ------- 记忆 ------- */
    if (p === '/api/memories') {
      if (req.method === 'GET') {
        const q = (urlObj.searchParams.get('q') || '').trim().toLowerCase();
        const scope = urlObj.searchParams.get('scope') || '';
        const sessionId = urlObj.searchParams.get('session_id') || '';
        let list = [...store.state.memories.values()];
        if (scope) list = list.filter((x) => x.scope === scope);
        if (sessionId) list = list.filter((x) => x.session_id === sessionId || x.scope === 'global');
        if (q) list = list.filter((x) => (x.key || '').toLowerCase().includes(q) || (x.content || '').toLowerCase().includes(q));
        list.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
        return json(res, 200, { total: list.length, items: list });
      }
      if (req.method === 'POST') {
        const body = parseJson(await readBody(req)) || {};
        if (!body.content) return json(res, 400, { error: 'bad_request', message: 'content 必填' });
        const { applied, op } = store.commit({
          op_id: body.op_id, device: dev.name, entity: 'memory', id: body.id, ts: now(),
          data: {
            scope: body.scope === 'session' ? 'session' : 'global',
            session_id: body.session_id || null,
            key: body.key || '',
            content: body.content,
          },
        });
        return json(res, 201, { applied, memory: store.state.memories.get(op.id) });
      }
    }

    /* ------- 文件上传 ------- */
    if (req.method === 'POST' && p === '/api/files') {
      const ctype = req.headers['content-type'] || '';
      let sessionId = '';
      let filePart = null;
      let clientOpId = null;
      let clientFileId = null;
      if (ctype.includes('multipart/form-data')) {
        const { fields, files } = parseMultipart(await readBody(req, 200 * 1024 * 1024), ctype);
        sessionId = fields.session_id || '';
        clientOpId = fields.op_id || null;
        clientFileId = fields.file_id || null;
        filePart = files.find((f) => f.field === 'file') || files[0];
      } else {
        const buf = await readBody(req, 200 * 1024 * 1024);
        sessionId = req.headers['x-session-id'] || '';
        clientOpId = req.headers['x-op-id'] || null;
        clientFileId = req.headers['x-file-id'] || null;
        filePart = {
          filename: decodeURIComponent(req.headers['x-file-name'] || 'file'),
          contentType: ctype || 'application/octet-stream',
          data: buf,
        };
      }
      if (!filePart || !filePart.data?.length) return json(res, 400, { error: 'bad_request', message: '缺少文件内容' });
      const { sha256, size } = store.saveFileContent(filePart.data);
      const id = clientFileId || uuid();
      const fileTs = Number(req.headers['x-file-ts']) || now();
      store.commit({
        op_id: clientOpId || uuid(), device: dev.name, entity: 'file', id, ts: fileTs,
        data: { session_id: sessionId, name: path.basename(filePart.filename || 'file'), mime: filePart.contentType, size, sha256 },
      });
      return json(res, 201, { file: store.state.files.get(id) });
    }

    /* ------- 文件下载 ------- */
    m = /^\/files\/([a-zA-Z0-9-]+)(?:\/.*)?$/.exec(p);
    if (m && req.method === 'GET') {
      const f = store.state.files.get(m[1]);
      if (!f) return json(res, 404, { error: 'not_found' });
      const filePath = store.fileContentPath(f.sha256);
      if (!filePath) return json(res, 404, { error: 'not_found', message: '文件内容缺失' });
      const buf = fs.readFileSync(filePath);
      res.writeHead(200, {
        'Content-Type': f.mime || 'application/octet-stream',
        'Content-Length': buf.length,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      });
      return res.end(buf);
    }

    /* ------- 同步：拉取 ------- */
    if (req.method === 'GET' && p === '/api/sync/pull') {
      const since = Number(urlObj.searchParams.get('since_seq')) || 0;
      const limit = Math.min(Number(urlObj.searchParams.get('limit')) || 2000, 10000);
      const ops = store.pullOps(since, limit);
      if (dev.name) store.touchDevice(dev.name, dev.platform, ops.length ? ops[ops.length - 1].seq : since);
      return json(res, 200, { ops, max_seq: store.maxSeq, has_more: ops.length >= limit });
    }

    /* ------- 同步：推送 ------- */
    if (req.method === 'POST' && p === '/api/sync/push') {
      const body = parseJson(await readBody(req, 50 * 1024 * 1024)) || {};
      const device = String(body.device || dev.name || 'unknown');
      const opsIn = Array.isArray(body.ops) ? body.ops.slice(0, 5000) : [];
      let applied = 0;
      let skipped = 0;
      const errors = [];
      for (const raw of opsIn) {
        try {
          const r = store.commit({ ...raw, device });
          r.applied ? applied++ : skipped++;
        } catch (e) {
          errors.push({ op_id: raw?.op_id, message: e.message });
        }
      }
      if (dev.name) store.touchDevice(device, dev.platform, store.maxSeq);
      return json(res, 200, { applied, skipped, errors, max_seq: store.maxSeq });
    }

    /* ------- 同步：SSE 实时流 ------- */
    if (req.method === 'GET' && p === '/api/sync/stream') {
      const since = Number(urlObj.searchParams.get('since_seq')) || 0;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      // 注册在线端并广播 presence
      const clientId = ++sseClientSeq;
      const clientName = String(urlObj.searchParams.get('name') || dev.name || 'browser').slice(0, 40);
      sseClients.set(clientId, { name: clientName, since: now(), res });
      res.write(`event: hello\ndata: ${JSON.stringify({ max_seq: store.maxSeq, server_time: now(), ...presencePayload() })}\n\n`);
      sseBroadcast('presence', presencePayload());
      for (const op of store.pullOps(since, 500)) {
        res.write(`event: op\ndata: ${JSON.stringify(op)}\n\n`);
      }
      const unsub = store.subscribe((op) => {
        try {
          res.write(`event: op\ndata: ${JSON.stringify(op)}\n\n`);
        } catch {}
      });
      const hb = setInterval(() => {
        try {
          res.write(`: ping ${Date.now()}\n\n`);
        } catch {
          // 半开连接：心跳写失败即回收，避免在线数虚高
          clearInterval(hb);
          unsub();
          sseClients.delete(clientId);
          sseBroadcast('presence', presencePayload());
        }
      }, 25000);
      req.on('close', () => {
        unsub();
        clearInterval(hb);
        sseClients.delete(clientId);
        sseBroadcast('presence', presencePayload());
      });
      return;
    }

    return json(res, 404, { error: 'not_found', path: p });
  } catch (e) {
    const code = e.statusCode || 500;
    console.error(`[http] ${req.method} ${p} → ${code}: ${e.message}`);
    return json(res, code, { error: 'server_error', message: e.message });
  }
});

server.keepAliveTimeout = 120000; // 2 分钟，避免长间隔请求复用已回收连接
server.headersTimeout = 125000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] SessionSync 已启动: http://localhost:${PORT}`);
  console.log(`[server] 数据目录: ${DATA_DIR}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n[server] 收到 ${sig}，写快照后退出`);
    store.shutdown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
