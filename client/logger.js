// logger.js —— 带时间戳的日志输出

function timestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  );
}

function info(msg) {
  console.log(`[${timestamp()}] ${msg}`);
}

function success(msg) {
  console.log(`[${timestamp()}] ✅ ${msg}`);
}

function warn(msg) {
  console.warn(`[${timestamp()}] ⚠️  ${msg}`);
}

function error(msg) {
  console.error(`[${timestamp()}] ❌ ${msg}`);
}

module.exports = { info, success, warn, error };
