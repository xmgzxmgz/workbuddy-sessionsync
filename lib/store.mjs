// lib/store.mjs — 操作日志 + 内存状态 + 快照 + 内容寻址文件存储
//
// 事实来源：data/oplog.jsonl（追加式，全局单调 seq）
// 内存状态与倒排索引由日志重放得出；snapshot.json 仅用于启动加速。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SearchIndex } from './search.mjs';
import { uuid, now } from './util.mjs';

const ENTITIES = new Set(['session', 'message', 'memory', 'file']);
const STATE_KEY = { session: 'sessions', message: 'messages', memory: 'memories', file: 'files' };
const SNAPSHOT_EVERY = 2000; // 大批量导入时降低快照频率，避免频繁全量序列化拖慢写入

export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.oplogPath = path.join(dataDir, 'oplog.jsonl');
    this.snapshotPath = path.join(dataDir, 'snapshot.json');
    this.devicesPath = path.join(dataDir, 'devices.json');
    this.filesDir = path.join(dataDir, 'files');

    this.state = {
      sessions: new Map(),
      messages: new Map(),
      memories: new Map(),
      files: new Map(),
      messagesBySession: new Map(), // session_id -> Set<message_id>
    };
    this.devices = new Map(); // name -> {name, platform, last_sync_seq, last_seen, created_at}
    this.index = new SearchIndex();
    this.appliedOpIds = new Set();
    this.maxSeq = 0;
    this.opCount = 0;
    this.opsSinceSnapshot = 0;
    this.subscribers = new Set(); // fn(op)
  }

  /* ---------------------------------------------------------- 启动 */
  init() {
    fs.mkdirSync(this.filesDir, { recursive: true });
    // 1) 快照加速
    if (fs.existsSync(this.snapshotPath)) {
      try {
        this.#loadSnapshot(fs.readFileSync(this.snapshotPath, 'utf8'));
      } catch (e) {
        console.error('[store] 快照损坏，改为全量重放日志:', e.message);
      }
    }
    // 2) 重放快照之后的日志尾部
    if (fs.existsSync(this.oplogPath)) {
      const text = fs.readFileSync(this.oplogPath, 'utf8');
      const lines = text.split('\n');
      for (const line of lines) {
        const s = line.trim();
        if (!s) continue;
        let op;
        try {
          op = JSON.parse(s);
        } catch {
          console.error('[store] 跳过损坏日志行');
          continue;
        }
        if (op.seq > this.maxSeq) this.#applyRecorded(op);
      }
    }
    this.opFd = fs.openSync(this.oplogPath, 'a');
    console.log(
      `[store] 就绪：seq=${this.maxSeq} ops=${this.opCount} sessions=${this.state.sessions.size} messages=${this.state.messages.size}`
    );
  }

  #loadSnapshot(text) {
    const snap = JSON.parse(text);
    this.maxSeq = snap.maxSeq || 0;
    this.opCount = snap.opCount || 0;
    this.appliedOpIds = new Set(snap.appliedOpIds || []);
    for (const s of snap.sessions || []) this.state.sessions.set(s.id, s);
    for (const m of snap.messages || []) this.state.messages.set(m.id, m);
    for (const m of snap.memories || []) this.state.memories.set(m.id, m);
    for (const f of snap.files || []) this.state.files.set(f.id, f);
    this.#rebuildDerived();
    this.devices = new Map(Object.entries(snap.devices || {}));
  }

  #rebuildDerived() {
    this.state.messagesBySession = new Map();
    const reindex = (e, type, fields) => this.index.indexFields(`${type}:${e.id}`, fields);
    for (const s of this.state.sessions.values())
      reindex(s, 'session', [
        { text: s.title, weight: 3 },
        { text: (s.tags || []).join(' '), weight: 3 },
        { text: s.summary, weight: 2 },
        { text: s.space || '', weight: 2 },
      ]);
    for (const m of this.state.messages.values()) {
      this.#linkMessage(m);
      reindex(m, 'message', [{ text: m.content, weight: 1 }]);
    }
    for (const m of this.state.memories.values())
      reindex(m, 'memory', [
        { text: m.key, weight: 3 },
        { text: m.content, weight: 2 },
      ]);
    for (const f of this.state.files.values()) reindex(f, 'file', [{ text: f.name, weight: 2 }]);
  }

  #linkMessage(m) {
    let set = this.state.messagesBySession.get(m.session_id);
    if (!set) {
      set = new Set();
      this.state.messagesBySession.set(m.session_id, set);
    }
    set.add(m.id);
  }

  /* ---------------------------------------------------------- 操作应用 */
  /** 应用一条已落盘的历史 op（重放路径：不追加、不广播、不查幂等） */
  #applyRecorded(op) {
    this.#applyToState(op);
    this.maxSeq = op.seq;
    this.opCount++;
  }

  /**
   * 提交一条新操作（权威路径）：
   * 幂等（op_id 去重）→ 分配 seq → 应用到状态与索引 → 追加日志 → 广播 → 触发快照
   * 返回 {applied: false} 表示重复 op_id 被跳过。
   */
  commit(rawOp) {
    const op = {
      op_id: String(rawOp.op_id || uuid()),
      device: String(rawOp.device || 'server'),
      action: rawOp.action === 'delete' ? 'delete' : 'upsert',
      entity: rawOp.entity,
      id: String(rawOp.id || uuid()),
      ts: Number(rawOp.ts) || now(),
      data: rawOp.data || {},
    };
    if (!ENTITIES.has(op.entity)) throw new Error(`未知实体类型: ${op.entity}`);
    if (this.appliedOpIds.has(op.op_id)) return { applied: false, op: null };

    op.seq = ++this.maxSeq;
    this.#applyToState(op);
    this.appliedOpIds.add(op.op_id);
    this.opCount++;

    fs.appendFileSync(this.opFd, JSON.stringify(op) + '\n');

    for (const fn of this.subscribers) {
      try {
        fn(op);
      } catch {
        /* 订阅方异常不影响主流程 */
      }
    }

    if (++this.opsSinceSnapshot >= SNAPSHOT_EVERY) {
      this.opsSinceSnapshot = 0;
      this.#writeSnapshot();
    }
    return { applied: true, op };
  }

  /** 将 op 应用到内存状态（含级联删除、索引维护） */
  #applyToState(op) {
    const { entity, id, action, data } = op;
    const store = this.state[STATE_KEY[entity]];

    if (action === 'delete') {
      // 会话删除级联删除其消息 / 记忆 / 文件；级联 id 记录进 op 以保证重放一致性
      if (entity === 'session' && !op.dependents) {
        op.dependents = {
          messages: [...(this.state.messagesBySession.get(id) || [])],
          memories: [...this.state.memories.values()].filter((m) => m.session_id === id).map((m) => m.id),
          files: [...this.state.files.values()].filter((f) => f.session_id === id).map((f) => f.id),
        };
      }
      if (entity === 'session' && op.dependents) {
        for (const mid of op.dependents.messages || []) this.#deleteEntity('message', mid);
        for (const mid of op.dependents.memories || []) this.#deleteEntity('memory', mid);
        for (const fid of op.dependents.files || []) this.#deleteEntity('file', fid);
        let set = this.state.messagesBySession.get(id);
        if (set) set.clear();
      }
      this.#deleteEntity(entity, id);
      return;
    }

    // upsert：合并默认字段（data 视为权威字段集，缺失字段取默认）
    let cur = store.get(id) || {};
    const next = this.#normalize(entity, id, data, cur, op.ts);
    store.set(id, next);

    if (entity === 'message') this.#linkMessage(next);
    // 索引
    if (entity === 'session')
      this.index.indexFields(`session:${id}`, [
        { text: next.title, weight: 3 },
        { text: (next.tags || []).join(' '), weight: 3 },
        { text: next.summary, weight: 2 },
        { text: next.space || '', weight: 2 },
      ]);
    else if (entity === 'message')
      this.index.indexFields(`message:${id}`, [{ text: next.content, weight: 1 }]);
    else if (entity === 'memory')
      this.index.indexFields(`memory:${id}`, [
        { text: next.key, weight: 3 },
        { text: next.content, weight: 2 },
      ]);
    else if (entity === 'file') this.index.indexFields(`file:${id}`, [{ text: next.name, weight: 2 }]);
  }

  #deleteEntity(entity, id) {
    const store = this.state[STATE_KEY[entity]];
    if (!store.has(id)) return;
    store.delete(id);
    this.index.remove(`${entity}:${id}`);
    if (entity === 'message') {
      const m = this.state.messagesBySession;
      for (const set of m.values()) set.delete(id);
    }
  }

  #normalize(entity, id, data, cur, opTs) {
    // 关键：data.ts > op.ts > cur.ts，重放时可以修正历史时间戳
    const ts = Number(data.ts) || Number(opTs) || Number(cur.ts) || now();
    if (entity === 'session')
      return {
        id,
        title: String(data.title ?? cur.title ?? '未命名会话'),
        tags: Array.isArray(data.tags) ? data.tags.map(String) : cur.tags || [],
        summary: String(data.summary ?? cur.summary ?? ''),
        source: String(data.source ?? cur.source ?? ''),
        space: String(data.space ?? cur.space ?? ''),
        status: String(data.status ?? cur.status ?? 'active'),
        created_at: Number(data.created_at) || Number(cur.created_at) || ts,
        updated_at: Number(data.updated_at) || ts,
      };
    if (entity === 'message')
      return {
        id,
        session_id: String(data.session_id ?? cur.session_id ?? ''),
        seq_in_session: Number(data.seq_in_session ?? cur.seq_in_session ?? 0),
        role: String(data.role ?? cur.role ?? 'user'),
        content: String(data.content ?? cur.content ?? ''),
        ts,
        meta: data.meta && typeof data.meta === 'object' ? data.meta : cur.meta || {},
      };
    if (entity === 'memory')
      return {
        id,
        scope: data.scope === 'session' || cur.scope === 'session' ? 'session' : 'global',
        session_id: data.session_id != null ? String(data.session_id) : cur.session_id || null,
        key: String(data.key ?? cur.key ?? ''),
        content: String(data.content ?? cur.content ?? ''),
        created_at: Number(data.created_at) || Number(cur.created_at) || ts,
        updated_at: ts,
      };
    // file
    return {
      id,
      session_id: String(data.session_id ?? cur.session_id ?? ''),
      name: String(data.name ?? cur.name ?? 'file'),
      mime: String(data.mime ?? cur.mime ?? 'application/octet-stream'),
      size: Number(data.size ?? cur.size ?? 0),
      sha256: String(data.sha256 ?? cur.sha256 ?? ''),
      ts,
    };
  }

  /* ---------------------------------------------------------- 查询辅助 */
  sessionMessages(sessionId) {
    const ids = this.state.messagesBySession.get(sessionId) || new Set();
    return [...ids]
      .map((id) => this.state.messages.get(id))
      .filter(Boolean)
      .sort((a, b) => (a.seq_in_session - b.seq_in_session) || (a.ts - b.ts));
  }

  sessionDerived(s) {
    // 动态计算 updated_at / msg_count / 时间跨度
    const msgs = this.sessionMessages(s.id);
    const lastTs = msgs.length ? msgs[msgs.length - 1].ts : 0;
    return {
      ...s,
      msg_count: msgs.length,
      updated_at: Math.max(s.updated_at || 0, lastTs),
      first_ts: msgs.length ? msgs[0].ts : s.created_at,
    };
  }

  pullOps(sinceSeq, limit = 2000) {
    const out = [];
    // 从日志流式读取（个人规模下可直接扫描全文件；快照之前的旧 op 也需可拉取）
    const text = fs.readFileSync(this.oplogPath, 'utf8');
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let op;
      try {
        op = JSON.parse(t);
      } catch {
        continue;
      }
      if (op.seq > sinceSeq) {
        out.push(op);
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  /** 只读 oplog 尾部，取最近 n 条操作（动态流用，避免全量扫描） */
  tailOps(n = 120) {
    try {
      const st = fs.statSync(this.oplogPath);
      const readBytes = Math.min(st.size, 512 * 1024);
      const buf = Buffer.alloc(readBytes);
      const fd = fs.openSync(this.oplogPath, 'r');
      fs.readSync(fd, buf, 0, readBytes, st.size - readBytes);
      fs.closeSync(fd);
      const lines = buf.toString('utf8').split('\n');
      if (readBytes < st.size) lines.shift(); // 丢掉可能被截断的首行
      const ops = [];
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        try { ops.push(JSON.parse(t)); } catch {}
      }
      return ops.slice(-n);
    } catch {
      return [];
    }
  }

  /* ---------------------------------------------------------- 文件内容 */
  saveFileContent(buf) {
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const p = path.join(this.filesDir, sha256);
    if (!fs.existsSync(p)) fs.writeFileSync(p, buf);
    return { sha256, size: buf.length };
  }

  fileContentPath(sha256) {
    const safe = String(sha256).replace(/[^a-f0-9]/gi, '');
    const p = path.join(this.filesDir, safe);
    return fs.existsSync(p) ? p : null;
  }

  /* ---------------------------------------------------------- 设备登记 */
  touchDevice(name, platform, syncSeq) {
    if (!name) return;
    const cur = this.devices.get(name) || { name, platform: '', last_sync_seq: 0, last_seen: 0, created_at: now() };
    if (platform) cur.platform = platform;
    if (Number.isFinite(syncSeq) && syncSeq > (cur.last_sync_seq || 0)) cur.last_sync_seq = syncSeq;
    cur.last_seen = now();
    this.devices.set(name, cur);
    this.#persistDevices();
  }

  #persistTimer = null;
  #persistDevices() {
    clearTimeout(this.#persistTimer);
    this.#persistTimer = setTimeout(() => {
      try {
        fs.writeFileSync(this.devicesPath, JSON.stringify(Object.fromEntries(this.devices), null, 2));
      } catch (e) {
        console.error('[store] 设备登记写入失败:', e.message);
      }
    }, 500);
  }

  /* ---------------------------------------------------------- 订阅 / 快照 */
  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  #writeSnapshot() {
    const snap = {
      maxSeq: this.maxSeq,
      opCount: this.opCount,
      appliedOpIds: [...this.appliedOpIds],
      sessions: [...this.state.sessions.values()],
      messages: [...this.state.messages.values()],
      memories: [...this.state.memories.values()],
      files: [...this.state.files.values()],
      devices: Object.fromEntries(this.devices),
      written_at: now(),
    };
    const tmp = this.snapshotPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(snap));
    fs.renameSync(tmp, this.snapshotPath);
  }

  shutdown() {
    try {
      this.#writeSnapshot();
    } catch (e) {
      console.error('[store] 退出快照失败:', e.message);
    }
    try {
      fs.closeSync(this.opFd);
    } catch {}
  }

  status() {
    return {
      max_seq: this.maxSeq,
      op_count: this.opCount,
      sessions: this.state.sessions.size,
      messages: this.state.messages.size,
      memories: [...this.state.memories.values()].filter((m) => m.scope === 'global').length,
      files: this.state.files.size,
      devices: [...this.devices.values()].sort((a, b) => (b.last_seen || 0) - (a.last_seen || 0)),
    };
  }
}
