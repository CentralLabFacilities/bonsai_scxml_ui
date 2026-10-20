import { memo, useRef, useState } from "react";
import { FiArrowDown, FiArrowUp, FiPlus, FiTrash2, FiMenu } from "react-icons/fi";

const ParallelLaneRow = memo(function ParallelLaneRow({
                             lane,
                             index,
                             laneCount,
                             onRename,
                             onMove,
                             onDelete,
                             draggedLaneId,
                             dropPosition,
                             onDragStart,
                             onDragOver,
                             onDrop,
                             onDragEnd,
                         }) {
    const laneLabel = String(lane?.data?.label || `Lane_${index + 1}`);
    const [draft, setDraft] = useState({ source: laneLabel, value: laneLabel, committed: laneLabel });
    const cancelBlurRef = useRef(false);

    if (draft.source !== laneLabel) {
        setDraft({ source: laneLabel, value: laneLabel, committed: laneLabel });
    }

    const commitName = () => {
        const nextName = String(draft.value || "").trim();
        if (nextName === draft.committed) {
            if (draft.value !== nextName) setDraft({ ...draft, value: nextName });
            return;
        }
        const nextDraft = nextName || laneLabel;
        setDraft({ ...draft, value: nextDraft, committed: nextDraft });
        onRename?.(lane.id, nextName);
    };

    const childCount = Number(lane?.childCount || 0);

    return (
        <div
            className={`parallel-lane-editor-card ${draggedLaneId === lane.id ? "dragging" : ""} ${dropPosition?.laneId === lane.id ? `drop-${dropPosition.placement}` : ""}`}
            onDragOver={(event) => onDragOver?.(event, lane.id)}
            onDrop={(event) => onDrop?.(event, lane.id)}
            onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) onDragOver?.(null, lane.id);
            }}
        >
            <div className="parallel-lane-editor-index" aria-hidden="true">
                {index + 1}
            </div>
            <span
                className="parallel-lane-drag-handle"
                role="button"
                tabIndex={-1}
                draggable
                title={`Drag to reorder ${laneLabel}`}
                aria-label={`Drag to reorder ${laneLabel}`}
                onDragStart={(event) => onDragStart?.(event, lane.id)}
                onDragEnd={onDragEnd}
            >
                <FiMenu size={14} />
            </span>

            <div className="parallel-lane-editor-main">
                <div className="parallel-lane-editor-label-row">
                    <span className="parallel-lane-editor-label">Lane name</span>
                    <span className="parallel-lane-editor-meta">
                        {childCount === 1 ? "1 state" : `${childCount} states`}
                    </span>
                </div>

                <input
                    className="parallel-lane-editor-input"
                    type="text"
                    value={draft.value}
                    placeholder={`Lane_${index + 1}`}
                    spellCheck="false"
                    onChange={(event) => setDraft({ ...draft, value: event.target.value })}
                    onBlur={() => {
                        if (cancelBlurRef.current) {
                            cancelBlurRef.current = false;
                            return;
                        }
                        commitName();
                    }}
                    onKeyDown={(event) => {
                        if (event.key === "Enter") {
                            event.preventDefault();
                            event.currentTarget.blur();
                        } else if (event.key === "Escape") {
                            event.preventDefault();
                            event.stopPropagation();
                            cancelBlurRef.current = true;
                            setDraft({ ...draft, value: draft.committed });
                            event.currentTarget.blur();
                        }
                    }}
                />
            </div>

            <div className="parallel-lane-editor-actions">
                <button
                    type="button"
                    className="parallel-lane-editor-action"
                    title="Move lane up"
                    aria-label={`Move ${laneLabel} up`}
                    disabled={index === 0}
                    onClick={() => onMove?.(lane.id, "up")}
                >
                    <FiArrowUp size={14} />
                </button>
                <button
                    type="button"
                    className="parallel-lane-editor-action"
                    title="Move lane down"
                    aria-label={`Move ${laneLabel} down`}
                    disabled={index >= laneCount - 1}
                    onClick={() => onMove?.(lane.id, "down")}
                >
                    <FiArrowDown size={14} />
                </button>
                <button
                    type="button"
                    className="parallel-lane-editor-action parallel-lane-editor-delete"
                    title={laneCount <= 1 ? "A parallel needs at least one lane" : "Delete lane and its contents"}
                    aria-label={`Delete ${laneLabel}`}
                    disabled={laneCount <= 1}
                    onClick={() => onDelete?.(lane.id)}
                >
                    <FiTrash2 size={13} />
                </button>
            </div>
        </div>
    );
});

function ParallelLaneEditor({
                                lanes = [],
                                onAdd,
                                onRename,
                                onMove,
                                onDelete,
                            }) {
    const [draggedLaneId, setDraggedLaneId] = useState(null);
    const [dropPosition, setDropPosition] = useState(null);
    const onDragStart = (event, laneId) => {
        event.stopPropagation();
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", laneId);
        setDraggedLaneId(laneId);
    };
    const onDragOver = (event, laneId) => {
        if (!event || !draggedLaneId || draggedLaneId === laneId) {
            setDropPosition(null);
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        const bounds = event.currentTarget.getBoundingClientRect();
        const placement = event.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
        setDropPosition((previous) => previous?.laneId === laneId && previous.placement === placement
            ? previous : { laneId, placement });
    };
    const onDrop = (event, laneId) => {
        event.preventDefault();
        event.stopPropagation();
        const sourceId = draggedLaneId;
        const placement = dropPosition?.laneId === laneId ? dropPosition.placement : "after";
        setDraggedLaneId(null);
        setDropPosition(null);
        if (sourceId && sourceId !== laneId) onMove?.(sourceId, { targetLaneId: laneId, placement });
    };
    const onDragEnd = () => {
        setDraggedLaneId(null);
        setDropPosition(null);
    };
    return (
        <section className="parallel-lane-editor">
            <div className="parallel-lane-editor-header">
                <div>
                    <div className="parallel-lane-editor-title-row">
                        <h3>Lanes</h3>
                        <span className="parallel-lane-count-badge">{lanes.length}</span>
                    </div>
                    <p>
                        Rename and arrange the parallel branches. Reordering a lane keeps its states with it.
                    </p>
                </div>

                <button
                    type="button"
                    className="parallel-lane-add-button"
                    onClick={() => onAdd?.()}
                >
                    <FiPlus size={14} />
                    Add lane
                </button>
            </div>

            <div className="parallel-lane-editor-list">
                {lanes.map((lane, index) => (
                    <ParallelLaneRow
                        key={lane.id}
                        lane={lane}
                        index={index}
                        laneCount={lanes.length}
                        onRename={onRename}
                        onMove={onMove}
                        onDelete={onDelete}
                        draggedLaneId={draggedLaneId}
                        dropPosition={dropPosition}
                        onDragStart={onDragStart}
                        onDragOver={onDragOver}
                        onDrop={onDrop}
                        onDragEnd={onDragEnd}
                    />
                ))}

                {lanes.length === 0 && (
                    <div className="parallel-lane-editor-empty">
                        This parallel has no lanes yet. Add one to create its first branch.
                    </div>
                )}
            </div>
        </section>
    );
}

export default ParallelLaneEditor;
