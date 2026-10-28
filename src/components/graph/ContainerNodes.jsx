import { Handle, NodeResizer, Position, useReactFlow, useUpdateNodeInternals } from "@xyflow/react";
import { useCallback, useEffect } from "react";
import { FiChevronDown, FiChevronRight, FiPlus } from "react-icons/fi";
import { ConnectionHandle, IncomingTransitionHandle, NodeTitle, StateActionBadges } from "./NodeChrome";
import { getCollapsedBoundaryLayout, getContainerExitEvents, resizeParallelLanes } from "../../utils/containerState.js";
import { PARALLEL_BOTTOM_PADDING, PARALLEL_HEADER_HEIGHT, growAllStateContainersToContents, measureCompoundMinimumSize, measureParallelMinimumSize, withNodeDimensions } from "../../utils/editorGeometry.js";
import { beginResizeTrace, finishResizeTrace, traceResizeForContainer, traceResizeGesture, traceResizeNodeMutation } from "../../utils/resizeDiagnostics.js";

// A Compound/Parallel switches between a different set of handles when
// collapsed, and imported boundary events may add handles after first render.
// Invalidate React Flow's handle measurements when that topology changes.
function useContainerHandleLayout(id, events, collapsed = false) {
    const updateNodeInternals = useUpdateNodeInternals();
    // A port can keep the same handle ID while its target changes; grouping
    // then changes its Y coordinate and React Flow must remeasure it.
    const signature = `${collapsed}|${events.map((event) => `${event.id}:${event.target || ""}`).join("|")}`;
    useEffect(() => {
        const frame = requestAnimationFrame(() => updateNodeInternals(id));
        return () => cancelAnimationFrame(frame);
    }, [id, signature, updateNodeInternals]);
}

function ContainerHeader({ id, data, type }) {
    const isParallel = type === "parallel";
    const isCollapsed = Boolean(data.isCollapsed);
    const collapseLabel = `${isCollapsed ? "Expand" : "Collapse"} ${type}`;

    return (
        <NodeTitle
            className={isParallel ? "parallel-group-header" : "compound-frame-header"}
            initial={data.isInitial && (isParallel || !data.autoParallelLaneCompound)}
            initialScope={data.initialScope}
            typeLabel={isParallel ? "PARALLEL" : "COMPOUND"}
            badgeClassName={isParallel ? "parallel-badge" : "compound-frame-badge"}
            label={data.label || (isParallel ? id : "Compound")}
            labelClassName={isParallel ? "parallel-title" : "compound-frame-title"}
            leading={
                <button
                    type="button"
                    className="container-collapse-btn nodrag nopan"
                    title={collapseLabel}
                    aria-label={collapseLabel}
                    onClick={(event) => {
                        event.stopPropagation();
                        data.onToggleCollapse?.(id);
                    }}
                >
                    {isCollapsed ? <FiChevronRight size={14} /> : <FiChevronDown size={14} />}
                </button>
            }
        />
    );
}

function CollapsedSlotAnchor({ data }) {
    if (!data.isCollapsed || (data.mode !== "slots" && data.mode !== "overview")) return null;
    return (
        <ConnectionHandle
            id="collapsed-slot-source"
            type="source"
            position={Position.Bottom}
            className="collapsed-slot-source-handle"
            isConnectableStart={false}
            isConnectableEnd={false}
            title="Collapsed slot connections"
            aria-label="Collapsed slot connections"
        />
    );
}

function BoundaryExits({ events }) {
    if (events.length === 0) return null;
    return (
        <div className="compound-frame-exits">
            {events.map((event) => {
                const label = event.name || event.rawEvent || event.id;
                return (
                    <div className="compound-frame-exit-item" key={event.id}>
                        {/* Internal helper edges arrive at the label; transitions leave at the border. */}
                        <Handle
                            id={`target-${event.id}`}
                            type="target"
                            position={Position.Left}
                            className="compound-frame-exit-target-handle"
                            style={{ opacity: 0, pointerEvents: "none" }}
                            isConnectableStart={false}
                            isConnectableEnd={false}
                        />
                        <span className="compound-frame-exit-label" title={label}>
                            {label}
                        </span>
                        <ConnectionHandle
                            id={event.id}
                            type="source"
                            position={Position.Right}
                            className="compound-frame-source-handle"
                            isConnectableStart={true}
                            isConnectableEnd={false}
                            title={`Outgoing transition: ${label}`}
                            aria-label={`Outgoing transition: ${label}`}
                        />
                    </div>
                );
            })}
        </div>
    );
}

export function CompoundNode({ id, data = {}, selected = false }) {
    const isCollapsed = Boolean(data.isCollapsed);
    const isParallelLaneWrapper = Boolean(data.autoParallelLaneCompound);
    const events = getContainerExitEvents(data, "compound");
    const collapsedLayout = getCollapsedBoundaryLayout(events);
    useContainerHandleLayout(id, events, isCollapsed);
    const { setNodes, getNodes } = useReactFlow();
    // Never cache intrinsic minimums for the whole selection lifetime: child
    // positions/sizes may change without changing the stable getNodes callback.
    // Let the gesture proceed down to a conservative floor; clamp to the
    // *current* subtree only once when the gesture finishes.
    const refitAfterResize = useCallback((_event, params) => {
        data.onContainerResizeEnd?.(id);
        setNodes((nodes) => {
            const compound = nodes.find((node) => node.id === id);
            if (!compound) return nodes;
            const minimum = measureCompoundMinimumSize(nodes, id);
            if (!minimum) return nodes;
            traceResizeForContainer(id, 'compound:resizeEnd:minimum', {
                requested: { width: params?.width, height: params?.height },
                minimum,
                prior: { width: compound.width, height: compound.height },
            });
            const width = Math.max(Number(params?.width) || 0, minimum.width);
            const height = Math.max(Number(params?.height) || 0, minimum.height);
            const result = growAllStateContainersToContents(nodes.map((node) =>
                node.id === id ? withNodeDimensions(node, width, height) : node
            ));
            traceResizeNodeMutation('compound:resizeEnd:refit', nodes, result);
            return result;
        });
        finishResizeTrace(id, params, getNodes);
    }, [setNodes, getNodes, data.onContainerResizeEnd, id]);

    return (
        <div
            className={`compound-frame-node ${
                isParallelLaneWrapper ? "parallel-lane-auto-compound" : ""
            } ${
                data.isInitial ? "initial-compound" : ""
            } ${selected ? "selected-compound" : ""} ${
                data.isDropTarget ? "compound-drop-target" : ""
            } ${isCollapsed ? "collapsed-container" : ""}`}
        >
            <NodeResizer
                isVisible={selected && !isCollapsed && !isParallelLaneWrapper}
                minWidth={220}
                minHeight={120}
                onResizeStart={(event) => {
                    beginResizeTrace(id, 'compound', getNodes(), event);
                    data.onContainerResizeStart?.(id);
                }}
                onResize={(_event, params) => traceResizeGesture(id, params)}
                onResizeEnd={refitAfterResize}
                color="#475569"
                handleStyle={{ pointerEvents: "all" }}
                lineStyle={{ pointerEvents: "all" }}
            />
            <IncomingTransitionHandle />
            {/* Display-only anchor for the compound's initial-child arrow. */}
            <Handle
                id="compound-entry"
                type="source"
                position={Position.Right}
                className="compound-frame-entry-handle"
                style={{
                    top: "50%",
                    left: "-5px",
                    right: "auto",
                    opacity: 0,
                    pointerEvents: "none",
                }}
                isConnectableStart={false}
                isConnectableEnd={false}
            />
            <ContainerHeader id={id} data={data} type="compound" />
            <CollapsedSlotAnchor data={data} />
            {!isCollapsed && <BoundaryExits events={events} />}
            {isCollapsed && events.map((event, index) => (
                <ConnectionHandle
                    key={`collapsed-source-${event.id}`}
                    id={event.id}
                    type="source"
                    position={Position.Right}
                    className="compound-frame-source-handle compound-collapsed-source-handle"
                    style={{ top: collapsedLayout.positions.get(event.id) }}
                    isConnectableStart={true}
                    isConnectableEnd={false}
                    title={`Outgoing transition: ${event.name || event.rawEvent || event.id}`}
                    aria-label={`Outgoing transition: ${event.name || event.rawEvent || event.id}`}
                />
            ))}
        </div>
    );
}

export function ParallelNode({ id, data = {}, selected = false }) {
    const isCollapsed = Boolean(data.isCollapsed);
    const events = getContainerExitEvents(data, "parallel");
    const collapsedLayout = getCollapsedBoundaryLayout(events);
    useContainerHandleLayout(id, events, isCollapsed);
    const { setNodes, getNodes } = useReactFlow();
    const laneCount = Math.max(1, Array.isArray(data.lanes) ? data.lanes.length : 1);
    // The intrinsic minimum belongs to the *resize transaction*, not to the
    // selection. Otherwise the stable getNodes reference leaves a stale width
    // limit in NodeResizer even after lane content has changed.
    const minHeight = PARALLEL_HEADER_HEIGHT + PARALLEL_BOTTOM_PADDING + laneCount * 90;
    // The graph change handler follows lane frames during the gesture without
    // rebuilding transitions. Only the final content-aware constraints and
    // nested-container fit run once when the gesture finishes.
    const refitAfterResize = useCallback((_event, params) => {
        data.onContainerResizeEnd?.(id);
        const width = Number(params?.width);
        const height = Number(params?.height);
        setNodes((nodes) => {
            const parallel = nodes.find((node) => node.id === id);
            if (!parallel) return nodes;
            const requestedWidth = Number.isFinite(width) ? width : Number(parallel.width || parallel.style?.width);
            const requestedHeight = Number.isFinite(height) ? height : Number(parallel.height || parallel.style?.height);
            // Re-measure the current descendants at release, after React
            // Flow's intermediate dimensions have been applied. Do not trust
            // a minimum cached at the time the container was selected.
            const currentMinimum = measureParallelMinimumSize(nodes, id);
            traceResizeForContainer(id, 'parallel:resizeEnd:minimum', {
                requested: { width: requestedWidth, height: requestedHeight },
                minimum: currentMinimum && {
                    width: currentMinimum.width,
                    height: currentMinimum.height,
                    laneHeights: [...currentMinimum.laneHeights.entries()],
                },
                prior: { width: parallel.width, height: parallel.height },
            });
            const resized = resizeParallelLanes(nodes, id, requestedWidth, requestedHeight, currentMinimum);
            traceResizeNodeMutation('parallel:resizeEnd:lanes', nodes, resized);
            const fitted = growAllStateContainersToContents(resized);
            traceResizeNodeMutation('parallel:resizeEnd:growAll', resized, fitted);
            return fitted;
        });
        finishResizeTrace(id, params, getNodes);
    }, [id, setNodes, getNodes, data.onContainerResizeEnd]);

    return (
        <div
            className={`${data.isDropTarget
                ? "parallel-group-container parallel-drop-target"
                : "parallel-group-container"} ${data.isInitial ? "initial-parallel" : ""} ${isCollapsed ? "collapsed-container" : ""}`}
        >
            <NodeResizer
                isVisible={selected && !isCollapsed}
                minWidth={280}
                minHeight={minHeight}
                color="#0284c7"
                handleStyle={{ pointerEvents: "all" }}
                lineStyle={{ pointerEvents: "all" }}
                onResizeStart={(event) => {
                    beginResizeTrace(id, 'parallel', getNodes(), event);
                    data.onContainerResizeStart?.(id);
                }}
                onResize={(_event, params) => traceResizeGesture(id, params)}
                onResizeEnd={refitAfterResize}
            />
            <StateActionBadges id={id} data={data} />
            <IncomingTransitionHandle handleId="target" className="parallel-group-handle" />
            <ContainerHeader id={id} data={data} type="parallel" />
            <CollapsedSlotAnchor data={data} />
            {/* A Parallel can also catch global SCXML events without a skill
                prefix. Those direct handlers belong on the Parallel itself. */}
            {!isCollapsed && <BoundaryExits events={events.filter(event => event.editorDirectParallelEvent)} />}
            {isCollapsed && events.map((event, index) => (
                <ConnectionHandle
                    key={`collapsed-parallel-source-${event.id}`}
                    id={event.id}
                    type="source"
                    position={Position.Right}
                    className="parallel-collapsed-source-handle"
                    style={{
                        top: collapsedLayout.positions.get(event.id),
                        left: "auto",
                        right: "0",
                    }}
                    isConnectableStart={true}
                    isConnectableEnd={false}
                    title={`Outgoing transition: ${event.name || event.rawEvent || event.id}`}
                    aria-label={`Outgoing transition: ${event.name || event.rawEvent || event.id}`}
                />
            ))}
            {!isCollapsed && (
                <button
                    className="parallel-add-lane-btn"
                    title="Add new row"
                    onClick={(event) => {
                        event.stopPropagation();
                        if (data.onAddLane) data.onAddLane(id);
                    }}
                >
                    <FiPlus size={12} />
                </button>
            )}
        </div>
    );
}

export function ParallelLaneNode({ id, data = {}, selected = false }) {
    const events = getContainerExitEvents(data, "parallelLane");
    useContainerHandleLayout(id, events);

    return (
        <div
            className={`parallel-lane-node ${selected ? "parallel-lane-selected" : ""}`}
            style={{
                width: "100%",
                height: "100%",
                position: "relative",
                boxSizing: "border-box",
                pointerEvents: "none",
            }}
        >
            <div
                className="parallel-lane-name nodrag nopan"
                title={data.label || id || "Parallel lane"}
            >
                {data.label || id || "Lane"}
            </div>
            {/* Explicit entry for SCXML transitions targeting the lane itself. */}
            <IncomingTransitionHandle />
            {/* Display-only entry point for this parallel branch. */}
            <ConnectionHandle
                type="source"
                position={Position.Right}
                id="parallel-entry"
                className="parallel-lane-entry-handle"
                style={{
                    top: "50%",
                    left: "0",
                    right: "auto",
                    transform: "translate(-50%, -50%)",
                }}
                isConnectableStart={false}
                isConnectableEnd={false}
                title="Parallel branch entry"
                aria-label="Parallel branch entry"
            />
            <BoundaryExits events={events} />
        </div>
    );
}
