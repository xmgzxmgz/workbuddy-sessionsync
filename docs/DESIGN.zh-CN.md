# SessionSync — 云端会话存储与同步系统

集中保存 WorkBuddy / AI 助手交互产生的全部数据：对话记录（双方消息）、生成的文件、记忆条目。支持数据持久化、跨设备访问、快速检索、会话续接、双向实时同步。

**技术形态**：零依赖 Node.js 单端口 HTTP 服务（标准库实现，无 npm 依赖），数据文件持久化，可直接部署到任意服务器 / 云主机，所有设备通过同一 URL 访问。

---

## 1. 总体架构

```
┌─────────────┐   ┌─────────────┐   ┌─────────────┐
│  设备 A      │   │  设备 B      │   │  设备 C      │
│  WorkBuddy   │   │  浏览器      │   │  sync-agent │
│  (本机)      │   │  Web 控制台  │   │  CLI        │
└──────┬──────┘   └──────┬──────┘   └──────┬──────┘
       │  HTTPS + Bearer Token（同一访问令牌体系）  │
       └────────────────┼────────────────┘
                        ▼
        ┌───────────────────────────────┐
        │   SessionSync Server (单端口)  │
        │  ┌─────────┐  ┌────────────┐  │
        │  │ REST API │  │ SSE 实时流  │  │
        │  └────┬────┘  └─────┬──────┘  │
        │       ▼             ▲         │
        │  ┌─────────────────────┐      │
        │  │  内存状态 + 倒排索引  ├──────┤ 新 op 广播
        │  └─────────┬───────────┘      │
        │            ▼                  │
        │  ┌─────────────────────┐      │
        │  │  Append-only Oplog  ├──────┘
        │  │  (data/oplog.jsonl) │
        │  └─────────┬───────────┘
        │            ▼
        │  data/snapshot.json（启动加速）
        │  data/files/<sha256>（内容寻址文件库）
        └───────────────────────────────┘
```

核心思想：**操作日志（Oplog）是唯一事实来源**。所有写入都以操作（op）形式追加到日志并赋予全局单调递增序列号 `seq`；内存状态与倒排索引由日志重放得出；快照仅是启动加速缓存。任何设备的增量同步 = 拉取 `seq > 本地水位` 的操作。

---

## 2. 数据存储结构

### 2.1 实体模型

| 实体 | 字段 | 说明 |
|---|---|---|
| **Session 会话** | `id`, `title`, `tags[]`, `summary`, `source`(来源设备/产品), `status`, `created_at`, `updated_at`, `msg_count` | 一个会话 = 一次完整交互线程；`summary` 为自动沉淀的上下文摘要，用于快速续接 |
| **Message 消息** | `id`, `session_id`, `seq_in_session`, `role`(user/assistant/system/tool), `content`, `ts`, `meta{}` | 双方逐条消息，含工具调用等元信息 |
| **Memory 记忆** | `id`, `scope`(global/session), `session_id?`, `key`, `content`, `created_at`, `updated_at` | 长期记忆条目，支持全局与会话级两层 |
| **File 文件** | `id`, `session_id`, `name`, `mime`, `size`, `sha256`, `ts` | 会话中生成的文件；内容以 sha256 内容寻址存入 `data/files/`，天然去重 |
| **Device 设备** | `id`, `name`, `platform`, `last_sync_seq`, `last_seen` | 接入设备登记，记录各自同步水位 |

### 2.2 磁盘布局

```
data/
├── oplog.jsonl      # 追加式操作日志，每行一个 JSON op（事实来源）
├── snapshot.json    # 全量状态快照（每 200 op 或优雅退出时写，加速重启）
├── tokens.json      # 访问令牌 → 设备映射
└── files/<sha256>   # 文件内容（内容寻址，自动去重）
```

### 2.3 操作日志格式

```jsonc
// data/oplog.jsonl 每行
{
  "seq": 1042,            // 服务端分配的全局单调序列号
  "ts": 1762672463000,
  "op_id": "uuid-v4",     // 客户端生成，幂等去重键（重试安全）
  "device": "macbook-workbuddy",
  "action": "upsert",     // upsert | delete
  "entity": "message",    // session | message | memory | file
  "id": "msg-uuid",
  "data": { ... }         // 实体内容；upsert 为全量字段
}
```

---

## 3. 同步机制（双向、增量、实时、幂等）

### 3.1 序列号水位

- 每个操作提交时由服务端分配全局递增 `seq`。
- 每台设备记录自己的 `last_sync_seq`（本地水位），增量拉取 `GET /api/sync/pull?since_seq=N`。
- 服务端同时登记每设备的 `Device.last_sync_seq`，控制台可查看各设备同步进度。

### 3.2 上行推送（设备 → 云端）

`POST /api/sync/push`

```jsonc
{ "device": "macbook-workbuddy", "ops": [ {op_id, action, entity, id, data}, ... ] }
```

- **幂等**：客户端为每个操作生成 UUID `op_id`；服务端已应用过的 `op_id` 直接跳过。网络重试、多设备重复上报均安全。
- **追加写入**：新操作只追加日志，不做原地修改，天然保留完整历史。

### 3.3 下行拉取（云端 → 设备）

`GET /api/sync/pull?since_seq=N` → `{ ops: [...], max_seq }`。设备本地同样以 JSONL 落盘，重放得到本地副本。

### 3.4 实时推送

`GET /api/sync/stream?since_seq=N`（SSE）。任意设备提交新 op 后，服务端向所有在线设备广播，Web 控制台与其他已连接 agent 近实时刷新 —— 满足「任一设备产生的新内容实时回传云端并同步到其他设备」。

### 3.5 冲突解决

- **消息/记忆新增**：天然交换律，追加即可。
- **实体更新**（如会话标题、记忆内容）：按 op 到达顺序应用，**最后写入胜出（LWW）**；因所有写入都经服务端统一排序分配 `seq`，不存在真并发分叉。
- **删除**：`action: "delete"` 打墓碑标记，删除信息同样随日志同步，不会在他端复活。

---

## 4. 检索方式

### 4.1 检索接口

`GET /api/search?q=关键词&from=2026-11-01&to=2026-11-09&tag=安全审计&session=<id>&role=user&limit=20&offset=0`

支持组合过滤：**关键词（消息正文/会话标题/记忆内容）× 时间范围 × 会话主题标签 × 指定会话 × 角色**，返回带高亮片段的分页结果。

### 4.2 倒排索引 + 中文分词

- 服务端维护内存倒排索引：`token → [(entity_type, id, tf)]`，随 op 应用实时更新。
- **分词策略**：CJK 文本按**二元词组（bigram）**切分（对中文子串检索效果好），ASCII 按词切分并统一小写化。
- 命中打分：词频 × 实体权重（标题 > 记忆 > 正文），返回上下文片段供前端高亮。
- 索引在启动时从 oplog/快照重放构建，无需额外索引文件。

### 4.3 快速定位

- 时间：`created_at` 范围过滤（B+ 树有序结构等价于按时间排序的状态）。
- 主题：会话 `tags` 精确匹配 + 标题关键词命中。
- 会话列表默认按 `updated_at` 倒序，最近工作一眼可见。

---

## 5. 会话续接

`GET /api/sessions/:id/context?full=1` 输出**上下文包**：

```jsonc
{
  "session":   { 标题、标签、摘要、时间、来源 },
  "messages":  [ 全部消息，按会话内顺序 ],
  "memories":  [ 该会话关联记忆 ],
  "files":     [ 文件清单（名称/大小/下载链接）],
  "stats":     { 消息数、时间跨度、最后活跃 }
}
```

Web 控制台提供**「复制续接上下文」**按钮：一键把上下文包渲染为结构化 Markdown，粘贴进新设备上的 WorkBuddy 对话即可无缝续上原会话。

---

## 6. API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/token` | 登记设备令牌（需已有令牌） |
| GET | `/api/sessions` | 会话列表（关键词/标签/时间过滤） |
| POST | `/api/sessions` | 创建会话 |
| GET | `/api/sessions/:id` | 会话详情 |
| PATCH | `/api/sessions/:id` | 更新（标题/标签/摘要） |
| GET | `/api/sessions/:id/context` | 续接上下文包 |
| GET/POST | `/api/sessions/:id/messages` | 拉取 / 追加消息 |
| GET/POST | `/api/memories` | 记忆列表 / 新增记忆 |
| POST | `/api/files` | 上传文件（multipart，关联会话） |
| GET | `/files/:sha256/:name` | 下载文件 |
| GET | `/api/search` | 组合检索 |
| GET/POST | `/api/sync/pull` `/api/sync/push` | 增量拉取 / 推送 |
| GET | `/api/sync/stream` | SSE 实时事件流 |
| GET | `/api/status` | 系统状态（设备水位、op 统计） |

认证：除首次初始化外均需 `Authorization: Bearer <token>`。

---

## 7. 部署与运行

```bash
# 本地启动（默认 8787 端口）
cd session-sync && node server.mjs

# 自定义端口 / 数据目录 / 访问令牌
PORT=9000 DATA_DIR=./data ACCESS_TOKEN=my-secret node server.mjs

# 首次启动会生成管理员令牌并打印（也可用 ACCESS_TOKEN 环境变量指定）

# 设备端同步代理
node agent/sync-agent.mjs push --server http://host:8787 --token <t> --file session.json
node agent/sync-agent.mjs pull --server http://host:8787 --token <t> --out ./local-copy
node agent/sync-agent.mjs status --server http://host:8787 --token <t>
```

部署到任意服务器（云主机 / 容器 / 内网穿透）后，所有设备访问同一 URL 即构成云端系统；建议置于 HTTPS 反向代理之后。

---

## 8. 目录结构

```
session-sync/
├── server.mjs           # HTTP 服务 + 路由
├── lib/
│   ├── store.mjs        # Oplog / 状态 / 快照 / 文件存储
│   ├── search.mjs       # 分词 + 倒排索引
│   └── util.mjs         # 通用工具
├── public/
│   └── index.html       # Web 管理控制台（单页）
├── agent/
│   └── sync-agent.mjs   # 设备同步 CLI
├── data/                # 运行时数据（自动创建）
└── README.md            # 本设计文档
```

---

## 9. WorkBuddy 会话自动同步桥（agent/workbuddy-bridge.mjs）

把本机 WorkBuddy 的真实会话历史增量同步到云端，实现"对话自动上云"。

**数据源**
- `~/.workbuddy/workbuddy.db` → `sessions` 表（标题 / 时间 / 工作区 / 状态）
- `~/.workbuddy/projects/<工作区>/<会话ID>.jsonl` → 逐条消息（`type=message`，user/assistant）

**转换规则**
| WorkBuddy | SessionSync |
|---|---|
| session.id | `wb-<id>` 会话实体，标题取 custom_title/title，标签 `WorkBuddy` + 工作区名，摘要取首条用户消息 |
| message.id | `wbmsg-<id>` 消息实体，role/ts 原样，正文剥离注入的 `<system-reminder>`，优先提取 `<user_query>` |
| 工具调用/推理/图片引用 | 跳过（只存双方可见文本） |

**幂等与增量**
- 会话 `op_id = wb-sess-<id>-<元数据hash>`：标题/摘要/更新时间变化才补推
- 消息 `op_id = wb-msg-<id>-<文本hash>`：消息被编辑会产生新版本（同 id upsert）
- 本地 `~/.sessionsync/bridge-state.json` 按文件 mtime+size 缓存，未变化文件直接跳过

**用法**
```bash
node agent/workbuddy-bridge.mjs                    # 全量增量一次（读 ~/.sessionsync/config.json）
node agent/workbuddy-bridge.mjs --session <id>     # 单会话
node agent/workbuddy-bridge.mjs --dry-run --verbose
node agent/workbuddy-bridge.mjs --watch --interval 300   # 常驻，每 5 分钟增量
```

**定时自动同步（三选一）**
1. WorkBuddy 自动化：已创建「WorkBuddy 会话自动同步到 SessionSync」，每小时执行一次
2. macOS LaunchAgent（5 分钟）：`launchctl load -w ~/Library/LaunchAgents/com.sessionsync.workbuddy-bridge.plist`
3. 手动常驻：`node agent/workbuddy-bridge.mjs --watch`

配置文件 `~/.sessionsync/config.json`：`{ "server": "http://100.124.11.49:8787", "token": "..." }`

---

## 10. 空间（Space）与产物文件

**空间对齐**：会话按 WorkBuddy 工作区（cwd）归入空间，`space = basename(cwd)`，时间戳临时目录统一归为「临时工作区」。
- 会话实体新增 `space` 字段，参与检索索引（权重 2）
- `GET /api/spaces` 返回空间聚合（会话数/消息数/最后活跃）
- `GET /api/sessions?space=xxx`、`GET /api/search?space=xxx` 支持按空间过滤
- 控制台会话页顶部为空间胶囊筛选，详情页与列表展示所属空间，检索页支持空间下拉

**产物文件同步**：读取 `~/.workbuddy/artifact-index/<sessionId>.json`，把 agent 生成的每个文件（≤50MB）上传到云存储：
- 文件实体 id = `wbf-<sessionId>-<路径哈希>`，op_id 含内容 sha256 → 内容不变不重传，变更后同 id 更新
- 本地按 mtime+size 缓存（`~/.sessionsync/bridge-state.json` → artifacts），重复运行零开销
- 服务端内容寻址存储 `data/files/<sha256>`，同内容跨会话自动去重

**时间戳修复**：操作日志的 `ts` 现在按 `data.ts > op.ts > cur.ts` 优先级归一化，历史导入数据可通过提升 op_id 版本重放来修正（v2/v3），保证列表按真实最后对话时间排序。
