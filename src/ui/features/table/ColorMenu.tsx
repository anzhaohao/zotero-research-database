import type { ViewColor } from "../../../domain/types";

export function colorValue(color: string | undefined): string | undefined {
  if (!color || color === "none") return undefined;
  return `var(--zrdb-color-${color})`;
}

export interface ColorTarget {
  kind: "cell" | "row";
  itemKey: string;
  columnID?: string;
  left: number;
  top: number;
}

export const colorChoices: Array<{ value: ViewColor; label: string }> = [
  { value: "none", label: "清除" },
  { value: "gray", label: "灰" },
  { value: "blue", label: "蓝" },
  { value: "green", label: "绿" },
  { value: "yellow", label: "黄" },
  { value: "orange", label: "橙" },
  { value: "red", label: "红" },
  { value: "purple", label: "紫" },
];

export function ColorMenu({
  target,
  onChoose,
  onClose,
}: {
  target: ColorTarget;
  onChoose: (color: ViewColor) => void;
  onClose: () => void;
}) {
  return (
    <div
      className="zrdb-color-menu"
      style={{ left: target.left, top: target.top }}
      role="menu"
      onMouseDown={(event) => event.stopPropagation()}
    >
      {colorChoices.map((choice) => (
        <button
          key={choice.value}
          type="button"
          title={choice.label}
          aria-label={choice.label}
          className={`zrdb-color-swatch color-${choice.value}`}
          onClick={() => onChoose(choice.value)}
        >
          {choice.value === "none" ? "×" : ""}
        </button>
      ))}
      <button type="button" className="zrdb-color-close" onClick={onClose}>
        完成
      </button>
    </div>
  );
}
