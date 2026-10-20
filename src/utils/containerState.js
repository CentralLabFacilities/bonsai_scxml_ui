import { traceResizeForContainer, traceResizeNodeMutation } from "./resizeDiagnostics.js";
import {
    COLLAPSED_CONTAINER_HEIGHT,
    COLLAPSED_CONTAINER_WIDTH,
    PARALLEL_BOTTOM_PADDING,
    PARALLEL_HEADER_HEIGHT,
    layoutStateContainerForExpansion,
    measureParallelMinimumSize,
    getNodeSize,
    growAllStateContainersToContents,
} from "./editorGeometry.js";

export function getContainerExitEvents(data, type) {
    const events = type === "parallel"
        ? data.events || []
        : Array.isArray(data.events) ? data.events : [];
    const uniqueEvents = [];
    const seen = new Set();

    events.forEach((event) => {
        const eventId = String(event?.id || "").trim();
        // Targetless compound events are reusable editor choices, not exits.
        if (
            !eventId ||
            (type !== "parallel" && eventId === "compound-entry") ||
            (type !== "parallelLane" && !event?.target) ||
            seen.has(eventId)
        ) return;
        seen.add(eventId);
        uniqueEvents.push({ ...event, id: eventId });
    });

    if (type === "parallel" && Array.isArray(data.collapsedTransitionHandles)) {
        data.collapsedTransitionHandles.forEach((event) => {
            const eventId = String(event?.id || "").trim();
            if (!eventId || seen.has(eventId)) return;
            seen.add(eventId);
            uniqueEvents.push({ ...event, id: eventId });
        });
    }

    return uniqueEvents;
}

// Group boundary ports by target (stable order within each group). Each event
// retains its own handle ID; merging handles would corrupt edge references.
export function getCollapsedBoundaryLayout(events = []) {
    const groups = new Map();
    events.forEach((event) => {
        const target = String(event?.target || "");
        if (!groups.has(target)) groups.set(target, []);
        groups.get(target).push(event);
    });
    let y = 47;
    const positions = new Map();
    for (const group of groups.values()) {
        for (const event of group) {
            positions.set(event.id, y);
            y += 24;
        }
        y += 9;
    }
    return {
        positions,
        height: Math.max(COLLAPSED_CONTAINER_HEIGHT, groups.size ? y + 10 : COLLAPSED_CONTAINER_HEIGHT),
    };
}

/**
 * Cheap geometry projection during a NodeResizer gesture. React Flow has
 * already supplied the new parallel rectangle; only its structural lane
 * frames (and historical automatic wrappers) need to follow it. Never run
 * intrinsic-size measurement, content fitting or transition routing here.
 * The content-aware minimum is enforced by resizeParallelLanes on release.
 */
export function followParallelResizeGesture(nodes, parallelId, width, height) {
    if (!Number.isFinite(width) || !Number.isFinite(height)) return nodes;
    const parallel = nodes.find((node) => node.id === parallelId && node.type === "parallel");
    if (!parallel) return nodes;
    const lanes = nodes
        .filter((node) => node.type === "parallelLane" && node.parentId === parallelId)
        .sort((a, b) => (a.position?.y || 0) - (b.position?.y || 0));
    if (!lanes.length) return nodes;

    const laneFloor = 90;
    const available = Math.max(0, height - PARALLEL_HEADER_HEIGHT - PARALLEL_BOTTOM_PADDING);
    const extra = Math.max(0, available - lanes.length * laneFloor);
    const weights = lanes.map((lane) => Math.max(0, getNodeSize(lane).height - laneFloor));
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    const frames = new Map();
    let y = PARALLEL_HEADER_HEIGHT;
    lanes.forEach((lane, index) => {
        const laneHeight = laneFloor + extra * (totalWeight > 0 ? weights[index] / totalWeight : 1 / lanes.length);
        frames.set(lane.id, { width, height: laneHeight, x: 0, y });
        y += laneHeight;
    });

    let changed = false;
    const result = nodes.map((node) => {
        const lane = frames.get(node.id);
        const parentLane = frames.get(node.parentId);
        const isWrapper = parentLane && node.type === "compound" &&
            (node.data?.autoParallelLaneCompound || node.className === "compound-in-lane");
        const frame = lane || (isWrapper ? { width: parentLane.width, height: parentLane.height, x: 0, y: 0 } : null);
        if (node.id === parallelId) {
            if (node.width === width && node.height === height &&
                node.style?.width === width && node.style?.height === height) return node;
            changed = true;
            return { ...node, width, height, style: { ...node.style, width, height } };
        }
        if (!frame) return node;
        if (node.width === frame.width && node.height === frame.height &&
            node.style?.width === frame.width && node.style?.height === frame.height &&
            node.position?.x === frame.x && node.position?.y === frame.y &&
            node.expandParent === false && node.extent !== "parent") return node;
        changed = true;
        const { extent, ...withoutExtent } = node;
        return {
            ...withoutExtent,
            expandParent: false,
            width: frame.width,
            height: frame.height,
            style: { ...node.style, width: frame.width, height: frame.height },
            position: { ...node.position, x: frame.x, y: frame.y },
        };
    });
    return changed ? result : nodes;
}

export function resizeParallelLanes(nodes, parallelId, width, height, cachedMinimum = null) {
    const lanes = nodes
        .filter((node) => node.parentId === parallelId && node.type === "parallelLane")
        .sort((a, b) => Number(a.position?.y || 0) - Number(b.position?.y || 0));
    if (lanes.length === 0) return nodes;

    // This is the release-time content-aware fit. The pointer hot path uses
    // followParallelResizeGesture() and never measures descendant subtrees.
    const minimum = cachedMinimum || measureParallelMinimumSize(nodes, parallelId);
    if (!minimum) return nodes;
    const actualWidth = Math.max(Number(width) || 0, minimum.width);
    const actualHeight = Math.max(Number(height) || 0, minimum.height);
    traceResizeForContainer(parallelId, 'geometry:resizeParallelLanes:constraints', {
        requested: { width, height },
        minimum: { width: minimum.width, height: minimum.height },
        actual: { width: actualWidth, height: actualHeight },
        existingLaneWidths: lanes.map((lane) => ({
            id: lane.id, width: getNodeSize(lane).width,
        })),
    });
    const firstLaneY = PARALLEL_HEADER_HEIGHT;
    const minimumHeights = lanes.map((lane) => minimum.laneHeights.get(lane.id) || 90);
    const contentHeight = minimumHeights.reduce((sum, h) => sum + h, 0);
    const availableHeight = actualHeight - firstLaneY - PARALLEL_BOTTOM_PADDING;
    const surplus = Math.max(0, availableHeight - contentHeight);
    const oldExtra = lanes.map((lane, index) => Math.max(0, getNodeSize(lane).height - minimumHeights[index]));
    const totalOldExtra = oldExtra.reduce((sum, value) => sum + value, 0);
    let nextY = firstLaneY;
    const geometryById = new Map();
    lanes.forEach((lane, index) => {
        const extra = surplus * (totalOldExtra > 0 ? oldExtra[index] / totalOldExtra : 1 / lanes.length);
        const laneHeight = minimumHeights[index] + extra;
        geometryById.set(lane.id, { y: nextY, width: actualWidth, height: laneHeight });
        nextY += laneHeight;
    });

    const result = nodes.map((node) => {
        if (node.id === parallelId) {
            return {
                ...node,
                width: actualWidth,
                height: actualHeight,
                style: { ...(node.style || {}), width: actualWidth, height: actualHeight },
            };
        }
        const geometry = geometryById.get(node.id);
        if (geometry) {
            return {
                ...node,
                // Lane frames cannot expand the parallel back to their previous
                // size while the parallel itself is being shrunk.
                expandParent: false,
                width: geometry.width,
                height: geometry.height,
                position: { ...node.position, x: 0, y: geometry.y },
                style: { ...node.style, width: geometry.width, height: geometry.height },
            };
        }
        const parentGeometry = geometryById.get(node.parentId);
        if (!parentGeometry || node.type !== "compound" ||
            !(node.data?.autoParallelLaneCompound || node.className === "compound-in-lane")) return node;
        return {
            ...node,
            width: parentGeometry.width,
            height: parentGeometry.height,
            position: { x: 0, y: 0 },
            style: { ...node.style, width: parentGeometry.width, height: parentGeometry.height },
        };
    });
    traceResizeNodeMutation('geometry:resizeParallelLanes:output', nodes, result);
    return result;
}

export function toggleContainerCollapse(nodes, containerId) {
    const container = nodes.find((node) => node.id === containerId);
    if (!container || !["compound", "parallel"].includes(container.type)) return nodes;

    const isCollapsed = Boolean(container.data?.isCollapsed);
    const defaultWidth = container.type === "compound" ? 320 : 420;
    const defaultHeight = container.type === "compound" ? 220 : 295;
    const savedSize = container.data?.expandedContainerSize || {};
    const width = isCollapsed
        ? Number(savedSize.width) || Number(container.width) || Number(container.style?.width) || defaultWidth
        : COLLAPSED_CONTAINER_WIDTH;
    const height = isCollapsed
        ? Number(savedSize.height) || defaultHeight
        : getCollapsedBoundaryLayout(getContainerExitEvents(container.data || {}, container.type)).height;
    const style = { ...(container.style || {}), width, height };

    if (!isCollapsed) {
        style.minHeight = COLLAPSED_CONTAINER_HEIGHT;
    } else if (savedSize.minHeight == null) {
        delete style.minHeight;
    } else {
        style.minHeight = savedSize.minHeight;
    }

    const data = { ...(container.data || {}), isCollapsed: !isCollapsed };
    if (!isCollapsed) {
        data.expandedContainerSize = {
            width: Number(container.width) || Number(container.measured?.width) || Number(container.style?.width) || defaultWidth,
            height: Number(container.height) || Number(container.measured?.height) || Number(container.style?.height) || defaultHeight,
            minHeight: container.style?.minHeight ?? null,
        };
    }

    const nextNodes = nodes.map((node) => node.id === containerId ? { ...node, width, height, style, data } : node);
    // Expansion must settle descendants before fitting the restored frame.
    return isCollapsed
        ? layoutStateContainerForExpansion(nextNodes, containerId)
        : growAllStateContainersToContents(nextNodes);
}

export function getParallelLaneSummaries(node, childrenByParent) {
    if (node?.type !== "parallel") return [];
    const lanes = (childrenByParent.get(node.id) || []).filter((child) => child.type === "parallelLane");

    return lanes.map((lane) => {
        let childCount = 0;
        const visited = new Set([lane.id]);
        const stack = [...(childrenByParent.get(lane.id) || [])];
        while (stack.length > 0) {
            const child = stack.pop();
            if (!child || visited.has(child.id)) continue;
            visited.add(child.id);
            if (child.type !== "parallelLane" && !child.data?.autoParallelLaneCompound && !child.data?.isSkillClone && !child.data?.isStateClone) {
                childCount += 1;
            }
            stack.push(...(childrenByParent.get(child.id) || []));
        }
        return { ...lane, childCount };
    });
}
