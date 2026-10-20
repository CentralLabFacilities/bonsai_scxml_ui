import assert from 'node:assert/strict';
import test from 'node:test';
import {
    beginResizeTrace,
    finishResizeTrace,
    resizeDebugEnabled,
    traceResizeGesture,
    traceResizeNodeChanges,
    traceResizeNodeMutation,
    traceResizeSnapshot,
} from './resizeDiagnostics.js';

const node = (width) => ({
    id: 'parallel_1', type: 'parallel', position: { x: 0, y: 0 },
    width, height: 350, style: { width, height: 350 },
});

test('resize tracing is disabled by default without a browser or flag', () => {
    assert.equal(resizeDebugEnabled(), false);
    assert.doesNotThrow(() => {
        beginResizeTrace('parallel_1', 'parallel', [node(800)]);
        traceResizeNodeMutation('test', [node(800)], [node(400)]);
        finishResizeTrace('parallel_1', { width: 400 }, () => [node(400)]);
    });
});

test('opt-in report shows whether a resized node was grown again after the gesture', async () => {
    const previousWindow = globalThis.window;
    const previousInfo = console.info;
    const previousGroup = console.groupCollapsed;
    const previousTable = console.table;
    const previousGroupEnd = console.groupEnd;
    globalThis.window = { localStorage: { getItem: (key) => key === 'bonsai:resizeDebug' ? '1' : null } };
    console.info = () => {};
    console.groupCollapsed = () => {};
    console.table = () => {};
    console.groupEnd = () => {};
    try {
        assert.equal(resizeDebugEnabled(), true);
        beginResizeTrace('parallel_1', 'parallel', [node(800)]);
        traceResizeGesture('parallel_1', { width: 400, height: 350 });
        traceResizeNodeChanges([{ id: 'parallel_1', type: 'dimensions', resizing: false, dimensions: { width: 400, height: 350 } }]);
        traceResizeNodeMutation('geometry:resizeParallelLanes:output', [node(800)], [node(400)]);
        traceResizeNodeMutation('geometry:growAllStateContainersToContents', [node(400)], [node(800)]);
        traceResizeSnapshot('ReactFlow:visibleNodes', [node(800)]);
        finishResizeTrace('parallel_1', { width: 400, height: 350 }, () => [node(800)]);
        await new Promise((resolve) => setTimeout(resolve, 670));
        const report = globalThis.window.__BONSAI_RESIZE_TRACE__.last;
        assert.equal(report.finalGesture.width, 400);
        assert.equal(report.gestureCount, 1);
        assert.equal(report.diagnosticSummary.settledReactFlowWidth, 800);
        const grow = report.events.find((entry) => entry.stage === 'geometry:growAllStateContainersToContents');
        assert.equal(grow.changed[0].before.width, 400);
        assert.equal(grow.changed[0].after.width, 800);
        assert.ok(JSON.parse(globalThis.window.__BONSAI_RESIZE_TRACE__.json()).events.length >= 4);
    } finally {
        console.info = previousInfo;
        console.groupCollapsed = previousGroup;
        console.table = previousTable;
        console.groupEnd = previousGroupEnd;
        if (previousWindow === undefined) delete globalThis.window;
        else globalThis.window = previousWindow;
    }
});
