/**
 * Skill event names edit their transitions on double-click. An ordinary click
 * must never open a modal; consume it so React Flow does not interpret the
 * second click as a double-click on the enclosing node (Inspector).
 * Keyboard users retain single-action Enter/Space activation.
 */
export function eventDoubleClickHandlers(onActivate) {
    return {
        role: "button",
        tabIndex: 0,
        onMouseDown: (event) => event.stopPropagation(),
        onClick: (event) => event.stopPropagation(),
        onDoubleClick: (event) => {
            event.preventDefault();
            event.stopPropagation();
            onActivate();
        },
        onKeyDown: (event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            event.stopPropagation();
            onActivate();
        },
    };
}
