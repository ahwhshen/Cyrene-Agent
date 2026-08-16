// import-wechat-history.js
// 用法: node scripts/import-wechat-history.js <文件路径>
//
// 支持格式（自动识别）:
//
// 格式0 — 服务器 history-log JSONL（推荐，直接从服务器拷过来）:
//   {"role":"user","content":"嘿嘿好啊","at":"2026-08-10T11:51:59.000Z"}
//   {"role":"assistant","content":"嗯嗯","at":"2026-08-10T11:52:00.000Z"}
//
// 格式1 — 通用文本导出（每段以 "昵称 时间" 开头）:
//   昔涟 2026-08-10 19:51:59
//   嘿嘿好啊
//
// 格式2 — 带角色标记:
//   [user] 2026-08-10 19:51:59 嘿嘿好啊
//
// 格式3 — JSON 数组:
//   [{"role":"user","content":"嘿嘿好啊","timestamp":1786362719699}, ...]
//
// 导入后消息会合并到桌面端的"微信聊天"会话中。

const fs = require("fs");
const path = require("path");

// ─── 配置 ───────────────────────────────────────────────
const SESSION_ID = "wechat-sync";
const CHATS_DIR = path.join(
  process.env.APPDATA || path.join(require("os").homedir(), "AppData", "Roaming"),
  "live2d-cyrene", "cyrene-chats"
);
const SESSIONS_DIR = path.join(CHATS_DIR, "sessions");
const INDEX_PATH = path.join(CHATS_DIR, "index.json");

// 你的微信昵称（识别为 user 角色）
const USER_NAMES = new Set(["昔涟", "开拓者", "Playa", "playa"]);
// AI 昵称（识别为 assistant 角色）
const AI_NAMES = new Set(["Cyrene", "cyrene", "昔涟AI", "AI"]);

// ─── 解析器 ──────────────────────────────────────────────

/** 格式0 — 服务器 history-log JSONL (每行一个 JSON，role/content/at) */
function parseHistoryLog(text) {
  const lines = text.split("\n").filter(l => l.trim());
  const messages = [];
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      if (e && (e.role === "user" || e.role === "assistant") && typeof e.content === "string") {
        messages.push({
          role: e.role,
          content: e.content,
          timestamp: e.at ? new Date(e.at).getTime() : Date.now(),
        });
      }
    } catch { /* skip bad line */ }
  }
  return messages.length > 0 ? messages : null;
}

function parseJSON(text) {
  try {
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) return null;
    return arr.map((m, i) => ({
      role: m.role === "assistant" || m.role === "model" ? "assistant" : "user",
      content: m.content || m.text || m.message || "",
      timestamp: m.timestamp || m.at || m.time || Date.now() + i,
    })).filter(m => m.content.trim());
  } catch {
    return null;
  }
}

function parseTaggedFormat(text) {
  // [user] 2026-08-10 19:51:59 嘿嘿好啊
  const lines = text.split("\n");
  const messages = [];
  const re = /^\[(user|assistant|model)\]\s+(\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?)\s+(.*)$/;

  for (const line of lines) {
    const m = re.exec(line.trim());
    if (m) {
      const role = m[1] === "model" ? "assistant" : m[1];
      const ts = new Date(m[2].replace(/\//g, "-")).getTime();
      messages.push({ role, content: m[3], timestamp: isNaN(ts) ? Date.now() : ts });
    }
  }
  return messages.length > 0 ? messages : null;
}

function parseTextExport(text) {
  // 昵称 2026-08-10 19:51:59\n消息内容\n\n昵称 ...
  const blocks = text.split(/\n\s*\n/).filter(b => b.trim());
  const messages = [];
  const headerRe = /^(.+?)\s+(\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?)\s*$/;

  for (const block of blocks) {
    const lines = block.trim().split("\n");
    if (lines.length === 0) continue;

    const headerMatch = headerRe.exec(lines[0].trim());
    if (!headerMatch) continue;

    const name = headerMatch[1].trim();
    const ts = new Date(headerMatch[2].replace(/\//g, "-")).getTime();
    const content = lines.slice(1).join("\n").trim();

    if (!content) continue;

    let role;
    if (USER_NAMES.has(name)) {
      role = "user";
    } else if (AI_NAMES.has(name)) {
      role = "assistant";
    } else {
      // 默认当 user
      role = "user";
    }

    messages.push({
      role,
      content,
      timestamp: isNaN(ts) ? Date.now() : ts,
    });
  }
  return messages.length > 0 ? messages : null;
}

function parseFile(filePath) {
  const text = fs.readFileSync(filePath, "utf-8").trim();
  if (!text) { console.error("文件为空"); process.exit(1); }

  // 优先尝试 history-log JSONL 格式
  let messages = parseHistoryLog(text);
  if (messages) { console.log("识别为 history-log JSONL 格式"); return messages; }

  // 尝试 JSON 数组
  messages = parseJSON(text);
  if (messages) { console.log("识别为 JSON 格式"); return messages; }

  // 尝试带角色标记的格式
  messages = parseTaggedFormat(text);
  if (messages) { console.log("识别为角色标记格式"); return messages; }

  // 尝试通用文本导出
  messages = parseTextExport(text);
  if (messages) { console.log("识别为文本导出格式"); return messages; }

  console.error("无法识别文件格式，请检查文件内容");
  process.exit(1);
}

// ─── 导入逻辑 ────────────────────────────────────────────

function readSessionFile(id) {
  const p = path.join(SESSIONS_DIR, id + ".json");
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function writeSessionFile(session) {
  const p = path.join(SESSIONS_DIR, session.id + ".json");
  fs.writeFileSync(p, JSON.stringify(session, null, 2), "utf-8");
}

function readIndex() {
  if (!fs.existsSync(INDEX_PATH)) return [];
  return JSON.parse(fs.readFileSync(INDEX_PATH, "utf-8"));
}

function writeIndex(index) {
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2), "utf-8");
}

function importMessages(messages) {
  // 按时间排序
  messages.sort((a, b) => a.timestamp - b.timestamp);

  let session = readSessionFile(SESSION_ID);

  if (!session) {
    // 创建新会话
    const chatMessages = messages.map((m, i) => ({
      id: `imported:${m.role}:${m.timestamp}:${i}`,
      role: m.role,
      content: m.content,
      at: m.timestamp,
      source: "synced",
    }));

    session = {
      id: SESSION_ID,
      title: "微信聊天",
      titleIsCustom: true,
      messages: chatMessages,
      createdAt: messages[0]?.timestamp || Date.now(),
      updatedAt: messages[messages.length - 1]?.timestamp || Date.now(),
    };
  } else {
    // 追加到已有会话（去重）
    const existingKeys = new Set(
      session.messages.map(m => `${m.role}|${m.content}|${m.at}`)
    );

    for (const m of messages) {
      const key = `${m.role}|${m.content}|${m.timestamp}`;
      if (existingKeys.has(key)) continue;

      session.messages.push({
        id: `imported:${m.role}:${m.timestamp}:${session.messages.length}`,
        role: m.role,
        content: m.content,
        at: m.timestamp,
        source: "synced",
      });
      existingKeys.add(key);
    }

    session.messages.sort((a, b) => a.at - b.at);
    session.updatedAt = Math.max(session.updatedAt, messages[messages.length - 1]?.timestamp || 0);
  }

  writeSessionFile(session);

  // 更新 index
  const index = readIndex();
  const existing = index.find(s => s.id === SESSION_ID);
  if (existing) {
    existing.messageCount = session.messages.length;
    existing.updatedAt = session.updatedAt;
  } else {
    index.push({
      id: SESSION_ID,
      title: session.title,
      messageCount: session.messages.length,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      pinned: false,
    });
  }
  writeIndex(index);

  return session.messages.length;
}

// ─── 主流程 ──────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.length === 0) {
  console.log(`
用法: node scripts/import-wechat-history.js <文件路径>

最简单的方式：把服务器上的 history 文件拷到本地，然后导入：
  服务器文件位置: <userData>/channels/history/channel_wechat_*.jsonl
  拷贝到本地后运行: node scripts/import-wechat-history.js channel_wechat_7be6d54fabbc4c58.jsonl

支持格式:
  0. history-log JSONL (服务器直接拷的 .jsonl 文件)
  1. JSON 数组
  2. 角色标记: [user] 时间 内容
  3. 文本导出: 昵称 时间\\n内容
`);
  process.exit(0);
}

const filePath = path.resolve(args[0]);
if (!fs.existsSync(filePath)) {
  console.error(`文件不存在: ${filePath}`);
  process.exit(1);
}

console.log(`读取文件: ${filePath}`);
const messages = parseFile(filePath);
console.log(`解析到 ${messages.length} 条消息`);

const total = importMessages(messages);
console.log(`✅ 已导入到"微信聊天"会话，当前共 ${total} 条消息`);
console.log(`重启桌面端即可在左侧看到导入的聊天记录`);
