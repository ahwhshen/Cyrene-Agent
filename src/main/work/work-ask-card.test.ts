import { describe, expect, it } from "vitest";
import {
  parseWorkAskQuestions,
  publishWorkAskCard,
  resolveWorkAskSubmission,
} from "./work-ask-card";

const validQuestions = [
  {
    id: "format",
    question: "报告用什么格式？",
    type: "single_select",
    options: [
      { label: "Word", value: "docx" },
      { label: "PDF", value: "pdf" },
    ],
  },
  {
    id: "note",
    question: "补充说明",
    type: "text",
    options: [],
  },
];

describe("parseWorkAskQuestions", () => {
  it("accepts valid questions", () => {
    const result = parseWorkAskQuestions(validQuestions);
    expect(result.error).toBeUndefined();
    expect(result.questions).toHaveLength(2);
  });

  it("rejects more than 3 questions", () => {
    const four = [...validQuestions, ...validQuestions].map((question, index) => ({ ...question, id: `q${index}` }));
    expect(parseWorkAskQuestions(four).error).toMatch(/1-3/);
  });

  it("rejects single_select with only one option", () => {
    const result = parseWorkAskQuestions([
      { id: "x", question: "选一个", type: "single_select", options: [{ label: "唯一", value: "only" }] },
    ]);
    expect(result.error).toMatch(/2-6/);
  });

  it("rejects duplicate option values", () => {
    const result = parseWorkAskQuestions([
      {
        id: "x",
        question: "选一个",
        type: "single_select",
        options: [
          { label: "A", value: "same" },
          { label: "B", value: "same" },
        ],
      },
    ]);
    expect(result.error).toMatch(/value 不可重复/);
  });

  it("accepts plain string options and normalizes them", () => {
    const result = parseWorkAskQuestions([
      { id: "q1", question: "选一个", type: "single_select", options: ["本周", "最近两周"] },
    ]);
    expect(result.error).toBeUndefined();
    expect(result.questions?.[0].options).toEqual([
      { label: "本周", value: "本周" },
      { label: "最近两周", value: "最近两周" },
    ]);
  });

  it("falls back value to label and synthesizes missing id", () => {
    const result = parseWorkAskQuestions([
      { question: "选一个", type: "single_select", options: [{ label: "A" }, { label: "B" }] },
    ]);
    expect(result.error).toBeUndefined();
    expect(result.questions?.[0].id).toBe("q1");
    expect(result.questions?.[0].options[0].value).toBe("A");
  });

  it("normalizes type aliases and infers missing type from options", () => {
    const aliased = parseWorkAskQuestions([
      { id: "a", question: "多选", type: "checkbox", options: ["一", "二"] },
      { id: "b", question: "没写类型但有选项", options: ["一", "二"] },
      { id: "c", question: "没写类型也没选项" },
    ]);
    expect(aliased.error).toBeUndefined();
    expect(aliased.questions?.map((question) => question.type)).toEqual([
      "multi_select",
      "single_select",
      "text",
    ]);
  });
});

describe("publishWorkAskCard + resolveWorkAskSubmission", () => {
  it("resolves option ids back to canonical values without leaking them to the payload", () => {
    const parsed = parseWorkAskQuestions(validQuestions).questions!;
    const publication = publishWorkAskCard(parsed, { interactionId: "i-1", sessionId: "s-1" }, "需要确认");
    // payload 对渲染层不可见规范值
    const serialized = JSON.stringify(publication.payload);
    expect(serialized).not.toContain("docx");

    const answer = resolveWorkAskSubmission(publication, {
      interactionId: "i-1",
      answers: [
        { questionId: "question-1", source: "option", optionId: "question-1-option-1" },
        { questionId: "question-2", source: "custom", text: "周五前给我" },
      ],
    });
    expect(answer.answers[0].selectedValues).toEqual(["docx"]);
    expect(answer.answers[1].customText).toBe("周五前给我");
  });

  it("rejects submissions with wrong interactionId", () => {
    const publication = publishWorkAskCard(parseWorkAskQuestions(validQuestions).questions!, {
      interactionId: "i-1",
      sessionId: "s-1",
    }, "");
    expect(() => resolveWorkAskSubmission(publication, { interactionId: "forged", answers: [] }))
      .toThrow("E_WORK_ASK_INVALID");
  });

  it("rejects forged option ids and missing answers", () => {
    const publication = publishWorkAskCard(parseWorkAskQuestions(validQuestions).questions!, {
      interactionId: "i-1",
      sessionId: "s-1",
    }, "");
    expect(() => resolveWorkAskSubmission(publication, {
      interactionId: "i-1",
      answers: [
        { questionId: "question-1", source: "option", optionId: "question-1-option-99" },
        { questionId: "question-2", source: "custom", text: "x" },
      ],
    })).toThrow("E_WORK_ASK_INVALID");
    expect(() => resolveWorkAskSubmission(publication, {
      interactionId: "i-1",
      answers: [{ questionId: "question-1", source: "option", optionId: "question-1-option-1" }],
    })).toThrow("E_WORK_ASK_INVALID");
  });
});
