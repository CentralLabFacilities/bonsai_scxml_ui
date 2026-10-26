import test from 'node:test';
import assert from 'node:assert/strict';
import { initialWorkflowStateIds, matchesLoadedInitial, shortRuntimeStateId } from './runtimeWorkflowIdentity.js';

const workflow = { nodes: [
    { id: 'other', type: 'custom', data: { fullSkillName: 'core.Navigate#1', isInitial: false } },
    { id: 'first', type: 'custom', data: { fullSkillName: 'ecwm.core.Wait2#1', isInitial: true } },
    { id: 'next', type: 'custom', data: { fullSkillName: 'ecwm.core.Wait2#2', isInitial: false } },
] };

test('runtime started initial matches the editor SCXML identity and its backend short form', () => {
    assert.equal(matchesLoadedInitial(workflow, 'ecwm.core.Wait2#1'), true);
    assert.equal(matchesLoadedInitial(workflow, 'Wait2#1'), true);
    assert.equal(shortRuntimeStateId('ecwm.core.Wait2#1'), 'Wait2#1');
});

test('runtime started cannot accept the wrong state, another root, or empty initial', () => {
    assert.equal(matchesLoadedInitial(workflow, 'Wait2#2'), false);
    assert.equal(matchesLoadedInitial(workflow, 'Navigate#1'), false);
    assert.equal(matchesLoadedInitial(workflow, ''), false);
    assert.equal(matchesLoadedInitial(null, 'Wait2#1'), false);
    assert.ok(initialWorkflowStateIds(workflow).includes('ecwm.core.Wait2#1'));
});
