import assert from 'node:assert/strict';
import test from 'node:test';
import { getCollapsedTransitionSource } from './editorGraph.js';

test('internal edges never become external collapsed-container exits', () => {
    const nodes = [
        { id: 'p', type: 'parallel', data: { isCollapsed: true } },
        { id: 'lane', type: 'parallelLane', parentId: 'p' },
        { id: 'sub', type: 'compound', parentId: 'lane' },
        { id: 'src', parentId: 'sub', type: 'custom' },
        { id: 'dst', parentId: 'lane', type: 'custom' },
        { id: 'outside', type: 'custom' },
    ];
    const byId = new Map(nodes.map(node => [node.id, node]));
    assert.equal(getCollapsedTransitionSource({ source: 'src', target: 'dst', sourceHandle: 'success' }, byId), null);
    assert.equal(getCollapsedTransitionSource({ source: 'src', target: 'outside', sourceHandle: 'success' }, byId)?.nodeId, 'p');
    assert.equal(getCollapsedTransitionSource({ source: 'src', target: 'p', sourceHandle: 'success' }, byId), null);
    assert.equal(getCollapsedTransitionSource({ source: 'src', target: 'outside', data: { boundaryOriginalTarget: 'dst' } }, byId), null);
});
