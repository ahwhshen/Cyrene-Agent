import { app, shell } from "electron";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import type {
  WorkArtifact,
  WorkMessage,
  WorkPlan,
  WorkSession,
  WorkSessionMeta,
  WorkSessionMode,
} from "../../shared/work-types";

const ROOT_DIR_NAME = "cyrene-work";
const SESSIONS_DIR_NAME = "sessions";
const INDEX_FILE_NAME = "index.json";
const ORDER_FILE_NAME = "rail-order.json";

let rootDir = "";
let sessionsDir = "";
let indexPath = "";
let orderPath = "";
let indexCache: WorkSessionMeta[] = [];
/** 用户手动排序的会话 ID 列表（与聊天侧 customOrder 语义一致）。 */
let customOrder: string[] = [];

function atomicWriteJson(filePath: string, value: unknown): void {
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tempPath, filePath);
}
function ensureInitialized(): void {
  if (rootDir) return;
  rootDir = path.join(app.getPath("userData"), ROOT_DIR_NAME);
  sessionsDir = path.join(rootDir, SESSIONS_DIR_NAME);
  indexPath = path.join(rootDir, INDEX_FILE_NAME);
  orderPath = path.join(rootDir, ORDER_FILE_NAME);
  fs.mkdirSync(sessionsDir, { recursive: true });
  try {
    const parsed = fs.existsSync(indexPath)
      ? JSON.parse(fs.readFileSync(indexPath, "utf8")) as unknown
      : [];
    indexCache = Array.isArray(parsed)
      ? parsed.filter(isWorkSessionMeta)
      : [];
  } catch {
    indexCache = [];
  }
  try {
    const parsedOrder = fs.existsSync(orderPath)
      ? JSON.parse(fs.readFileSync(orderPath, "utf8")) as unknown
      : [];
    customOrder = Array.isArray(parsedOrder)
      ? parsedOrder.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    customOrder = [];
  }
  sortIndexCache();
}

/** 排序规则：置顶优先 → 手动顺序 → updatedAt 降序（与聊天侧会话栏一致）。 */
function sortIndexCache(): void {
  const orderIdx = new Map(customOrder.map((id, i) => [id, i]));
  indexCache.sort((a, b) => {
    const aPin = a.pinned ? 0 : 1;
    const bPin = b.pinned ? 0 : 1;
    if (aPin !== bPin) return aPin - bPin;
    const aOrder = orderIdx.has(a.id) ? orderIdx.get(a.id)! : Infinity;
    const bOrder = orderIdx.has(b.id) ? orderIdx.get(b.id)! : Infinity;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return b.updatedAt - a.updatedAt;
  });
}

function persistOrder(): void {
  atomicWriteJson(orderPath, customOrder);
}

function isWorkSessionMeta(value: unknown): value is WorkSessionMeta {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<WorkSessionMeta>;
  return typeof item.id === "string"
    && typeof item.title === "string"
    && typeof item.messageCount === "number"
    && typeof item.createdAt === "number"
    && typeof item.updatedAt === "number";
}

function sessionPath(id: string): string {
  ensureInitialized();
  return path.join(sessionsDir, `${id}.json`);
}

/** 旧会话 JSON 无 mode 字段，缺省视为普通工作会话。 */
export function workSessionMode(session: WorkSession): WorkSessionMode {
  return session.mode === "code" || session.mode === "learn" ? session.mode : "work";
}

function metaFromSession(session: WorkSession): WorkSessionMeta {
  const mode = workSessionMode(session);
  const existing = indexCache.find((item) => item.id === session.id);
  return {
    id: session.id,
    title: session.title,
    status: session.status,
    messageCount: session.messages.length,
    ...(mode !== "work" ? { mode } : {}),
    ...(existing?.pinned ? { pinned: true } : {}),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function persistSession(session: WorkSession): void {
  ensureInitialized();
  atomicWriteJson(sessionPath(session.id), session);
  const meta = metaFromSession(session);
  const index = indexCache.findIndex((item) => item.id === session.id);
  if (index >= 0) indexCache[index] = meta;
  else indexCache.push(meta);
  sortIndexCache();
  atomicWriteJson(indexPath, indexCache);
}

function deriveTitle(messages: WorkMessage[]): string {
  const first = messages.find((message) => message.role === "user" && message.content.trim());
  if (!first) return "新工作";
  const title = first.content.replace(/\s+/g, " ").trim();
  return title.length > 36 ? `${title.slice(0, 36)}…` : title;
}

export function initializeWorkStore(): void {
  ensureInitialized();
}

export function getWorkRootDir(): string {
  ensureInitialized();
  return rootDir;
}

export function listWorkSessions(): WorkSessionMeta[] {
  ensureInitialized();
  return indexCache.map((item) => ({ ...item }));
}

export function getWorkSession(id: string): WorkSession | null {
  const filePath = sessionPath(id);
  if (!fs.existsSync(filePath)) return null;
  try {
    const session = JSON.parse(fs.readFileSync(filePath, "utf8")) as WorkSession;
    return session?.schemaVersion === 1 && Array.isArray(session.messages) ? session : null;
  } catch {
    return null;
  }
}

export function createWorkSession(
  title?: string,
  mode?: WorkSessionMode,
  boundDir?: string,
): WorkSession {
  const now = Date.now();
  const normalizedMode = mode === "code" || mode === "learn" ? mode : "work";
  const session: WorkSession = {
    schemaVersion: 1,
    id: randomUUID(),
    title: title?.trim() || (normalizedMode === "code" ? "新代码会话" : normalizedMode === "learn" ? "新学习会话" : "新工作"),
    messages: [],
    artifacts: [],
    status: "idle",
    ...(normalizedMode !== "work" ? { mode: normalizedMode } : {}),
    ...(normalizedMode !== "work" && boundDir ? { boundDir } : {}),
    createdAt: now,
    updatedAt: now,
  };
  persistSession(session);
  return session;
}

const DEFAULT_SESSION_TITLES = new Set(["新工作", "新代码会话", "新学习会话"]);

export function saveWorkSession(session: WorkSession): WorkSession {
  const next: WorkSession = {
    ...session,
    title: DEFAULT_SESSION_TITLES.has(session.title) ? deriveTitle(session.messages) : session.title,
    updatedAt: Date.now(),
  };
  persistSession(next);
  return next;
}

export function appendWorkMessage(id: string, message: WorkMessage): WorkSession | null {
  const session = getWorkSession(id);
  if (!session) return null;
  session.messages.push(message);
  return saveWorkSession(session);
}

export function updateWorkExecutionState(
  id: string,
  update: { status?: WorkSession["status"]; plan?: WorkPlan; artifacts?: WorkArtifact[] },
): WorkSession | null {
  const session = getWorkSession(id);
  if (!session) return null;
  if (update.status) session.status = update.status;
  if (update.plan) session.plan = update.plan;
  if (update.artifacts) session.artifacts = update.artifacts;
  return saveWorkSession(session);
}

export function renameWorkSession(id: string, title: string): WorkSession | null {
  const session = getWorkSession(id);
  if (!session || !title.trim()) return null;
  session.title = title.trim();
  return saveWorkSession(session);
}

/**
 * 为 code/learn 会话绑定（或解绑）只读目录。目录绑定与会话创建解耦：
 * 会话可先建后绑；work 模式会话不接受绑定。
 */
export function bindWorkSessionDir(id: string, boundDir?: string): WorkSession | null {
  const session = getWorkSession(id);
  if (!session || workSessionMode(session) === "work") return null;
  if (boundDir) session.boundDir = boundDir;
  else delete session.boundDir;
  return saveWorkSession(session);
}

export function deleteWorkSession(id: string): boolean {
  const filePath = sessionPath(id);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  const before = indexCache.length;
  indexCache = indexCache.filter((item) => item.id !== id);
  customOrder = customOrder.filter((itemId) => itemId !== id);
  persistOrder();
  if (before !== indexCache.length) atomicWriteJson(indexPath, indexCache);
  return before !== indexCache.length;
}

/** 置顶/取消置顶会话（会话栏右键菜单）。 */
export function pinWorkSession(id: string, pinned: boolean): boolean {
  ensureInitialized();
  const meta = indexCache.find((item) => item.id === id);
  if (!meta) return false;
  if (pinned) meta.pinned = true;
  else delete meta.pinned;
  sortIndexCache();
  atomicWriteJson(indexPath, indexCache);
  return true;
}

/** 重新排序会话列表（传入当前展示的完整 ID 顺序）。 */
export function reorderWorkSessions(orderedIds: string[]): boolean {
  ensureInitialized();
  if (!Array.isArray(orderedIds)) return false;
  customOrder = orderedIds.filter((id) => typeof id === "string" && indexCache.some((item) => item.id === id));
  persistOrder();
  sortIndexCache();
  atomicWriteJson(indexPath, indexCache);
  return true;
}

export async function openWorkFolder(): Promise<void> {
  ensureInitialized();
  await shell.openPath(rootDir);
}
