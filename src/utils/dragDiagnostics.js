/**
 * Read-only, opt-in diagnosis of full-canvas flashes and drag jank.
 * No editor/React imports. Nothing is observed or scheduled when disabled.
 *
 * Enable (then reload): localStorage.setItem('bonsai:dragDebug', '1')
 * Each finished gesture is printed and can be exported with:
 * window.__BONSAI_DRAG_TRACE__.download()
 */
const DEBUG_KEY = 'bonsai:dragDebug';
const MAX_EVENTS = 300;
const SETTLE_DELAY_MS = 450;
let session = null;
let lastReport = null;
let sequence = 0;

export function dragDebugEnabled() {
    try {
        return typeof window !== 'undefined' && (
            window.BONSAI_DRAG_DEBUG === true ||
            window.localStorage?.getItem(DEBUG_KEY) === '1'
        );
    } catch {
        return false;
    }
}

const timeNow = () => typeof performance !== 'undefined' ? performance.now() : Date.now();
const rounded = (value) => Math.round(value * 10) / 10;

export function classifyCanvasEvidence(report) {
    const events = report?.events || [];
    const stages = events.map((entry) => entry.stage);
    const graphs = events.filter((entry) => entry.stage === 'canvas:graph');
    const graphEmpty = graphs.some((entry, index) =>
        entry.nodes === 0 && graphs.slice(0, index).some((prior) => prior.nodes > 0));
    const edgesCleared = graphs.some((entry, index) =>
        entry.edges === 0 && graphs.slice(0, index).some((prior) => prior.edges > 0));
    const rootDisconnected = stages.includes('dom:root-disconnected') ||
        stages.includes('dom:root-replaced');
    const nodeListEmptied = stages.includes('dom:nodes-emptied');
    const remount = stages.includes('canvas:unmount') ||
        stages.includes('flow:unmount');
    return {
        canvasRemounted: remount,
        reactFlowRootDisconnected: rootDisconnected,
        nodeDomEmptied: nodeListEmptied,
        emptyVisibleGraphObserved: graphEmpty,
        edgesTemporarilyCleared: edgesCleared,
        slowFrames: report?.metrics?.slowFrames || 0,
        worstFrameMs: report?.metrics?.worstFrameMs || 0,
        reactCommitCount: report?.metrics?.reactCommitCount || 0,
        worstReactCommitMs: report?.metrics?.worstReactCommitMs || 0,
        documentPublications: report?.metrics?.documentPublications || 0,
        // Even when no DOM disappearance is recorded, paint/compositor stalls
        // remain possible. Do NOT label them as proven React rerenders.
        paintOrCompositorCauseNotExcluded: true,
    };
}

const push = (stage, data = {}) => {
    if (!session) return;
    const current = session;
    if (current.events.length === MAX_EVENTS) {
        current.events.shift();
        current.droppedEvents += 1;
    }
    current.events.push({ ms: rounded(timeNow() - current.started), stage, ...data });
};

function surfaceSnapshot(root) {
    if (!root) return { found: false };
    // DOM measurement is deliberately limited to gesture boundaries and
    // anomalous/periodic samples, not every pointer movement.
    const nodes = root.querySelector('.react-flow__nodes');
    const edges = root.querySelector('.react-flow__edges');
    const viewport = root.querySelector('.react-flow__viewport');
    const style = root.isConnected ? window.getComputedStyle(root) : null;
    return {
        found: true,
        connected: root.isConnected,
        viewportPresent: Boolean(viewport),
        nodesLayerPresent: Boolean(nodes),
        nodeElements: nodes?.children.length ?? null,
        edgeElements: edges?.children.length ?? null,
        display: style?.display ?? null,
        visibility: style?.visibility ?? null,
        opacity: style?.opacity ?? null,
        background: style?.backgroundColor ?? null,
        width: root.clientWidth,
        height: root.clientHeight,
    };
}

function exposeTrace() {
    if (typeof window === 'undefined') return;
    window.__BONSAI_DRAG_TRACE__ = {
        get last() { return lastReport; },
        get summary() { return lastReport?.diagnosticSummary ?? null; },
        json() { return JSON.stringify(lastReport, null, 2); },
        download() {
            if (!lastReport || typeof document === 'undefined') return false;
            const blob = new Blob([JSON.stringify(lastReport, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = `bonsai-drag-trace-${lastReport.sequence}.json`;
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            // Release after download navigation has consumed the blob URL.
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            return true;
        },
    };
}

function stopObserving(current) {
    for (const observer of current.observers || []) observer.disconnect();
    current.observers = [];
    if (current.raf != null) cancelAnimationFrame(current.raf);
    current.raf = null;
    if (current.settleTimer != null) clearTimeout(current.settleTimer);
    current.settleTimer = null;
}

function observeRoot(current, root) {
    if (!root || typeof MutationObserver === 'undefined') return;
    // Observing only direct children prevents a large, recursive observer from
    // imposing the performance cost that this trace is meant to diagnose.
    const targets = [];
    for (let parent = root.parentElement, depth = 0; parent && depth < 4; parent = parent.parentElement, depth += 1) {
        targets.push({ element: parent, stage: 'dom:ancestor-mutated', depth });
    }
    for (const [selector, stage] of [
        ['.react-flow__nodes', 'dom:nodes-mutated'],
        ['.react-flow__edges', 'dom:edges-mutated'],
        ['.react-flow__viewport', 'dom:viewport-mutated'],
    ]) {
        const element = root.querySelector(selector);
        if (element) targets.push({ element, stage });
    }
    current.observers = [];
    for (const target of targets) {
        const observer = new MutationObserver((mutations) => {
            if (session !== current) return;
            const removed = mutations.reduce((total, mutation) => total + mutation.removedNodes.length, 0);
            const added = mutations.reduce((total, mutation) => total + mutation.addedNodes.length, 0);
            const nodeLayer = root.querySelector('.react-flow__nodes');
            const nodeCount = nodeLayer?.children.length ?? null;
            if (!root.isConnected && !current.disconnectionRecorded) {
                current.disconnectionRecorded = true;
                push('dom:root-disconnected', { atDepth: target.depth ?? null });
            }
            // Suppress ordinary tiny mutations; retain mass removal, notably
            // the transient empty canvas that the user describes.
            if (target.stage === 'dom:nodes-mutated' && nodeCount === 0 && removed > 0) {
                push('dom:nodes-emptied', { removed, added });
            } else if (removed > 2 || added > 2 || target.stage === 'dom:ancestor-mutated' && removed > 0) {
                push(target.stage, { removed, added, nodeCount, depth: target.depth ?? null });
            }
        });
        observer.observe(target.element, { childList: true });
        current.observers.push(observer);
    }
}

function sampleFrames(current) {
    if (session !== current) return;
    const currentTime = timeNow();
    if (current.lastFrameTime != null) {
        const delta = currentTime - current.lastFrameTime;
        current.metrics.worstFrameMs = Math.max(current.metrics.worstFrameMs, rounded(delta));
        if (delta > 34) {
            current.metrics.slowFrames += 1;
            if (delta > 65) push('frame:long-gap', { durationMs: rounded(delta) });
        }
    }
    current.lastFrameTime = currentTime;
    const root = current.root;
    if (root && !root.isConnected && !current.disconnectionRecorded) {
        current.disconnectionRecorded = true;
        push('dom:root-disconnected');
    }
    // Very small DOM checks every ~120ms; no forced layout every frame.
    if (currentTime - current.lastDomSample >= 120) {
        current.lastDomSample = currentTime;
        if (typeof document !== 'undefined') {
            const liveRoot = document.querySelector('.react-flow');
            if (root && liveRoot && liveRoot !== root && !current.rootReplaced) {
                current.rootReplaced = true;
                push('dom:root-replaced');
            }
        }
        const snapshot = surfaceSnapshot(root);
        if (snapshot.nodeElements === 0 && (current.initialNodeCount || 0) > 0 && !current.emptyRecorded) {
            current.emptyRecorded = true;
            push('dom:nodes-emptied', { sampled: true });
        }
    }
    current.raf = requestAnimationFrame(() => sampleFrames(current));
}

export function beginDragTrace(event, node, info = {}) {
    if (!dragDebugEnabled()) return;
    if (session) complete(session, 'interrupted-by-new-drag');
    const root = event?.target?.closest?.('.react-flow') ||
        (typeof document === 'undefined' ? null : document.querySelector('.react-flow'));
    const current = {
        sequence: ++sequence,
        nodeId: node?.id ?? null,
        nodeType: node?.type ?? null,
        started: timeNow(),
        events: [],
        droppedEvents: 0,
        moveCount: 0,
        ended: false,
        root,
        initialNodeCount: root?.querySelector('.react-flow__nodes')?.children.length ?? 0,
        lastDomSample: 0,
        observers: [],
        metrics: {
            slowFrames: 0, worstFrameMs: 0, reactCommitCount: 0,
            worstReactCommitMs: 0, documentPublications: 0,
            nodeChangeBatches: 0, frameBatches: 0,
        },
    };
    session = current;
    exposeTrace();
    push('drag:start', { nodeId: current.nodeId, nodeType: current.nodeType, ...info,
        dom: root ? surfaceSnapshot(root) : { found: false } });
    observeRoot(current, root);
    if (typeof requestAnimationFrame === 'function') {
        current.raf = requestAnimationFrame(() => sampleFrames(current));
    }
    console.info(`[Bonsai drag] tracing ${current.nodeType || 'node'} ${current.nodeId || ''}`);
}

export function traceDragMovement(node) {
    if (!session || session.ended) return;
    session.moveCount += 1;
    if (session.moveCount === 1 || session.moveCount % 30 === 0) {
        push('drag:move', { count: session.moveCount, x: node?.position?.x, y: node?.position?.y });
    }
}

export function traceDragEvent(stage, details = {}) {
    if (!session) return;
    push(stage, details);
}

export function traceDragReactCommit(id, phase, actualDuration, baseDuration) {
    if (!session) return;
    const metrics = session.metrics;
    metrics.reactCommitCount += 1;
    metrics.worstReactCommitMs = Math.max(metrics.worstReactCommitMs, rounded(actualDuration));
    if (actualDuration >= 16 || phase === 'mount') {
        push('react:commit', { id, phase, durationMs: rounded(actualDuration), baseMs: rounded(baseDuration) });
    }
}

export function traceDragComputation(stage, work) {
    if (!session) return work();
    const start = timeNow();
    try { return work(); }
    finally {
        if (session) {
            const durationMs = rounded(timeNow() - start);
            const metric = session.computations?.[stage] || { calls: 0, totalMs: 0, maxMs: 0 };
            metric.calls += 1;
            metric.totalMs = rounded(metric.totalMs + durationMs);
            metric.maxMs = Math.max(metric.maxMs, durationMs);
            if (!session.computations) session.computations = {};
            session.computations[stage] = metric;
            if (durationMs >= 8) push('compute:slow', { name: stage, durationMs });
        }
    }
}

export function traceDragGraphPublication(stage, before, after, durationMs = null) {
    if (!session || !before || !after) return;
    session.metrics.documentPublications += 1;
    const count = session.metrics.documentPublications;
    const structural = before.nodes?.length !== after.nodes?.length ||
        before.edges !== after.edges || before.slotNodes !== after.slotNodes ||
        before.slotEdges !== after.slotEdges;
    if (structural || count === 1 || count % 15 === 0 || (durationMs != null && durationMs >= 8)) {
        push('document:publish', {
            source: stage, count, durationMs: durationMs == null ? null : rounded(durationMs),
            nodeCount: after.nodes?.length ?? 0,
            edgeCount: after.edges?.length ?? 0,
            structural,
        });
    }
}

export function traceDragNodeChanges(changes, stage) {
    if (!session || !changes?.length) return;
    const metrics = session.metrics;
    if (stage === 'queued') metrics.nodeChangeBatches += 1;
    if (stage === 'flushed') metrics.frameBatches += 1;
    if (metrics.nodeChangeBatches === 1 || metrics.nodeChangeBatches % 20 === 0 ||
        changes.some((change) => change.type !== 'position')) {
        push('nodes:changes', { stage, count: changes.length,
            types: [...new Set(changes.map((change) => change.type))] });
    }
}

export function traceDragCanvasGraph(documentKey, nodes, edges, isDragging) {
    if (!session) return;
    const next = { documentKey, nodes: nodes?.length ?? 0, edges: edges?.length ?? 0,
        isDragging: Boolean(isDragging) };
    const previous = session.lastGraph;
    session.lastGraph = next;
    session.graphSamples = (session.graphSamples || 0) + 1;
    if (!previous || previous.documentKey !== next.documentKey ||
        previous.nodes !== next.nodes || previous.edges !== next.edges ||
        previous.isDragging !== next.isDragging || session.graphSamples % 30 === 0) {
        push('canvas:graph', next);
    }
}

function complete(current, reason) {
    if (session !== current) return;
    stopObserving(current);
    push('drag:finish', { reason, dom: current.root ? surfaceSnapshot(current.root) : { found: false } });
    const report = {
        sequence: current.sequence, nodeId: current.nodeId, nodeType: current.nodeType,
        durationMs: rounded(timeNow() - current.started),
        moveCount: current.moveCount,
        droppedEvents: current.droppedEvents,
        metrics: { ...current.metrics },
        computations: current.computations || {},
        events: [...current.events],
    };
    report.diagnosticSummary = classifyCanvasEvidence(report);
    lastReport = report;
    session = null;
    exposeTrace();
    console.groupCollapsed(`[Bonsai drag] COMPLETE #${report.sequence} (${report.durationMs} ms; ${report.moveCount} drag callbacks)`);
    console.table(report.diagnosticSummary);
    console.info('For a downloadable JSON file, run: window.__BONSAI_DRAG_TRACE__.download()');
    console.groupEnd();
}

export function endDragTrace(node) {
    if (!session || session.ended) return;
    const current = session;
    current.ended = true;
    push('drag:stop', { nodeId: node?.id ?? null,
        dom: current.root ? surfaceSnapshot(current.root) : { found: false } });
    // Observe render completion and queued graph normalization after onDragStop.
    current.settleTimer = setTimeout(() => complete(current, 'settled'), SETTLE_DELAY_MS);
}
