// 插件窗口 preload —— 暴露受限的 window.cyrenePlugin 桥。
// 插件 id 由 BrowserWindow 的 additionalArguments 传入（--cyrene-plugin-id=<id>），
// 桥只能操作自己插件的配置与工具，天然隔离。

import { contextBridge, ipcRenderer } from "electron";

function readPluginId(): string {
  for (const arg of process.argv) {
    if (arg.startsWith("--cyrene-plugin-id=")) {
      return arg.slice("--cyrene-plugin-id=".length);
    }
  }
  return "";
}

const pluginId = readPluginId();

contextBridge.exposeInMainWorld("cyrenePlugin", {
  /** 本插件的 id。 */
  pluginId,
  /** 读取本插件配置（schema 默认值已合并）。 */
  getSettings: (): Promise<Record<string, unknown>> =>
    ipcRenderer.invoke("plugin-window:get-settings", pluginId),
  /** 配置在设置页被修改时的订阅。返回取消函数。 */
  onSettingsChange: (cb: () => void): (() => void) => {
    const listener = () => cb();
    ipcRenderer.on("plugin-window:settings-changed", listener);
    return () => ipcRenderer.removeListener("plugin-window:settings-changed", listener);
  },
  /** 调用本插件注册的工具（非本插件工具会被主进程拒绝）。 */
  callTool: (toolId: string, args: Record<string, unknown> = {}): Promise<string> =>
    ipcRenderer.invoke("plugin-window:call-tool", { pluginId, toolId, args }),
});
