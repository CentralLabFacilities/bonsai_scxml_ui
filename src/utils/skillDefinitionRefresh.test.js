import assert from 'node:assert/strict';
import test from 'node:test';
import { getRefreshableSkillNodeIds, reconcileRefreshedSkillEvents } from './skillDefinitionRefresh.js';

test('refresh targets only genuine installed skill nodes, never visual clones or containers', () => {
    const nodes = [
        { id: 'a', type: 'custom', data: { fullSkillName: 'Wait#1' } },
        { id: 'alias', type: 'custom', data: { fullSkillName: 'Wait#1', isSkillClone: true } },
        { id: 'c', type: 'compound', data: { fullSkillName: 'Container#1' } },
        { id: 'empty', type: 'custom', data: {} },
    ];
    assert.deepEqual(getRefreshableSkillNodeIds(nodes), ['a']);
});

test('refresh preserves transition configuration for an unchanged API event', () => {
    const previous = [{ id: 'success', target: 'target', cond: 'x > 0', assignments: [{ location: 'x', expr: '1' }] }];
    const result = reconcileRefreshedSkillEvents(previous, [{ event: 'success', description: 'Success' }]);
    assert.equal(result[0].target, 'target');
    assert.equal(result[0].cond, 'x > 0');
    assert.equal(result[0].assignments.length, 1);
    assert.equal(result[0].definitionMissing, false);
});

test('refresh never silently loses a connected event removed from the skill definition', () => {
    const result = reconcileRefreshedSkillEvents([{ id: 'oldExit' }], [{ event: 'newExit' }], ['oldExit']);
    assert.deepEqual(result.map((entry) => entry.id), ['newExit', 'fatal', '*', 'oldExit']);
    assert.equal(result.at(-1).definitionMissing, true);
});

test('custom wildcards survive refresh; truly unused removed events disappear', () => {
    const result = reconcileRefreshedSkillEvents([{ id: 'success.*' }, { id: 'obsolete' }], []);
    assert.equal(result.some((entry) => entry.id === 'success.*'), true);
    assert.equal(result.some((entry) => entry.id === 'obsolete'), false);
});

test('refresh preserves slot handle indices and paths when API reorders or adds a slot', async () => {
    const { reconcileRefreshedSlotRequests } = await import('./skillDefinitionRefresh.js');
    const previous = [
        { key: 'Entity', type: 'EntitySlot', path: '/entityslot', inherited: { xpath: '/entityslot' } },
        { key: 'Location', type: 'LocationSlot', path: '/location' },
    ];
    const result = reconcileRefreshedSlotRequests(previous, [
        { key: 'Destination', type: 'LocationSlot' },
        { key: 'Location', type: 'LocationSlot' },
        { key: 'Entity', type: 'EntitySlot' },
    ]);
    assert.deepEqual(result.map((slot) => slot.key), ['Entity', 'Location', 'Destination']);
    assert.equal(result[0].path, '/entityslot');
    assert.equal(result[0].inherited.xpath, '/entityslot');
    assert.equal(result[1].path, '/location');
    assert.equal(result[2].path, '');
});

test('API removing a bound slot cannot silently repurpose that existing handle', async () => {
    const { reconcileRefreshedSlotRequests } = await import('./skillDefinitionRefresh.js');
    const result = reconcileRefreshedSlotRequests([
        { key: 'Old', type: 'OldSlot', path: '/old' },
        { key: 'Still', type: 'StableSlot', path: '/still' },
    ], [{ key: 'Still', type: 'StableSlot' }]);
    assert.equal(result[0].key, 'Old');
    assert.equal(result[0].definitionMissing, true);
    assert.equal(result[1].key, 'Still');
    assert.equal(result[1].path, '/still');
});
