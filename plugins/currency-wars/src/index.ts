// currency-wars 插件入口 —— 实现插件接口契约（见《昔涟插件接口调用规范》）。
// 职责拆分：
//  - 运行核心（runner.ts/types.ts/image-detectors.ts/text-matcher.ts）：纯逻辑，不碰 Electron；
//  - 宿主能力（截图/识别/键鼠/提权输入）：全部经 ctx.services.gamebot 注入；
//  - UI：window 模式控制台（window/index.html），配置走 settingsSchema 声明式表单。

import * as fs from "fs";
import * as path from "path";
import { runCurrencyWars, type CurrencyWarsRunTools } from "./runner";
import {
  DEFAULT_CURRENCY_WARS_SETTINGS,
  normalizeCurrencyWarsSettings,
  type CurrencyWarsSettings,
} from "./types";
import type { OcrResult, WindowTarget } from "./host-types";

// ── 宿主服务面（与 src/main/game-bot/plugin-service.ts 对齐）──

interface GamebotService {
  getSharedConfig(): { vlm: { baseUrl: string; apiKey: string; model: string }; exePath: string };
  resolveOcrLaunch(opts: { command: string; args: string[]; autoDetect: boolean }):
    { command: string; args: string[]; source: string } | null;
  buildCurrencyWarsRunTools(opts: {
    vlm: { baseUrl: string; apiKey: string; model: string };
    ocr: { command: string; args: string[] } | null;
    elevatedInput: boolean;
    recognitionOnly: boolean;
    processName: string;
    signal: { aborted: boolean };
  }): Promise<CurrencyWarsRunTools>;
}

interface PluginCtx {
  getSettings(): Record<string, unknown>;
  onSettingsChange(cb: () => void): void;
  log(msg: string): void;
  isElevated(): boolean;
  app: { userDataPath: string; dataPath: string };
  services: Record<string, unknown>;
}

// ── 运行状态（currency_wars_status 工具与控制台窗口轮询的对象）──

interface RunState {
  running: boolean;
  progress: { index: number; total: number; desc: string };
  log: string[];
  lastResult: { ok: boolean; rounds: number; matched?: string; error?: string } | null;
}

const state: RunState = {
  running: false,
  progress: { index: 0, total: 0, desc: "" },
  log: [],
  lastResult: null,
};

function pushLog(line: string): void {
  state.log.unshift(`${new Date().toLocaleTimeString()} ${line}`);
  if (state.log.length > 200) state.log.length = 200;
}

// ── 配置转换：schema 扁平值 → CurrencyWarsSettings ──

/** text 字段里的列表约定：逗号/顿号/换行分隔。 */
function splitList(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim()) return [];
  return Array.from(new Set(
    value.split(/[\r\n，,、]/).map((s) => s.trim()).filter(Boolean),
  ));
}

function toRunSettings(raw: Record<string, unknown>): CurrencyWarsSettings {
  const d = DEFAULT_CURRENCY_WARS_SETTINGS;
  return normalizeCurrencyWarsSettings({
    flowMode: raw.flowMode as CurrencyWarsSettings["flowMode"],
    targetMode: raw.targetMode as CurrencyWarsSettings["targetMode"],
    autoLaunch: raw.autoLaunch as boolean,
    windowTitle: raw.windowTitle as string,
    targetWords: splitList(raw.targetWords ?? d.targetWords.join("，")),
    debuffEnabled: raw.debuffEnabled as boolean,
    targetMatchAny: raw.targetMatchAny as boolean,
    blockedWords: splitList(raw.blockedWords ?? d.blockedWords.join("，")),
    blockedEnabled: raw.blockedEnabled as boolean,
    investmentTargets: splitList(raw.investmentTargets ?? d.investmentTargets.join("，")),
    investmentEnabled: raw.investmentEnabled as boolean,
    checkInvestmentWhenBlocked: raw.checkInvestmentWhenBlocked as boolean,
    strategyTargets: splitList(raw.strategyTargets ?? d.strategyTargets.join("，")),
    inGameInvestmentTargets: splitList(raw.inGameInvestmentTargets ?? d.inGameInvestmentTargets.join("，")),
    combinedMainRule: raw.combinedMainRule as CurrencyWarsSettings["combinedMainRule"],
    combinedBlockedRule: raw.combinedBlockedRule as CurrencyWarsSettings["combinedBlockedRule"],
    combinedOuterInvestmentRule: raw.combinedOuterInvestmentRule as CurrencyWarsSettings["combinedOuterInvestmentRule"],
    combinedInGameInvestmentRule: raw.combinedInGameInvestmentRule as CurrencyWarsSettings["combinedInGameInvestmentRule"],
    fuzzyScore: raw.fuzzyScore as number,
    blockedFuzzyScore: raw.blockedFuzzyScore as number,
    buttonFuzzyScore: raw.buttonFuzzyScore as number,
    investmentFuzzyScore: raw.investmentFuzzyScore as number,
    maxRounds: raw.maxRounds as number,
    stopOnTargetMatch: raw.stopOnTargetMatch as boolean,
    recognitionOnly: raw.recognitionOnly as boolean,
    elevatedInput: raw.elevatedInput as boolean,
    autoDetectOcr: raw.autoDetectOcr as boolean,
    ocrCommand: raw.ocrCommand as string,
    ocrArgs: splitList(raw.ocrArgs),
  });
}

// ── 运行控制 ──

let signal: { aborted: boolean } | null = null;

function getService(ctx: PluginCtx): GamebotService | null {
  const svc = ctx.services?.gamebot as GamebotService | undefined;
  return svc && typeof svc.buildCurrencyWarsRunTools === "function" ? svc : null;
}

/**
 * 解析游戏 exe 路径：允许配置直接指向 exe，也允许指向游戏目录（自动在里面找 StarRail.exe）。
 * 返回 exe 或人话报错（避免 spawn ENOENT 这类看不出原因的错误）。
 */
function resolveGameExe(raw: string): { exe?: string; error?: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { error: "[错误·配置] 未配置游戏 exe 路径（插件设置 → 基础）。" };
  try {
    const st = fs.statSync(trimmed);
    if (st.isFile()) return { exe: trimmed };
    if (st.isDirectory()) {
      const entries = fs.readdirSync(trimmed);
      const hit = entries.find((n) => n.toLowerCase() === "starrail.exe");
      if (hit) return { exe: path.join(trimmed, hit) };
      const exes = entries.filter((n) => n.toLowerCase().endsWith(".exe"));
      return {
        error:
          "[错误·配置] exe 路径指向的是目录，且目录内未找到 StarRail.exe"
          + (exes.length ? `（目录内可执行文件：${exes.slice(0, 6).join("、")}）` : "")
          + "。请把路径直接填到游戏 exe 文件（如 ...\\games\\Star Rail Game\\StarRail.exe）。",
      };
    }
    return { error: "[错误·配置] 游戏 exe 路径无效：" + trimmed };
  } catch {
    return { error: "[错误·配置] 游戏 exe 路径不存在：" + trimmed };
  }
}

async function start(ctx: PluginCtx): Promise<string> {
  if (state.running) return "⏳ 货币战争已在运行中，请先停止。";
  const svc = getService(ctx);
  if (!svc) return "[错误] 宿主未提供 gamebot 服务，无法运行货币战争。";

  const raw = ctx.getSettings();
  const settings = toRunSettings(raw);
  const shared = svc.getSharedConfig();
  const exeRaw = (typeof raw.exePath === "string" && raw.exePath.trim()) ? raw.exePath : shared.exePath;
  const resolvedExe = resolveGameExe(exeRaw);
  if (!resolvedExe.exe) return resolvedExe.error ?? "[错误·配置] exe 路径解析失败。";
  const exe = resolvedExe.exe;
  const hasVlm = Boolean(shared.vlm.baseUrl && shared.vlm.apiKey && shared.vlm.model);
  const ocrLaunch = svc.resolveOcrLaunch({
    command: settings.ocrCommand,
    args: settings.ocrArgs,
    autoDetect: settings.autoDetectOcr,
  });
  if (!hasVlm && !ocrLaunch) return "[错误·配置] 未配置可用识别器（VLM 或本地 OCR）。";

  signal = { aborted: false };
  state.running = true;
  state.lastResult = null;
  pushLog(ocrLaunch ? `启动（识别: ${ocrLaunch.source === "better-hsrcw" ? "本地 RapidOCR" : "本地 OCR"}）` : "启动（识别: VLM）");
  ctx.log("启动货币战争: " + exe);

  try {
    if (settings.elevatedInput && !settings.recognitionOnly) pushLog("等待管理员输入助手连接…");
    const tools = await svc.buildCurrencyWarsRunTools({
      vlm: shared.vlm,
      ocr: ocrLaunch,
      elevatedInput: settings.elevatedInput,
      recognitionOnly: settings.recognitionOnly,
      processName: path.parse(exe).name,
      signal,
    });
    const disposable = tools as CurrencyWarsRunTools & { dispose?: () => void };
    void runCurrencyWars({
      exe,
      settings,
      signal,
      onProgress: (info) => {
        state.progress = info;
        pushLog(`${info.desc}${info.index >= 0 ? ` (${info.index + 1}/${info.total})` : ""}`);
      },
      tools,
    }).then((res) => {
      state.lastResult = res;
      pushLog(res.ok ? `完成，共 ${res.rounds} 轮${res.matched ? "，命中: " + res.matched : ""}` : `失败: ${res.error ?? ""}`);
      ctx.log(res.ok ? "货币战争完成" : "货币战争失败: " + (res.error ?? ""));
    }).catch((err) => {
      state.lastResult = { ok: false, rounds: 0, error: err instanceof Error ? err.message : String(err) };
      pushLog("异常: " + (err instanceof Error ? err.message : String(err)));
    }).finally(() => {
      state.running = false;
      signal = null;
      try { disposable.dispose?.(); } catch { /* 回收失败不影响结果 */ }
    });
    return "✅ 货币战争已启动，进度可在控制台窗口查看。";
  } catch (err) {
    state.running = false;
    signal = null;
    const msg = err instanceof Error ? err.message : String(err);
    pushLog("启动失败: " + msg);
    return "[错误] 启动失败: " + msg;
  }
}

/** 识别测试：按目标模式找窗口 → 截图 → OCR/VLM，返回识别文本（诊断用）。 */
async function testOcr(ctx: PluginCtx): Promise<string> {
  const svc = getService(ctx);
  if (!svc) return "[错误] 宿主未提供 gamebot 服务。";
  const raw = ctx.getSettings();
  const settings = toRunSettings(raw);
  const shared = svc.getSharedConfig();
  const exeRaw = (typeof raw.exePath === "string" && raw.exePath.trim()) ? raw.exePath : shared.exePath;
  const resolvedExe = resolveGameExe(exeRaw);
  if (!resolvedExe.exe) return resolvedExe.error ?? "[错误·配置] exe 路径解析失败。";
  const exe = resolvedExe.exe;
  const hasVlm = Boolean(shared.vlm.baseUrl && shared.vlm.apiKey && shared.vlm.model);
  const ocrLaunch = svc.resolveOcrLaunch({
    command: settings.ocrCommand,
    args: settings.ocrArgs,
    autoDetect: settings.autoDetectOcr,
  });
  if (!hasVlm && !ocrLaunch) return "[错误·配置] 未配置可用识别器（VLM 或本地 OCR）。";

  const probe: { aborted: boolean } = { aborted: false };
  const tools = await svc.buildCurrencyWarsRunTools({
    vlm: shared.vlm,
    ocr: ocrLaunch,
    elevatedInput: false,
    recognitionOnly: true,
    processName: exe ? path.parse(exe).name : "",
    signal: probe,
  });
  const disposable = tools as CurrencyWarsRunTools & { dispose?: () => void };
  let target: WindowTarget | null = null;
  let diag = "";
  try {
    if (settings.targetMode === "fullscreen" && exe) {
      target = await tools.findFullscreen(exe);
      if (!target) diag += `全屏模式进程检测失败(exe=${exe})，`;
    } else if (settings.targetMode === "window") {
      target = await tools.findWindow(settings.windowTitle);
      if (!target) diag += `窗口模式未找到标题含"${settings.windowTitle}"的窗口，`;
    }
    if (!target) target = await tools.fullscreenFallback();

    const capture = await tools.capture(target);
    const result: OcrResult | null = await tools.recognize(capture).catch(() => null);
    if (!result) return diag + "识别失败：未返回结果";
    pushLog(`识别测试成功（${result.items.length} 个文本块）`);
    return diag + "识别成功，文本预览:\n" + result.rawText.slice(0, 1200);
  } catch (err) {
    return diag + "识别测试异常: " + (err instanceof Error ? err.message : String(err));
  } finally {
    try { disposable.dispose?.(); } catch { /* 回收失败忽略 */ }
  }
}

// ── 插件契约 ──

const plugin = {
  registerTools(ctx: PluginCtx) {
    return [
      {
        id: "currency_wars_start",
        name: "货币战争·启动",
        description:
          "启动《崩坏：星穹铁道》货币战争自动运行（窗口截图 + OCR/VLM 识别，自动选祝福/投资）。\n\n" +
          "何时用：用户说“跑货币战争”“货币战争代肝”“自动刷祝福”等。\n" +
          "不要用于：用户只是问怎么配置（引导去 设置 → 插件 → 货币战争）。\n\n" +
          "无需参数。启动后独立运行，用 currency_wars_status 查进度。",
        enabled: true,
        risk: "shell" as const,
        inputSchema: { type: "object" as const, properties: {}, required: [] },
        execute: async () => start(ctx),
      },
      {
        id: "currency_wars_stop",
        name: "货币战争·停止",
        description: "停止正在运行的货币战争自动任务。用户说“停下/别跑了/取消货币战争”时调用。无需参数。",
        enabled: true,
        risk: "safe" as const,
        inputSchema: { type: "object" as const, properties: {}, required: [] },
        execute: async () => {
          if (!state.running) return "当前没有正在运行的货币战争任务。";
          if (signal) signal.aborted = true;
          pushLog("收到停止请求");
          return "⏹ 已发送停止信号，任务会在当前步骤结束后退出。";
        },
      },
      {
        id: "currency_wars_status",
        name: "货币战争·状态",
        description: "查询货币战争自动任务的运行状态与最近进度（JSON）。用户问“跑到哪了/结果如何”时调用。无需参数。",
        enabled: true,
        risk: "safe" as const,
        inputSchema: { type: "object" as const, properties: {}, required: [] },
        execute: async () => JSON.stringify(state),
      },
      {
        id: "currency_wars_test_ocr",
        name: "货币战争·识别测试",
        description: "诊断货币战争的窗口定位与文字识别：截图当前游戏画面并返回识别文本。配置后验证环境时用。无需参数。",
        enabled: true,
        risk: "safe" as const,
        inputSchema: { type: "object" as const, properties: {}, required: [] },
        execute: async () => {
          try {
            return await testOcr(ctx);
          } catch (err) {
            return "[错误] 识别测试失败: " + (err instanceof Error ? err.message : String(err));
          }
        },
      },
    ];
  },
  onEnable(ctx: PluginCtx) {
    ctx.log("货币战争插件已启用");
  },
  onDisable() {
    if (signal) signal.aborted = true;
    state.running = false;
  },
  dispose() {
    if (signal) signal.aborted = true;
  },
};

module.exports = plugin;
