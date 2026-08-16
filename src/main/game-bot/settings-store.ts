// settings-store —— game-bot 配置存取。userData/game-bot-settings.json。
// 照 index.ts 的 GeneralSettings 模式：load / save / normalize 三件套。
// 唯一碰 electron（app.getPath）；resolveGameExePath 为纯 fs 工具，供引擎与插件服务共用。

import * as fs from "fs";
import * as path from "path";
import { app } from "electron";

export interface GameBotSettings {
  enabled: boolean;
  exePath: string;
  activeRecipe: string;   // 脚本文件名（去 .yaml）
  vlm: {
    baseUrl: string;
    apiKey: string;
    model: string;
  };
}

const DEFAULTS: GameBotSettings = {
  enabled: false,
  exePath: "",
  activeRecipe: "star-rail-daily",
  vlm: { baseUrl: "", apiKey: "", model: "" },
};

function filePath(): string {
  return path.join(app.getPath("userData"), "game-bot-settings.json");
}

function normalize(input: Partial<GameBotSettings> | null | undefined): GameBotSettings {
  const v = (input?.vlm ?? {}) as { baseUrl?: string; apiKey?: string; model?: string };
  return {
    enabled: Boolean(input?.enabled),
    exePath: typeof input?.exePath === "string" ? input.exePath : "",
    activeRecipe: typeof input?.activeRecipe === "string" && input.activeRecipe
      ? input.activeRecipe : DEFAULTS.activeRecipe,
    vlm: {
      baseUrl: typeof v.baseUrl === "string" ? v.baseUrl.trim() : "",
      apiKey: typeof v.apiKey === "string" ? v.apiKey.trim() : "",
      model: typeof v.model === "string" ? v.model.trim() : "",
    },
  };
}

export function loadGameBotSettings(): GameBotSettings {
  try {
    const p = filePath();
    if (!fs.existsSync(p)) return { ...DEFAULTS };
    return normalize(JSON.parse(fs.readFileSync(p, "utf8")) as Partial<GameBotSettings>);
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveGameBotSettings(patch: Partial<GameBotSettings>): GameBotSettings {
  const existing = loadGameBotSettings();
  const merged: Partial<GameBotSettings> = { ...existing, ...patch };
  if (patch.vlm) merged.vlm = { ...existing.vlm, ...patch.vlm };
  const final = normalize(merged);
  fs.mkdirSync(path.dirname(filePath()), { recursive: true });
  fs.writeFileSync(filePath(), JSON.stringify(final, null, 2), "utf8");
  return final;
}

/**
 * 解析游戏 exe 路径：允许直接指向 exe 文件，也允许指向游戏目录（自动在目录内找可执行文件）。
 * 避免配置填了目录导致 spawn ENOENT。找不到时返回人话错误。
 */
export function resolveGameExePath(raw: string): { exe?: string; error?: string } {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { exe: "" };
  try {
    const st = fs.statSync(trimmed);
    if (st.isFile()) return { exe: trimmed };
    if (st.isDirectory()) {
      const exes = fs.readdirSync(trimmed).filter((n) => n.toLowerCase().endsWith(".exe"));
      if (exes.length === 1) return { exe: path.join(trimmed, exes[0]) };
      return {
        error:
          "exe 路径指向目录，且目录内"
          + (exes.length ? `有多个可执行文件（${exes.slice(0, 6).join("、")}），无法自动判定` : "没有可执行文件")
          + "，请直接把路径填到游戏 exe 文件。",
      };
    }
    return { error: "游戏 exe 路径无效：" + trimmed };
  } catch {
    return { error: "游戏 exe 路径不存在：" + trimmed };
  }
}
