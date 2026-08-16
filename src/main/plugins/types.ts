// 插件系统 —— 类型定义（第一期）。
// 插件 id 永远 = 目录名（kebab-case），是唯一对外标识。
// 设计原则：核心功能（天气/邮件/搜索等）固定不动，插件栏只承接增量扩展。

import type { ToolDefinition } from "../orchestrator/tool-registry";

/** 插件权限声明：与 permission.ts 的工具风险档位对齐 + admin 提权标记。 */
export type PluginRisk = "safe" | "network" | "fs-read" | "fs-write" | "shell";

/** settingsSchema 支持的字段类型。 */
export type PluginSettingFieldType = "text" | "select" | "checkbox" | "number";

/** 配置表单字段声明，设置页据此自动渲染。 */
export interface PluginSettingField {
  key: string;                    // 配置键名
  type: PluginSettingFieldType;
  label: string;                  // 展示文案
  default?: unknown;              // 默认值
  placeholder?: string;           // text 占位提示
  secret?: boolean;               // true = 密码态（掩码输入）
  options?: Array<{ value: string; label: string }>;  // select 专用
  section?: string;               // 分组标题（排版声明）
  /** 条件显隐：{ key, equals } 满足时才显示本字段。 */
  visibleWhen?: { key: string; equals: unknown };
}

/** 窗口启动策略：插件被调用时检查并据此决定窗口行为。
 *  - new:        前台运行，每次调用新建窗口
 *  - background: 后台静默，不建窗口（纯逻辑运行）
 *  - reuse:      前台运行，已有窗口则复用并适当拉伸，没有才新建（默认） */
export type PluginWindowPolicy = "new" | "background" | "reuse";

/** UI 模式声明：window = 插件自带独立窗口；settings = 纯声明式配置（默认）。 */
export interface PluginUiConfig {
  mode: "window" | "settings";
  /** window 模式：插件包内 UI 入口（相对路径，如 window/index.html） */
  entry?: string;
  /** window 模式：窗口参数 */
  window?: {
    width?: number;
    height?: number;
    title?: string;
    resizable?: boolean;
    /** 启动策略，缺省 "reuse"。 */
    policy?: PluginWindowPolicy;
  };
}

/** plugin.json 清单规范。 */
export interface PluginManifest {
  id: string;                     // = 目录名，kebab-case
  name: string;                   // 展示名
  description: string;            // 展示 + 日志
  version: string;
  entry: string;                  // 入口文件（编译后的 JS）
  defaultEnabled: boolean;
  /** 插件图标（相对包目录的路径，如 icon.png）。
   *  用途：新建窗口的窗口图标 + 设置页卡片展示。扫描时校验文件存在。 */
  icon?: string;
  requiresAdmin?: boolean;        // 声明需要管理员身份（运行时弹警告 + 提权）
  risk?: PluginRisk[];            // 权限声明
  /** 依赖的宿主服务名（如 ["gamebot"]）。纯声明，供扫描校验与用户知情；
   *  运行时从 ctx.services 按名取用，未提供时为 undefined。 */
  uses?: string[];
  settingsSchema?: PluginSettingField[];
  ui?: PluginUiConfig;
}

/** 一个插件的完整内存表示。 */
export interface PluginEntry {
  id: string;
  manifest: PluginManifest;
  dirPath: string;                // 插件目录绝对路径
  /** 图标绝对路径（扫描时已确认存在）；未声明或文件缺失为 undefined，UI 回落 emoji。 */
  iconPath?: string;
  source: "builtin" | "user";
  enabled: boolean;               // 运行时状态（持久化到 plugin-state.json）
  loaded: boolean;                // 代码是否已加载并注册工具
  registeredToolIds: string[];    // 该插件注册进 ToolRegistry 的工具 id
  loadError?: string;             // 加载失败原因（异常隔离）
}

/** 框架注入插件的执行上下文（受限能力暴露）。 */
export interface PluginContext {
  /** 读该插件自己的配置（settingsSchema 持久化值，未设置的回落 default）。 */
  getSettings(): Record<string, unknown>;
  /** 配置变更订阅：设置页保存后触发。 */
  onSettingsChange(cb: () => void): void;
  /** 带插件 id 前缀的日志。 */
  log(msg: string): void;
  /** 当前进程是否已以管理员身份运行。 */
  isElevated(): boolean;
  /** 受限的应用信息。 */
  app: {
    userDataPath: string;
    /** 插件自己的数据目录（userData/plugins/<id>/data），已确保存在。 */
    dataPath: string;
  };
  /** 宿主注入的具名服务（插件清单用 uses 声明）。未提供/未声明时为 undefined，插件必须判空降级。 */
  services: Record<string, unknown>;
}

/** 插件模块实现的接口（Agent 侧核心契约）。 */
export interface CyrenePlugin {
  /** 返回该插件提供的工具，由框架注册进 ToolRegistry。可返回空数组（纯 UI 插件）。 */
  registerTools?(ctx: PluginContext): ToolDefinition[];
  /** 用户在设置页打开插件开关时调用。 */
  onEnable?(ctx: PluginContext): void | Promise<void>;
  /** 关闭时调用（框架会自动注销其工具、销毁其窗口）。 */
  onDisable?(ctx: PluginContext): void | Promise<void>;
  /** window 模式：窗口创建后的钩子（可借此推送初始状态）。 */
  onWindowOpen?(ctx: PluginContext): void;
  /** 应用退出时清理。 */
  dispose?(ctx: PluginContext): void;
}

/** 设置页列表用的插件视图模型。 */
export interface PluginView {
  id: string;
  name: string;
  description: string;
  version: string;
  source: "builtin" | "user";
  enabled: boolean;
  loaded: boolean;
  loadError?: string;
  requiresAdmin: boolean;
  /** 当前进程是否已提权（requiresAdmin 插件据此决定能否启用）。 */
  elevated: boolean;
  risk: PluginRisk[];
  uiMode: "window" | "settings";
  /** window 模式的启动策略；settings 模式恒为 undefined。 */
  windowPolicy?: PluginWindowPolicy;
  /** 插件图标 data URL（卡片展示用）；未提供图标时 undefined，UI 回落 emoji。 */
  iconUrl?: string;
  settingsSchema: PluginSettingField[];
  settings: Record<string, unknown>;
}

/** userData/plugins/index.json 清单条目（启动扫描产物 + 变更检测用）。 */
export interface PluginIndexEntry {
  id: string;
  name: string;
  version: string;
  source: "builtin" | "user";
  uiMode: "window" | "settings";
  requiresAdmin: boolean;
  scannedAt: string;              // ISO 时间戳
}
