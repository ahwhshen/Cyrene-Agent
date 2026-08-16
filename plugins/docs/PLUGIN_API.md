# 昔涟插件接口调用规范（v1.0）

> 本文档是插件与宿主（昔涟 Agent 主进程）之间的正式契约。
> 插件代码只允许通过本文档声明的接口与宿主交互；任何未声明的通道都不保证可用。
> 实现源码：`src/main/plugins/`（框架）、`src/preload/plugin-window.ts`（窗口桥）。

## 0. 版本兼容

| 项 | 说明 |
|---|---|
| 规范版本 | v1.0 |
| 宿主加载器 | CommonJS（`module.exports` 导出插件对象） |
| Node/Electron | 随宿主发行，插件不要依赖更高版本特性 |
| 兼容承诺 | 本文档声明的接口只增不删；破坏性变更会升大版本并在清单校验层拒绝不兼容插件 |

## 1. 插件包结构

```
plugins/<plugin-id>/
├── plugin.json        # 清单（必需）
├── index.js           # 入口（必需，编译后的 CommonJS JS）
├── icon.png           # 图标（强烈推荐，见 §3.6）
├── window/            # window 模式自带 UI（可选）
│   └── index.html
└── lib/ …             # 任意自定义模块，入口内自由 require
```

扫描根目录两个，后者按 id 覆盖前者：

| 根目录 | 用途 |
|---|---|
| `appPath/plugins/` | 内置插件，随安装包分发 |
| `userData/plugins/` | 用户自行添加的插件 |

插件 id **永远等于目录名**（kebab-case），清单里的 `id` 必须与之一致，否则整个插件被拒绝。

## 2. 生命周期

```
扫描 → 校验清单 → （首次）登记 index.json
  ↓ 用户开启开关（或 defaultEnabled）
加载 index.js → registerTools(ctx) → onEnable(ctx)
  ↓ window 模式且用户打开界面
创建窗口 → onWindowOpen(ctx)
  ↓ 用户关闭开关
onDisable(ctx) → 注销全部该插件工具 → 销毁全部该插件窗口
  ↓ 应用退出
dispose(ctx)
```

- 禁用只"下线"，不卸载模块缓存；重新启用会再次调用 `registerTools` + `onEnable`。
- 所有钩子都是可选的；纯 UI 插件可以只注册工具，纯工具插件可以不写 UI。

## 3. plugin.json 清单规范

### 3.1 必需字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 必须等于目录名（kebab-case） |
| `name` | string | 展示名（设置页卡片标题） |
| `description` | string | 一句话描述（卡片 + 日志） |
| `version` | string | 语义化版本，如 `1.0.0` |
| `entry` | string | 入口文件相对路径，通常 `index.js` |
| `defaultEnabled` | boolean | 首次扫描到时是否默认启用 |

### 3.2 可选字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `icon` | string | 图标相对路径（如 `icon.png`），建议 256×256 PNG。扫描时校验文件存在；用于新建窗口的窗口图标与设置页卡片展示。未提供则卡片回落 emoji |
| `requiresAdmin` | boolean | 需要管理员身份。未提权时不加载；用户尝试启用时弹警告并可一键提权重启 |
| `risk` | string[] | 权限声明：`safe` / `network` / `fs-read` / `fs-write` / `shell`。与宿主权限档位联动，非法项剔除 |
| `settingsSchema` | array | 配置表单声明，见 §5 |
| `ui` | object | UI 模式声明，见 §6 |

### 3.3 最小示例

```json
{
  "id": "my-plugin",
  "name": "我的插件",
  "description": "一句话描述",
  "version": "1.0.0",
  "entry": "index.js",
  "defaultEnabled": false
}
```

### 3.4 校验规则（不合规即整包拒绝）

- `id` ≠ 目录名、缺必需字段、`plugin.json` 解析失败 → 跳过该插件并在主进程日志告警；
- `risk` 中的非法项只剔除不拒绝；
- `settingsSchema` 里非法字段只跳过不拒绝；
- `icon` 声明但文件缺失 → 告警，UI 回落 emoji，不拒绝加载。

## 4. 入口契约（CyrenePlugin）

`index.js` 必须 `module.exports` 一个插件对象，可导出工厂函数 `module.exports = () => plugin`（二者等价）：

```js
module.exports = {
  registerTools(ctx) { return [/* ToolDefinition[] */]; },
  async onEnable(ctx) {},
  async onDisable(ctx) {},
  onWindowOpen(ctx) {},
  dispose(ctx) {},
};
```

| 钩子 | 调用时机 | 返回 |
|---|---|---|
| `registerTools(ctx)` | 启用加载时，框架把返回值注册进全局工具表 | `ToolDefinition[]`，可为 `[]` |
| `onEnable(ctx)` | 开关打开（含启动时已启用） | `void \| Promise<void>` |
| `onDisable(ctx)` | 开关关闭；框架随后自动注销工具、销毁窗口 | `void \| Promise<void>` |
| `onWindowOpen(ctx)` | window 模式窗口创建后 | `void` |
| `dispose(ctx)` | 应用退出 | `void` |

### 4.1 工具定义（ToolDefinition）

```ts
interface ToolDefinition {
  id: string;            // 建议带插件前缀防冲突，如 "currency_wars_start"
  name: string;          // 展示名
  description: string;   // 供 LLM 路由的一句话描述
  enabled: boolean;      // 初值，用户可在工具面板改
  risk?: "safe" | "network" | "fs-read" | "fs-write" | "shell";
  inputSchema: {         // JSON Schema（MCP 兼容）
    type: "object";
    properties: Record<string, object>;
    required?: string[];
  };
  execute: (args: Record<string, unknown>) => Promise<string>;  // 返回字符串结果
}
```

**冲突规则**：工具 `id` 与核心工具或其他插件重复时，框架跳过注册（先到先得，不覆盖），并告警。

### 4.2 PluginContext（框架注入）

```ts
interface PluginContext {
  getSettings(): Record<string, unknown>;       // 本插件配置（schema 默认值已合并）
  onSettingsChange(cb: () => void): void;       // 设置页保存后触发
  log(msg: string): void;                       // 带 "[Plugin:<id>]" 前缀的主进程日志
  isElevated(): boolean;                        // 宿主进程是否已管理员提权
  app: {
    userDataPath: string;                       // 宿主 userData 目录
    dataPath: string;                           // 本插件专属数据目录（已确保存在）
  };
}
```

约定：

- 插件**持久化数据一律写 `ctx.app.dataPath`**，不要写 userData 其他位置；
- `getSettings()` 是同步快照；配置变化以 `onSettingsChange` 通知为准，收到后重新取；
- 不要在模块顶层做副作用（require 时不启动服务），全部放 `onEnable`。

## 5. settingsSchema（声明式配置表单）

设置页按 schema 自动渲染，不需要插件写任何 UI 代码。

```json
{
  "settingsSchema": [
    { "key": "apiKey", "type": "text", "label": "API Key", "secret": true, "default": "" },
    { "key": "source", "type": "select", "label": "数据源",
      "options": [{ "value": "a", "label": "A 源" }, { "value": "b", "label": "B 源" }],
      "default": "a" },
    { "key": "enabled", "type": "checkbox", "label": "启用增强", "default": false },
    { "key": "limit", "type": "number", "label": "上限", "default": 10 }
  ]
}
```

字段属性：

| 属性 | 适用 | 说明 |
|---|---|---|
| `key` / `type` / `label` | 全部 | 必需 |
| `default` | 全部 | 未保存时的回落值 |
| `placeholder` | text | 占位提示 |
| `secret` | text | 掩码输入 |
| `options` | select | `{value, label}[]` |
| `section` | 全部 | 分组标题（同值字段归为一组） |
| `visibleWhen` | 全部 | `{ "key": "<其他字段>", "equals": <值> }` 条件显隐 |

类型支持：`text`、`select`、`checkbox`、`number`。
checkbox 一律渲染为统一 `.switch` 开关控件（宿主 UI 规范，插件无需关心）。

持久化位置：`userData/plugin-state.json` 的 `plugins.<id>.settings`。

## 6. UI 模式（ui）

### 6.1 settings 模式（默认）

不声明 `ui` 或 `ui.mode = "settings"`：设置页卡片内联渲染 settingsSchema 表单，无独立窗口。

### 6.2 window 模式

```json
{
  "ui": {
    "mode": "window",
    "entry": "window/index.html",
    "window": {
      "width": 960, "height": 640,
      "title": "货币战争控制台",
      "resizable": true,
      "policy": "reuse"
    }
  }
}
```

| 属性 | 缺省 | 说明 |
|---|---|---|
| `entry` | — | 插件包内 HTML 入口（相对路径），必需 |
| `window.width/height` | 1080×720 | 窗口初始尺寸 |
| `window.title` | 插件 name | 窗口标题 |
| `window.resizable` | true | 可否调整大小 |
| `window.policy` | `reuse` | 启动策略，见下 |

### 6.3 窗口启动策略（policy）

插件被调用时框架检查：

| policy | 行为 |
|---|---|
| `new` | 前台运行，每次调用新建一个窗口（支持多窗并存） |
| `background` | 后台静默，不建窗口，纯逻辑运行 |
| `reuse`（默认） | 前台运行：已有窗口则复用聚焦，并在当前尺寸小于声明尺寸时"适当拉伸"到声明值（用户手动放大的不回缩）；无窗口才新建 |

### 6.4 窗口桥（window.cyrenePlugin）

window 模式下宿主自动注入受限桥，按插件 id 隔离（只能操作自己）：

```ts
interface CyrenePluginBridge {
  pluginId: string;
  /** 读本插件配置（schema 默认值已合并）。 */
  getSettings(): Promise<Record<string, unknown>>;
  /** 订阅"设置页改了本插件配置"，返回取消函数。 */
  onSettingsChange(cb: () => void): () => void;
  /** 调用本插件注册的工具；非本插件工具会被主进程拒绝。返回工具的字符串结果。 */
  callTool(toolId: string, args?: Record<string, unknown>): Promise<string>;
}
```

调用模式（插件窗口 HTML 内）：

```js
const settings = await window.cyrenePlugin.getSettings();
await window.cyrenePlugin.callTool("my_plugin_run", { target: settings.target });
const off = window.cyrenePlugin.onSettingsChange(() => location.reload());
```

## 7. 异常隔离与安全

1. **加载隔离**：`index.js` require 或任何钩子抛错 → 只禁用该插件（设置页显示错误原因），不影响宿主与其他插件。
2. **工具隔离**：插件工具执行抛错 → 错误文本作为工具结果返回给 LLM，不崩宿主。
3. **窗口隔离**：窗口桥只允许调用 `registeredToolIds` 内的工具；插件禁用时桥调用直接返回提示。
4. **权限联动**：`risk` 声明与宿主权限档位对齐；`requiresAdmin` 插件在未提权进程里不加载。
5. **无签名校验**：用户可自行编译 TS/JS 插件，门槛优先于管控。

## 8. 完整示例

见仓库内置示例插件：

- `plugins/hello-settings/` —— settings 模式：schema 表单 + 一个演示工具；
- `plugins/demo-window/` —— window 模式：独立窗口 + 窗口桥调用自己的工具；
- `plugins/currency-wars/` —— 真实业务插件：window 模式控制台 + 运行控制工具。

## 9. 宿主 UI 规范（插件相关约定）

- 开关类控件一律使用统一 `.switch` 滑动开关；
- 所有文字颜色使用主题语义变量（`--rb-text-*`），随深/浅色主题动态适配；
- 插件图标建议 256×256 PNG，圆角由宿主容器处理。
