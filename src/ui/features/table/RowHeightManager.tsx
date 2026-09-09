import React, { useState } from "react";
import {
  MAX_ROW_HEIGHT,
  MIN_ROW_HEIGHT,
  ROW_HEIGHT_STEP,
  ROW_HEIGHT_PRESETS,
} from "./tableConstants";
import { Modal } from "../shared/ui";

export function RowHeightManager({
  rowHeight,
  onApply,
  onClose,
}: {
  rowHeight: number;
  onApply: (rowHeight: number) => void;
  onClose: () => void;
}) {
  const [draftRowHeight, setDraftRowHeight] = useState(() =>
    Math.min(MAX_ROW_HEIGHT, Math.max(MIN_ROW_HEIGHT, Math.round(rowHeight))),
  );
  const progress =
    ((draftRowHeight - MIN_ROW_HEIGHT) / (MAX_ROW_HEIGHT - MIN_ROW_HEIGHT)) *
    100;

  return (
    <Modal title="统一调整行高" onClose={onClose}>
      <form
        className="zrdb-row-height-manager"
        onSubmit={(event) => {
          event.preventDefault();
          onApply(draftRowHeight);
        }}
      >
        <div className="zrdb-row-height-readout">
          <span>当前高度</span>
          <output htmlFor="zrdb-row-height-slider">
            {draftRowHeight}
            <small> px</small>
          </output>
        </div>
        <div
          className="zrdb-row-height-track"
          style={
            {
              "--zrdb-row-height-progress": `${progress}%`,
            } as React.CSSProperties
          }
        >
          <input
            id="zrdb-row-height-slider"
            className="zrdb-row-height-slider"
            type="range"
            min={MIN_ROW_HEIGHT}
            max={MAX_ROW_HEIGHT}
            step={ROW_HEIGHT_STEP}
            value={draftRowHeight}
            aria-label="统一行高"
            aria-valuetext={`${draftRowHeight} 像素`}
            aria-describedby="zrdb-row-height-note"
            onChange={(event) =>
              setDraftRowHeight(Number.parseInt(event.target.value, 10))
            }
          />
          <div
            className="zrdb-row-height-nodes"
            role="group"
            aria-label="预设行高"
          >
            {ROW_HEIGHT_PRESETS.map((preset) => {
              const position =
                ((preset.value - MIN_ROW_HEIGHT) /
                  (MAX_ROW_HEIGHT - MIN_ROW_HEIGHT)) *
                100;
              return (
                <button
                  key={preset.value}
                  className="zrdb-row-height-node"
                  type="button"
                  aria-label={`${preset.value} ${preset.label}`}
                  aria-pressed={draftRowHeight === preset.value}
                  style={
                    {
                      "--zrdb-row-height-node-position": `${position}%`,
                    } as React.CSSProperties
                  }
                  onClick={() => setDraftRowHeight(preset.value)}
                >
                  <span
                    className="zrdb-row-height-node-dot"
                    aria-hidden="true"
                  />
                  <span>{preset.value}</span>
                  <small>{preset.label}</small>
                </button>
              );
            })}
          </div>
        </div>
        <p id="zrdb-row-height-note" className="zrdb-row-height-note">
          应用后会清除当前视图的逐篇行高，所有文献行使用同一高度。
        </p>
        <div className="zrdb-dialog-actions">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button className="primary" type="submit">
            统一全部行
          </button>
        </div>
      </form>
    </Modal>
  );
}
