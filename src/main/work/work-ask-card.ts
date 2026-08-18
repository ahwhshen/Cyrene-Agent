// Work 结构化询问卡片：主进程侧的发布与作答解析（移植自上游 ask-card.ts）。
//
// 发布时把模型给的规范值（value）藏进私有映射，渲染层只见 optionId；
// 作答回来必须通过 interactionId + optionId 双重对账才解析成规范值，
// 任何字段不符一律抛 E_WORK_ASK_INVALID，不让伪造答案进入执行链。

import { randomUUID } from "crypto";
import type {
  WorkAskAnswer,
  WorkAskCardPayload,
  WorkAskOptionView,
  WorkAskQuestion,
  WorkAskSubmission,
} from "../../shared/work-ask-types";

const MAX_QUESTIONS = 3;
const OPTION_LIMITS: Record<WorkAskQuestion["type"], { min: number; max: number }> = {
  single_select: { min: 2, max: 6 },
  multi_select: { min: 2, max: 8 },
  text: { min: 0, max: 0 },
};

/** 常见 type 别名的归一化映射（模型常输出简写或自然语言变体）。 */
const TYPE_ALIASES: Record<string, WorkAskQuestion["type"]> = {
  single_select: "single_select",
  single: "single_select",
  select: "single_select",
  choice: "single_select",
  radio: "single_select",
  multi_select: "multi_select",
  multi: "multi_select",
  multiselect: "multi_select",
  checkbox: "multi_select",
  text: "text",
  input: "text",
  free: "text",
  free_text: "text",
  freetext: "text",
};

/** 归一化单个 type 值；无法识别时返回空串（由调用方根据 options 兜底推断）。 */
function normalizeAskType(raw: unknown, hasOptions: boolean): WorkAskQuestion["type"] | "" {
  const alias = TYPE_ALIASES[String(raw ?? "").trim().toLowerCase()];
  if (alias) return alias;
  // type 缺失/不认识：有选项默认单选，无选项默认自由填写
  if (raw === undefined || raw === null || raw === "") return hasOptions ? "single_select" : "text";
  return "";
}

/** 校验并规整 Action Gate 输出的 questions；不合法返回 error 说明。 */
export function parseWorkAskQuestions(raw: unknown): { questions?: WorkAskQuestion[]; error?: string } {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_QUESTIONS) {
    return { error: `questions 必须是包含 1-${MAX_QUESTIONS} 个问题的数组` };
  }
  const ids = new Set<string>();
  const questions: WorkAskQuestion[] = [];
  for (const [index, candidate] of raw.entries()) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return { error: `第 ${index + 1} 个问题必须是对象` };
    }
    const item = candidate as Record<string, unknown>;
    // id 缺失时合成占位 id，避免小模型漏字段直接打挂整个卡片
    const id = String(item.id ?? "").trim() || `q${index + 1}`;
    const question = String(item.question ?? "").trim();
    if (ids.has(id)) return { error: `第 ${index + 1} 个问题的 id 必须唯一` };
    if (!question) return { error: `第 ${index + 1} 个问题文本不能为空` };
    const rawOptions = item.options;
    if (rawOptions !== undefined && !Array.isArray(rawOptions)) {
      return { error: `第 ${index + 1} 个问题的 options 必须是数组` };
    }
    const optionsSource = (rawOptions ?? []) as unknown[];
    const type = normalizeAskType(item.type, optionsSource.length > 0);
    if (!type) {
      return { error: `第 ${index + 1} 个问题的 type 必须是 single_select、multi_select 或 text` };
    }
    const limits = OPTION_LIMITS[type];
    if (optionsSource.length < limits.min || optionsSource.length > limits.max) {
      return { error: `第 ${index + 1} 个 ${type} 问题必须有 ${limits.min}-${limits.max} 个选项` };
    }
    const values = new Set<string>();
    const options: WorkAskQuestion["options"] = [];
    for (const optionCandidate of optionsSource) {
      // 宽容模型常见输出形态：纯字符串选项、缺 value（用 label 兜底）
      if (typeof optionCandidate === "string") {
        const text = optionCandidate.trim();
        if (!text) return { error: `第 ${index + 1} 个问题含有空选项` };
        if (values.has(text)) return { error: `第 ${index + 1} 个问题的选项不可重复` };
        values.add(text);
        options.push({ label: text, value: text });
        continue;
      }
      if (!optionCandidate || typeof optionCandidate !== "object" || Array.isArray(optionCandidate)) {
        return { error: `第 ${index + 1} 个问题含有无效选项` };
      }
      const option = optionCandidate as Record<string, unknown>;
      const label = String(option.label ?? "").trim();
      const value = String(option.value ?? "").trim() || label;
      if (!label || values.has(value)) {
        return { error: `第 ${index + 1} 个问题的选项 label 必须非空，且 value 不可重复` };
      }
      values.add(value);
      const description = typeof option.description === "string" ? option.description.trim() : "";
      options.push({ label, value, ...(description ? { description } : {}) });
    }
    ids.add(id);
    questions.push({ id, question, type, options });
  }
  return { questions };
}

interface PublishedQuestion {
  modelId: string;
  prompt: string;
  type: WorkAskQuestion["type"];
  options: Map<string, string>;
}

/** 发布状态只留在主进程，绝不下发渲染层。 */
export interface WorkAskPublication {
  payload: WorkAskCardPayload;
  privateQuestions: Map<string, PublishedQuestion>;
}

export function publishWorkAskCard(
  questions: WorkAskQuestion[],
  identity: { interactionId: string; sessionId: string },
  intro: string,
): WorkAskPublication {
  const privateQuestions = new Map<string, PublishedQuestion>();
  const views = questions.map((question, questionIndex) => {
    const questionId = `question-${questionIndex + 1}`;
    const optionMap = new Map<string, string>();
    const publicOptions: WorkAskOptionView[] = question.options.map((option, optionIndex) => {
      const optionId = `${questionId}-option-${optionIndex + 1}`;
      optionMap.set(optionId, option.value);
      return {
        id: optionId,
        label: option.label,
        ...(option.description ? { description: option.description } : {}),
      };
    });
    privateQuestions.set(questionId, {
      modelId: question.id,
      prompt: question.question,
      type: question.type,
      options: optionMap,
    });
    return {
      id: questionId,
      prompt: question.question,
      multiple: question.type === "multi_select",
      options: publicOptions,
      customEnabled: question.type === "text",
    };
  });
  return {
    payload: {
      interactionId: identity.interactionId,
      sessionId: identity.sessionId,
      intro,
      questions: views,
    },
    privateQuestions,
  };
}

function invalidAnswer(): never {
  throw new Error("E_WORK_ASK_INVALID");
}

/** 渲染层作答 → 规范答案；任何对不上账的提交直接抛错。 */
export function resolveWorkAskSubmission(
  publication: WorkAskPublication,
  submission: WorkAskSubmission,
): WorkAskAnswer {
  const payload = publication.payload;
  if (!submission
    || submission.interactionId !== payload.interactionId
    || !Array.isArray(submission.answers)
    || submission.answers.length !== payload.questions.length) invalidAnswer();

  const seen = new Set<string>();
  const answers = submission.answers.map((answer) => {
    if (!answer || seen.has(answer.questionId)) invalidAnswer();
    seen.add(answer.questionId);
    const question = publication.privateQuestions.get(answer.questionId);
    if (!question) invalidAnswer();

    if (answer.source === "custom") {
      const customText = answer.text?.trim();
      if (question.type !== "text" || !customText) invalidAnswer();
      return { questionId: question.modelId, question: question.prompt, customText };
    }
    if (answer.source !== "option") invalidAnswer();
    const optionIds = answer.optionIds ?? (answer.optionId ? [answer.optionId] : []);
    if (optionIds.length === 0 || (question.type !== "multi_select" && optionIds.length !== 1)) invalidAnswer();
    const values = optionIds.map((optionId) => question.options.get(optionId));
    if (values.some((value) => value === undefined)) invalidAnswer();
    const canonical = values as string[];
    return question.type === "text"
      ? { questionId: question.modelId, question: question.prompt, customText: canonical[0] }
      : { questionId: question.modelId, question: question.prompt, selectedValues: canonical };
  });
  return { interactionId: payload.interactionId, answers };
}

export function newInteractionId(): string {
  return randomUUID();
}
