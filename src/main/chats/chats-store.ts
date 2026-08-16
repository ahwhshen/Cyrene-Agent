// 聊天会话持久化存储
//
// 布局：<userData>/cyrene-chats/
//   index.json              — ChatSessionMeta[]，按 updatedAt desc 排序
//   sessions/<id>.json      — 完整 ChatSession（含 messages）
//
// 设计：
// - 列表读 index.json（轻），进入会话才读 sessions/<id>.json（重）；
// - 写时先写 .tmp 再 rename，避免 crash 中间态损坏文件；
// - index.json 在内存里有缓存（initialize() 时一次性加载），
//   后续 list 直接返回缓存的 deep clone；任何写操作后同步刷新缓存；
// - 删除文件夹整体可移植：用户拷贝 cyrene-chats/ 到新机器即可恢复。

import { app, shell } from "electron";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import {
  CHAT_SCHEMA_VERSION,
  type ChatMessage,
  type ChatSession,
  type ChatSessionMeta,
  type ChatSessionPurpose,
} from "../../shared/chat-types";

const ROOT_DIR_NAME = "cyrene-chats";
const SESSIONS_SUBDIR = "sessions";
const INDEX_FILE = "index.json";
const ORDER_FILE = "order.json";

let rootDir = "";
let sessionsDir = "";
let indexPath = "";
let orderPath = "";
let indexCache: ChatSessionMeta[] = [];
let customOrder: string[] = []; // 用户手动排序的 ID 列表
let initialized = false;

function ensureDirs(): void {
  if (!fs.existsSync(rootDir)) fs.mkdirSync(rootDir, { recursive: true });
  if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });
}

function readOrderFromDisk(): string[] {
  if (!fs.existsSync(orderPath)) return [];
  try {
    const raw = fs.readFileSync(orderPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
}

function persistOrder(): void {
  atomicWriteJson(orderPath, customOrder);
}

function atomicWriteJson(filePath: string, data: unknown): void {
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmpPath, filePath);
}

function readIndexFromDisk(): ChatSessionMeta[] {
  if (!fs.existsSync(indexPath)) return [];
  try {
    const raw = fs.readFileSync(indexPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is ChatSessionMeta => {
      if (!item || typeof item !== "object") return false;
      const meta = item as Partial<ChatSessionMeta>;
      return (
        typeof meta.id === "string" &&
        typeof meta.title === "string" &&
        typeof meta.createdAt === "number" &&
        typeof meta.updatedAt === "number" &&
        typeof meta.messageCount === "number" &&
        (meta.purpose === undefined || meta.purpose === "proactive-chat")
      );
    });
  } catch (err) {
    console.warn("[chats-store] index.json 解析失败，重置为空:", err);
    return [];
  }
}

function persistIndex(): void {
  // 排序规则：置顶优先，然后按 customOrder（如果有），最后按 updatedAt desc
  const orderIdx = new Map(customOrder.map((id, i) => [id, i]));
  indexCache.sort((a, b) => {
    // 置顶的排前面
    const aPin = a.pinned ? 0 : 1;
    const bPin = b.pinned ? 0 : 1;
    if (aPin !== bPin) return aPin - bPin;
    // 同组内按 customOrder
    const aOrder = orderIdx.has(a.id) ? orderIdx.get(a.id)! : Infinity;
    const bOrder = orderIdx.has(b.id) ? orderIdx.get(b.id)! : Infinity;
    if (aOrder !== bOrder) return aOrder - bOrder;
    // 最后按 updatedAt desc
    return b.updatedAt - a.updatedAt;
  });
  atomicWriteJson(indexPath, indexCache);
}

function sessionPath(id: string): string {
  // Windows 文件名不允许冒号，统一替换为下划线
  const safeId = id.replace(/:/g, "_");
  return path.join(sessionsDir, safeId + ".json");
}

/**
 * 迁移旧数据：早期微信历史导入的消息 role 存成了 "assistant"，
 * 渲染层只认 "user" | "model"，导致这些消息没有头像。
 * 这里把 role 归一到 ChatRole，并按 角色+内容+时间戳 去掉由此产生的重复消息。
 * 返回是否有改动（有改动时调用方回写磁盘）。
 */
function migrateSessionRoles(session: ChatSession): boolean {
  let changed = false;
  const seen = new Set<string>();
  // 近重复去重：同步客户端和旧导入可能把同一条消息写两次（时间戳相差十几 ms），
  // 仅限 synced 消息：同角色+同内容且时间差 < 2s 视为同一条；本地发送的重复消息不受影响。
  const recentByKey = new Map<string, number>();
  const migrated: ChatMessage[] = [];
  for (const m of session.messages) {
    const rawRole = m.role as string;
    let role = m.role;
    if (rawRole !== "user" && rawRole !== "model") {
      role = rawRole === "assistant" || rawRole === "system" ? "model" : "user";
      changed = true;
    }
    const key = `${role}|${m.content}|${m.at}`;
    if (seen.has(key)) {
      changed = true; // 去掉重复消息
      continue;
    }
    const nearKey = `${role}|${m.content}`;
    const lastAt = m.source === "synced" ? recentByKey.get(nearKey) : undefined;
    if (lastAt !== undefined && Math.abs(m.at - lastAt) < 2000) {
      changed = true; // 同一条消息的双写，去掉后到的一条
      continue;
    }
    if (m.source === "synced") recentByKey.set(nearKey, m.at);
    seen.add(key);
    migrated.push(role === m.role ? m : { ...m, role });
  }
  if (changed) session.messages = migrated;
  return changed;
}

function readSessionFile(id: string): ChatSession | null {
  const filePath = sessionPath(id);
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as ChatSession;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.messages)) {
      return null;
    }
    if (migrateSessionRoles(parsed)) {
      writeSessionFile(parsed);
    }
    return parsed;
  } catch (err) {
    console.warn("[chats-store] session 文件解析失败:", id, err);
    return null;
  }
}

function writeSessionFile(session: ChatSession): void {
  atomicWriteJson(sessionPath(session.id), session);
}

function metaFromSession(session: ChatSession): ChatSessionMeta {
  const existing = indexCache.find(m => m.id === session.id);
  return {
    id: session.id,
    title: session.title,
    identityId: session.identityId,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
    purpose: session.purpose,
    pinned: existing?.pinned ?? false,
  };
}

function upsertMeta(meta: ChatSessionMeta): void {
  const idx = indexCache.findIndex((m) => m.id === meta.id);
  if (idx === -1) indexCache.push(meta);
  else indexCache[idx] = meta;
  persistIndex();
}

function removeMetaById(id: string): void {
  indexCache = indexCache.filter((m) => m.id !== id);
  persistIndex();
}

// 从首条用户消息推导标题（前 30 字 / 单行）。
function deriveTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user" && m.content.trim());
  if (!firstUser) return "新对话";
  const cleaned = firstUser.content.replace(/\s+/g, " ").trim();
  return cleaned.length > 30 ? cleaned.slice(0, 30) + "…" : cleaned;
}

// ── public API ──────────────────────────────────────────────

export function initialize(): void {
  if (initialized) return;
  rootDir = path.join(app.getPath("userData"), ROOT_DIR_NAME);
  sessionsDir = path.join(rootDir, SESSIONS_SUBDIR);
  indexPath = path.join(rootDir, INDEX_FILE);
  orderPath = path.join(rootDir, ORDER_FILE);
  ensureDirs();
  indexCache = readIndexFromDisk();
  customOrder = readOrderFromDisk();
  initialized = true;
}

export function getRootDir(): string {
  return rootDir;
}

export function listSessions(): ChatSessionMeta[] {
  // 返回深拷贝，避免外部修改影响缓存
  return indexCache.map((m) => ({ ...m }));
}

export function getSession(id: string): ChatSession | null {
  return readSessionFile(id);
}

export function getSessionPage(id: string, before: number | null, limit: number): {
  session: Omit<ChatSession, "messages"> & { messageCount: number };
  messages: ChatMessage[];
  hasMore: boolean;
} | null {
  const session = readSessionFile(id);
  if (!session) return null;
  const end = Math.max(0, Math.min(before ?? session.messages.length, session.messages.length));
  const safeLimit = Math.max(1, Math.min(Math.floor(limit) || 1, 200));
  const start = Math.max(0, end - safeLimit);
  const { messages: _messages, ...meta } = session;
  return {
    session: { ...meta, messageCount: session.messages.length },
    messages: session.messages.slice(start, end),
    hasMore: start > 0,
  };
}

export function createSession(opts?: {
  title?: string;
  identityId?: string | null;
  initialMessages?: ChatMessage[];
  purpose?: ChatSessionPurpose;
}): ChatSession {
  const now = Date.now();
  const messages = opts?.initialMessages ?? [];
  const session: ChatSession = {
    id: randomUUID(),
    title: opts?.title?.trim() || (messages.length > 0 ? deriveTitle(messages) : "新对话"),
    identityId: opts?.identityId ?? null,
    messages,
    createdAt: now,
    updatedAt: now,
    schemaVersion: CHAT_SCHEMA_VERSION,
    purpose: opts?.purpose,
    titleIsCustom: opts?.purpose ? true : undefined,
  };
  writeSessionFile(session);
  upsertMeta(metaFromSession(session));
  return session;
}

export function getSessionByPurpose(purpose: ChatSessionPurpose): ChatSession | null {
  const meta = indexCache.find((session) => session.purpose === purpose);
  return meta ? readSessionFile(meta.id) : null;
}

/**
 * Electron 主进程内的 store API 是同步的：查询与创建之间没有 await，
 * 因此同一事件循环上的并发调用也无法穿插出两个同用途会话。
 */
export function getOrCreateSessionByPurpose(
  purpose: ChatSessionPurpose,
  opts?: { title?: string; identityId?: string | null },
): ChatSession {
  const existing = getSessionByPurpose(purpose);
  if (existing) return existing;
  return createSession({
    title: opts?.title,
    identityId: opts?.identityId ?? null,
    purpose,
  });
}

export function appendMessage(id: string, message: ChatMessage): ChatSession | null {
  const session = readSessionFile(id);
  if (!session) return null;
  session.messages.push(message);
  session.updatedAt = Date.now();
  // 用户没手动改名时，根据最新内容重新派生（清空后也会回到"新对话"）
  if (!session.titleIsCustom) {
    session.title = deriveTitle(session.messages);
  }
  writeSessionFile(session);
  upsertMeta(metaFromSession(session));
  return session;
}

// 批量覆盖整个 messages 数组（聊天窗口流式结束/清空/错误等场景用）。
// updatedAt 一并刷新；用户没手动改名时根据新内容重新派生。
export function replaceMessages(id: string, messages: ChatMessage[]): ChatSession | null {
  const session = readSessionFile(id);
  if (!session) return null;
  session.messages = messages;
  session.updatedAt = Date.now();
  if (!session.titleIsCustom) {
    session.title = deriveTitle(session.messages);
  }
  writeSessionFile(session);
  upsertMeta(metaFromSession(session));
  return session;
}

export function replaceMessagesTail(id: string, startIndex: number, messages: ChatMessage[]): ChatSession | null {
  const session = readSessionFile(id);
  if (!session || !Number.isInteger(startIndex) || startIndex < 0 || startIndex > session.messages.length) return null;
  session.messages = session.messages.slice(0, startIndex).concat(messages);
  session.updatedAt = Date.now();
  if (!session.titleIsCustom) session.title = deriveTitle(session.messages);
  writeSessionFile(session);
  upsertMeta(metaFromSession(session));
  return session;
}

/**
 * 删除一条消息及其配对（整轮）。
 * - 删除 AI(model) 消息时：如果前一条是 user 消息，一起删除
 * - 删除 user 消息时：如果后一条是 model 消息，一起删除
 * 用于清除 AI 越界生成等有问题的历史记录，避免污染上下文。
 */
export function deleteMessageRound(id: string, messageId: string): ChatSession | null {
  const session = readSessionFile(id);
  if (!session) return null;
  const index = session.messages.findIndex(m => m.id === messageId);
  if (index < 0) return null;

  let start = index;
  let end = index + 1;

  const target = session.messages[index];
  // 通话消息（callEvent 标记）是独立事件记录，不是对话轮次，删除时不连带相邻消息。
  if (target.callEvent) {
    // 只删通话消息本身
  } else if (target.role === "model" && index > 0 && session.messages[index - 1].role === "user") {
    start = index - 1;
  } else if (target.role === "user" && index + 1 < session.messages.length && session.messages[index + 1].role === "model") {
    end = index + 2;
  }

  session.messages.splice(start, end - start);
  session.updatedAt = Date.now();
  if (!session.titleIsCustom) session.title = deriveTitle(session.messages);
  writeSessionFile(session);
  upsertMeta(metaFromSession(session));
  return session;
}

export function renameSession(id: string, title: string): ChatSession | null {
  const session = readSessionFile(id);
  if (!session) return null;
  const trimmed = title.trim();
  if (!trimmed) return session;
  session.title = trimmed.slice(0, 80);
  session.titleIsCustom = true;
  session.updatedAt = Date.now();
  writeSessionFile(session);
  upsertMeta(metaFromSession(session));
  return session;
}

export function deleteSession(id: string): boolean {
  const filePath = sessionPath(id);
  let fileExisted = false;
  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
      fileExisted = true;
    } catch (err) {
      console.warn("[chats-store] 删除 session 文件失败:", id, err);
    }
  }
  const inIndex = indexCache.some((m) => m.id === id);
  if (inIndex) removeMetaById(id);
  // 从 customOrder 中也移除
  customOrder = customOrder.filter(x => x !== id);
  persistOrder();
  return fileExisted || inIndex;
}

// 置顶/取消置顶会话
export function pinSession(id: string, pinned: boolean): boolean {
  const meta = indexCache.find(m => m.id === id);
  if (!meta) return false;
  meta.pinned = pinned;
  persistIndex();
  return true;
}

// 重新排序会话列表（传入完整的 ID 顺序）
export function reorderSessions(orderedIds: string[]): boolean {
  // 只保留当前存在的 ID
  const validIds = orderedIds.filter(id => indexCache.some(m => m.id === id));
  customOrder = validIds;
  persistOrder();
  persistIndex();
  return true;
}

// 返回最新一条会话的 id（按 updatedAt 排）；列表为空返回 null。
export function getLatestSessionId(): string | null {
  if (indexCache.length === 0) return null;
  // indexCache 已按 updatedAt desc 持久化，但保险起见再排一次
  const sorted = [...indexCache].sort((a, b) => b.updatedAt - a.updatedAt);
  return sorted[0].id;
}

// 一次性迁移：从聊天窗口 localStorage 拿来的旧 Message[] 包成单个 session。
// 已经迁移过（再次调用且数据相同）时返回 null 让调用方决定是否提示。
export function migrateLegacyMessages(messages: ChatMessage[]): ChatSession | null {
  if (!messages || messages.length === 0) return null;
  // 过滤掉无意义条目（空 content / 占位）
  const cleaned = messages.filter(
    (m) => m && (m.role === "user" || m.role === "model") && typeof m.content === "string" && m.content.trim(),
  );
  if (cleaned.length === 0) return null;
  return createSession({
    title: "历史对话",
    identityId: null,
    initialMessages: cleaned,
  });
}

// 在系统文件管理器中打开存储目录。
export async function openStorageFolder(): Promise<void> {
  ensureDirs();
  await shell.openPath(rootDir);
}

// ── 消息同步集成 ────────────────────────────────────────────

/** 从远程服务器同步的消息结构 */
export interface SyncedMessage {
  uid: string;
  role: string;
  content: string;
  timestamp: number;
  session_id: string | null;
}

/**
 * 将远程同步的消息合并到本地聊天存储。
 * - 按 session_id 分组
 * - 不存在的 session 自动创建
 * - 按时间顺序插入，避免重复（通过 uid 检查）
 * - 返回新插入的消息数量
 */
/** 同步消息统一使用的会话 ID */
const WECHAT_SESSION_ID = "wechat-sync";

/** 测试消息内容匹配，这些消息不存入聊天记录 */
const TEST_MESSAGE_PATTERNS = ["测试消息", "回复消息"];

function isTestMessage(content: string): boolean {
  const trimmed = content.trim();
  return TEST_MESSAGE_PATTERNS.some((p) => trimmed === p);
}

export function mergeSyncedMessages(messages: SyncedMessage[]): number {
  if (!messages || messages.length === 0) return 0;

  // 过滤掉测试消息
  const realMessages = messages.filter((m) => !isTestMessage(m.content));
  if (realMessages.length === 0) return 0;

  // 所有同步消息合并到同一个"微信聊天"会话
  let session = readSessionFile(WECHAT_SESSION_ID);

  if (!session) {
    // 创建新的微信聊天会话
    const initialMessages: ChatMessage[] = [];
    for (const msg of realMessages) {
      const role = normalizeRole(msg.role);
      initialMessages.push({
        id: msg.uid,
        role,
        content: msg.content,
        at: msg.timestamp,
        source: "synced",
      });
    }
    initialMessages.sort((a, b) => a.at - b.at);
    const newSession = createSession({
      title: "微信聊天",
      initialMessages,
    });
    // 重命名为固定 ID
    if (newSession.id !== WECHAT_SESSION_ID) {
      const oldId = newSession.id;
      const oldPath = sessionPath(oldId);
      newSession.id = WECHAT_SESSION_ID;
      writeSessionFile(newSession);
      if (fs.existsSync(oldPath)) {
        try { fs.unlinkSync(oldPath); } catch { /* ignore */ }
      }
      // 先删除旧的 UUID 条目，再插入新条目
      removeMetaById(oldId);
      upsertMeta(metaFromSession(newSession));
    }
    return realMessages.length;
  }

  // 会话已存在，插入新消息（去重：按 uid + 内容/角色/时间戳）
  const existingUids = new Set(session.messages.map((m) => m.id));
  const existingKeys = new Set(session.messages.map((m) => `${m.role}|${m.content}|${m.at}`));
  // 近重复去重：同一条消息可能在服务器侧有两个 uid（导入 + 渠道双写），时间戳相差十几 ms；
  // 同角色+同内容且时间差 < 2s 视为同一条，与迁移逻辑保持一致。
  const existingNear = new Map<string, number>();
  for (const m of session.messages) {
    const nearKey = `${m.role}|${m.content}`;
    const prev = existingNear.get(nearKey);
    if (prev === undefined || m.at > prev) existingNear.set(nearKey, m.at);
  }
  const newMsgs: ChatMessage[] = [];

  for (const msg of realMessages) {
    const key = `${normalizeRole(msg.role)}|${msg.content}|${msg.timestamp}`;
    if (existingUids.has(msg.uid) || existingKeys.has(key)) continue;
    const role = normalizeRole(msg.role);
    const nearKey = `${role}|${msg.content}`;
    const nearAt = existingNear.get(nearKey);
    if (nearAt !== undefined && Math.abs(msg.timestamp - nearAt) < 2000) continue;
    newMsgs.push({
      id: msg.uid,
      role,
      content: msg.content,
      at: msg.timestamp,
      source: "synced",
    });
    existingUids.add(msg.uid);
    existingKeys.add(key);
    existingNear.set(nearKey, msg.timestamp);
  }

  if (newMsgs.length === 0) return 0;

  // 合并并按时间排序
  session.messages = [...session.messages, ...newMsgs].sort((a, b) => a.at - b.at);
  session.updatedAt = Date.now();
  if (!session.titleIsCustom) {
    session.title = deriveTitle(session.messages);
  }
  writeSessionFile(session);
  upsertMeta(metaFromSession(session));
  return newMsgs.length;
}

/** 将远程 role 映射到本地 ChatRole */
function normalizeRole(role: string): "user" | "model" {
  const r = role.toLowerCase();
  if (r === "assistant" || r === "model" || r === "system") return "model";
  return "user";
}
