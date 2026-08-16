// 插件系统 —— 状态持久化。
// 独立存 userData/plugin-state.json（enabled + settings），不侵入核心 settings.json，
// 避免改动 GeneralSettings 归一化链路（核心功能零改动原则）。

import * as fs from "fs";
import * as path from "path";

export interface PluginStateEntry {
  enabled?: boolean;                      // 用户开关覆盖（缺省 = manifest.defaultEnabled）
  settings?: Record<string, unknown>;     // settingsSchema 持久化值
}

export type PluginStateMap = Record<string, PluginStateEntry>;

let statePath = "";

export function configurePluginState(userDataPath: string): void {
  statePath = path.join(userDataPath, "plugin-state.json");
}

export function loadPluginState(): PluginStateMap {
  if (!statePath) return {};
  try {
    if (!fs.existsSync(statePath)) return {};
    const raw = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (!raw || typeof raw !== "object") return {};
    return raw as PluginStateMap;
  } catch {
    return {};
  }
}

export function savePluginState(state: PluginStateMap): void {
  if (!statePath) return;
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
  } catch (err) {
    console.warn("[Plugins] 持久化插件状态失败:", err);
  }
}

/** 读某插件的 enabled（用户覆盖优先，缺省回落 defaultEnabled）。 */
export function readEnabledState(state: PluginStateMap, id: string, defaultEnabled: boolean): boolean {
  const entry = state[id];
  return typeof entry?.enabled === "boolean" ? entry.enabled : defaultEnabled;
}
