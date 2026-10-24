import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { getVariableType } from "../../utils/valueTypes.js";
import { getUpwardPopoverPosition } from "../../utils/upwardPopoverPlacement.js";

function ExpressionVariableSuggestions({ variables, activeIndex, onSelect, showTypes = false, upwardAnchor = null }) {
    const [position, setPosition] = useState(null);

    useLayoutEffect(() => {
        if (!upwardAnchor) return undefined;
        let frame = null;
        const measure = () => {
            frame = null;
            const rect = upwardAnchor.getBoundingClientRect();
            const scrollContainer = upwardAnchor.closest(".transition-assignment-list");
            const clip = scrollContainer?.getBoundingClientRect();
            const visible = !clip || (rect.bottom > clip.top && rect.top < clip.bottom);
            const next = visible
                ? getUpwardPopoverPosition(rect, window.innerWidth, window.innerHeight)
                : null;
            setPosition((old) => JSON.stringify(old) === JSON.stringify(next) ? old : next);
        };
        const schedule = () => {
            if (frame == null) frame = window.requestAnimationFrame(measure);
        };
        measure();
        // Capture nested assignment-list and drawer scrolling as well as window changes.
        window.addEventListener("scroll", schedule, true);
        window.addEventListener("resize", schedule);
        return () => {
            if (frame != null) window.cancelAnimationFrame(frame);
            window.removeEventListener("scroll", schedule, true);
            window.removeEventListener("resize", schedule);
        };
    }, [upwardAnchor]);

    const list = (
        <div className="typed-value-autocomplete" role="listbox"
             style={upwardAnchor ? position || { display: "none" } : undefined}>
            {variables.map((variable, index) => {
                const type = showTypes ? getVariableType(variable) : null;

                return (
                    <button
                        type="button"
                        className={`typed-value-autocomplete-option ${
                            index === activeIndex ? "active" : ""
                        }`}
                        key={variable.id}
                        onMouseDown={(event) => {
                            event.preventDefault();
                            onSelect(variable);
                        }}
                    >
                        <span className="typed-value-autocomplete-value">
                            @{variable.id}
                        </span>
                        {type && (
                            <span className={`datamodel-value-type-badge datamodel-value-type-${type.toLowerCase()}`}>
                                {type}
                            </span>
                        )}
                    </button>
                );
            })}
        </div>
    );

    // The assignment editor itself scrolls. A CSS-only upward dropdown would
    // still be clipped by that ancestor, so place it in the document overlay.
    return upwardAnchor && typeof document !== "undefined"
        ? createPortal(list, document.body)
        : list;
}

export default ExpressionVariableSuggestions;
