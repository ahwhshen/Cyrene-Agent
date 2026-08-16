import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const markup = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

describe("sidebar entries", () => {
  it("has a plugins entry and a plugins-settings entry", () => {
    // 菜单里的“插件”条目：直奔设置页插件栏
    expect(markup).toContain('id="model-switch-btn"');
    expect(markup).toContain("<span>插件</span>");
    expect(markup).not.toContain("<span>切换模型</span>");
    // 底部「插件」按钮：独立控制台已删除，同样直进设置页插件栏
    expect(markup).toContain('id="game-btn"');
    expect(markup).toContain('title="打开插件设置"');
    expect(markup).not.toContain("打开插件控制台");
  });
});
