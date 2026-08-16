// 插件系统 —— 管理器（第一期）。
// 职责：启动扫描 → index.json 变更检测 → 按 enabled 加载代码 → 注册工具进 ToolRegistry。
// 核心功能（天气/邮件/搜索等）不走此通道，永久固定在主工程；本模块只承接增量扩展。
// 异常隔离：任何插件的加载/执行失败只影响自身，绝不影响主进程。

import * as fs from "fs";
import * as path from "path";
import { spawn, spawnSync } from "child_process";
import { app } from "electron";
import { toolRegistry } from "../orchestrator/tool-registry";
import { scanAllPlugins, toIndexEntry, writePluginIndex, type ScannedPlugin } from "./scanner";
import { configurePluginState, loadPluginState, savePluginState, readEnabledState, type PluginStateMap } from "./state";
import { configureWindowHost, openPluginWindow, closePluginWindow, closeAllPluginWindows, notifyPluginWindowSettingsChanged } from "./window-host";
import type { CyrenePlugin, PluginContext, PluginEntry, PluginView } from "./types";

const LOG_PREFIX = "[Plugins]";

/** 插件注册表：id → 运行时条目。 */
const entries = new Map<string, PluginEntry & { impl?: CyrenePlugin; ctx?: PluginContext }>();
let state: PluginStateMap = {};
let userDataPath = "";
let preloadPath = "";

// ── 宿主服务注册表（接口规范 §8）──────────────────────
// 宿主侧（能碰 Electron 的模块）按名注册能力服务，插件经 ctx.services 按名取用。
const serviceRegistry = new Map<string, unknown>();

/** 注册一个宿主服务（必须在 initPlugins 之前调用）。同名后注册覆盖。 */
export function registerPluginService(name: string, impl: unknown): void {
  serviceRegistry.set(name, impl);
}

/** 按插件清单的 uses 声明解析可用服务；未声明/未提供的一律不出现在结果里。 */
function resolveServices(entry: PluginEntry): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const name of entry.manifest.uses ?? []) {
    const impl = serviceRegistry.get(name);
    if (impl === undefined) {
      console.warn(LOG_PREFIX, `${entry.id}: 声明依赖宿主服务 "${name}"，但宿主未提供`);
      continue;
    }
    resolved[name] = impl;
  }
  return resolved;
}

// ── 插件状态迁移（核心功能改造为插件时搬运存量配置）─────────────
type PluginStateEntryLike = { enabled?: boolean; settings?: Record<string, unknown> };
type StateMigration = (current: PluginStateEntryLike | undefined) => PluginStateEntryLike | undefined;
const stateMigrations = new Map<string, StateMigration>();

/** 注册某插件的一次性状态迁移（必须在 initPlugins 之前调用）。
 *  迁移函数自行判重（如已有 settings 则原样返回），框架不重复干预。 */
export function registerPluginStateMigration(id: string, migrate: StateMigration): void {
  stateMigrations.set(id, migrate);
}

function applyStateMigrations(): void {
  let changed = false;
  for (const [id, migrate] of stateMigrations) {
    try {
      const next = migrate(state[id]);
      if (next !== state[id] && next !== undefined) {
        state[id] = next;
        changed = true;
        console.log(LOG_PREFIX, `已迁移存量配置到插件: ${id}`);
      }
    } catch (err) {
      console.warn(LOG_PREFIX, `状态迁移失败（忽略）: ${id}`, err);
    }
  }
  stateMigrations.clear();
  if (changed) savePluginState(state);
}

// ── 管理员权限检测 ────────────────────────────────────────

let elevatedCache: boolean | null = null;

/** 当前进程是否以管理员身份运行（Windows: net session 探测；其他平台视为非提权）。 */
export function isElevated(): boolean {
  if (elevatedCache !== null) return elevatedCache;
  if (process.platform !== "win32") {
    elevatedCache = false;
    return false;
  }
  try {
    const r = spawnSync("net", ["session"], { timeout: 3000, windowsHide: true });
    elevatedCache = r.status === 0;
  } catch {
    elevatedCache = false;
  }
  return elevatedCache;
}

/** 以管理员身份重启应用（UAC 由 Start-Process -Verb RunAs 触发）。 */
export function relaunchElevated(): void {
  if (process.platform !== "win32") return;
  const exe = process.execPath;
  try {
    spawn(
      "powershell",
      ["-NoProfile", "-Command", `Start-Process -FilePath '${exe}' -Verb RunAs`],
      { detached: true, stdio: "ignore" },
    ).unref();
    app.quit();
  } catch (err) {
    console.warn(LOG_PREFIX, "提权重启失败:", err);
  }
}

// ── 配置读取 ─────────────────────────────────────────────

/** 合并 schema 默认值与持久化值，返回该插件的完整配置。 */
export function getPluginSettings(id: string): Record<string, unknown> {
  const entry = entries.get(id);
  if (!entry) return {};
  const saved = state[id]?.settings ?? {};
  const merged: Record<string, unknown> = {};
  for (const field of entry.manifest.settingsSchema ?? []) {
    merged[field.key] = field.key in saved ? saved[field.key] : field.default;
  }
  // 保存了 schema 之外的键也透传（向前兼容）
  for (const [k, v] of Object.entries(saved)) {
    if (!(k in merged)) merged[k] = v;
  }
  return merged;
}

function buildContext(entry: PluginEntry): PluginContext {
  const settingsChangeCallbacks: Array<() => void> = [];
  (entry as { __settingsChangeCallbacks?: Array<() => void> }).__settingsChangeCallbacks = settingsChangeCallbacks;
  const dataPath = path.join(userDataPath, "plugins", entry.id, "data");
  try {
    fs.mkdirSync(dataPath, { recursive: true });
  } catch { /* 目录创建失败不阻断，插件自己会感知 */ }
  return {
    getSettings: () => getPluginSettings(entry.id),
    onSettingsChange: (cb) => { settingsChangeCallbacks.push(cb); },
    log: (msg) => console.log(`${LOG_PREFIX}[${entry.id}] ${msg}`),
    isElevated,
    app: { userDataPath, dataPath },
    services: resolveServices(entry),
  };
}

// ── 加载 / 卸载 ──────────────────────────────────────────

function loadEntry(entry: PluginEntry & { impl?: CyrenePlugin; ctx?: PluginContext }): void {
  if (entry.loaded) return;
  entry.loadError = undefined;

  // 管理员门槛：声明 requiresAdmin 但未提权 → 不加载，等 UI 引导提权
  if (entry.manifest.requiresAdmin && !isElevated()) {
    entry.loadError = "needs-admin";
    console.log(LOG_PREFIX, `${entry.id} 声明需要管理员权限，当前未提权，暂不加载`);
    return;
  }

  try {
    const entryPath = path.join(entry.dirPath, entry.manifest.entry);
    // 清 require 缓存，支持插件文件热替换后重启生效
    try { delete require.cache[require.resolve(entryPath)]; } catch { /* 首次加载无缓存 */ }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(entryPath);
    const impl: CyrenePlugin = typeof mod === "function" ? mod() : (mod?.default ?? mod);
    if (!impl || typeof impl !== "object") {
      throw new Error("入口模块未导出插件对象（module.exports 应为对象或返回对象的工厂函数）");
    }

    const ctx = buildContext(entry);
    entry.impl = impl;
    entry.ctx = ctx;

    // 注册工具（与核心工具 id 冲突时跳过并告警，绝不覆盖核心功能）
    const tools = impl.registerTools?.(ctx) ?? [];
    for (const tool of tools) {
      if (toolRegistry.getById(tool.id)) {
        console.warn(LOG_PREFIX, `${entry.id}: 工具 id "${tool.id}" 已被占用，跳过注册`);
        continue;
      }
      toolRegistry.register(tool);
      entry.registeredToolIds.push(tool.id);
    }

    entry.loaded = true;
    void Promise.resolve(impl.onEnable?.(ctx)).catch((err) => {
      console.warn(LOG_PREFIX, `${entry.id} onEnable 异常:`, err);
    });
    console.log(LOG_PREFIX, `已加载: ${entry.id} v${entry.manifest.version}（工具: ${entry.registeredToolIds.join(", ") || "无"}）`);
  } catch (err) {
    entry.loaded = false;
    entry.loadError = err instanceof Error ? err.message : String(err);
    console.warn(LOG_PREFIX, `加载失败（已隔离）: ${entry.id}`, entry.loadError);
  }
}

function unloadEntry(entry: PluginEntry & { impl?: CyrenePlugin; ctx?: PluginContext }): void {
  if (!entry.loaded) return;
  closePluginWindow(entry.id);
  for (const toolId of entry.registeredToolIds) {
    toolRegistry.unregister(toolId);
  }
  entry.registeredToolIds = [];
  try {
    void entry.impl?.onDisable?.(entry.ctx!);
  } catch (err) {
    console.warn(LOG_PREFIX, `${entry.id} onDisable 异常:`, err);
  }
  entry.loaded = false;
}

// ── 初始化 ───────────────────────────────────────────────

export interface InitPluginsOptions {
  /** app.getAppPath()，内置插件根 = appPath/plugins */
  appPath: string;
  /** app.getPath("userData")，用户插件根 = userData/plugins */
  userDataPath: string;
  /** plugin-window preload 编译产物路径 */
  pluginWindowPreloadPath: string;
  appIconPath?: string;
}

/** 应用启动时调用一次（放在 initSkills 之后）。 */
export function initPlugins(options: InitPluginsOptions): void {
  userDataPath = options.userDataPath;
  preloadPath = options.pluginWindowPreloadPath;
  configurePluginState(userDataPath);
  state = loadPluginState();
  applyStateMigrations();

  const builtinRoot = path.join(options.appPath, "plugins");
  const userRoot = path.join(userDataPath, "plugins");
  const scanned = scanAllPlugins(builtinRoot, userRoot);

  for (const p of scanned) {
    const entry: PluginEntry & { impl?: CyrenePlugin; ctx?: PluginContext } = {
      id: p.id,
      manifest: p.manifest,
      dirPath: p.dirPath,
      iconPath: p.iconPath,
      source: p.source,
      enabled: readEnabledState(state, p.id, p.manifest.defaultEnabled),
      loaded: false,
      registeredToolIds: [],
    };
    entries.set(p.id, entry);
  }

  // index.json：清单落盘 + 与上次 diff（变更检测）
  const indexPath = path.join(userDataPath, "plugins", "index.json");
  const diff = writePluginIndex(indexPath, scanned.map(toIndexEntry));
  if (diff.added.length > 0) console.log(LOG_PREFIX, "新增插件:", diff.added.join(", "));
  if (diff.removed.length > 0) console.log(LOG_PREFIX, "移除插件:", diff.removed.join(", "));

  // 装配窗口宿主
  configureWindowHost({
    getEntry: (id) => entries.get(id),
    getSettings: getPluginSettings,
    callTool: async (_pluginId, toolId, args) => {
      const tool = toolRegistry.getById(toolId);
      if (!tool) return "[plugin-window] 工具不存在";
      return tool.execute(args);
    },
    preloadPath,
    appIconPath: options.appIconPath,
  });

  // 只加载启用的插件；禁用的登记在册，开关打开时再加载
  for (const entry of entries.values()) {
    if (entry.enabled) loadEntry(entry);
  }

  console.log(LOG_PREFIX, `扫描到 ${entries.size} 个插件:`, Array.from(entries.keys()).join(", ") || "(无)");
}

// ── 设置页 API ───────────────────────────────────────────

/** 图标 data URL 缓存（id → dataUrl；读失败记空串避免反复读盘）。 */
const iconUrlCache = new Map<string, string>();

const ICON_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
};

/** 读插件图标转 data URL 供设置页卡片展示；无图标返回 undefined。 */
function getPluginIconUrl(entry: PluginEntry): string | undefined {
  if (!entry.iconPath) return undefined;
  const cached = iconUrlCache.get(entry.id);
  if (cached !== undefined) return cached || undefined;
  try {
    const buf = fs.readFileSync(entry.iconPath);
    const mime = ICON_MIME[path.extname(entry.iconPath).toLowerCase()] ?? "image/png";
    const url = `data:${mime};base64,${buf.toString("base64")}`;
    iconUrlCache.set(entry.id, url);
    return url;
  } catch (err) {
    console.warn(LOG_PREFIX, `${entry.id} 图标读取失败:`, err);
    iconUrlCache.set(entry.id, "");
    return undefined;
  }
}

/** 设置页列表视图。 */
export function listPluginsForUi(): PluginView[] {
  const elevated = isElevated();
  return Array.from(entries.values()).map((entry) => ({
    id: entry.id,
    name: entry.manifest.name,
    description: entry.manifest.description,
    version: entry.manifest.version,
    source: entry.source,
    enabled: entry.enabled,
    loaded: entry.loaded,
    loadError: entry.loadError,
    requiresAdmin: entry.manifest.requiresAdmin === true,
    elevated,
    risk: entry.manifest.risk ?? [],
    uiMode: entry.manifest.ui?.mode ?? "settings",
    windowPolicy: entry.manifest.ui?.mode === "window" ? entry.manifest.ui.window?.policy ?? "reuse" : undefined,
    iconUrl: getPluginIconUrl(entry),
    settingsSchema: entry.manifest.settingsSchema ?? [],
    settings: getPluginSettings(entry.id),
  }));
}

/** 切换插件开关：持久化 + 加载/卸载。requiresAdmin 且未提权时拒绝开启。 */
export function setPluginEnabled(id: string, enabled: boolean): { ok: boolean; error?: string } {
  const entry = entries.get(id);
  if (!entry) return { ok: false, error: "插件不存在" };
  if (enabled && entry.manifest.requiresAdmin && !isElevated()) {
    return { ok: false, error: "needs-admin" };
  }
  entry.enabled = enabled;
  state[id] = { ...state[id], enabled };
  savePluginState(state);
  if (enabled) {
    loadEntry(entry);
  } else {
    unloadEntry(entry);
  }
  return { ok: true };
}

/** 保存插件配置：持久化 + 通知插件 + 推送窗口。 */
export function setPluginSettings(id: string, settings: Record<string, unknown>): { ok: boolean; error?: string } {
  const entry = entries.get(id);
  if (!entry) return { ok: false, error: "插件不存在" };
  state[id] = { ...state[id], settings };
  savePluginState(state);
  const callbacks = (entry as { __settingsChangeCallbacks?: Array<() => void> }).__settingsChangeCallbacks ?? [];
  for (const cb of callbacks) {
    try { cb(); } catch (err) { console.warn(LOG_PREFIX, `${id} settingsChange 回调异常:`, err); }
  }
  notifyPluginWindowSettingsChanged(id);
  return { ok: true };
}

/** 打开 window 模式插件的独立窗口。 */
export function openPluginWindowById(id: string): { ok: boolean; error?: string } {
  return openPluginWindow(id);
}

/** 以管理员身份重启（设置页警告框确认按钮）。 */
export function relaunchAsAdmin(): void {
  relaunchElevated();
}

/** 应用退出前调用：dispose 所有插件 + 关窗。 */
export function disposeAllPlugins(): void {
  for (const entry of entries.values()) {
    if (entry.loaded) {
      try { entry.impl?.dispose?.(entry.ctx!); } catch { /* 退出期忽略 */ }
    }
  }
  closeAllPluginWindows();
}

/** 测试辅助：清空注册表。 */
export function clearPluginsForTest(): void {
  for (const entry of entries.values()) {
    for (const toolId of entry.registeredToolIds) toolRegistry.unregister(toolId);
  }
  entries.clear();
  iconUrlCache.clear();
  serviceRegistry.clear();
  stateMigrations.clear();
  state = {};
  userDataPath = "";
  elevatedCache = null;
}
