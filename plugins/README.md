# 插件目录（plugins/）

此目录存放**内置插件包**；用户自装插件放 `userData/plugins/`（同 id 时用户目录覆盖内置）。
启动时框架自动扫描两个目录，清单写入 `userData/plugins/index.json`。

## 一个插件包 = 一个目录

目录名即插件 id（kebab-case，如 `demo-window`），最少包含两个文件：

```
my-plugin/
├── plugin.json   # 清单：声明一切元信息
├── index.js      # 入口：实现逻辑（编译后的 JS，CommonJS）
├── icon.png      # 图标：窗口图标 + 设置页卡片展示（建议 256×256 PNG）
└── window/       # 可选：window 模式的自带 UI
    └── index.html
```

## plugin.json 清单字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 必须与目录名一致 |
| `name` | ✅ | 展示名 |
| `description` | ✅ | 一句话描述 |
| `version` | ✅ | 语义化版本 |
| `entry` | ✅ | 入口文件相对路径（通常 `index.js`） |
| `icon` | 推荐 | 图标文件相对路径（如 `icon.png`）。扫描时校验存在；用于新建窗口的窗口图标和设置页卡片展示；未提供时卡片回落 emoji |
| `defaultEnabled` | ✅ | 首次扫描时是否默认启用 |
| `requiresAdmin` | ❌ | `true` = 需要管理员身份；未提权时不加载，启用时弹警告并可一键提权重启 |
| `risk` | ❌ | 权限声明数组：`safe` / `network` / `fs-read` / `fs-write` / `shell` |
| `settingsSchema` | ❌ | 声明式配置表单（见下） |
| `ui` | ❌ | UI 模式（见下） |

## UI 双模式

### settings 模式（默认）—— 纯声明，无自己的界面

```json
"ui": { "mode": "settings" }
```

设置页「插件」栏会按 `settingsSchema` 自动渲染配置表单。字段类型：

- `text`：文本框（`secret: true` 为密码态）
- `select`：下拉框（需 `options: [{value, label}]`）
- `checkbox`：开关
- `number`：数字

排版能力：`section`（分组标题）、`visibleWhen: { key, equals }`（条件显隐）。

### window 模式 —— 自带独立窗口（适合大项目，如货币战争级别）

```json
"ui": {
  "mode": "window",
  "entry": "window/index.html",
  "window": { "width": 480, "height": 420, "title": "窗口标题", "resizable": true, "policy": "reuse" }
}
```

#### 窗口启动策略（`window.policy`）—— 插件被调用时检查，三选一

| policy | 行为 |
|---|---|
| `new` | 前台运行，每次调用新建一个窗口（可多窗并存） |
| `background` | 后台静默：不建窗口，插件纯逻辑运行（设置页不显示“打开界面”按钮） |
| `reuse`（默认） | 前台运行：已有窗口则复用并适当拉伸（小于声明尺寸时拉到声明值），没有才新建 |

框架负责建窗口和生命周期；页面里通过 `window.cyrenePlugin` 桥通信：

```js
const bridge = window.cyrenePlugin;
bridge.pluginId;                                  // 本插件 id
await bridge.getSettings();                       // 读自己的配置
bridge.onSettingsChange(() => refresh());         // 配置变更订阅（返回取消函数）
await bridge.callTool("my_tool_id", { k: "v" });  // 调自己注册的工具（别人的工具会被拒绝）
```

## index.js 入口契约

模块导出插件对象（或返回插件对象的工厂函数），全部方法均可选：

```js
module.exports = {
  // 返回工具数组，框架注册进 ToolRegistry（纯 UI 插件可返回 []）
  registerTools(ctx) {
    return [{
      id: "my_tool",            // 与核心工具重名时会被跳过，不会覆盖
      name: "我的工具",
      description: "给 LLM Router 看的一句话描述",
      enabled: true,
      risk: "safe",
      inputSchema: { type: "object", properties: {}, required: [] },
      async execute(args) { return "结果字符串"; }
    }];
  },
  onEnable(ctx) {},      // 用户打开开关
  onDisable(ctx) {},     // 关闭（框架自动注销工具、销毁窗口）
  onWindowOpen(ctx) {},  // window 模式：窗口创建后
  dispose(ctx) {}        // 应用退出清理
};
```

### PluginContext（框架注入，能力受限）

- `ctx.getSettings()` —— 读自己的配置（schema default 已合并）
- `ctx.onSettingsChange(cb)` —— 配置变更订阅
- `ctx.log(msg)` —— 带插件 id 前缀的日志
- `ctx.isElevated()` —— 当前是否管理员身份
- `ctx.app.userDataPath` / `ctx.app.dataPath`（`userData/plugins/<id>/data`，插件私有数据目录）

## 异常隔离

插件加载或执行抛异常只会禁用它自己，不影响宿主和其他插件。

## UI 规范

- **开关类设置项一律使用开关控件**：settingsSchema 里凡是布尔开关（`type: "checkbox"`）与插件启用开关，都由设置页统一渲染为工程标准的 `.switch` 滑动开关（与偏好设置/功能栏等其他开关同款样式），插件不需要也不应该自定义勾选框样式。
- 文字颜色随主题动态适配：插件窗口 UI 自己负责与所选背景的对比度（参考 demo-window 的双主题配色）。

## 示例

- `hello-settings/` —— settings 模式：声明式表单 + 注册问候工具
- `demo-window/` —— window 模式：自带窗口 UI，演示桥的三个能力
