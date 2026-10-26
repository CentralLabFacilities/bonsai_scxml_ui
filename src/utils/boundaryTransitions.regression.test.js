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

test('two explicit connections with the same source, event and target remain distinct transitions', () => {
    const nodes = [
        { id: 'container', type: 'compound', position: { x: 0, y: 0 }, data: { events: [] } },
        { id: 'skill', type: 'custom', parentId: 'container', position: { x: 30, y: 40 }, data: { label: 'Wait', events: [{ id: 'success' }] } },
        { id: 'target', type: 'custom', position: { x: 800, y: 80 }, data: {} },
    ];
    const first = { id: 'first', source: 'skill', sourceHandle: 'success', target: 'target', data: { cond: '' } };
    const second = { id: 'second', source: 'skill', sourceHandle: 'success', target: 'target', data: { cond: 'attempts > 2' } };
    const initial = rebuildBoundaryTransitions(nodes, [first]);
    const withSecond = rebuildBoundaryTransitionsIncremental(initial.nodes, [...initial.edges, second], {
        previousEdges: initial.edges, changedEdgeIds: [second.id],
    });
    const semantic = withSecond.edges.filter(e => !e.data?.boundaryInternalEdge);
    assert.deepEqual(semantic.map(e => e.id).sort(), ['first', 'second']);
    assert.equal(semantic[1].data.cond, 'attempts > 2');
    const again = rebuildBoundaryTransitions(withSecond.nodes, withSecond.edges);
    assert.deepEqual(again.edges.filter(e => !e.data?.boundaryInternalEdge).map(e => e.id).sort(), ['first', 'second']);
});

test('Compound exit connects all matching Wait skills to the same boundary port', () => {
    const scoped = [
        { id: 'compound', type: 'compound', position: { x: 0, y: 0 }, data: { label: 'Group', events: [] } },
        { id: 'wait1', parentId: 'compound', type: 'custom', position: { x: 30, y: 50 }, data: { label: 'Wait', fullSkillName: 'core.Wait#1', events: [{ id: 'success' }] } },
        { id: 'wait2', parentId: 'compound', type: 'custom', position: { x: 30, y: 140 }, data: { label: 'Wait', fullSkillName: 'core.Wait#2', events: [{ id: 'success' }] } },
        { id: 'other', parentId: 'compound', type: 'custom', position: { x: 30, y: 240 }, data: { label: 'Talk', fullSkillName: 'core.Talk#1', events: [{ id: 'success' }] } },
        { id: 'outside', type: 'custom', position: { x: 900, y: 30 }, data: {} },
    ];
    const edges = [{ id: 'exit', source: 'wait1', sourceHandle: 'success', target: 'outside', data: {} }];
    const output = rebuildBoundaryTransitions(scoped, edges);
    const helpers = output.edges.filter((e) => e.data?.compoundInternalEdge);
    assert.deepEqual(helpers.map((e) => e.source).sort(), ['wait1', 'wait2']);
    assert.equal(new Set(helpers.map((e) => e.targetHandle)).size, 1);
    assert.equal(helpers[0].target, 'compound');
    assert.equal(output.edges.filter((e) => !e.data?.boundaryInternalEdge).length, 1);
    assert.deepEqual(output.edges.find((e) => e.id === 'exit').data.boundaryOriginalSources, [
        { sourceId: 'wait1', sourceHandle: 'success' },
        { sourceId: 'wait2', sourceHandle: 'success' },
    ]);
    const again = rebuildBoundaryTransitions(output.nodes, output.edges);
    assert.deepEqual(again.edges.map((e) => e.id), output.edges.map((e) => e.id), 'reprojection must be stable');
    assert.deepEqual(rebuildBoundaryTransitions(again.nodes, []).edges, [], 'deletion removes all helpers');
});

test('Compound boundary routing does not reach outside nested compound or pick a different event', () => {
    const scoped = [
        { id: 'outer', type: 'compound', data: { label: 'Outer' } },
        { id: 'inner', type: 'compound', parentId: 'outer', data: { label: 'Inner' } },
        { id: 'wait1', type: 'custom', parentId: 'inner', data: { label: 'Wait', fullSkillName: 'core.Wait#1', events: [{ id: 'success' }] } },
        { id: 'wait2', type: 'custom', parentId: 'inner', data: { label: 'Wait', fullSkillName: 'core.Wait#2', events: [{ id: 'success' }] } },
        { id: 'wait3', type: 'custom', parentId: 'outer', data: { label: 'Wait', fullSkillName: 'core.Wait#3', events: [{ id: 'success' }] } },
        { id: 'wait4', type: 'custom', parentId: 'inner', data: { label: 'Wait', fullSkillName: 'core.Wait#4', events: [{ id: 'failure' }] } },
        { id: 'outside', type: 'custom', data: {} },
    ];
    const graph = rebuildBoundaryTransitions(scoped,
        [{ id: 'exit', source: 'wait1', sourceHandle: 'success', target: 'outside', data: {} }]);
    assert.deepEqual(graph.edges.filter((e) => e.data?.boundaryInternalEdge && e.target === 'inner')
        .map((e) => e.source).sort(), ['wait1', 'wait2']);
    assert.deepEqual(graph.edges.filter((e) => e.data?.boundaryInternalEdge && e.source === 'wait3'), []);
});

test('Incremental Compound edits add and remove every matching inner helper', () => {
    const scoped = [
        { id: 'box', type: 'compound', data: { label: 'Box', events: [] } },
        { id: 'w1', type: 'custom', parentId: 'box', data: { label: 'Wait', fullSkillName: 'Wait#1', events: [{ id: 'success' }] } },
        { id: 'w2', type: 'custom', parentId: 'box', data: { label: 'Wait', fullSkillName: 'Wait#2', events: [{ id: 'success' }] } },
        { id: 'target', type: 'custom', data: {} },
    ];
    const edge = { id: 'edge', source: 'w1', sourceHandle: 'success', target: 'target', data: {} };
    const added = rebuildBoundaryTransitionsIncremental(scoped, [edge], {
        previousEdges: [], changedEdgeIds: [edge.id],
    });
    assert.deepEqual(added.edges.filter((e) => e.data?.boundaryInternalEdge).map((e) => e.source).sort(), ['w1', 'w2']);
    assert.equal(added.nodes.find((n) => n.id === 'box').data.events.length, 1);
    const cleared = rebuildBoundaryTransitionsIncremental(added.nodes, [], {
        previousEdges: added.edges, changedEdgeIds: [edge.id],
    });
    assert.deepEqual(cleared.edges, []);
    assert.deepEqual(cleared.nodes.find((n) => n.id === 'box').data.events, []);
});
