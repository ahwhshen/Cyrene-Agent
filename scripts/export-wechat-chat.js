/**
 * 导出微信聊天记录为可读文本文件
 * 
 * 用法: node scripts/export-wechat-chat.js [输出路径]
 * 默认输出到桌面: wechat-chat-export.txt
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

// 定位 wechat-sync 会话文件
const sessionFile = path.join(
  process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
  "live2d-cyrene",
  "cyrene-chats",
  "sessions",
  "wechat-sync.json"
);

// 输出路径：第一个参数或桌面
const outputPath = process.argv[2] || path.join(__dirname, "..", "wechat-chat-export.txt");

if (!fs.existsSync(sessionFile)) {
  console.error("❌ 找不到微信聊天会话文件:", sessionFile);
  console.error("   请先通过同步拉取获取微信消息");
  process.exit(1);
}

const session = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
const messages = session.messages || [];

if (messages.length === 0) {
  console.log("⚠️ 没有消息可导出");
  process.exit(0);
}

// 按时间排序
messages.sort((a, b) => (a.at || 0) - (b.at || 0));

// 格式化输出
const lines = [];
lines.push(`微信聊天记录导出`);
lines.push(`导出时间: ${new Date().toLocaleString("zh-CN")}`);
lines.push(`消息总数: ${messages.length}`);
lines.push(`═`.repeat(60));
lines.push("");

let currentDate = "";

for (const msg of messages) {
  const date = new Date(msg.at || Date.now());
  const dateStr = date.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  
  // 日期分隔线
  if (dateStr !== currentDate) {
    currentDate = dateStr;
    lines.push("");
    lines.push(`── ${dateStr} ──`);
    lines.push("");
  }

  const timeStr = date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
  
  const roleLabel = msg.role === "user" ? "我" : "昔涟";
  lines.push(`[${timeStr}] ${roleLabel}:`);
  lines.push(msg.content);
  lines.push("");
}

const content = lines.join("\n");
fs.writeFileSync(outputPath, content, "utf8");

console.log(`✅ 导出完成!`);
console.log(`   消息数: ${messages.length}`);
console.log(`   输出到: ${outputPath}`);
console.log(`   日期范围: ${new Date(messages[0].at).toLocaleDateString("zh-CN")} ~ ${new Date(messages[messages.length - 1].at).toLocaleDateString("zh-CN")}`);
