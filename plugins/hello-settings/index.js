// 示例插件（settings 模式）：展示插件如何用声明式配置 + 注册工具。
// 模块导出可以是插件对象，也可以是返回插件对象的工厂函数。

const STYLE_TEXT = {
  sweet: (name) => `嘿嘿，${name}～今天也要元气满满哦！`,
  lively: (name) => `${name}！新的一天开始啦，一起冲！`,
  formal: (name) => `${name}，您好，祝您今日顺利。`
};

function formatTime(fmt) {
  const now = new Date();
  if (fmt === "iso") return now.toISOString().slice(0, 10);
  return `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;
}

module.exports = {
  registerTools(ctx) {
    return [
      {
        id: "hello_settings_greet",
        name: "示例问候",
        description: "示例插件提供的问候工具：按插件配置的称呼与语气生成一句问候语。",
        enabled: true,
        risk: "safe",
        inputSchema: {
          type: "object",
          properties: {
            target: {
              type: "string",
              description: "可选：覆盖默认称呼，向指定对象问候"
            }
          },
          required: []
        },
        async execute(args) {
          const settings = ctx.getSettings();
          const name = (args.target || settings.nickname || "主人").toString();
          const style = settings.style || "sweet";
          const maker = STYLE_TEXT[style] || STYLE_TEXT.sweet;
          const lines = [];
          const count = Math.max(1, Number(settings.repeatCount) || 1);
          for (let i = 0; i < count; i += 1) lines.push(maker(name));
          if (settings.appendTime) lines.push(`今天是 ${formatTime(settings.timeFormat)}`);
          ctx.log(`greet -> ${name} (${style})`);
          return lines.join("\n");
        }
      }
    ];
  },

  onEnable(ctx) {
    ctx.log("hello-settings 已启用");
  },

  onDisable(ctx) {
    ctx.log("hello-settings 已停用");
  }
};
