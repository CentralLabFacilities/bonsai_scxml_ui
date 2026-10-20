/**
 * Opt-in, read-only resize trace. It intentionally has no imports from the
 * editor's geometry/model code so instrumentation cannot alter layout or
 * introduce a circular dependency.
 *
 * Enable in DevTools: localStorage.setItem('bonsai:resizeDebug', '1')
 * Disable:           localStorage.removeItem('bonsai:resizeDebug')
 * The most recent report is at window.__BONSAI_RESIZE_TRACE__.last.
 */
const KEY = 'bonsai:resizeDebug';
const MAX_EVENTS = 240;
const MAX_TRACKED_NODES = 80;
let active = null;
let nextSequence = 0;
let lastReport = null;

export const resizeDebugEnabled = () => {
    try {
        return typeof window !== 'undefined' && (
            window.BONSAI_RESIZE_DEBUG === true ||
            window.localStorage?.getItem(KEY) === '1'
        );
    } catch {
        return false;
    }
};

const now = () => typeof performance !== 'undefined' ? performance.now() : Date.now();
const finite = (value) => {
    const number = Number(value);
    return value == null || !Number.isFinite(number) ? null : Math.round(number * 100) / 100;
};

const dimensions = (node) => node ? {
    parentId: node.parentId || null,
    type: node.type,
    x: finite(node.position?.x), y: finite(node.position?.y),
    width: finite(node.width), styleWidth: finite(node.style?.width),
    measuredWidth: finite(node.measured?.width),
    height: finite(node.height), styleHeight: finite(node.style?.height),
    measuredHeight: finite(node.measured?.height),
    expandParent: Boolean(node.expandParent),
    hidden: Boolean(node.hidden),
    autoLaneWrapper: Boolean(node.data?.autoParallelLaneCompound),
} : null;

const indexNodes = (nodes) => new Map((nodes || []).map((node) => [node.id, node]));
const isDescendant = (node, parentId, byId) => {
    const visited = new Set();
    let ancestorId = node.parentId;
    while (ancestorId && !visited.has(ancestorId)) {
        if (ancestorId === parentId) return true;
        visited.add(ancestorId);
        ancestorId = byId.get(ancestorId)?.parentId;
    }
    return false;
};

const selectedNodes = (nodes, session) => {
    const byId = indexNodes(nodes);
    return [...byId.values()].filter((node) =>
        session.tracked.has(node.id) || isDescendant(node, session.id, byId)
    ).slice(0, MAX_TRACKED_NODES);
};

const record = (stage, details = {}) => {
    if (!active) return;
    const session = active;
    if (session.events.length >= MAX_EVENTS) {
        // Keep the end-of-gesture evidence even after a very noisy resize.
        session.events.shift();
        session.dropped += 1;
    }
    session.events.push({
        timeMs: Math.round((now() - session.started) * 10) / 10,
        stage,
        ...details,
    });
};

const nodeSignature = (node) => JSON.stringify(dimensions(node));
const changesBetween = (previous, next, session) => {
    const before = indexNodes(previous);
    const after = indexNodes(next);
    const ids = new Set([...session.tracked, ...selectedNodes(next, session).map((n) => n.id)]);
    const changed = [];
    for (const id of ids) {
        const prior = before.get(id);
        const latest = after.get(id);
        if (nodeSignature(prior) === nodeSignature(latest)) continue;
        changed.push({ id, before: dimensions(prior), after: dimensions(latest) });
        if (changed.length >= 24) break;
    }
    return changed;
};

const elementSnapshot = (id) => {
    if (typeof document === 'undefined') return null;
    const element = [...document.querySelectorAll('.react-flow__node')]
        .find((item) => item.getAttribute('data-id') === id);
    if (!element) return { found: false };
    const style = window.getComputedStyle(element);
    return {
        found: true,
        cssWidth: style.width,
        cssMinWidth: style.minWidth,
        inlineWidth: element.style.width,
        offsetWidth: element.offsetWidth,
        scrollWidth: element.scrollWidth,
        rectWidth: finite(element.getBoundingClientRect().width),
        cssHeight: style.height,
        cssMinHeight: style.minHeight,
    };
};

const exposeReport = (report) => {
    lastReport = report;
    if (typeof window !== 'undefined') {
        window.__BONSAI_RESIZE_TRACE__ = {
            last: report,
            // JSON is much easier to copy than expanding every nested object
            // in the DevTools console.
            json: () => JSON.stringify(lastReport, null, 2),
        };
    }
};

export const beginResizeTrace = (id, type, nodes, pointerEvent = null) => {
    if (!resizeDebugEnabled()) return;
    if (active) finalize(active);
    const byId = indexNodes(nodes);
    const selected = (nodes || []).filter((node) =>
        node.id === id || isDescendant(node, id, byId)
    ).slice(0, MAX_TRACKED_NODES);
    active = {
        sequence: ++nextSequence,
        id, type,
        started: now(),
        tracked: new Set([id, ...selected.map((node) => node.id)]),
        events: [], dropped: 0, gestureCount: 0,
        pointer: {
            startX: finite(pointerEvent?.clientX), startY: finite(pointerEvent?.clientY),
            minX: finite(pointerEvent?.clientX), maxX: finite(pointerEvent?.clientX),
            minY: finite(pointerEvent?.clientY), maxY: finite(pointerEvent?.clientY),
            moves: 0,
        },
        initial: selected.map((node) => ({ id: node.id, ...dimensions(node) })),
    };
    if (typeof document !== 'undefined') {
        const session = active;
        session.pointerListener = (event) => {
            if (active !== session || session.ended) return;
            const x = finite(event.clientX), y = finite(event.clientY);
            if (x === null || y === null) return;
            const pointer = session.pointer;
            pointer.moves += 1;
            if (pointer.startX === null) pointer.startX = x;
            if (pointer.startY === null) pointer.startY = y;
            pointer.minX = Math.min(pointer.minX ?? x, x);
            pointer.maxX = Math.max(pointer.maxX ?? x, x);
            pointer.minY = Math.min(pointer.minY ?? y, y);
            pointer.maxY = Math.max(pointer.maxY ?? y, y);
        };
        document.addEventListener('pointermove', session.pointerListener, { passive: true, capture: true });
    }
    record('start:DOM', { dom: elementSnapshot(id) });
    console.info(`[Bonsai resize] START ${type} ${id}; diagnostic trace #${active.sequence}`);
};

export const traceResizePoint = (stage, details = {}) => {
    if (!active) return;
    record(stage, details);
};

export const traceResizeForContainer = (id, stage, details = {}) => {
    if (!active || !active.tracked.has(id)) return;
    record(stage, { containerId: id, ...details });
};

export const traceResizeGesture = (id, params) => {
    if (!active || id !== active.id) return;
    active.gestureCount += 1;
    const width = finite(params?.width);
    const height = finite(params?.height);
    active.lastGesture = { width, height };
    if (active.gestureCount === 1 || active.gestureCount % 8 === 0) {
        record('ReactFlow:NodeResizer:onResize', { width, height, sample: active.gestureCount });
    }
};

export const traceResizeNodeChanges = (changes) => {
    if (!active) return;
    const relevant = (changes || []).filter((change) =>
        active.tracked.has(change.id) && (change.type === 'dimensions' || change.type === 'position')
    );
    if (!relevant.length) return;
    active.flowChangeCount = (active.flowChangeCount || 0) + 1;
    if (active.flowChangeCount === 1 || active.flowChangeCount % 8 === 0 ||
        relevant.some((change) => change.type === 'dimensions' && change.resizing === false)) {
        record('ReactFlow:onNodesChange', {
            count: relevant.length,
            changes: relevant.slice(0, 8).map((change) => ({
                id: change.id, type: change.type, resizing: change.resizing,
                dimensions: change.dimensions,
            })),
        });
    }
};

export const traceResizeNodeMutation = (stage, previous, next, details = null) => {
    if (!active || previous === next) return;
    const changed = changesBetween(previous, next, active);
    if (changed.length) record(stage, { changed, ...(details || {}) });
};

export const traceResizeSnapshot = (stage, nodes) => {
    if (!active) return;
    const node = (nodes || []).find((candidate) => candidate.id === active.id);
    if (!node) return;
    const snapshot = dimensions(node);
    const signature = JSON.stringify(snapshot);
    if (active.lastSnapshots?.[stage] === signature) return;
    if (!active.lastSnapshots) active.lastSnapshots = {};
    active.lastSnapshots[stage] = signature;
    record(stage, { node: snapshot });
};

export const finishResizeTrace = (id, params, nodes) => {
    if (!active || active.id !== id) return;
    const session = active;
    session.ended = true;
    record('ReactFlow:NodeResizer:onResizeEnd', {
        width: finite(params?.width), height: finite(params?.height),
        eventCount: session.gestureCount,
        pointer: { ...session.pointer },
        dom: elementSnapshot(id),
    });
    const readNodes = typeof nodes === 'function' ? nodes : () => nodes;
    if (readNodes()) traceResizeSnapshot('onResizeEnd:ReactFlowStore', readNodes());
    // React state, the presentation graph, and browser layout may settle in
    // different tasks. Keep tracing through that interval before reporting.
    setTimeout(() => {
        if (active !== session) return;
        if (readNodes()) traceResizeSnapshot('settled:ReactFlowStore', readNodes());
        record('settled:DOM', { dom: elementSnapshot(id) });
        finalize(session);
    }, 650);
};

function finalize(session) {
    if (session.pointerListener && typeof document !== 'undefined') {
        document.removeEventListener('pointermove', session.pointerListener, true);
        session.pointerListener = null;
    }
    if (active === session) active = null;
    const report = {
        sequence: session.sequence, type: session.type, id: session.id,
        initial: session.initial,
        gestureCount: session.gestureCount,
        pointer: session.pointer,
        finalGesture: session.lastGesture || null,
        durationMs: Math.round((now() - session.started) * 10) / 10,
        droppedEvents: session.dropped,
        events: session.events,
    };
    const reportedMinimum = [...report.events].reverse().find((event) =>
        event.stage === 'parallel:resizeEnd:minimum' || event.stage === 'compound:resizeEnd:minimum'
    )?.minimum || null;
    const postFit = [...report.events].reverse().find((event) =>
        event.stage === 'settled:ReactFlowStore'
    )?.node || null;
    report.diagnosticSummary = {
        pointerMoves: report.pointer?.moves || 0,
        resizeCallbacks: report.gestureCount,
        requestedWidth: report.finalGesture?.width ?? null,
        calculatedMinimumWidth: reportedMinimum?.width ?? null,
        settledReactFlowWidth: postFit?.width ?? null,
        suspectedPreModelClamp: (report.pointer?.moves || 0) > 4 && report.gestureCount === 0,
    };
    exposeReport(report);
    console.groupCollapsed(`[Bonsai resize] COMPLETE ${session.type} ${session.id} (${report.gestureCount} updates, ${report.events.length} trace entries)`);
    console.info('Copy the diagnostic report with: copy(window.__BONSAI_RESIZE_TRACE__.json())');
    console.info('Inspect stage-by-stage changes:', report);
    console.table(session.events.filter((event) =>
        event.stage.includes('NodeResizer') || event.stage === 'settled:DOM' ||
        event.stage.includes('minimum')
    ).map((event) => ({
        ms: event.timeMs,
        stage: event.stage,
        width: event.width ?? event.node?.width ?? event.dom?.offsetWidth ?? '',
        height: event.height ?? event.node?.height ?? '',
    })));
    console.groupEnd();
}
