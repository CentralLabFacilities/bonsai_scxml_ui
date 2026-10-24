import { Handle, Position } from "@xyflow/react";
import { useState } from "react";
import { createPortal } from "react-dom";
import { FiAlertCircle } from "react-icons/fi";
import { startTargetEdgeReconnectFromEntry } from "../../utils/edgeReconnect";
import { getConfiguredAssignments, formatStateActionTooltip } from "../../utils/stateActions";

export function ConnectionHandle({
    className = "",
    isConnectable = true,
    isConnectableStart = true,
    isConnectableEnd = true,
    ...props
}) {
    const displayOnly = !isConnectableStart && !isConnectableEnd;
    return (
        <Handle
            {...props}
            className={`connection-handle ${className}`}
            isConnectable={isConnectable}
            isConnectableStart={isConnectable && isConnectableStart}
            isConnectableEnd={isConnectable && isConnectableEnd}
            role={displayOnly ? "img" : "button"}
            tabIndex={displayOnly || !isConnectable ? undefined : 0}
            aria-disabled={!displayOnly && !isConnectable ? true : undefined}
            onKeyDown={displayOnly || !isConnectable ? undefined : (event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                event.stopPropagation();
                event.currentTarget.click();
            }}
        />
    );
}

export function NodeTitle({
    className,
    initial = false,
    initialScope = "root",
    typeLabel,
    badgeClassName,
    label,
    labelClassName,
    leading,
    children,
}) {
    return (
        <div className={className}>
            {leading}
            {initial && (
                <span
                    className={`initial-state-badge initial-state-badge-inline ${initialScope === "container" ? "initial-state-badge-local" : ""}`}
                    title={initialScope === "container" ? "Initial child of this container" : "Initial state of the state machine"}
                >{initialScope === "container" ? "LOCAL INITIAL" : "INITIAL"}</span>
            )}
            {typeLabel && <span className={badgeClassName}>{typeLabel}</span>}
            {label != null && (labelClassName ? (
                <strong className={`${labelClassName} node-title-label`} title={String(label)}>
                    {label}
                </strong>
            ) : (
                <span className="node-title-label" title={String(label)}>{label}</span>
            ))}
            {children}
        </div>
    );
}

export function IncomingTransitionHandle({
    data = {},
    handleId = "transition-target",
    className = "target-handle",
    reconnect = false,
}) {
    const title = reconnect && data.reconnectIncomingEdgeId
        ? "Drag to reconnect the incoming transition"
        : "Incoming transition";
    return (
        <ConnectionHandle
            id={handleId}
            type="target"
            position={Position.Left}
            className={className}
            isConnectableStart={false}
            isConnectableEnd={true}
            onMouseDown={
                reconnect
                    ? (event) =>
                          startTargetEdgeReconnectFromEntry(event, data.reconnectIncomingEdgeId)
                    : undefined
            }
            title={title}
            aria-label={title}
        />
    );
}

export function StateActionBadges({ id, data }) {
    const [tooltip, setTooltip] = useState(null);
    const entryCount = getConfiguredAssignments(data.onEntry).length;
    const exitCount = getConfiguredAssignments(data.onExit).length;
    if (!entryCount && !exitCount) return null;
    const entryTooltip = formatStateActionTooltip(data.onEntry, "OnEntry assignments");
    const exitTooltip = formatStateActionTooltip(data.onExit, "OnExit assignments");

    // The React Flow nodes are individually transformed/stacked. A CSS ::after
    // tooltip inside a node can be obscured by other nodes or the canvas. Render
    // it in the document instead and position it in viewport CSS pixels.
    const showTooltip = (event, content, align) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        const margin = 8;
        const minComfortableWidth = 160;

        // CSS uses width: max-content, so the rendered width is usually smaller
        // than the 340px maximum. Anchor OnExit by its RIGHT edge instead of
        // subtracting the maximum width from the badge's right edge. Flip to
        // the other edge only if there isn't room for a readable tooltip.
        let anchorRight = align === "right";
        if (anchorRight && rect.right - margin < minComfortableWidth) {
            anchorRight = false;
        } else if (!anchorRight && viewportWidth - rect.left - margin < minComfortableWidth) {
            anchorRight = true;
        }
        const left = anchorRight ? undefined : Math.max(margin, rect.left);
        const right = anchorRight ? Math.max(margin, viewportWidth - rect.right) : undefined;
        const availableWidth = anchorRight
            ? viewportWidth - right - margin
            : viewportWidth - left - margin;
        const width = Math.max(0, Math.min(340, availableWidth));

        const spaceAbove = Math.max(0, rect.top - 15);
        const spaceBelow = Math.max(0, window.innerHeight - rect.bottom - 15);
        const estimatedHeight = Math.min(480, 20 + content.split("\n").length * 19);
        const above = spaceAbove >= estimatedHeight || spaceAbove >= spaceBelow;
        setTooltip({
            content,
            left,
            right,
            top: above ? rect.top - 7 : rect.bottom + 7,
            above,
            width,
            maxHeight: Math.max(32, Math.min(480, above ? spaceAbove : spaceBelow)),
        });
    };

    const openActions = (event) => {
        event.preventDefault();
        event.stopPropagation();
        setTooltip(null);
        data.onOpenStateActions?.(id);
    };

    return (
        <div className="state-action-badges" aria-label="Configured state actions">
            {entryCount > 0 && (
                <button
                    type="button"
                    className="state-action-badge state-action-badge-entry nodrag nopan"
                    aria-label={`${entryTooltip}. Click to open Entry / Exit`}
                    onMouseEnter={(event) => showTooltip(event, entryTooltip, "left")}
                    onMouseLeave={() => setTooltip(null)}
                    onFocus={(event) => showTooltip(event, entryTooltip, "left")}
                    onBlur={() => setTooltip(null)}
                    onClick={openActions}
                >
                    onentry
                </button>
            )}
            {exitCount > 0 && (
                <button
                    type="button"
                    className="state-action-badge state-action-badge-exit nodrag nopan"
                    aria-label={`${exitTooltip}. Click to open Entry / Exit`}
                    onMouseEnter={(event) => showTooltip(event, exitTooltip, "right")}
                    onMouseLeave={() => setTooltip(null)}
                    onFocus={(event) => showTooltip(event, exitTooltip, "right")}
                    onBlur={() => setTooltip(null)}
                    onClick={openActions}
                >
                    onexit
                </button>
            )}
            {tooltip && createPortal(
                <div
                    className="state-action-hover-tooltip"
                    role="tooltip"
                    style={{
                        left: tooltip.left,
                        right: tooltip.right,
                        top: tooltip.top,
                        maxWidth: tooltip.width,
                        maxHeight: tooltip.maxHeight,
                        transform: tooltip.above ? "translateY(-100%)" : undefined,
                    }}
                >
                    {tooltip.content}
                </div>,
                document.body,
            )}
        </div>
    );
}

export function NodeWarning({ title }) {
    return title ? (
        <div className="node-warning-badge" title={title}>
            <FiAlertCircle />
        </div>
    ) : null;
}
