/**
 * 一次性脚本：把 assets/icon-presets 下的两个 1024x1024 PNG 预设图标
 * 生成对应的多尺寸 .ico（16/24/32/48/64/128/256，PNG 压缩 entry，Vista+ 支持）。
 * Windows 任务栏/Alt+Tab 对 .ico 的渲染最可靠，纯大尺寸 PNG 会退回 Electron 默认图标。
 *
 * 用法：node scripts/build-icon-presets-ico.js
 */
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const PRESETS = ["cyrene-sun.png", "cyrene-pink.png"];
const SIZES = [16, 24, 32, 48, 64, 128, 256];

/** 把多张 PNG buffer 打包成 ICO 文件（PNG-in-ICO 格式） */
function packIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngs.length, 4);
  let offset = 6 + pngs.length * 16;
  const entries = [];
  for (const png of pngs) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(png.size >= 256 ? 0 : png.size, 0); // 宽，256 记为 0
    entry.writeUInt8(png.size >= 256 ? 0 : png.size, 1); // 高
    entry.writeUInt8(0, 2); // 调色板
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // 色彩平面
    entry.writeUInt16LE(32, 6); // 位深
    entry.writeUInt32LE(png.data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.data.length;
    entries.push(entry);
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

(async () => {
  for (const name of PRESETS) {
    const src = path.join(__dirname, "..", "assets", "icon-presets", name);
    const pngs = [];
    for (const size of SIZES) {
      const data = await sharp(src)
        .resize(size, size, { fit: "cover" })
        .png()
        .toBuffer();
      pngs.push({ size, data });
    }
    const icoPath = src.replace(/\.png$/i, ".ico");
    fs.writeFileSync(icoPath, packIco(pngs));
    console.log(`[build-ico] ${path.basename(icoPath)} (${SIZES.join("/")}px) 完成`);
  }
})().catch((err) => {
  console.error("[build-ico] 失败:", err);
  process.exit(1);
});
