// index.js —— 客户端同步服务入口

const db = require("./db");
const sync = require("./sync");
const logger = require("./logger");

// ─── 启动 ────────────────────────────────────────────────

(async () => {
  logger.info("🚀 客户端同步服务已启动");

  // 初始化数据库（sql.js 是异步加载 WASM）
  await db.init();
  logger.success("数据库已就绪 (client.db)");

  // 启动同步循环
  const stopSync = sync.startSync();

  // ─── 优雅退出 ──────────────────────────────────────────

  function shutdown() {
    logger.info("收到退出信号，正在关闭...");
    stopSync();
    db.close();
    logger.success("客户端已安全退出");
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
})();
