export const COLUMN_DRAG_HOLD_MS = 260;

export const COLUMN_DRAG_START_DISTANCE = 5;

export const COLUMN_DRAG_EDGE_SIZE = 48;

export const COLUMN_DRAG_SCROLL_STEP = 16;

export const COLUMN_RESIZE_END_GUTTER = 18;

export const MIN_ROW_HEIGHT = 200;

export const MAX_ROW_HEIGHT = 360;

export const ROW_HEIGHT_STEP = 5;

export const ROW_HEIGHT_PRESETS = [
  { value: 220, label: "紧凑" },
  { value: 240, label: "标准" },
  { value: 270, label: "舒适" },
  { value: 300, label: "宽松" },
  { value: 340, label: "展开" },
] as const;
