// 独立插件面板窗口（外部扩展插件包管理）
// 入口：主界面右侧状态面板「插件」按钮 / 侧栏「插件」按钮（设置页已移除插件选项卡）
// 渲染逻辑从 settings.ts 的 pluginpacks 栏原样移植：卡片 + 开关 + 声明式配置表单 + 管理员警告框
import "../ui/theme";

interface PluginPanelApi {
  minimize: () => void;
  close: () => void;
  listPlugins: () => Promise<Array<{
    id: string; name: string; description: string; version: string;
    source: "builtin" | "user"; enabled: boolean; loaded: boolean; loadError?: string;
    requiresAdmin: boolean; elevated: boolean;
    risk: string[]; uiMode: "window" | "settings"; windowPolicy?: "new" | "background" | "reuse"; iconUrl?: string;
    settingsSchema: Array<{ key: string; type: string; label: string; default?: unknown; placeholder?: string; secret?: boolean; options?: Array<{ value: string; label: string }>; section?: string; visibleWhen?: { key: string; equals: unknown } }>;
    settings: Record<string, unknown>;
  }>>;
  setPluginEnabled: (id: string, enabled: boolean) => Promise<{ ok: boolean; error?: string }>;
  setPluginSettings: (id: string, settings: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;
  openPluginWindow: (id: string) => Promise<{ ok: boolean; error?: string }>;
  relaunchAsAdmin: () => Promise<{ ok: boolean }>;
}

declare global {
  interface Window {
    pluginPanel?: PluginPanelApi;
  }
}

type PluginPackView = Awaited<ReturnType<NonNullable<PluginPanelApi["listPlugins"]>>>[number];
type PluginPackField = PluginPackView["settingsSchema"][number];

/* ── 窗口控制 ────────────────────────────────────────── */
document.getElementById("min-btn")?.addEventListener("click", () => {
  window.pluginPanel?.minimize();
});
document.getElementById("close-btn")?.addEventListener("click", () => {
  window.pluginPanel?.close();
});

/* ── 管理员警告框（cy-modal 风格，HTML 在 index.html） ── */
function showPluginAdminWarning(pack: PluginPackView): void {
  const overlay = document.getElementById("plugin-admin-overlay");
  const body = document.getElementById("plugin-admin-body");
  if (!overlay || !body) return;
  const riskText = ["需要管理员身份运行", ...pack.risk.map((r) => `权限声明：${r}`)].join("\n");
  body.textContent = `插件「${pack.name}」声明需要管理员权限。以管理员身份运行将使该插件获得系统级操作能力，请确认插件来源可信。\n\n${riskText}`;
  overlay.classList.remove("is-hidden");
}

function hidePluginAdminWarning(): void {
  document.getElementById("plugin-admin-overlay")?.classList.add("is-hidden");
}

document.getElementById("plugin-admin-confirm")?.addEventListener("click", () => {
  hidePluginAdminWarning();
  void window.pluginPanel?.relaunchAsAdmin();
});
document.getElementById("plugin-admin-cancel")?.addEventListener("click", () => {
  hidePluginAdminWarning();
  void loadPluginPacksPanel();  // 刷新开关回退态
});

/** 判断 visibleWhen 条件是否满足。 */
function pluginFieldVisible(field: PluginPackField, values: Record<string, unknown>): boolean {
  if (!field.visibleWhen) return true;
  return values[field.visibleWhen.key] === field.visibleWhen.equals;
}

/** 构建统一样式的开关（.switch 结构，与全工程其他开关项保持一致）。 */
function buildPluginSwitch(checked: boolean, onChange: (next: boolean) => void): { root: HTMLElement; input: HTMLInputElement } {
  const root = document.createElement("span");
  root.className = "switch";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  const track = document.createElement("span");
  track.className = "switch__track";
  const thumb = document.createElement("span");
  thumb.className = "switch__thumb";
  track.appendChild(thumb);
  root.appendChild(input);
  root.appendChild(track);
  return { root, input };
}

/** 渲染单个 schema 字段的输入控件。 */
function renderPluginFieldControl(field: PluginPackField, value: unknown, onInput: (v: unknown) => void): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "pluginpack-field";
  wrap.dataset.fieldKey = field.key;

  const label = document.createElement("label");
  label.className = "pluginpack-field__label";
  label.textContent = field.label;
  wrap.appendChild(label);

  if (field.type === "checkbox") {
    // 开关类设置项一律用统一 .switch 开关，仿照其他设置项
    const { root } = buildPluginSwitch(value === true, (next) => onInput(next));
    wrap.appendChild(root);
    return wrap;
  }

  if (field.type === "select") {
    const select = document.createElement("select");
    select.className = "pluginpack-field__input";
    for (const opt of field.options ?? []) {
      const o = document.createElement("option");
      o.value = opt.value;
      o.textContent = opt.label;
      select.appendChild(o);
    }
    select.value = typeof value === "string" ? value : (field.options?.[0]?.value ?? "");
    select.addEventListener("change", () => onInput(select.value));
    wrap.appendChild(select);
    return wrap;
  }

  const input = document.createElement("input");
  input.className = "pluginpack-field__input";
  input.type = field.type === "number" ? "number" : field.secret ? "password" : "text";
  input.placeholder = field.placeholder ?? "";
  input.value = value == null ? "" : String(value);
  input.addEventListener("change", () => {
    onInput(field.type === "number" ? Number(input.value) : input.value);
  });
  wrap.appendChild(input);
  return wrap;
}

/** 渲染一张插件卡片（含声明式配置表单）。 */
function renderPluginPackCard(pack: PluginPackView): HTMLElement {
  const card = document.createElement("article");
  card.className = "pluginpack-card";

  // 头部：图标 + 名称/描述 + 徽标 + 开关
  const head = document.createElement("div");
  head.className = "pluginpack-card__head";

  const icon = document.createElement("div");
  icon.className = "pluginpack-card__icon";
  if (pack.iconUrl) {
    // 插件自带图标（清单 icon 声明，扫描时已校验存在）
    const img = document.createElement("img");
    img.className = "pluginpack-card__icon-img";
    img.src = pack.iconUrl;
    img.alt = pack.name;
    icon.appendChild(img);
  } else {
    icon.textContent = pack.uiMode === "window" ? "🪟" : "🧩";
  }

  const info = document.createElement("div");
  info.className = "pluginpack-card__info";
  const title = document.createElement("h2");
  title.className = "pluginpack-card__title";
  title.textContent = pack.name;
  const meta = document.createElement("div");
  meta.className = "pluginpack-card__meta";
  const badges: string[] = [`v${pack.version}`, pack.source === "user" ? "用户插件" : "内置"];
  if (pack.requiresAdmin) badges.push("🛡️ 需管理员");
  if (pack.uiMode === "window") {
    // 窗口启动策略徽标：new=新建窗口 / background=后台静默 / reuse=复用拉伸（默认）
    if (pack.windowPolicy === "background") badges.push("后台静默");
    else if (pack.windowPolicy === "new") badges.push("每次新建窗口");
    else badges.push("独立界面");
  }
  for (const risk of pack.risk) badges.push(risk);
  meta.textContent = badges.join(" · ");
  const desc = document.createElement("p");
  desc.className = "pluginpack-card__desc";
  desc.textContent = pack.description;
  info.appendChild(title);
  info.appendChild(meta);
  info.appendChild(desc);

  const actions = document.createElement("div");
  actions.className = "pluginpack-card__actions";

  if (pack.uiMode === "window" && pack.windowPolicy !== "background") {
    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "pluginpack-open-btn";
    openBtn.textContent = "打开界面";
    openBtn.disabled = !pack.enabled;
    openBtn.addEventListener("click", async () => {
      const result = await window.pluginPanel?.openPluginWindow(pack.id);
      if (result && !result.ok) console.warn("[plugin-panel] 打开插件窗口失败:", result.error);
    });
    actions.appendChild(openBtn);
  }

  const { root: toggleRoot, input: toggle } = buildPluginSwitch(pack.enabled, async (next) => {
    const result = await window.pluginPanel?.setPluginEnabled(pack.id, next);
    if (!result?.ok) {
      toggle.checked = !next;
      if (result?.error === "needs-admin") showPluginAdminWarning(pack);
      else console.warn("[plugin-panel] 切换插件失败:", result?.error);
    } else {
      void loadPluginPacksPanel();  // 刷新 loaded/错误态与窗口按钮可用性
    }
  });
  actions.appendChild(toggleRoot);

  head.appendChild(icon);
  head.appendChild(info);
  head.appendChild(actions);
  card.appendChild(head);

  // 加载失败提示（异常隔离，不影响其他插件）
  if (pack.enabled && !pack.loaded && pack.loadError && pack.loadError !== "needs-admin") {
    const err = document.createElement("div");
    err.className = "pluginpack-card__error";
    err.textContent = `加载失败（已隔离）：${pack.loadError}`;
    card.appendChild(err);
  }
  if (pack.loadError === "needs-admin") {
    const warn = document.createElement("div");
    warn.className = "pluginpack-card__warn";
    warn.textContent = "需要管理员身份：开启开关后按提示以管理员重启应用";
    card.appendChild(warn);
  }

  // 声明式配置表单（schema 自动渲染，含 visibleWhen）
  if (pack.settingsSchema.length > 0) {
    const form = document.createElement("div");
    form.className = "pluginpack-form";
    const values: Record<string, unknown> = { ...pack.settings };
    const fieldWraps: Array<{ field: PluginPackField; el: HTMLElement }> = [];
    let currentSection = "";

    const persist = (): void => {
      void window.pluginPanel?.setPluginSettings(pack.id, values);
    };
    const refreshVisibility = (): void => {
      for (const { field, el } of fieldWraps) {
        el.classList.toggle("is-hidden", !pluginFieldVisible(field, values));
      }
    };

    for (const field of pack.settingsSchema) {
      if (field.section && field.section !== currentSection) {
        currentSection = field.section;
        const sectionTitle = document.createElement("div");
        sectionTitle.className = "pluginpack-form__section";
        sectionTitle.textContent = currentSection;
        form.appendChild(sectionTitle);
      }
      const el = renderPluginFieldControl(field, values[field.key], (v) => {
        values[field.key] = v;
        refreshVisibility();
        persist();
      });
      el.classList.toggle("is-hidden", !pluginFieldVisible(field, values));
      fieldWraps.push({ field, el });
      form.appendChild(el);
    }
    card.appendChild(form);
  }

  return card;
}

/** 拉取插件列表并渲染整个插件面板。 */
async function loadPluginPacksPanel(): Promise<void> {
  const listEl = document.getElementById("pluginpack-list");
  const emptyEl = document.getElementById("pluginpack-empty");
  if (!listEl || !window.pluginPanel?.listPlugins) return;

  let packs: PluginPackView[] = [];
  try {
    packs = await window.pluginPanel.listPlugins();
  } catch (err) {
    console.warn("[plugin-panel] 加载插件列表失败:", err);
  }

  listEl.innerHTML = "";
  if (packs.length === 0) {
    emptyEl?.classList.remove("is-hidden");
    return;
  }
  emptyEl?.classList.add("is-hidden");
  for (const pack of packs) {
    listEl.appendChild(renderPluginPackCard(pack));
  }
}

void loadPluginPacksPanel();
