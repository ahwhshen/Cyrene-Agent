// Work/Code/Learn 模式的结构化询问卡片契约（移植自上游 harness ask_user 机制）。
//
// 安全边界（与上游一致）：
// - WorkAskCardPayload 是渲染层唯一可见的结构：只含选项 id 与显示文本，
//   不含规范值（value）。渲染层作答时只回传 optionId，由主进程
//   work-ask-card.ts 的 resolveWorkAskSubmission 解析成规范值，
//   防止模型或渲染层伪造答案。

export type WorkAskFieldType = "single_select" | "multi_select" | "text";

export interface WorkAskOption {
  value: string;
  label: string;
  description?: string;
}

/** Action Gate 结构化输出里的问题（模型侧视角）。 */
export interface WorkAskQuestion {
  /** 问题唯一标识（模型提供，仅用于答案回填对照）。 */
  id: string;
  question: string;
  type: WorkAskFieldType;
  options: WorkAskOption[];
}

/** 发给渲染层的卡片（经主进程发布，选项只暴露 id）。 */
export interface WorkAskCardPayload {
  interactionId: string;
  sessionId: string;
  intro: string;
  questions: WorkAskQuestionView[];
}

export interface WorkAskQuestionView {
  id: string;
  prompt: string;
  multiple: boolean;
  options: WorkAskOptionView[];
  /** text 类型或允许补充说明时为 true。 */
  customEnabled: boolean;
}

export interface WorkAskOptionView {
  id: string;
  label: string;
  description?: string;
}

/** 渲染层提交回来的作答（只含选项 id / 自由文本，不含规范值）。 */
export interface WorkAskSubmission {
  interactionId: string;
  answers: WorkAskAnswerSubmission[];
}

export type WorkAskAnswerSubmission =
  | { questionId: string; source: "option"; optionId?: string; optionIds?: string[] }
  | { questionId: string; source: "custom"; text: string };

/** 主进程解析后的规范答案（回灌给 Action Gate 的事实）。 */
export interface WorkAskAnswer {
  interactionId: string;
  answers: Array<{
    questionId: string;
    question: string;
    selectedValues?: string[];
    customText?: string;
  }>;
}
