# Cyrene 插件接口调用规范（v1.0 · 桌面版）

> 本文档是插件与宿主（昔涟 Agent 主进程）之间的正式契约。
> 插件代码只允许通过本文档声明的接口与宿主交互；任何未声明的通道都不保证可用。
> 实现源码：`src/main/plugins/`（框架）、`src/preload/plugin-window.ts`（窗口桥）。
>
> 【怎么用这份文档】
> - 第一次写插件：按 §0 快速上手抄模板 → 遇到问题回来查对应章节。
> - 每个代码块上方的 `// 注释` 说明了"这段在什么时候用、要注意什么"。

---

## 0. 快速上手（三步写一个插件）

```
第 1 步：在 plugins/ 下建一个目录，目录名就是插件 id（kebab-case，如 my-plugin）
第 2 步：目录里放 plugin.json（声明）+ index.js（逻辑）
第 3 步：重启应用（或在设置页→插件栏重新扫描），打开开关即可
```

最小可运行示例（复制即用）：

`plugins/my-plugin/plugin.json`
```json
{
  "id": "my-plugin",           // 必须与目录名完全一致，否则整包被拒
  "name": "我的插件",           // 设置页卡片标题
  "description": "一句话描述",  // 卡片正文 + 日志前缀
  "version": "1.0.0",
  "entry": "index.js",          // 入口文件
  "defaultEnabled": false       // 首次扫描到是否默认开灯
}
```

`plugins/my-plugin/index.js`
```js
// 入口必须 module.exports 一个插件对象（也可以导出返回对象的工厂函数）。
// 所有钩子都是可选的，用不到就不写。
module.exports = {
  // 【何时调用】插件被启用时，框架调用一次，把返回的工具注册给 AI。
  // 【注意】工具 id 全局唯一，建议带插件前缀（如 my_plugin_xxx），撞车会被跳过。
  registerTools(ctx) {
    return [{
      id: "my_plugin_hello",
      name: "打招呼",
      description: "返回一句问候（供 AI 判断何时调用）",
      enabled: true,
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", description: "对谁说" } },
        required: ["name"],
      },
      // 执行器：必须是 async、必须返回字符串（会原样交给 AI / 插件窗口）
      execute: async (args) => `你好，${args.name}！`,
    }];
  },
};
```

---

## 1. 版本兼容

| 项 | 说明 |
|---|---|
| 规范版本 | v1.0 |
| 宿主加载器 | CommonJS（`module.exports` 导出插件对象） |
| Node/Electron | 随宿主发行，插件不要依赖更高版本特性 |
| 兼容承诺 | 本文档声明的接口只增不删；破坏性变更升大版本，并在清单校验层拒绝不兼容插件 |

## 2. 插件包结构

```
plugins/<plugin-id>/
├── plugin.json        # 清单（必需）—— 声明一切元信息
├── index.js           # 入口（必需）—— 编译后的 CommonJS JS
├── icon.png           # 图标（强烈推荐，见 §4.2）
├── window/            # window 模式自带 UI（可选，见 §7）
│   └── index.html
└── lib/ …             # 任意自定义模块，入口内自由 require
```

【扫描位置】两个根目录，后者按 id 覆盖前者：

| 根目录 | 用途 |
|---|---|
| `appPath/plugins/` | 内置插件，随安装包分发 |
| `userData/plugins/` | 用户自行添加的插件（同名会覆盖内置版） |

【重要】插件 id **永远等于目录名**。清单里的 `id` 与目录名不一致 → 整包拒绝。

## 3. 生命周期

```
扫描 → 校验清单 → 登记 index.json
  ↓ 用户打开开关（或 defaultEnabled=true）
加载 index.js → registerTools(ctx) → onEnable(ctx)
  ↓ window 模式且用户点了"打开界面"
创建窗口 → onWindowOpen(ctx)
  ↓ 用户关闭开关
onDisable(ctx) → 框架自动注销全部该插件工具 → 销毁全部该插件窗口
  ↓ 应用退出
dispose(ctx)
```

【怎么用】
- 启动服务、建连接 → 写在 `onEnable`；停止、关连接 → 写在 `onDisable`。
- **不要在模块顶层（require 时）做副作用**：插件被扫描到时就会 require 入口，
  顶层起服务会导致"没开开关也在跑"。
- 禁用只"下线"不卸载：重新启用会再次调用 `registerTools` + `onEnable`。

## 4. plugin.json 清单规范

### 4.1 必需字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 必须等于目录名（kebab-case） |
| `name` | string | 展示名（设置页卡片标题） |
| `description` | string | 一句话描述（卡片 + 日志） |
| `version` | string | 语义化版本，如 `1.0.0` |
| `entry` | string | 入口文件相对路径，通常 `index.js` |
| `defaultEnabled` | boolean | 首次扫描到时是否默认启用 |

### 4.2 可选字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `icon` | string | 图标相对路径（如 `icon.png`），建议 256×256 PNG。扫描时校验文件存在；用于**新建窗口的窗口图标**与**设置页卡片展示**。未提供则卡片回落 emoji |
| `requiresAdmin` | boolean | 需要管理员身份。未提权时不加载；用户尝试启用时弹警告并可一键提权重启 |
| `risk` | string[] | 权限声明：`safe` / `network` / `fs-read` / `fs-write` / `shell`。与宿主权限档位联动，非法项剔除 |
| `settingsSchema` | array | 配置表单声明，见 §6 |
| `ui` | object | UI 模式声明，见 §7 |

【声明范例——一个较完整的清单】
```json
{
  "id": "my-plugin",
  "name": "我的插件",
  "description": "一句话描述",
  "version": "1.0.0",
  "entry": "index.js",
  "icon": "icon.png",
  "defaultEnabled": false,
  "risk": ["network"],
  "uses": ["gamebot"],
  "settingsSchema": [
    { "key": "apiKey", "type": "text", "label": "API Key", "secret": true, "default": "" }
  ],
  "ui": { "mode": "window", "entry": "window/index.html" }
}
```

### 4.3 校验规则（不合规即整包拒绝）

- `id` ≠ 目录名、缺必需字段、`plugin.json` 解析失败 → 跳过该插件并在主进程日志告警；
- `risk` / `uses` 中的非法项只剔除不拒绝；
- `settingsSchema` 里非法字段只跳过不拒绝；
- `icon` 声明但文件缺失 → 告警，UI 回落 emoji，不拒绝加载。

## 5. 入口契约（CyrenePlugin）

`index.js` 必须 `module.exports` 一个插件对象（或返回对象的工厂函数）：

```js
module.exports = {
  registerTools(ctx) { return [/* ToolDefinition[] */]; },  // 注册 AI 工具
  async onEnable(ctx) {},      // 开关打开时
  async onDisable(ctx) {},     // 开关关闭时
  onWindowOpen(ctx) {},        // window 模式窗口创建后
  dispose(ctx) {},             // 应用退出时
};
```

| 钩子 | 调用时机 | 返回值 |
|---|---|---|
| `registerTools(ctx)` | 启用加载时，框架把返回值注册进全局工具表 | `ToolDefinition[]`，可为 `[]`（纯 UI 插件） |
| `onEnable(ctx)` | 开关打开（含启动时已启用） | `void | Promise<void>` |
| `onDisable(ctx)` | 开关关闭；框架随后自动注销工具、销毁窗口 | `void | Promise<void>` |
| `onWindowOpen(ctx)` | window 模式窗口创建后（可借此推送初始状态） | `void` |
| `dispose(ctx)` | 应用退出 | `void` |

### 5.1 工具定义（ToolDefinition）

```js
// 【怎么用】每个工具就是"AI 能调的一个动作"。
// description 写给 AI 看：写清楚"什么时候该调我、参数什么含义"，AI 才会在正确的时机调用。
{
  id: "my_plugin_run",        // 建议带插件前缀防冲突
  name: "执行",                // 人类看的展示名
  description: "供 AI 路由的一句话描述",
  enabled: true,               // 初值；用户之后可在工具面板改
  risk: "network",             // 可选，缺省 "safe"
  inputSchema: {               // JSON Schema（MCP 兼容），AI 据此生成参数
    type: "object",
    properties: { target: { type: "string", description: "目标" } },
    required: ["target"],
  },
  // 执行器：抛错不会崩宿主——错误文本会作为工具结果返回给 AI。
  execute: async (args) => { return "结果字符串"; },
}
```

**冲突规则**：工具 `id` 与核心工具或其他插件重复时，框架跳过注册（先到先得，不覆盖）并告警。

### 5.2 PluginContext（框架注入，所有钩子的第一个参数）

```ts
interface PluginContext {
  // 【怎么用】读自己的配置。返回的是同步快照（schema 默认值已合并）。
  // 配置变了不要靠轮询，用 onSettingsChange 通知后重新 getSettings()。
  getSettings(): Record<string, unknown>;

  // 【怎么用】设置页保存后触发；在这里重读配置、重建连接。
  onSettingsChange(cb: () => void): void;

  // 【怎么用】打日志。自动带 "[Plugins][<插件id>]" 前缀，直接在主进程控制台可见。
  log(msg: string): void;

  // 【怎么用】判断宿主是否管理员运行（需要注入/键鼠提权类功能的插件用）。
  isElevated(): boolean;

  app: {
    userDataPath: string;  // 宿主 userData 目录（只读参考，别往里乱写）
    dataPath: string;      // ★ 本插件专属数据目录（已确保存在）
  };

  // 【怎么用】宿主注入的具名服务（见 §8）。未声明 uses 或宿主未提供时取值为 undefined。
  services: Record<string, unknown>;
}
```

【持久化约定】插件的数据文件一律写 `ctx.app.dataPath`（`userData/plugins/<id>/data`），
不要写 userData 其他位置——卸载/清理插件时宿主只认这个目录。

## 6. settingsSchema（声明式配置表单）

【怎么用】把配置项写进清单，设置页自动渲染表单，**插件不用写任何 UI 代码**。

```json
{
  "settingsSchema": [
    { "key": "apiKey",   "type": "text",     "label": "API Key",  "secret": true, "default": "" },
    { "key": "source",   "type": "select",   "label": "数据源",
      "options": [{ "value": "a", "label": "A 源" }, { "value": "b", "label": "B 源" }],
      "default": "a" },
    { "key": "enhanced", "type": "checkbox", "label": "启用增强", "default": false },
    { "key": "limit",    "type": "number",   "label": "上限",     "default": 10 },
    { "key": "note",     "type": "text",     "label": "备注",     "section": "高级",
      "visibleWhen": { "key": "enhanced", "equals": true } }
  ]
}
```

字段属性：

| 属性 | 适用 | 说明 |
|---|---|---|
| `key` / `type` / `label` | 全部 | 必需 |
| `default` | 全部 | 未保存时的回落值 |
| `placeholder` | text | 占位提示 |
| `secret` | text | 掩码输入（密钥类必填） |
| `options` | select | `{value, label}[]` |
| `section` | 全部 | 分组标题（同值字段归为一组） |
| `visibleWhen` | 全部 | `{ "key": "<其他字段>", "equals": <值> }` 条件显隐 |

类型支持：`text`、`select`、`checkbox`、`number`。
checkbox 一律渲染为统一 `.switch` 开关控件（宿主 UI 规范，插件无需关心）。

【持久化位置】`userData/plugin-state.json` 的 `plugins.<id>.settings`。
【数组/复杂值】schema 没有数组类型——约定用 `text` 存逗号或换行分隔字符串，插件内自行 split。

## 7. UI 模式（ui）

### 7.1 settings 模式（默认）

不声明 `ui` 或 `ui.mode = "settings"`：设置页卡片内联渲染 settingsSchema 表单，无独立窗口。
**大多数插件用这个模式就够了。**

### 7.2 window 模式

```json
{
  "ui": {
    "mode": "window",
    "entry": "window/index.html",   // 必需：插件包内 HTML 入口（相对路径）
    "window": {
      "width": 960, "height": 640,  // 缺省 1080×720
      "title": "我的控制台",          // 缺省用插件 name
      "resizable": true,
      "policy": "reuse"             // 启动策略，见 §7.3
    }
  }
}
```

【怎么用】适合需要自己画界面的插件（控制台、画布、仪表盘）。
HTML 里可以直接写 CSS/JS，主题请跟随 §9 的颜色约定。

### 7.3 窗口启动策略（policy）

插件被调用时框架检查：

| policy | 行为 |
|---|---|
| `new` | 前台运行，每次调用新建一个窗口（支持多窗并存） |
| `background` | 后台静默，不建窗口，纯逻辑运行 |
| `reuse`（默认） | 前台运行：已有窗口则复用聚焦，且当前尺寸小于声明尺寸时"适当拉伸"到声明值（用户手动放大的不回缩）；无窗口才新建 |

### 7.4 窗口桥（window.cyrenePlugin）

【怎么用】window 模式下宿主自动在页面里注入 `window.cyrenePlugin`。
桥按插件 id 隔离——**只能操作自己的配置、只能调自己注册的工具**。

```ts
interface CyrenePluginBridge {
  pluginId: string;
  getSettings(): Promise<Record<string, unknown>>;      // 读本插件配置
  onSettingsChange(cb: () => void): () => void;         // 订阅设置页改动，返回取消函数
  callTool(toolId: string, args?: object): Promise<string>;  // 调本插件工具
}
```

【调用范例】（写在插件的 window/index.html 内）
```js
// 1) 启动时读配置渲染界面
const settings = await window.cyrenePlugin.getSettings();

// 2) 点按钮 → 调自己注册的工具（返回值就是 execute 的字符串）
const result = await window.cyrenePlugin.callTool("my_plugin_run", { target: settings.target });

// 3) 设置页改了配置 → 桥会收到通知，这里刷新界面
const off = window.cyrenePlugin.onSettingsChange(async () => {
  /* 重新 getSettings 并刷新 UI */
});

// 4) 需要实时进度又没有推送通道时：轮询自己的状态工具（约定 1s 一次即可）
setInterval(async () => {
  const status = await window.cyrenePlugin.callTool("my_plugin_status");
  /* 更新进度条 */
}, 1000);
```

## 8. 宿主服务注入（services）

【这是什么】有些插件需要宿主的"重能力"（如游戏代肝的截图/识别/键鼠注入），
这些能力不可能发给每个插件，因此由宿主**按名字注册服务**，插件**按名字取用**。

【怎么用】
1. 清单里声明依赖：`"uses": ["gamebot"]`（纯声明，供扫描校验与用户知情）；
2. 入口里取用：`ctx.services.gamebot`；宿主未提供或插件未声明时是 `undefined`，**必须判空降级**。

当前宿主提供的服务：

### 8.1 `gamebot` —— 游戏自动化能力（货币战争插件在用）

```ts
interface GamebotPluginService {
  // 读游戏代肝共享配置（VLM 识别器、游戏 exe 路径）。
  // 【为什么共享】VLM 端点属于宿主级配置，插件不重复存。
  getSharedConfig(): { vlm: { baseUrl; apiKey; model }; exePath: string };

  // 解析本地 OCR 启动配置（自动探测 Better-HSRCW 等）；无可用返回 null。
  resolveOcrLaunch(opts: { command: string; args: string[]; autoDetect: boolean }):
    { command: string; args: string[]; source: string } | null;

  // ★ 核心：组装一轮"货币战争"运行所需的全部动作工具。
  // elevatedInput=true 且非仅识别时，内部会连接管理员输入助手（可能弹窗等待）。
  buildCurrencyWarsRunTools(opts: {
    vlm: { baseUrl; apiKey; model };
    ocr: { command: string; args: string[] } | null;   // null = 识别走 VLM
    elevatedInput: boolean;
    recognitionOnly: boolean;
    processName: string;                                // 游戏进程名（提权输入用）
    signal: { aborted: boolean };                       // 中止旗标，stop 时置 true
  }): Promise<CurrencyWarsRunTools>;
}

// CurrencyWarsRunTools —— 传给插件内 runCurrencyWars() 的动作集合
interface CurrencyWarsRunTools {
  launch(exe): Promise<void>;                  // 启动游戏
  findWindow(titleKeyword): Promise<WindowTarget | null>;
  findFullscreen(exe): Promise<WindowTarget | null>;
  fullscreenFallback(): Promise<WindowTarget>;
  capture(target, region?): Promise<WindowCapture>;   // 抓窗口画面
  recognize(capture): Promise<OcrResult | null>;      // OCR/VLM 文字识别
  click(x, y): Promise<void>;
  drag(start, end): Promise<void>;
  key(combo): Promise<void>;                   // 如 "F4" / "Alt+F4"
  delay(ms): Promise<void>;                    // 尊重 signal 的可打断延时
}
```

【新增服务的规则】服务名 kebab/snake 均可但全工程唯一；服务实现必须放在宿主侧
（能碰 Electron 的模块），插件侧永远只拿到"纯函数/纯数据"的接口面。

## 9. 异常隔离与安全

1. **加载隔离**：`index.js` require 或任何钩子抛错 → 只禁用该插件（设置页显示错误原因），不影响宿主与其他插件。
2. **工具隔离**：插件工具执行抛错 → 错误文本作为工具结果返回给 AI，不崩宿主。
3. **窗口隔离**：窗口桥只允许调用本插件注册的工具；插件禁用时桥调用直接返回提示。
4. **权限联动**：`risk` 声明与宿主权限档位对齐；`requiresAdmin` 插件在未提权进程里不加载。
5. **无签名校验**：用户可自行编译 TS/JS 插件，门槛优先于管控。

【调试技巧】所有插件日志带 `[Plugins][<id>]` 前缀；清单校验失败看 `[Plugins] 跳过不合规插件清单`。

## 10. 完整示例索引

见仓库内置插件（`plugins/` 下，直接抄）：

| 插件 | 演示内容 |
|---|---|
| `hello-settings/` | settings 模式：schema 表单 + 一个演示工具 |
| `demo-window/` | window 模式：独立窗口 + 窗口桥调用自己的工具 |
| `currency-wars/` | 真实业务插件：window 模式控制台 + `uses:["gamebot"]` 宿主服务 + 运行控制工具 |

## 11. 宿主 UI 规范（插件相关约定）

- 开关类控件一律使用统一 `.switch` 滑动开关；
- 所有文字颜色使用主题语义变量（`--rb-text-strong/default/muted/faint`），随深/浅色主题动态适配，**禁止写死颜色**；
- 插件图标建议 256×256 PNG，圆角由宿主容器处理；
- 窗口 HTML 无外部 CDN 依赖（离线可用），资源放自己包内。
