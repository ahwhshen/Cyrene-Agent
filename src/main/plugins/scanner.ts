// 插件系统 —— 目录扫描与清单校验。
// 与 Skill 系统同构：扫描 builtin + user 两个根目录，user 按 id 覆盖 builtin。
// 每次启动全量扫描（开销极小），扫描结果写 userData/plugins/index.json 并与上次 diff。

import * as fs from "fs";
import * as path from "path";
import type { PluginManifest, PluginIndexEntry, PluginSettingField } from "./types";

const LOG_PREFIX = "[Plugins]";

const VALID_RISKS = new Set(["safe", "network", "fs-read", "fs-write", "shell"]);
const VALID_FIELD_TYPES = new Set(["text", "select", "checkbox", "number"]);
const VALID_WINDOW_POLICIES = new Set(["new", "background", "reuse"]);

/** 校验 plugin.json 字段。任何不合规直接返回 undefined（跳过该插件，不影响启动）。 */
export function validateManifest(value: unknown, expectedId: string): PluginManifest | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || v.id !== expectedId) return undefined;
  if (typeof v.name !== "string" || v.name.length === 0) return undefined;
  if (typeof v.description !== "string") return undefined;
  if (typeof v.version !== "string") return undefined;
  if (typeof v.entry !== "string" || v.entry.length === 0) return undefined;
  if (typeof v.defaultEnabled !== "boolean") return undefined;

  // risk：非法项剔除而不是整体拒绝（容错）
  const risk = Array.isArray(v.risk)
    ? (v.risk.filter((r) => VALID_RISKS.has(String(r))) as PluginManifest["risk"])
    : [];

  // uses：宿主服务依赖声明，只保留非空字符串项
  const uses = Array.isArray(v.uses)
    ? v.uses.filter((u): u is string => typeof u === "string" && u.length > 0)
    : undefined;

  // settingsSchema：逐字段校验，非法字段跳过
  let settingsSchema: PluginSettingField[] | undefined;
  if (Array.isArray(v.settingsSchema)) {
    settingsSchema = [];
    for (const raw of v.settingsSchema) {
      if (!raw || typeof raw !== "object") continue;
      const f = raw as Record<string, unknown>;
      if (typeof f.key !== "string" || typeof f.label !== "string") continue;
      if (!VALID_FIELD_TYPES.has(String(f.type))) continue;
      const field: PluginSettingField = {
        key: f.key,
        type: f.type as PluginSettingField["type"],
        label: f.label,
        default: f.default,
        placeholder: typeof f.placeholder === "string" ? f.placeholder : undefined,
        secret: f.secret === true,
        section: typeof f.section === "string" ? f.section : undefined,
        options: Array.isArray(f.options)
          ? f.options
              .filter((o) => o && typeof o === "object" && typeof (o as Record<string, unknown>).value === "string")
              .map((o) => ({
                value: String((o as Record<string, unknown>).value),
                label: String((o as Record<string, unknown>).label ?? (o as Record<string, unknown>).value),
              }))
          : undefined,
        visibleWhen:
          f.visibleWhen && typeof f.visibleWhen === "object" && typeof (f.visibleWhen as Record<string, unknown>).key === "string"
            ? { key: String((f.visibleWhen as Record<string, unknown>).key), equals: (f.visibleWhen as Record<string, unknown>).equals }
            : undefined,
      };
      settingsSchema.push(field);
    }
  }

  // ui 声明
  let ui: PluginManifest["ui"];
  const rawUi = v.ui as Record<string, unknown> | undefined;
  if (rawUi && typeof rawUi === "object" && rawUi.mode === "window") {
    if (typeof rawUi.entry !== "string" || rawUi.entry.length === 0) {
      console.warn(LOG_PREFIX, `${expectedId}: ui.mode=window 但缺少 ui.entry，降级为 settings 模式`);
      ui = { mode: "settings" };
    } else {
      const w = (rawUi.window ?? {}) as Record<string, unknown>;
      // 窗口启动策略三态：new=新建 / background=静默 / reuse=复用拉伸；非法值回落 reuse
      const rawPolicy = w.policy;
      const policy = typeof rawPolicy === "string" && VALID_WINDOW_POLICIES.has(rawPolicy)
        ? (rawPolicy as "new" | "background" | "reuse")
        : undefined;
      if (rawPolicy !== undefined && policy === undefined) {
        console.warn(LOG_PREFIX, `${expectedId}: 非法的 window.policy "${String(rawPolicy)}"，回落 reuse`);
      }
      ui = {
        mode: "window",
        entry: rawUi.entry,
        window: {
          width: typeof w.width === "number" ? w.width : undefined,
          height: typeof w.height === "number" ? w.height : undefined,
          title: typeof w.title === "string" ? w.title : undefined,
          resizable: typeof w.resizable === "boolean" ? w.resizable : undefined,
          policy,
        },
      };
    }
  } else {
    ui = { mode: "settings" };
  }

  return {
    id: v.id,
    name: v.name,
    description: v.description,
    version: v.version,
    entry: v.entry,
    defaultEnabled: v.defaultEnabled,
    icon: typeof v.icon === "string" && v.icon.length > 0 ? v.icon : undefined,
    requiresAdmin: v.requiresAdmin === true,
    risk,
    uses: uses && uses.length > 0 ? uses : undefined,
    settingsSchema,
    ui,
  };
}

/** 读取单个插件目录的 plugin.json。 */
export function readManifest(pluginDir: string, id: string): PluginManifest | undefined {
  const manifestPath = path.join(pluginDir, "plugin.json");
  if (!fs.existsSync(manifestPath)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return validateManifest(parsed, id);
  } catch (err) {
    console.warn(LOG_PREFIX, `plugin.json 解析失败（跳过）: ${manifestPath}`, err);
    return undefined;
  }
}

export interface ScannedPlugin {
  id: string;
  manifest: PluginManifest;
  dirPath: string;
  /** 图标绝对路径（扫描时已确认存在）；未声明或文件缺失为 undefined。 */
  iconPath?: string;
  source: "builtin" | "user";
}

/** 校验插件图标：要求插件包自带图标（用于窗口图标与卡片展示）。
 *  未声明或文件缺失只告警不拒绝，UI 侧回落 emoji。 */
function resolvePluginIcon(id: string, dirPath: string, manifest: PluginManifest): string | undefined {
  if (!manifest.icon) {
    console.warn(LOG_PREFIX, `${id}: 未声明 icon（建议在 plugin.json 里提供图标，用于窗口与卡片展示）`);
    return undefined;
  }
  const iconPath = path.join(dirPath, manifest.icon);
  if (!fs.existsSync(iconPath)) {
    console.warn(LOG_PREFIX, `${id}: 声明的图标文件不存在: ${manifest.icon}`);
    return undefined;
  }
  return iconPath;
}

/** 扫描一个根目录下的所有插件包。目录不存在返回空数组。 */
export function scanPluginDir(root: string, source: "builtin" | "user"): ScannedPlugin[] {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];  // 目录不存在或无权限
  }

  const result: ScannedPlugin[] = [];
  for (const id of entries) {
    const dirPath = path.join(root, id);
    const manifest = readManifest(dirPath, id);
    if (!manifest) {
      // 无 plugin.json 或校验失败：静默跳过（目录里可能有用户放的无关文件夹）
      if (fs.existsSync(path.join(dirPath, "plugin.json"))) {
        console.warn(LOG_PREFIX, `跳过不合规插件清单: ${dirPath}`);
      }
      continue;
    }
    result.push({ id, manifest, dirPath, iconPath: resolvePluginIcon(id, dirPath, manifest), source });
  }
  return result;
}

/** 扫描 builtin + user 两个根目录，user 按 id 覆盖 builtin。 */
export function scanAllPlugins(builtinRoot: string, userRoot: string): ScannedPlugin[] {
  const builtin = scanPluginDir(builtinRoot, "builtin");
  const user = scanPluginDir(userRoot, "user");
  const map = new Map<string, ScannedPlugin>();
  for (const p of builtin) map.set(p.id, p);
  for (const p of user) map.set(p.id, p);
  return Array.from(map.values());
}

/** 生成 index.json 清单条目。 */
export function toIndexEntry(p: ScannedPlugin): PluginIndexEntry {
  return {
    id: p.id,
    name: p.manifest.name,
    version: p.manifest.version,
    source: p.source,
    uiMode: p.manifest.ui?.mode ?? "settings",
    requiresAdmin: p.manifest.requiresAdmin === true,
    scannedAt: new Date().toISOString(),
  };
}

export interface IndexDiff {
  added: string[];
  removed: string[];
}

/** 写 index.json 并与上次清单 diff（新增/移除检测）。写入失败不影响主流程。 */
export function writePluginIndex(indexPath: string, entries: PluginIndexEntry[]): IndexDiff {
  let previous: PluginIndexEntry[] = [];
  try {
    if (fs.existsSync(indexPath)) {
      const raw = JSON.parse(fs.readFileSync(indexPath, "utf8"));
      if (Array.isArray(raw)) previous = raw;
    }
  } catch {
    previous = [];
  }

  const prevIds = new Set(previous.map((e) => e.id));
  const nextIds = new Set(entries.map((e) => e.id));
  const diff: IndexDiff = {
    added: entries.filter((e) => !prevIds.has(e.id)).map((e) => e.id),
    removed: previous.filter((e) => !nextIds.has(e.id)).map((e) => e.id),
  };

  try {
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    fs.writeFileSync(indexPath, JSON.stringify(entries, null, 2), "utf8");
  } catch (err) {
    console.warn(LOG_PREFIX, "写入 index.json 失败:", err);
  }
  return diff;
}
