import assert from 'node:assert/strict';
import test from 'node:test';
import { rebuildBoundaryTransitions, rebuildBoundaryTransitionsIncremental } from './boundaryTransitions.js';
import { getNodeSize } from './editorGeometry.js';

test('old auto-generated parallel exits are not retained as real events', () => {
    const nodes = [
        { id: 'p', type: 'parallel', position: { x: 0, y: 0 }, data: { events: [
            { id: 'phantom', name: 'parallel_1.success', target: 'outside', sourceNodeId: 'skill', transitionHandleId: 'success' },
            { id: 'real', name: 'app.heartbeat', target: 'outside' },
        ] } },
        { id: 'lane', type: 'parallelLane', parentId: 'p', position: { x: 0, y: 64 }, data: {} },
        { id: 'skill', type: 'custom', parentId: 'lane', position: { x: 40, y: 40 }, data: { fullSkillName: 'Grasp#42' } },
        { id: 'outside', type: 'custom', position: { x: 700, y: 50 }, data: {} },
    ];
    const result = rebuildBoundaryTransitions(nodes, []);
    assert.deepEqual(result.nodes.find(n => n.id === 'p').data.events.map(e => e.id), ['real']);
});

test('generated compound boundary width is reflected in node.width and React Flow style', () => {
    const nodes = [
        { id: 'compound', type: 'compound', data: { label: 'Container', events: [] }, position: { x: 0, y: 0 }, width: 320, style: { width: 320, height: 200 } },
        { id: 'skill', type: 'custom', data: { label: 'LongRunningTask' }, parentId: 'compound', position: { x: 340, y: 90 }, width: 140, height: 60 },
        { id: 'outside', type: 'custom', data: { label: 'Outside' }, position: { x: 800, y: 0 } },
    ];
    const edges = [{ id: 'e', source: 'skill', target: 'outside', sourceHandle: 'error.cancelled' }];
    const full = rebuildBoundaryTransitions(nodes, edges);
    const container = full.nodes.find(n => n.id === 'compound');
    assert.ok(getNodeSize(container).width > 320);
    assert.equal(container.width, container.style.width);
    const partial = rebuildBoundaryTransitionsIncremental(nodes, edges, { sourceIds: ['skill'] });
    const incrementalContainer = partial.nodes.find(n => n.id === 'compound');
    assert.equal(incrementalContainer.width, incrementalContainer.style.width);
    assert.ok(getNodeSize(incrementalContainer).width >= getNodeSize(container).width);
});

test('boundary helper IDs do not change when rebuilding the same graph', () => {
    const nodes = [
        { id: 'container', type: 'compound', position: { x: 0, y: 0 }, data: { events: [] } },
        { id: 'skill', type: 'custom', parentId: 'container', data: { label: 'Grasp' }, position: { x: 50, y: 100 } },
        { id: 'outside', type: 'custom', position: { x: 900, y: 10 } },
    ];
    const edges = [{ id: 'edge', source: 'skill', sourceHandle: 'error.cancelled', target: 'outside' }];
    const once = rebuildBoundaryTransitions(nodes, edges);
    const twice = rebuildBoundaryTransitions(once.nodes, once.edges);
    const helperIds = graph => graph.edges.filter(e => e.data?.boundaryInternalEdge).map(e => e.id);
    assert.ok(helperIds(once).length > 0);
    assert.deepEqual(helperIds(once), helperIds(twice));
});
