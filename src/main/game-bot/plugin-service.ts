// gamebot 宿主服务 —— 把游戏自动化能力面注册进插件系统（接口规范 §8）。
// 货币战争等插件声明 uses:["gamebot"] 后经 ctx.services.gamebot 取用；
// 本模块是插件与 Electron 能力层（截图/输入/VLM/OCR/提权输入）的唯一桥梁。
// 同时负责把旧版 game-bot-settings.json 里的货币战争配置一次性迁移进插件状态。

import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { captureWindowTarget, findFullscreenTarget, findWindowTarget, getFullscreenFallback } from "./window-target";
import * as input from "./input";
import * as vlm from "./vlm-locator";
import { OcrClient } from "./ocr-client";
import { resolveOcrLaunchConfig } from "./ocr-runtime";
import { ElevatedInputClient } from "./elevated-input";
import { launchDetached } from "./process-tools";
import { loadGameBotSettings, resolveGameExePath } from "./settings-store";
import { registerPluginService, registerPluginStateMigration } from "../plugins";

const LOG = "[GameBot·Service]";

interface VlmConfig { baseUrl: string; apiKey: string; model: string }

interface BuildRunToolsOptions {
  vlm: VlmConfig;
  ocr: { command: string; args: string[] } | null;
  elevatedInput: boolean;
  recognitionOnly: boolean;
  processName: string;
  signal: { aborted: boolean };
}

/** 组装货币战争运行所需的全部动作工具（与旧 startGameBot 的装配逻辑一致）。 */
async function buildCurrencyWarsRunTools(opts: BuildRunToolsOptions) {
  const { vlm: vlmConfig, ocr, signal } = opts;
  let elevated: ElevatedInputClient | null = null;
  if (opts.elevatedInput && !opts.recognitionOnly && opts.processName) {
    elevated = await ElevatedInputClient.connect(app.getPath("userData"), opts.processName);
  }
  const ocrClient = ocr ? new OcrClient(ocr.command, ocr.args) : null;
  return {
    launch: async (exe: string) => { await launchDetached(exe); },
    findWindow: findWindowTarget,
    findFullscreen: findFullscreenTarget,
    fullscreenFallback: getFullscreenFallback,
    capture: captureWindowTarget,
    click: elevated ? elevated.click.bind(elevated) : input.click,
    drag: elevated ? elevated.drag.bind(elevated) : input.drag,
    key: elevated ? elevated.key.bind(elevated) : input.keyPress,
    // 尊重中止旗标的可打断延时（100ms 粒度）
    delay: async (ms: number) => {
      let remaining = ms;
      while (remaining > 0) {
        if (signal.aborted) return;
        const chunk = Math.min(remaining, 100);
        await new Promise<void>((resolve) => setTimeout(resolve, chunk));
        remaining -= chunk;
      }
    },
    recognize: async (capture: { base64: string; mime?: string; width: number; height: number }) => {
      if (ocrClient) {
        return ocrClient.recognize(Buffer.from(capture.base64, "base64"), capture.width, capture.height);
      }
      return vlm.recognizeText(vlmConfig, { base64: capture.base64, mime: capture.mime ?? "image/png" });
    },
    /** 运行结束后由插件调用：回收 OCR 子进程与提权输入连接。 */
    dispose: () => {
      try { ocrClient?.dispose(); } catch { /* 退出期忽略 */ }
      try { elevated?.dispose(); } catch { /* 退出期忽略 */ }
    },
  };
}

// ── 存量配置迁移：旧 game-bot-settings.json → currency-wars 插件状态 ──

function readLegacyGamebotSettings(): Record<string, unknown> | null {
  try {
    const p = path.join(app.getPath("userData"), "game-bot-settings.json");
    if (!fs.existsSync(p)) return null;
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    return raw && typeof raw === "object" ? raw : null;
  } catch {
    return null;
  }
}

const joinList = (v: unknown): string =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").join("，") : "";

/** 把嵌套的旧 currencyWars 配置摊平成插件 settingsSchema 的扁平键。 */
function flattenLegacyCurrencyWars(exePath: string, cw: Record<string, unknown>): Record<string, unknown> {
  return {
    exePath: typeof exePath === "string" ? exePath : "",
    flowMode: cw.flowMode,
    targetMode: cw.targetMode,
    autoLaunch: cw.autoLaunch,
    windowTitle: cw.windowTitle,
    maxRounds: cw.maxRounds,
    recognitionOnly: cw.recognitionOnly,
    elevatedInput: cw.elevatedInput,
    targetWords: joinList(cw.targetWords),
    debuffEnabled: cw.debuffEnabled,
    targetMatchAny: cw.targetMatchAny,
    stopOnTargetMatch: cw.stopOnTargetMatch,
    blockedWords: joinList(cw.blockedWords),
    blockedEnabled: cw.blockedEnabled,
    investmentTargets: joinList(cw.investmentTargets),
    investmentEnabled: cw.investmentEnabled,
    checkInvestmentWhenBlocked: cw.checkInvestmentWhenBlocked,
    strategyTargets: joinList(cw.strategyTargets),
    inGameInvestmentTargets: joinList(cw.inGameInvestmentTargets),
    combinedMainRule: cw.combinedMainRule,
    combinedBlockedRule: cw.combinedBlockedRule,
    combinedOuterInvestmentRule: cw.combinedOuterInvestmentRule,
    combinedInGameInvestmentRule: cw.combinedInGameInvestmentRule,
    fuzzyScore: cw.fuzzyScore,
    blockedFuzzyScore: cw.blockedFuzzyScore,
    buttonFuzzyScore: cw.buttonFuzzyScore,
    investmentFuzzyScore: cw.investmentFuzzyScore,
    autoDetectOcr: cw.autoDetectOcr,
    ocrCommand: cw.ocrCommand,
    ocrArgs: joinList(cw.ocrArgs),
  };
}

/** 注册 gamebot 服务 + 货币战争存量配置迁移（app.whenReady 后、initPlugins 之前调用）。 */
export function registerGamebotPluginService(): void {
  registerPluginService("gamebot", {
    getSharedConfig(): { vlm: VlmConfig; exePath: string } {
      const s = loadGameBotSettings();
      // 共享配置里的 exePath 先做目录→exe 解析，插件拿到即可直接用
      const resolved = resolveGameExePath(s.exePath);
      return { vlm: { baseUrl: s.vlm.baseUrl, apiKey: s.vlm.apiKey, model: s.vlm.model }, exePath: resolved.exe ?? s.exePath };
    },
    resolveOcrLaunch(opts: { command: string; args: string[]; autoDetect: boolean }) {
      return resolveOcrLaunchConfig({
        command: opts.command,
        args: opts.args,
        autoDetect: opts.autoDetect,
        appPath: app.getAppPath(),
      });
    },
    buildCurrencyWarsRunTools,
  });

  registerPluginStateMigration("currency-wars", (current) => {
    // 判重：插件已有用户保存的配置就不覆盖
    if (current?.settings && Object.keys(current.settings).length > 0) return current;
    const legacy = readLegacyGamebotSettings();
    const cw = (legacy?.currencyWars ?? null) as Record<string, unknown> | null;
    if (!legacy || !cw || typeof cw !== "object") return current;
    const settings = flattenLegacyCurrencyWars(String(legacy.exePath ?? ""), cw);
    console.log(LOG, "检测到旧版货币战争配置，迁移到 currency-wars 插件");
    return { ...current, settings };
  });
}
