// 示例插件（window 模式）：自带独立窗口 UI。
// 窗口页面通过 window.cyrenePlugin 桥调用本插件注册的工具与配置。

const PALETTE = {
  aurora: ["#ff9ff3", "#a29bfe", "#81ecec"],
  night: ["#576574", "#222f3e", "#c8d6e5"]
};

module.exports = {
  registerTools(ctx) {
    return [
      {
        id: "demo_window_palette",
        name: "示例调色板",
        description: "示例窗口插件的工具：根据配置的主题返回一组调色板颜色。",
        enabled: true,
        risk: "safe",
        inputSchema: {
          type: "object",
          properties: {},
          required: []
        },
        async execute() {
          const settings = ctx.getSettings();
          const theme = settings.theme || "aurora";
          const colors = PALETTE[theme] || PALETTE.aurora;
          ctx.log(`palette -> ${theme}`);
          return JSON.stringify({ theme, colors });
        }
      }
    ];
  },

  onWindowOpen(ctx) {
    ctx.log("demo-window 窗口已打开");
  }
};
