/** Position a fixed autocomplete above its input, independent of scrollable ancestors.
 * Coordinates are viewport CSS pixels; no document geometry is changed.
 */
export function getUpwardPopoverPosition(rect, viewportWidth, viewportHeight, options = {}) {
    const gap = options.gap ?? 5;
    const inset = options.inset ?? 8;
    const preferredHeight = options.maxHeight ?? 180;
    if (!rect || rect.width <= 0 || rect.bottom <= 0 || rect.top >= viewportHeight) return null;

    const availableWidth = Math.max(0, viewportWidth - 2 * inset);
    const width = Math.min(rect.width, availableWidth);
    const left = Math.max(inset, Math.min(rect.left, viewportWidth - inset - width));
    const maxHeight = Math.max(0, Math.min(preferredHeight, rect.top - gap - inset));
    if (maxHeight < 24 || width <= 0) return null;

    return {
        position: "fixed",
        top: "auto",
        right: "auto",
        bottom: viewportHeight - rect.top + gap,
        left,
        width,
        maxHeight,
        zIndex: 2100,
    };
}
