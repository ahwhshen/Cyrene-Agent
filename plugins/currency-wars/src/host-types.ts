// host-types —— 宿主能力面的数据结构（原 game-bot 侧类型，插件化后本地化）。
// 插件运行时从 ctx.services.gamebot 拿到的动作工具，其输入输出即这些结构。
// 保持与原宿主类型逐字段一致，服务实现无需做任何转换。

/** 进度回调：每个顶层步骤执行前调用。 */
export type ProgressCb = (info: { index: number; total: number; desc: string }) => void;

/** OCR 识别出的单个文本块。 */
export interface OcrTextItem {
  text: string;
  confidence: number;
  bounds: { x: number; y: number; width: number; height: number };
}

/** 一次识别的结果（OCR 或 VLM 文字识别）。 */
export interface OcrResult {
  rawText: string;
  items: OcrTextItem[];
}

/** 相对窗口尺寸的比例坐标（0~1）。 */
export interface RatioPoint {
  x: number;
  y: number;
}

export interface RatioRegion extends RatioPoint {
  width: number;
  height: number;
}

/** 定位到的目标窗口（屏幕绝对像素）。 */
export interface WindowTarget {
  title: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 一次窗口截图。 */
export interface WindowCapture {
  base64: string;
  mime: string;
  width: number;
  height: number;
  screenRegion: WindowTarget;
}
