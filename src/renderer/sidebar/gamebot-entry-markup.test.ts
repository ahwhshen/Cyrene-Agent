import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const markup = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

describe("sidebar entries", () => {
  it("has a plugins entry and a plugins-settings entry", () => {
    // 菜单里的“插件”条目：打开独立插件面板窗口
    expect(markup).toContain('id="model-switch-btn"');
    expect(markup).toContain("<span>插件</span>");
    expect(markup).not.toContain("<span>切换模型</span>");
    // 底部「插件」按钮：同样打开独立插件面板窗口（设置页已移除插件选项卡）
    expect(markup).toContain('id="game-btn"');
    expect(markup).toContain('title="打开插件面板"');
    expect(markup).not.toContain("打开插件控制台");
    expect(markup).not.toContain("打开插件设置");
  });
});
