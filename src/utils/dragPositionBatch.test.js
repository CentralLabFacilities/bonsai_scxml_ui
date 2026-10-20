import assert from 'node:assert/strict';
import test from 'node:test';
import { isMovingPositionBatch, collectDraggedPositions } from './dragPositionBatch.js';

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
