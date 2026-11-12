/** Pure (no DOM access): also used by the server's tests. */

/**
 * The position of a pointer event inside an element, in the element's own CSS pixels — also while the page is
 * zoomed or scaled: browser / app zoom, pinch zoom, CSS `zoom` or transforms. `clientX/Y` and the element's
 * bounding rectangle are in the same (zoomed) coordinates; the rectangle's size against the element's layout size
 * gives the scale back.
 */
export function pointerInElement(
  e: { clientX: number; clientY: number },
  rect: { left: number; top: number; width: number; height: number },
  layout: { width: number; height: number },
): { x: number; y: number } {
  const sx = layout.width > 0 && rect.width > 0 ? rect.width / layout.width : 1;
  const sy = layout.height > 0 && rect.height > 0 ? rect.height / layout.height : 1;
  return { x: (e.clientX - rect.left) / sx, y: (e.clientY - rect.top) / sy };
}
