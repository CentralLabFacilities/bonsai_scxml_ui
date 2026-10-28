import assert from 'node:assert/strict';
import test from 'node:test';
import { isMovingPositionBatch, collectDraggedPositions, splitDragPreviewChanges, withDragPreviewPositions, finishedDragPositions, isLiveGeometryBatch, collectLiveGeometry } from './dragPositionBatch.js';

test('only in-flight node positions may be frame coalesced', () => {
    assert.equal(isMovingPositionBatch([{id:'p', type:'position', dragging:true}]), true);
    assert.equal(isMovingPositionBatch([{id:'p', type:'position', dragging:false}]), false);
    assert.equal(isMovingPositionBatch([{id:'p', type:'position'}]), false);
    assert.equal(isMovingPositionBatch([{id:'p', type:'dimensions'}]), false);
    assert.equal(isMovingPositionBatch([{id:'p', type:'position', dragging:true}, {id:'q', type:'remove'}]), false);
    assert.equal(isMovingPositionBatch([]), false);
});

test('coalescing retains latest independent positions when dragging multiple nodes', () => {
    const pending = new Map();
    collectDraggedPositions(pending, [{id:'p', type:'position', dragging:true, position:{x:1,y:2}}]);
    collectDraggedPositions(pending, [
        {id:'q', type:'position', dragging:true, position:{x:5,y:6}},
        {id:'p', type:'position', dragging:true, position:{x:3,y:4}},
    ]);
    assert.deepEqual([...pending.keys()], ['p','q']);
    assert.deepEqual(pending.get('p').position, {x:3,y:4});
    assert.deepEqual(pending.get('q').position, {x:5,y:6});
});


test('live drag positions stay visual; selections, dimensions and removals reach the document', () => {
    const preview = new Map();
    const changes = [
        { id: 'skill', type: 'position', dragging: true, position: { x: 12, y: 4 } },
        { id: 'other', type: 'select', selected: true },
        { id: 'container', type: 'dimensions', dimensions: { width: 220, height: 180 } },
    ];
    const first = splitDragPreviewChanges(changes, preview);
    assert.deepEqual(first.moving, [changes[0]]);
    assert.deepEqual(first.other, [changes[1], changes[2]]);
    preview.set('skill', changes[0]);
    // React Flow's final dragging:false position remains local until drop.
    const finalChange = { id: 'skill', type: 'position', dragging: false, position: { x: 15, y: 4 } };
    assert.deepEqual(splitDragPreviewChanges([finalChange, { id:'other', type:'remove' }], preview), {
        moving: [finalChange], other: [{ id:'other', type:'remove' }],
    });
});

test('local preview keeps unrelated nodes referentially identical', () => {
    const dragged = { id: 'one', position: { x: 0, y: 0 }, data: { label: 'Wait#1' } };
    const other = { id: 'two', position: { x: 100, y: 0 } };
    const nodes = [dragged, other];
    assert.equal(withDragPreviewPositions(nodes, null), nodes);
    const preview = new Map([['one', { position: { x: 20, y: 30 } }]]);
    const updated = withDragPreviewPositions(nodes, preview);
    assert.deepEqual(updated[0].position, { x: 20, y: 30 });
    assert.equal(updated[0].data, dragged.data);
    assert.equal(updated[1], other);
    assert.deepEqual(nodes[0].position, { x: 0, y: 0 });
});

test('drop commits latest positions once for all dragged nodes and preserves final coordinates', () => {
    const preview = new Map([
        ['one', { id:'one', type:'position', dragging: true, position: { x: 5, y: 5 } }],
        ['two', { id:'two', type:'position', dragging: true, position: { x: 90, y: 10 } }],
    ]);
    const final = finishedDragPositions(preview, [
        { id: 'one', position: { x: 8, y: 7 } },
        { id: 'two', position: { x: 93, y: 12 } },
    ]);
    assert.equal(final.length, 2);
    assert.deepEqual(final.map((change) => [change.id, change.position]), [
        ['one', { x: 8, y: 7 }], ['two', { x: 93, y: 12 }],
    ]);
    assert.ok(final.every((change) => change.dragging === false));
    assert.equal(preview.get('one').dragging, true);
});

test('only intermediate positions and resize dimensions are frame-batched', () => {
    assert.equal(isLiveGeometryBatch([{id:'parallel', type:'dimensions', resizing:true, dimensions:{width:600,height:420}}]), true);
    assert.equal(isLiveGeometryBatch([{id:'parallel', type:'dimensions', resizing:true, dimensions:{width:600,height:420}}, {id:'lane', type:'position', dragging:true,position:{x:0,y:90}}]), true);
    assert.equal(isLiveGeometryBatch([{id:'parallel', type:'dimensions', resizing:false, dimensions:{width:600,height:420}}]), false);
    assert.equal(isLiveGeometryBatch([{id:'parallel', type:'dimensions', dimensions:{width:600,height:420}}]), false);
    assert.equal(isLiveGeometryBatch([{id:'parallel', type:'dimensions', resizing:true, dimensions:{width:600,height:420}}, {id:'skill', type:'remove'}]), false);
});

test('last live resize replaces earlier dimensions, while independent position survives', () => {
    const pending = new Map();
    collectLiveGeometry(pending, [{id:'parallel', type:'dimensions', resizing:true, dimensions:{width:500,height:300}}]);
    collectLiveGeometry(pending, [{id:'parallel', type:'dimensions', resizing:true, dimensions:{width:540,height:360}}, {id:'skill',type:'position',dragging:true,position:{x:20,y:30}}]);
    assert.equal(pending.size, 2);
    assert.deepEqual(pending.get('parallel:dimensions').dimensions, {width:540,height:360});
    assert.deepEqual(pending.get('skill:position').position, {x:20,y:30});
});
