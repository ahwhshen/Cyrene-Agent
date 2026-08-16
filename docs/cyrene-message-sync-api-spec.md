# Cyrene 消息同步服务器接口调用规范

> 对应功能：桌面端「消息同步」（`client/` 子项目，Node.js + sql.js 本地库）
> 代码来源：`client/sync.js`、`client/db.js`、`client/config.json`
> 服务器地址配置：`client/config.json` 的 `server_url`（环境变量 `SYNC_SERVER_URL` 优先）

---

## 1. 总体约定

| 项目 | 约定 |
| --- | --- |
| 传输协议 | HTTP + JSON（当前无鉴权头，内网/可信网络部署） |
| 响应包装 | 所有业务响应统一 `{ "code": 0, ... }`，`code === 0` 表示成功，非 0 视为业务失败 |
| HTTP 状态 | 非 2xx 一律视为请求失败，客户端进入重试退避 |
| 轮询模型 | 客户端定时轮询（默认 `poll_interval = 3000ms`），每轮顺序：心跳 → 拉取 → 推送 |
| 超时 | 推送/心跳 `timeout_ms = 5000ms`；拉取放宽到 `max(timeout_ms, 15000ms)` |
| 失败退避 | 连续失败 ≥ 3 次后轮询间隔翻倍，上限 60s；一次成功后重置为基础间隔 |
| 幂等基准 | 消息以 `uid`（UUID）为全局唯一键，服务端与客户端均按 `uid` 去重 |

### 消息模型（Message）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `uid` | string | 是 | 客户端生成的 UUID，全局唯一，去重键；兼容旧字段 `client_id` |
| `role` | string | 是 | `user` / `assistant` / `system`，缺省按 `user` 处理 |
| `content` | string | 是 | 消息正文（纯文本） |
| `timestamp` | number | 是 | 毫秒级 Unix 时间戳 |
| `session_id` | string \| null | 否 | 所属会话 ID，缺省 null |
| `server_id` / `id` | number | 服务端 | 服务端自增主键，拉取增量游标；两字段名兼容 |

---

## 2. 接口定义

### 2.1 拉取增量消息

```
GET {server_url}/pull?since_id={number}&limit={number}
```

**请求参数（Query）**

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `since_id` | number | 增量游标：只返回 `server_id > since_id` 的消息；客户端断点保存在 `config.json` 的 `max_server_id` |
| `limit` | number | 单批上限，客户端固定传 `100` |

**成功响应**

```json
{
  "code": 0,
  "data": [
    {
      "server_id": 19,
      "uid": "6f1c…-uuid",
      "role": "user",
      "content": "你好",
      "timestamp": 1786000000000,
      "session_id": "default"
    }
  ],
  "max_id": 19
}
```

**规范要点**

1. `data` 必须按 `server_id` **升序**返回；客户端按批写库后立即把 `max_id` 存为断点，中断后下次从断点续传。
2. `max_id` 可为 `null`（无数据时），客户端此时不更新断点。
3. 客户端判断 `hasMore = data.length >= limit`：满批则继续下一轮 `pull`，直到返回不足一批或空数组。
4. `data` 必须为数组，否则客户端判为响应异常并报错重试。

---

### 2.2 推送本地消息

```
POST {server_url}/push
Content-Type: application/json
```

**请求体**（单批最多 50 条）

```json
{
  "messages": [
    {
      "uid": "a2b9…-uuid",
      "role": "assistant",
      "content": "我在呢",
      "timestamp": 1786000000123,
      "session_id": "default"
    }
  ]
}
```

**成功响应**

```json
{
  "code": 0,
  "server_ids": [20, 21]
}
```

**规范要点**

1. `server_ids` 为服务端落库后的自增 ID 数组，**顺序必须与请求 `messages` 一一对应**；客户端用它回填本地 `server_id` 并标记已同步。
2. 若无法提供 ID，可返回 `code: 0` 且不带 `server_ids`，客户端按 null 兜底（不影响同步，但失去断点精度）。
3. 服务端必须按 `uid` 幂等去重（重复推送不得产生重复记录）。
4. 本地消息流向：主进程写入 `client/outbox.json` → 同步客户端读入本地库（`synced=0`）→ 本接口批量上送。

---

### 2.3 在线心跳（Presence）

```
POST {server_url}/presence
Content-Type: application/json
（无请求体）
```

**规范要点**

1. 客户端每轮轮询（默认 3s）发送一次，单独 3s 超时，失败静默忽略、不影响主同步流程。
2. 服务端以此判断「桌面端在线」：建议超过 10~15s 未收到心跳即判定离线。
3. 响应体不做强校验，返回 `{"code":0}` 即可。

---

## 3. 客户端本地状态机（供服务端联调参考）

本地库 `client.db`（SQLite，sql.js）`messages` 表关键字段：

| 字段 | 含义 |
| --- | --- |
| `synced` | 0=待推送，1=已推送（拉取来的消息直接为 1） |
| `server_id` | 服务端自增 ID，`/pull` 增量游标来源（取本地最大值） |
| `merged` | 0=待合并进桌面端聊天存储，1=已合并 |

与主进程（Electron）的本地交互协议：

- **客户端 → 主进程**：stdout 行协议 `__SYNC_DATA__:{json}`，type=`pull` 携带新消息供合并进聊天存储。
- **主进程 → 客户端**：待上送消息写入 `outbox.json`；合并完成回执写入 `merge-queue.json`（uid 数组，客户端据此置 `merged=1`）。
- 客户端每次启动会把未合并消息（`merged=0`，上限 200 条）重新发给主进程，保证崩溃后不丢。

---

## 4. 服务器实现方检查清单

- [ ] `GET /pull`：按 `since_id` 升序分页，返回 `code/data/max_id`
- [ ] `POST /push`：按 `uid` 幂等写入，返回对齐的 `server_ids`
- [ ] `POST /presence`：记录最后心跳时间，供在线状态查询
- [ ] 所有响应 JSON 带 `code` 字段；异常用非 0 code 或非 2xx
- [ ] `server_id` 使用严格自增整数（客户端增量游标依赖单调性）
