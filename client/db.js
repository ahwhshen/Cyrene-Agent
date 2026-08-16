// db.js —— 本地 SQLite 数据库管理（sql.js 纯 JS 实现，无需编译）

const fs = require("fs");
const path = require("path");
const initSqlJs = require("sql.js");

const DB_PATH = path.join(__dirname, "client.db");

let db; // sql.js Database 实例
let SQL; // sql.js 模块引用

/** 初始化数据库连接 + 建表 */
async function init() {
  SQL = await initSqlJs();

  // 如果已有数据库文件则加载，否则新建
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  // 建表：包含 session_id、role、merged 字段用于聊天集成
  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uid TEXT UNIQUE NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      session_id TEXT DEFAULT NULL,
      synced INTEGER DEFAULT 0,
      server_id INTEGER DEFAULT NULL,
      merged INTEGER DEFAULT 0
    )
  `);

  // 迁移：如果旧表缺少新列，自动添加（必须在 CREATE INDEX 之前）
  try {
    const cols = db.exec("PRAGMA table_info(messages)");
    const colNames = cols.length > 0 ? cols[0].values.map((r) => r[1]) : [];
    if (!colNames.includes("session_id")) {
      db.run("ALTER TABLE messages ADD COLUMN session_id TEXT DEFAULT NULL");
    }
    if (!colNames.includes("role")) {
      db.run("ALTER TABLE messages ADD COLUMN role TEXT DEFAULT 'user'");
    }
    if (!colNames.includes("merged")) {
      db.run("ALTER TABLE messages ADD COLUMN merged INTEGER DEFAULT 0");
    }
  } catch (e) {
    console.error("[db] 迁移失败:", e.message);
  }

  db.run("CREATE INDEX IF NOT EXISTS idx_uid ON messages(uid)");
  db.run("CREATE INDEX IF NOT EXISTS idx_merged ON messages(merged)");
  db.run("CREATE INDEX IF NOT EXISTS idx_session ON messages(session_id)");

  save(); // 立即落盘确保文件存在
  return db;
}

/** 持久化到磁盘 */
function save() {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

/** 插入一条消息（uid 重复则忽略），返回是否新插入 */
function insertOrIgnore(msg) {
  const before = db.exec("SELECT changes() as c")[0]?.values[0][0];
  db.run(
    `INSERT OR IGNORE INTO messages (uid, role, content, timestamp, session_id, synced, server_id, merged)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      msg.uid,
      msg.role ?? "user",
      msg.content,
      msg.timestamp,
      msg.session_id ?? null,
      msg.synced ?? 0,
      msg.server_id ?? null,
      msg.merged ?? 0,
    ]
  );
  const after = db.exec("SELECT changes() as c")[0]?.values[0][0];
  const inserted = (after ?? 0) > 0;
  save();
  return inserted;
}

/** 获取待上传的消息（synced=0），按时间正序 */
function getUnsynced(limit = 50) {
  const stmt = db.prepare(
    "SELECT * FROM messages WHERE synced = 0 ORDER BY timestamp ASC LIMIT ?"
  );
  stmt.bind([limit]);
  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

/** 批量标记消息为已同步 */
function markSynced(uids, serverIds) {
  if (!uids || uids.length === 0) return;
  db.run("BEGIN TRANSACTION");
  for (let i = 0; i < uids.length; i++) {
    const sid = serverIds?.[i] ?? null;
    db.run(
      "UPDATE messages SET synced = 1, server_id = ? WHERE uid = ?",
      [sid, uids[i]]
    );
  }
  db.run("COMMIT");
  save();
}

/** 获取本地最大的 server_id（用于增量拉取） */
function getMaxServerId() {
  const result = db.exec(
    "SELECT MAX(server_id) as max_id FROM messages WHERE server_id IS NOT NULL"
  );
  if (result.length === 0 || result[0].values[0][0] === null) return 0;
  return result[0].values[0][0];
}

/** 获取已同步但未合并到聊天存储的消息（merged=0, synced=1），按时间正序 */
function getUnmerged(limit = 200) {
  const stmt = db.prepare(
    "SELECT * FROM messages WHERE synced = 1 AND merged = 0 ORDER BY timestamp ASC LIMIT ?"
  );
  stmt.bind([limit]);
  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

/** 批量标记消息为已合并 */
function markMerged(uids) {
  if (!uids || uids.length === 0) return;
  const placeholders = uids.map(() => "?").join(",");
  db.run(
    `UPDATE messages SET merged = 1 WHERE uid IN (${placeholders})`,
    uids
  );
  save();
}

/** 关闭数据库 */
function close() {
  if (db) {
    save();
    db.close();
    db = null;
  }
}

module.exports = { init, insertOrIgnore, getUnsynced, markSynced, getMaxServerId, getUnmerged, markMerged, close };
