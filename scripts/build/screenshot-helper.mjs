import { copyFile, mkdir } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { verifyScreenshotHelper } from "../verify/screenshot-helper.mjs";

// GNU 工具链（无 MSVC 环境）下 windows crate 需要 dlltool；rustup 的 self-contained
// 目录里自带它但不在 PATH 上，编译前自动补进 PATH（本机工具链固定在 program 根目录）。
function augmentedEnv() {
  const rustupHome = process.env.RUSTUP_HOME ?? "";
  if (!rustupHome) return process.env;
  const toolchainsDir = path.join(rustupHome, "toolchains");
  if (!existsSync(toolchainsDir)) return process.env;
  for (const name of readdirSync(toolchainsDir)) {
    if (!name.includes("windows-gnu")) continue;
    const selfContained = path.join(toolchainsDir, name, "lib", "rustlib", "x86_64-pc-windows-gnu", "bin", "self-contained");
    if (existsSync(path.join(selfContained, "dlltool.exe"))) {
      return { ...process.env, PATH: `${selfContained}${path.delimiter}${process.env.PATH ?? ""}` };
    }
  }
  return process.env;
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, "..", "..");
const manifestPath = path.join(
  repoRoot,
  "native",
  "cyrene-screenshot",
  "Cargo.toml",
);
const builtHelperPath = path.join(
  repoRoot,
  "native",
  "cyrene-screenshot",
  "target",
  "release",
  "cyrene-screenshot.exe",
);
const stagedHelperPath = path.join(
  repoRoot,
  "resources",
  "bin",
  "cyrene-screenshot.exe",
);

const result = spawnSync("cargo", [
  "build",
  "--release",
  "--locked",
  "--manifest-path",
  manifestPath,
], {
  cwd: repoRoot,
  shell: false,
  stdio: "inherit",
  env: augmentedEnv(),
});

if (result.error) {
  console.error(`[screenshot-helper] failed to launch Cargo: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

await mkdir(path.dirname(stagedHelperPath), { recursive: true });
await copyFile(builtHelperPath, stagedHelperPath);
const verified = await verifyScreenshotHelper(stagedHelperPath);
console.log(
  `[screenshot-helper] staged ${verified.helperPath} (${verified.size} bytes)`,
);
