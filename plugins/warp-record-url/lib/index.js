"use strict";
// warp-record-url 插件入口 —— 实现插件接口契约（见 docs/cyrene-plugin-api-spec.md）。
// 职责：从《崩坏：星穹铁道》本地 WebCache 中提取跃迁记录页面链接（含临时 authkey）。
//  - 只被动读取游戏磁盘缓存文件，不触碰游戏进程；
//  - authkey 等同账号临时凭证：全程本地处理，不上传、不写明文日志；
//  - 自动检测失败时支持手动指定游戏目录 / 手动粘贴链接兜底（云游戏可用）。
const fs = require("fs");
const path = require("path");
const cp = require("child_process");

// 星穹铁道 WebCache 的 XOR 混淆密钥（data_2 二进制需先解码再搜文本）。
const XOR_KEY = 0xf4;
// 链接最长存活提示用：提取时间由窗口侧记录，这里只回传原始信息。

// ─────────────────────────────── 状态文件 ───────────────────────────────
// 窗口桥只能读 settingsSchema 配置，无法回写；“是否看过说明页”“手动目录”
// 这类窗口产生的状态统一落在 ctx.app.dataPath/state.json。
let dataDir = "";
function stateFile() {
  return path.join(dataDir, "state.json");
}
function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), "utf8"));
  } catch {
    return {};
  }
}
function writeState(patch) {
  try {
    const cur = readState();
    fs.writeFileSync(stateFile(), JSON.stringify(Object.assign(cur, patch), null, 2), "utf8");
  } catch {
    /* 落盘失败不影响主流程 */
  }
}

// ─────────────────────────────── 游戏目录探测 ───────────────────────────────
function execQuiet(command) {
  return new Promise((resolve) => {
    try {
      cp.exec(command, { encoding: "buffer", timeout: 8000, windowsHide: true }, (err, stdout) => {
        resolve(err ? null : stdout);
      });
    } catch {
      resolve(null);
    }
  });
}

/** reg query 输出是 UTF-16LE，统一转字符串再找形如路径的值。 */
function pickPathFromReg(buffer) {
  if (!buffer) return null;
  const text = buffer.toString("utf16le");
  // 匹配 X:\... 形式且含 "Star Rail" 的值（安装路径可能带反斜杠结尾）
  const m = text.match(/[A-Za-z]:\\[^\r\n]*?Star Rail[^\r\n]*/i);
  if (!m) return null;
  return m[0].trim().replace(/\\+$/, "");
}

async function detectGameDirFromRegistry() {
  // 1) 游戏本体注册表（值名随版本变，直接扫全部值找路径）
  let buf = await execQuiet('reg query "HKCU\\SOFTWARE\\miHoYo\\崩坏：星穹铁道"');
  let p = pickPathFromReg(buf);
  if (p) return p;
  // 2) 卸载信息里的 InstallLocation（启动器安装方式）
  buf = await execQuiet(
    'reg query "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\崩坏：星穹铁道" /v InstallLocation'
  );
  p = pickPathFromReg(buf);
  if (p) return p;
  buf = await execQuiet(
    'reg query "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\崩坏：星穹铁道" /v InstallLocation'
  );
  return pickPathFromReg(buf);
}

const COMMON_DIRS = [
  () => path.join(process.env.ProgramW6432 || "C:\\Program Files", "Star Rail"),
  () => path.join(process.env.ProgramFiles || "C:\\Program Files", "Star Rail"),
  () => "D:\\Program Files\\Star Rail",
  () => "D:\\Games\\Star Rail",
  () => "E:\\Games\\Star Rail",
];

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/** 目录里（或其 Game 子目录里）能找到 StarRail.exe 才算有效。 */
function looksLikeGameDir(dir) {
  if (!dir || !exists(dir)) return false;
  return exists(path.join(dir, "Game", "StarRail.exe")) || exists(path.join(dir, "StarRail.exe"));
}

/** 配置值允许指向目录，也允许直接指向 StarRail.exe。 */
function normalizeConfiguredDir(raw) {
  const v = String(raw || "").trim().replace(/^"|"$/g, "");
  if (!v) return null;
  if (v.toLowerCase().endsWith("starrail.exe")) {
    const dir = path.dirname(path.dirname(v)); // …\Star Rail\Game\StarRail.exe → …\Star Rail
    return looksLikeGameDir(dir) ? dir : path.dirname(v);
  }
  return looksLikeGameDir(v) ? v : null;
}

async function resolveGameDir(settings, log) {
  const configured = normalizeConfiguredDir(settings.gameDir);
  if (configured) return { dir: configured, source: "插件设置" };
  const manual = normalizeConfiguredDir(readState().manualGameDir);
  if (manual) return { dir: manual, source: "窗口手动指定" };
  const fromReg = await detectGameDirFromRegistry();
  if (fromReg && looksLikeGameDir(fromReg)) return { dir: fromReg, source: "注册表" };
  for (const mk of COMMON_DIRS) {
    const d = mk();
    if (looksLikeGameDir(d)) return { dir: d, source: "常见路径" };
  }
  log("未找到游戏目录：注册表与常见路径均无果，请在窗口里手动指定。");
  return null;
}

// ─────────────────────────────── WebCache 扫描与提取 ───────────────────────────────
/** 收集 webCaches 下所有版本的 data_2，按修改时间倒序（越新越可能是有效 authkey）。 */
function findCacheFiles(gameDir) {
  // 缓存根目录随版本变过：老版在 Game/webCaches，新版（miHoYo Launcher 安装）
  // 移到 StarRail_Data/webCaches，三个位置都扫一遍。
  const roots = [
    path.join(gameDir, "Game", "webCaches"),
    path.join(gameDir, "webCaches"),
    path.join(gameDir, "StarRail_Data", "webCaches"),
  ];
  const out = [];
  for (const root of roots) {
    if (!exists(root)) continue;
    let versions = [];
    try {
      versions = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const ver of versions) {
      // 常规布局 + 新版可能出现的 Segmented 布局；URL 长度不同会落在
      // 不同块文件（data_1~data_3），三个都扫。
      for (const layout of ["Cache", "Segmented"]) {
        for (const name of ["data_1", "data_2", "data_3"]) {
          const f = path.join(root, ver, layout, "Cache_Data", name);
          try {
            const st = fs.statSync(f);
            if (st.isFile() && st.size > 0) out.push({ file: f, mtime: st.mtimeMs, size: st.size });
          } catch {
            /* 不存在就跳过 */
          }
        }
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** 收集 buffer 中所有带 authkey 的候选链接（明文 + XOR 双模式），并解析各自 timestamp。 */
function collectGachaUrls(buf) {
  const out = [];
  const variants = [];
  variants.push({ text: buf.toString("latin1"), mode: "raw" });
  const xored = Buffer.from(buf);
  for (let i = 0; i < xored.length; i++) xored[i] ^= XOR_KEY;
  variants.push({ text: xored.toString("latin1"), mode: "xor" });
  for (const { text, mode } of variants) {
    const anchor = "authkey=";
    let from = 0;
    while (true) {
      const idx = text.indexOf(anchor, from);
      if (idx < 0) break;
      from = idx + anchor.length;
      // 向前回溯到 http 起点，向后截取到空白/控制符为止
      let start = idx;
      while (start > 0 && /[\x21-\x7e]/.test(text[start - 1])) start--;
      let end = idx;
      while (end < text.length && /[\x21-\x7e]/.test(text[end])) end++;
      let url = text.slice(start, end);
      // 新版缓存里 URL 前面可能紧贴着条目元数据（如 "1/0/https://…"），
      // 回溯无法断开可打印字符，改在候选串内定位 http(s):// 真实起点。
      const scheme = url.match(/https?:\/\//);
      if (scheme) url = url.slice(scheme.index);
      // 跃迁页面 URL 形如 https://webstatic(-sea)?.hoyoverse.com/hkr/event/e2023...gacha/...；
      // 接口 URL 含 gacha_record。只要带 authkey 且命中抽卡相关特征即可。
      if (!/^https?:\/\//.test(url) || !/gacha|warp|hoyoverse|mihoyo/i.test(url)) continue;
      const tm = url.match(/[?&]timestamp=(\d+)/);
      out.push({ url, mode, ts: tm ? Number(tm[1]) : 0 });
    }
  }
  return out;
}

async function extractFromCache(gameDir, log) {
  const files = findCacheFiles(gameDir);
  if (!files.length) {
    return { error: "游戏目录里没有找到 webCaches 缓存文件（可能从未运行过游戏，或目录指错了）。" };
  }
  log(`找到 ${files.length} 个缓存文件，按新旧顺序尝试…`);
  // 缓存里会积累历史链接（authkey 只有 24 小时有效），不能取第一条，
  // 收集全部候选后取 timestamp 最新的一条。
  let best = null;
  for (const { file, mtime } of files.slice(0, 6)) {
    try {
      // 块文件一般几 MB；上限 200MB 防御异常文件
      const st = fs.statSync(file);
      if (st.size > 200 * 1024 * 1024) continue;
      const buf = fs.readFileSync(file);
      for (const c of collectGachaUrls(buf)) {
        if (!best || c.ts > best.ts) {
          best = { ...c, cacheFile: file, cacheMtime: new Date(mtime).toLocaleString() };
        }
      }
    } catch (e) {
      log(`读取失败：${path.relative(gameDir, file)}（${e.message}）`);
    }
  }
  if (!best) {
    return {
      error:
        "缓存里没找到跃迁记录链接。请先在游戏里打开「跃迁 → 历史记录」并翻几页，再回来提取（缓存只在你打开页面时才会写入）。",
    };
  }
  // 最新一条也过期的话直接说明白，避免用户拿着死链接反复试。
  const ageHours = best.ts ? (Date.now() / 1000 - best.ts) / 3600 : Infinity;
  if (ageHours > 23) {
    const days = Math.max(1, Math.floor(ageHours / 24));
    return {
      error:
        `缓存里最新的一条链接也是 ${days} 天前的，authkey 已过期（有效期只有 24 小时）。` +
        "请在游戏里重新打开「跃迁 → 历史记录」并翻几页，等 10 秒左右（新链接写入缓存有延迟），再回来提取。",
    };
  }
  log(`命中（${best.mode} 模式）：${path.relative(gameDir, best.cacheFile)}`);
  return {
    url: best.url,
    cacheFile: best.cacheFile,
    cacheMtime: best.cacheMtime,
  };
}

// ─────────────────────────────── 插件对象 ───────────────────────────────
module.exports = {
  registerTools(ctx) {
    return [
      {
        id: "warp_record_url_extract",
        name: "提取跃迁记录链接",
        description:
          "从《崩坏：星穹铁道》本地缓存提取跃迁记录页面链接（含临时 authkey）。参数 mode: auto=自动检测游戏目录；manual=使用窗口手动指定的目录。失败时返回人话原因。",
        enabled: true,
        risk: "fs-read",
        inputSchema: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: ["auto", "manual"],
              description: "auto=自动检测游戏目录（默认），manual=使用手动指定的目录",
            },
          },
        },
        execute: async (args) => {
          const settings = ctx.getSettings();
          const log = (m) => ctx.log(m);
          let located = null;
          if ((args && args.mode) === "manual") {
            const manual = normalizeConfiguredDir(readState().manualGameDir);
            located = manual ? { dir: manual, source: "窗口手动指定" } : null;
          } else {
            located = await resolveGameDir(settings, log);
          }
          if (!located) {
            return JSON.stringify({
              ok: false,
              error: "没有找到游戏安装目录。请在插件窗口里手动指定，或在插件设置里填写游戏安装路径。",
            });
          }
          log(`游戏目录（${located.source}）：${located.dir}`);
          const result = await extractFromCache(located.dir, log);
          if (result.error) return JSON.stringify({ ok: false, error: result.error, gameDir: located.dir });
          return JSON.stringify({ ok: true, gameDir: located.dir, ...result });
        },
      },
      {
        id: "warp_record_url_set_dir",
        name: "指定游戏目录",
        description: "手动保存《崩坏：星穹铁道》安装目录（自动检测失败时的兜底）。参数 dir: 游戏目录或 StarRail.exe 完整路径。",
        enabled: true,
        risk: "safe",
        inputSchema: {
          type: "object",
          properties: { dir: { type: "string", description: "游戏安装目录或 StarRail.exe 完整路径" } },
          required: ["dir"],
        },
        execute: async (args) => {
          const dir = String((args && args.dir) || "").trim();
          if (!dir) return "目录不能为空";
          if (!exists(dir.replace(/^"|"$/g, ""))) return "该路径不存在，请检查后重试";
          writeState({ manualGameDir: dir });
          return "已保存，现在可以点「提取链接」了";
        },
      },
      {
        id: "warp_record_url_guide_state",
        name: "说明页状态",
        description: "读取/更新跃迁记录插件「首次启动说明页」的展示状态。action: get=是否已看过；seen=标记为已看过。",
        enabled: true,
        risk: "safe",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["get", "seen"], description: "get=查询，seen=标记已看过" },
          },
          required: ["action"],
        },
        execute: async (args) => {
          const action = args && args.action;
          if (action === "seen") {
            writeState({ guideSeen: true });
            return JSON.stringify({ guideSeen: true });
          }
          return JSON.stringify({ guideSeen: !!readState().guideSeen });
        },
      },
    ];
  },

  onEnable(ctx) {
    dataDir = ctx.app.dataPath;
    ctx.log("已启用：跃迁记录链接提取（读游戏本地 WebCache，全程本地处理）");
  },
};
