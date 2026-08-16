// sync.js —— 核心同步引擎：拉取 + 推送 + 指数退避 + 聊天集成

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const db = require("./db");
const logger = require("./logger");

const CONFIG_PATH = path.join(__dirname, "config.json");
const OUTBOX_PATH = path.join(__dirname, "outbox.json");
const MERGE_QUEUE_PATH = path.join(__dirname, "merge-queue.json");

/** 读取配置（环境变量优先，支持从主进程传入） */
function loadConfig() {
  const fileCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  return {
    server_url: process.env.SYNC_SERVER_URL || fileCfg.server_url || "http://127.0.0.1:8080",
    poll_interval: parseInt(process.env.SYNC_POLL_INTERVAL, 10) || fileCfg.poll_interval || 3000,
    timeout_ms: parseInt(process.env.SYNC_TIMEOUT_MS, 10) || fileCfg.timeout_ms || 5000,
    max_server_id: fileCfg.max_server_id || 0,
  };
}

/** 写回配置（更新 max_server_id） */
function saveConfig(partial) {
  const cfg = loadConfig();
  Object.assign(cfg, partial);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf-8");
}

/** 带超时的 fetch（AbortController 实现） */
async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/** 安全解析 JSON，失败返回 null */
async function safeJson(res) {
  try {
    const text = await res.text();
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 输出结构化 JSON 到 stdout，供主进程解析。
 * 格式：__SYNC_DATA__:<json>
 */
function emitSyncData(type, data) {
  const line = `__SYNC_DATA__:${JSON.stringify({ type, ...data })}`;
  console.log(line);
}

// ─── 启动时重新发送未合并的消息 ─────────────────────────

function resendUnmerged() {
  const unmerged = db.getUnmerged(200);
  if (unmerged.length === 0) return 0;
  const messages = unmerged.map((m) => ({
    uid: m.uid,
    role: m.role || "user",
    content: m.content,
    timestamp: m.timestamp,
    session_id: m.session_id || null,
  }));
  emitSyncData("pull", { messages });
  logger.info(`重新发送 ${messages.length} 条未合并消息到主进程`);
  return messages.length;
}

// ─── 拉取逻辑（分批断点续传） ────────────────────────────

/** 每批拉取的消息数量上限 */
const PULL_BATCH_SIZE = 100;

/**
 * 单批次拉取：从 sinceId 开始，最多拉 PULL_BATCH_SIZE 条。
 * @returns {{ messages: object[], maxId: number|null, hasMore: boolean }}
 */
async function pullBatch(sinceId) {
  const cfg = loadConfig();
  const url = `${cfg.server_url}/pull?since_id=${sinceId}&limit=${PULL_BATCH_SIZE}`;

  // 拉取超时放宽到 15s（分批后每批数据量可控，但网络可能慢）
  const pullTimeout = Math.max(cfg.timeout_ms, 15000);
  const res = await fetchWithTimeout(url, {}, pullTimeout);
  if (!res.ok) {
    throw new Error(`拉取失败: HTTP ${res.status}`);
  }

  const json = await safeJson(res);
  if (!json || json.code !== 0 || !Array.isArray(json.data)) {
    throw new Error(`拉取响应异常: ${JSON.stringify(json ?? "null").slice(0, 200)}`);
  }

  const messages = json.data;
  const hasMore = messages.length >= PULL_BATCH_SIZE;
  const maxId = json.max_id ?? null;

  return { messages, maxId, hasMore };
}

/**
 * 处理一批消息：写入本地 DB + 通知主进程合并。
 * @returns 新插入的消息数
 */
function processBatch(messages) {
  let added = 0;
  const newMessages = [];

  for (const msg of messages) {
    const uid = msg.uid || msg.client_id || crypto.randomUUID();
    const inserted = db.insertOrIgnore({
      uid,
      role: msg.role || "user",
      content: msg.content,
      timestamp: msg.timestamp,
      session_id: msg.session_id || null,
      synced: 1,
      server_id: msg.server_id ?? msg.id ?? null,
      merged: 0,
    });
    if (inserted) {
      added++;
      newMessages.push({
        uid,
        role: msg.role || "user",
        content: msg.content,
        timestamp: msg.timestamp,
        session_id: msg.session_id || null,
      });
    }
  }

  // 通知主进程合并到聊天存储
  if (newMessages.length > 0) {
    emitSyncData("pull", { messages: newMessages });
  }

  return added;
}

/**
 * 断点续传拉取：循环分批拉取，每批处理完立即保存 max_server_id。
 * 如果中途失败，下次启动时从已保存的 max_server_id 继续。
 */
async function pullFromServer() {
  let totalAdded = 0;
  let maxServerId = db.getMaxServerId();
  let hasMore = true;
  let batchCount = 0;

  while (hasMore) {
    const { messages, maxId, hasMore: more } = await pullBatch(maxServerId);
    batchCount++;

    if (messages.length === 0) break;

    // 处理本批消息（写入 DB + 通知主进程）
    const added = processBatch(messages);
    totalAdded += added;

    // 立即保存进度：更新 max_server_id，下次从断点继续
    if (maxId != null) {
      maxServerId = maxId;
      saveConfig({ max_server_id: maxId });
    }

    hasMore = more;

    if (more) {
      logger.info(`已拉取第 ${batchCount} 批 (${messages.length} 条)，继续拉取...`);
    }
  }

  if (batchCount > 1) {
    logger.info(`分 ${batchCount} 批拉取完成，共新增 ${totalAdded} 条`);
  }

  return totalAdded;
}

// ─── 推送逻辑 ────────────────────────────────────────────

async function pushToServer() {
  // 先检查 outbox（主进程写入的本地消息）
  drainOutbox();

  const unsynced = db.getUnsynced(50);
  if (unsynced.length === 0) return 0;

  const cfg = loadConfig();
  const payload = {
    messages: unsynced.map((m) => ({
      uid: m.uid,
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
      session_id: m.session_id,
    })),
  };

  const res = await fetchWithTimeout(
    `${cfg.server_url}/push`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    cfg.timeout_ms
  );

  if (!res.ok) {
    throw new Error(`推送失败: HTTP ${res.status}`);
  }

  const json = await safeJson(res);
  if (!json || json.code !== 0) {
    throw new Error(`推送响应异常: ${JSON.stringify(json ?? "null").slice(0, 200)}`);
  }

  // 标记已同步，记录服务器返回的 id
  const uids = unsynced.map((m) => m.uid);
  const serverIds = json.server_ids ?? unsynced.map((m) => null);
  db.markSynced(uids, serverIds);

  return unsynced.length;
}

// ─── Outbox：读取主进程写入的本地消息 ────────────────────

function drainOutbox() {
  if (!fs.existsSync(OUTBOX_PATH)) return;
  try {
    const raw = fs.readFileSync(OUTBOX_PATH, "utf-8");
    const messages = JSON.parse(raw);
    if (!Array.isArray(messages) || messages.length === 0) return;

    for (const msg of messages) {
      db.insertOrIgnore({
        uid: msg.uid || crypto.randomUUID(),
        role: msg.role || "user",
        content: msg.content,
        timestamp: msg.timestamp || Date.now(),
        session_id: msg.session_id || null,
        synced: 0, // 需要推送到服务器
        server_id: null,
        merged: 1, // 本地消息已在聊天存储中，不需要合并
      });
    }

    // 清空 outbox
    fs.writeFileSync(OUTBOX_PATH, "[]", "utf-8");
    logger.info(`从 outbox 读取了 ${messages.length} 条本地消息`);
  } catch (err) {
    logger.error(`读取 outbox 失败: ${err.message}`);
  }
}

// ─── 合并标记：主进程写入的待标记 UID ────────────────

function drainMergeQueue() {
  if (!fs.existsSync(MERGE_QUEUE_PATH)) return;
  try {
    const raw = fs.readFileSync(MERGE_QUEUE_PATH, "utf-8").trim();
    // 容错：空文件 / 损坏内容按空队列处理并重置文件，避免每轮刷屏报错
    if (!raw) {
      fs.writeFileSync(MERGE_QUEUE_PATH, "[]", "utf-8");
      return;
    }
    const uids = JSON.parse(raw);
    if (Array.isArray(uids) && uids.length > 0) {
      db.markMerged(uids);
      logger.info(`已标记 ${uids.length} 条消息为已合并`);
    }
    fs.writeFileSync(MERGE_QUEUE_PATH, "[]", "utf-8");
  } catch (err) {
    logger.error(`读取 merge-queue 失败: ${err.message}`);
    // 内容无法解析时重置为空队列，防止持续报错
    try { fs.writeFileSync(MERGE_QUEUE_PATH, "[]", "utf-8"); } catch { /* 忽略写入失败 */ }
  }
}

// ─── Presence 心跳 ────────────────────────────────────────

/** 向同步服务器发送在线心跳，告知服务器端 agent 桌面端在线 */
function sendPresenceHeartbeat() {
  const cfg = loadConfig();
  fetchWithTimeout(
    `${cfg.server_url}/presence`,
    { method: "POST", headers: { "Content-Type": "application/json" } },
    3000
  ).catch(() => {
    // 心跳失败不影响主同步流程，静默忽略
  });
}

// ─── 主循环（指数退避） ──────────────────────────────────

function startSync() {
  const cfg = loadConfig();
  const baseInterval = cfg.poll_interval ?? 3000;
  let currentInterval = baseInterval;
  let consecutiveFailures = 0;
  let timer = null;

  // 启动时重新发送未合并的消息到主进程
  resendUnmerged();

  async function tick() {
    try {
      // 先处理主进程发来的合并标记
      drainMergeQueue();

      // 发送在线心跳（告诉同步服务器桌面端在线）
      sendPresenceHeartbeat();

      // 再拉取
      const pulled = await pullFromServer();
      if (pulled > 0) {
        logger.success(`拉取到 ${pulled} 条新消息`);
      }

      // 再推送
      const pushed = await pushToServer();
      if (pushed > 0) {
        logger.success(`推送了 ${pushed} 条消息到服务器`);
      }

      // 成功 → 重置退避
      if (consecutiveFailures > 0) {
        consecutiveFailures = 0;
        currentInterval = baseInterval;
        logger.info(`网络恢复，轮询间隔重置为 ${baseInterval}ms`);
      }
    } catch (err) {
      consecutiveFailures++;
      logger.error(`同步失败 (#${consecutiveFailures}): ${err.message}`);

      // 指数退避：连续失败 3 次后翻倍，最大 60s
      if (consecutiveFailures >= 3) {
        currentInterval = Math.min(currentInterval * 2, 60000);
        logger.warn(`连续失败，轮询间隔调整为 ${currentInterval}ms`);
      }
    } finally {
      // 安排下一次
      timer = setTimeout(tick, currentInterval);
    }
  }

  logger.info(`开始同步循环，初始间隔 ${baseInterval}ms`);
  timer = setTimeout(tick, baseInterval);

  // 返回停止函数
  return () => {
    if (timer) clearTimeout(timer);
  };
}

module.exports = { pullFromServer, pushToServer, startSync };
