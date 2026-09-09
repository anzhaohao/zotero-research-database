import { assert } from "chai";

export function assertUnobscured(
  win: _ZoteroTypes.MainWindow,
  element: Element,
): void {
  const rect = element.getBoundingClientRect();
  const style = win.getComputedStyle(element);
  assert.isAbove(rect.width, 0, `${element.id} width`);
  assert.isAbove(rect.height, 0, `${element.id} height`);
  assert.equal(style.visibility, "visible", `${element.id} visibility`);
  assert.notEqual(style.display, "none", `${element.id} display`);
  const hit = win.document.elementFromPoint(
    rect.left + rect.width / 2,
    rect.top + rect.height / 2,
  );
  assert.isTrue(
    element === hit || element.contains(hit),
    `${element.id} pointer hit: ${hit?.id || hit?.localName}`,
  );
}

// Native XUL .click() is not a substitute for a trusted pointer activation.
// Route through Gecko's hit testing so an overlay cannot produce a false pass.
export function clickControl(
  win: _ZoteroTypes.MainWindow,
  element: Element,
): void {
  assertUnobscured(win, element);
  const rect = element.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const utils = (win as any).windowUtils;
  utils.sendMouseEvent("mousedown", x, y, 0, 1, 0);
  utils.sendMouseEvent("mouseup", x, y, 0, 1, 0);
}
