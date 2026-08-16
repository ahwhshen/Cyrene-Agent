import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const markup = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

describe("gamebot settings markup", () => {
  it("功能栏只保留 Game Bot 启用开关，独立控制窗口与游戏面板整体移除", () => {
    expect(markup).toContain('id="plugin-gamebot-enabled"');
    expect(markup).toContain("「插件」按钮会直达本页插件栏");
    expect(markup).not.toContain("独立控制窗口");
    // 旧的 gamebot 配置/运行控件与游戏栏不得残留
    expect(markup).not.toContain('id="gamebot-exe"');
    expect(markup).not.toContain('id="gamebot-currency-wars-config"');
    expect(markup).not.toContain('id="gamebot-start-btn"');
    expect(markup).not.toContain('data-section="game"');
    expect(markup).not.toContain('id="game-panel"');
  });
});
