// 插件系统 —— window 模式宿主。
// 大项目型插件（如货币战争级别）自带 UI：框架只负责建窗口、管生命周期、提供受限 IPC 桥。
// 桥按插件 id 隔离：只能读自己的配置、调自己注册的工具。

import { BrowserWindow, ipcMain } from "electron";
import * as path from "path";
import type { PluginEntry } from "./types";

const LOG_PREFIX = "[Plugins:Window]";

/** 插件窗口集合：id → 窗口实例列表（policy=new 时可多窗）。 */
const windows = new Map<string, BrowserWindow[]>();

/** 读取插件声明的启动策略，缺省 reuse。 */
function policyOf(entry: PluginEntry): "new" | "background" | "reuse" {
  const p = entry.manifest.ui?.window?.policy;
  return p === "new" || p === "background" ? p : "reuse";
}

/** 依赖注入：由 index.ts 装配，避免循环依赖。 */
export interface WindowHostDeps {
  getEntry: (id: string) => PluginEntry | undefined;
  getSettings: (id: string) => Record<string, unknown>;
  callTool: (pluginId: string, toolId: string, args: Record<string, unknown>) => Promise<string>;
  preloadPath: string;   // plugin-window preload 编译产物绝对路径
  appIconPath?: string;
}

let deps: WindowHostDeps | null = null;
let ipcRegistered = false;

export function configureWindowHost(nextDeps: WindowHostDeps): void {
  deps = nextDeps;
  if (!ipcRegistered) {
    ipcRegistered = true;
    ipcMain.handle("plugin-window:get-settings", (_event, pluginId: unknown) => {
      const id = String(pluginId ?? "");
      const entry = deps?.getEntry(id);
      if (!entry || !entry.enabled) return {};
      return deps?.getSettings(id) ?? {};
    });

    ipcMain.handle("plugin-window:call-tool", async (_event, payload: unknown) => {
      const p = payload as { pluginId?: string; toolId?: string; args?: Record<string, unknown> };
      const entry = deps?.getEntry(String(p?.pluginId ?? ""));
      if (!entry || !entry.enabled) return "[plugin-window] 插件未启用";
      const toolId = String(p?.toolId ?? "");
      // 隔离校验：只能调本插件注册的工具
      if (!entry.registeredToolIds.includes(toolId)) {
        return `[plugin-window] 工具 ${toolId} 不属于插件 ${entry.id}`;
      }
      try {
        return await (deps?.callTool(entry.id, toolId, p?.args ?? {}) ?? Promise.resolve("[plugin-window] 未初始化"));
      } catch (err) {
        return "[plugin-window] 工具执行失败: " + (err instanceof Error ? err.message : String(err));
      }
    });
  }
}

/** 打开（或按策略处理）某插件的独立窗口。
 *  调用时检查三态：new=新建；background=静默不建窗；reuse=复用已有窗口并适当拉伸。 */
export function openPluginWindow(id: string): { ok: boolean; error?: string } {
  const entry = deps?.getEntry(id);
  if (!entry) return { ok: false, error: "插件不存在" };
  if (!entry.enabled) return { ok: false, error: "插件未启用" };
  const ui = entry.manifest.ui;
  if (ui?.mode !== "window" || !ui.entry) return { ok: false, error: "该插件未声明 window UI" };

  const policy = policyOf(entry);
  const list = (windows.get(id) ?? []).filter((w) => !w.isDestroyed());
  windows.set(id, list);

  // 后台静默：不建窗口，插件纯逻辑运行
  if (policy === "background") {
    console.log(LOG_PREFIX, `插件 ${id} 为后台静默策略，不创建窗口`);
    return { ok: true };
  }

  // 前台复用：已有窗口则聚焦并适当拉伸，不新建
  if (policy === "reuse" && list.length > 0) {
    const win = list[list.length - 1];
    win.show();
    win.focus();
    stretchToManifest(win, ui);
    return { ok: true };
  }

  // 前台新建（policy=new 总是建；policy=reuse 无存量时也建）
  const win = createPluginWindow(entry, ui);
  list.push(win);
  console.log(LOG_PREFIX, `已打开插件窗口: ${id}（策略: ${policy}，当前 ${list.length} 个）`);
  return { ok: true };
}

/** 复用时的“适当拉伸”：当前尺寸小于声明尺寸时拉伸到声明值，否则尊重用户调整不动。 */
function stretchToManifest(win: BrowserWindow, ui: NonNullable<PluginEntry["manifest"]["ui"]>): void {
  const declared = ui.window ?? {};
  if (typeof declared.width !== "number" && typeof declared.height !== "number") return;
  if (win.isMaximized() || win.isMinimized()) return;
  const [cw, ch] = win.getSize();
  const tw = typeof declared.width === "number" ? Math.max(cw, declared.width) : cw;
  const th = typeof declared.height === "number" ? Math.max(ch, declared.height) : ch;
  if (tw !== cw || th !== ch) win.setSize(tw, th, true);
}

/** 按清单声明创建一个插件窗口。 */
function createPluginWindow(entry: PluginEntry, ui: NonNullable<PluginEntry["manifest"]["ui"]>): BrowserWindow {
  const htmlPath = path.join(entry.dirPath, ui.entry!);
  const w = ui.window ?? {};
  const win = new BrowserWindow({
    width: w.width ?? 1080,
    height: w.height ?? 720,
    title: w.title ?? entry.manifest.name,
    resizable: w.resizable ?? true,
    // 窗口图标：优先插件自带图标（清单 icon 声明），回落应用图标
    icon: entry.iconPath ?? deps?.appIconPath,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: deps?.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 插件 id 通过启动参数传给 preload（桥按 id 隔离）
      additionalArguments: [`--cyrene-plugin-id=${entry.id}`],
    },
  });

  win.loadFile(htmlPath).catch((err) => {
    console.warn(LOG_PREFIX, `加载插件 UI 失败 [${entry.id}]:`, err);
  });
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => {
    const list = windows.get(entry.id);
    if (list) {
      windows.set(entry.id, list.filter((x) => x !== win && !x.isDestroyed()));
    }
  });
  return win;
}

/** 向插件窗口推送配置变更（设置页保存后调用）。 */
export function notifyPluginWindowSettingsChanged(id: string): void {
  for (const win of windows.get(id) ?? []) {
    if (!win.isDestroyed()) win.webContents.send("plugin-window:settings-changed");
  }
}

/** 销毁某插件的全部窗口（禁用插件时调用）。 */
export function closePluginWindow(id: string): void {
  for (const win of windows.get(id) ?? []) {
    if (!win.isDestroyed()) win.destroy();
  }
  windows.delete(id);
}

/** 应用退出时销毁全部插件窗口。 */
export function closeAllPluginWindows(): void {
  for (const [id, list] of windows) {
    for (const win of list) {
      if (!win.isDestroyed()) win.destroy();
    }
    windows.delete(id);
  }
}
