import assert from 'node:assert/strict';
import test from 'node:test';
import { getExportedStateName, proposedExportedStateName, validateStateRename, findDuplicateSubmachineStateName } from './stateNameValidation.js';

const skill = (id, fullSkillName, parentId = null, extra = {}) => ({
    id, type: 'custom', parentId,
    data: { label: 'Wait', fullSkillName, ...extra },
});
const parallel = { id: 'p', type: 'parallel', data: { label: 'parallel_1' } };
const compound = { id: 'c', type: 'compound', parentId: 'p', data: { label: 'Container' } };
const nodes = [parallel, compound,
    skill('wait-a', 'de.test.Wait#1', 'c'),
    skill('wait-b', 'de.test.Wait#2', 'p'),
];

test('a skill cannot take a duplicate SCXML ID in another container', () => {
    assert.match(validateStateRename(nodes, 'wait-b', '1'), /already in use/);
    assert.equal(validateStateRename(nodes, 'wait-b', '3'), null);
    assert.equal(proposedExportedStateName(nodes[3], '3'), 'de.test.Wait#3');
    assert.equal(validateStateRename(nodes, 'wait-b', '2'), null, 'unchanged name is allowed');
});

test('a container and skill share the same global SCXML state namespace', () => {
    assert.match(validateStateRename(nodes, 'c', 'parallel_1'), /already in use/);
    assert.match(validateStateRename(nodes, 'c', 'de.test.Wait#2'), /already in use/);
    assert.equal(validateStateRename(nodes, 'c', 'AnotherContainer'), null);
    assert.equal(getExportedStateName(compound), 'Container');
});

test('aliases/clones do not represent a separate SCXML state', () => {
    const clone = skill('clone', 'de.test.Wait#4', null, { isSkillClone: true });
    assert.equal(validateStateRename([...nodes, clone], 'wait-b', '4'), null);
    assert.match(validateStateRename([...nodes, clone], 'clone', '5'), /References/);
});

test('editor-only instance IDs do not change their underlying SCXML state name', () => {
    const nop1 = skill('nop1', 'de.test.Nop', null, { editorInstanceId: 'left' });
    const nop2 = skill('nop2', 'de.test.Nop', null, { editorInstanceId: 'right' });
    assert.match(validateStateRename([nop1, nop2], 'nop2', 'left'), /already in use/);
    assert.equal(validateStateRename([nop1, nop2], 'nop2', 'middle'), null);
    assert.equal(validateStateRename([nop1, nop2], 'nop2', ''), null);
    assert.equal(getExportedStateName(nop2), 'de.test.Nop');
});

test('skill names with different qualified bases are distinct SCXML IDs', () => {
    const other = skill('wait-other', 'de.another.Wait#1');
    assert.equal(validateStateRename([...nodes, other], 'wait-other', '2'), null);
    assert.equal(validateStateRename([...nodes, other], 'wait-other', '1'), null);
});

test('a parallel lane is renamed as a container state, not as a skill instance', () => {
    const lane = { id: 'lane', type: 'parallelLane', parentId: 'p', data: { label: 'Lane_1', fullSkillName: 'Lane_1' } };
    assert.equal(proposedExportedStateName(lane, 'Left'), 'Left');
    assert.equal(validateStateRename([...nodes, lane], 'lane', 'Left'), null);
    assert.match(validateStateRename([...nodes, lane], 'lane', 'Container'), /already in use/);
});


test("load preflight catches duplicate sub-state-machine names without flagging shared End", () => {
    const nodes = [
        { id: "a", type: "submachine", data: { fullSkillName: "Search", label: "Search" } },
        { id: "b", type: "submachine", data: { fullSkillName: "Search", label: "Search" } },
        { id: "end1", type: "custom", data: { fullSkillName: "End", label: "End" } },
        { id: "end2", type: "custom", data: { fullSkillName: "End", label: "End" } },
    ];
    assert.equal(findDuplicateSubmachineStateName(nodes), "Search");
    nodes[1].data.fullSkillName = "Search#2";
    assert.equal(findDuplicateSubmachineStateName(nodes), null);
});
