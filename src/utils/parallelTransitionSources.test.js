import assert from 'node:assert/strict';
import test from 'node:test';
import { findContainerEventSources } from './parallelTransitionSources.js';
import { rebuildBoundaryTransitions, rebuildBoundaryTransitionsIncremental } from './boundaryTransitions.js';

const nodes = () => [
    { id: 'parallel', type: 'parallel', position: { x: 0, y: 0 }, data: { events: [] } },
    { id: 'lane1', parentId: 'parallel', type: 'parallelLane', position: { x: 0, y: 40 }, data: {} },
    { id: 'lane2', parentId: 'parallel', type: 'parallelLane', position: { x: 0, y: 200 }, data: {} },
    { id: 'wait1', parentId: 'lane1', type: 'custom', position: { x: 40, y: 40 }, data: { label: 'Wait', fullSkillName: 'de.test.Wait#1', events: [{ id: 'success' }] } },
    { id: 'wait2', parentId: 'lane2', type: 'custom', position: { x: 40, y: 40 }, data: { label: 'Wait', fullSkillName: 'de.test.Wait#2', events: [{ id: 'success' }] } },
    { id: 'other', parentId: 'lane2', type: 'custom', position: { x: 220, y: 40 }, data: { label: 'Talk', fullSkillName: 'de.test.Talk#1' } },
    { id: 'outside', type: 'custom', position: { x: 900, y: 0 }, data: {} },
];

const logicalEdges = () => [{
    id: 'success-to-outside', source: 'wait1', sourceHandle: 'success',
    target: 'outside', targetHandle: 'target', label: 'success', type: 'smartTransition',
    data: { cond: '', assignments: [] },
}];

test('one SCXML parallel exit is visualized from matching skills across ALL lanes', () => {
    const out = rebuildBoundaryTransitions(nodes(), logicalEdges());
    const helpers = out.edges.filter((e) => e.data?.boundaryInternalEdge);
    const external = out.edges.filter((e) => !e.data?.boundaryInternalEdge);
    assert.equal(external.length, 1, 'do not introduce a second semantic transition');
    assert.equal(external[0].source, 'lane1');
    assert.equal(external[0].sourceHandle, 'wait1-success');
    assert.equal(external[0].target, 'outside', 'outer transition must reach the target');
    assert.deepEqual(helpers.map((e) => e.source).sort(), ['wait1', 'wait2']);
    assert.deepEqual(external[0].data.boundaryOriginalSources, [
        { sourceId: 'wait1', sourceHandle: 'success' },
        { sourceId: 'wait2', sourceHandle: 'success' },
    ]);
    for (const laneId of ['lane1', 'lane2']) {
        assert.deepEqual(out.nodes.find((n) => n.id === laneId).data.events.map((e) => e.id), ['wait1-success']);
    }
    assert.equal(out.nodes.find((n) => n.id === 'parallel').data.events.length, 0);
    const again = rebuildBoundaryTransitions(out.nodes, out.edges);
    assert.equal(again.edges.length, out.edges.length, 'rebuilding must not duplicate helper edges');
    assert.deepEqual(again.edges.map(e => e.id), out.edges.map(e => e.id));
});

test('incremental updates keep both lanes and a single outer edge', () => {
    const base = nodes();
    const edge = logicalEdges();
    const first = rebuildBoundaryTransitions(base, edge);
    const newer = rebuildBoundaryTransitionsIncremental(first.nodes, first.edges, {
        previousEdges: first.edges,
        changedEdgeIds: [edge[0].id],
    });
    assert.equal(newer.edges.filter(e => !e.data?.boundaryInternalEdge).length, 1);
    assert.deepEqual(newer.edges.filter(e => e.data?.boundaryInternalEdge).map(e => e.source).sort(), ['wait1', 'wait2']);
    const removed = rebuildBoundaryTransitionsIncremental(first.nodes, [], {
        previousEdges: first.edges, changedEdgeIds: [edge[0].id],
    });
    assert.deepEqual(removed.nodes.find(n => n.id === 'lane1').data.events, []);
    assert.deepEqual(removed.nodes.find(n => n.id === 'lane2').data.events, []);
});

test('closest unconditional compound handler shadows an enclosing parallel handler', () => {
    const scoped = nodes();
    scoped.push({ id: 'inner', type: 'compound', parentId: 'lane2', data: { events: [
        { id: 'catch', rawEvent: 'Wait.success', target: 'other', cond: '' },
    ] } });
    scoped.find(n => n.id === 'wait2').parentId = 'inner';
    const matches = findContainerEventSources({ owner: scoped[0], rawEvent: 'Wait.success', nodes: scoped });
    assert.deepEqual(matches, [{ sourceId: 'wait1', sourceHandle: 'success' }]);
    const routed = rebuildBoundaryTransitions(scoped, logicalEdges());
    assert.deepEqual(routed.edges.filter(e => e.data?.boundaryInternalEdge).map(e => e.source), ['wait1']);
});

test('conditional descendant handler does not prevent ancestor fallback', () => {
    const scoped = nodes();
    scoped.push({ id: 'inner', type: 'compound', parentId: 'lane2', data: { events: [
        { id: 'catch', rawEvent: 'Wait.success', target: 'other', cond: 'guard' },
    ] } });
    scoped.find(n => n.id === 'wait2').parentId = 'inner';
    const matches = findContainerEventSources({ owner: scoped[0], rawEvent: 'Wait.success', nodes: scoped });
    assert.deepEqual(matches.map(e => e.sourceId), ['wait1', 'wait2']);
});

test('wildcard descriptor matches Wait in both lanes but not Talk or unrelated containers', () => {
    const scoped = nodes();
    scoped.push({ id: 'unrelated', type: 'custom', data: { label: 'Wait', fullSkillName: 'de.test.Wait#3' } });
    const matches = findContainerEventSources({ owner: scoped[0], rawEvent: 'Wait.*', nodes: scoped });
    assert.deepEqual(matches, [
        { sourceId: 'wait1', sourceHandle: '*' },
        { sourceId: 'wait2', sourceHandle: '*' },
    ]);
});

test('unchanged graph nodes retain referential identity after boundary projection', () => {
    const original = nodes();
    const result = rebuildBoundaryTransitions(original, logicalEdges());
    assert.strictEqual(result.nodes.find(n => n.id === 'outside'), original.find(n => n.id === 'outside'));
    assert.strictEqual(result.nodes.find(n => n.id === 'other'), original.find(n => n.id === 'other'));
});


test('skill-level local transition shadows parallel without hiding conditional fallback', () => {
    const scoped = nodes();
    const second = scoped.find(n => n.id === 'wait2');
    second.data = { ...second.data, events: [{ id: 'success', target: 'other' }] };
    const list = () => findContainerEventSources({
        owner: scoped[0], rawEvent: 'Wait.success', nodes: scoped,
    }).map(e => e.sourceId);
    assert.deepEqual(list(), ['wait1']);
    second.data.events[0].cond = 'x > 0';
    assert.deepEqual(list(), ['wait1', 'wait2']);
});

test('incremental wildcard projection creates and removes physical skill ports', () => {
    const base = nodes();
    const edges = [{
        ...logicalEdges()[0], id: 'wildcard', sourceHandle: '*',
        data: { boundaryImportedRawEvent: 'Wait.*', cond: '' },
    }];
    const projected = rebuildBoundaryTransitionsIncremental(base, edges, {
        previousEdges: [], changedEdgeIds: ['wildcard'],
    });
    for (const sourceId of ['wait1', 'wait2']) {
        assert.ok(projected.nodes.find(n => n.id === sourceId).data.events.some(e => e.id === '*'));
    }
    assert.equal(projected.edges.filter(e => e.data?.boundaryInternalEdge).length, 2);
    const afterDelete = rebuildBoundaryTransitionsIncremental(projected.nodes, [], {
        previousEdges: projected.edges, changedEdgeIds: ['wildcard'],
    });
    for (const sourceId of ['wait1', 'wait2']) {
        assert.equal(afterDelete.nodes.find(n => n.id === sourceId).data.events.some(e => e.id === '*'), false);
    }
});
