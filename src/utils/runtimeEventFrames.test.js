import test from 'node:test';
import assert from 'node:assert/strict';
import { appendRuntimeEvent, emptyRuntimeTimeline, invalidateRuntimeTimeline } from './runtimeEventFrames.js';
import { getRuntimeVariableValues } from './runtimeValueDisplay.js';

const e = (type, sequence, details = {}, values = {}) => ({ type, sequence, timestamp: new Date().toISOString(), details, values });

test('initial skill, transition, next skill each gets one snapshot; no skill is lost', () => {
    let t = emptyRuntimeTimeline();
    const dispatch = (type, sequence, details, values) => { t = appendRuntimeEvent(t, e(type, sequence, details, values)); };
    dispatch('started', 209, { initial: 'Wait2#1' });
    dispatch('datamodel_scope_initialized', 210, { scope: 'global', valuesJson: '{"hello":"ld","t":10000}' });
    dispatch('datamodel_assignment', 211, { scope: 'global', location: 'hello', sourceState: 'Wait2#1', newValueJson: '"world"' });
    dispatch('state_entered', 213, { state: 'Wait2#1' });
    assert.equal(t.frames.length, 1, 'first skill appears immediately');
    assert.equal(t.frames[0].type, 'state_entered');
    dispatch('parameter', 214, { state: 'Wait2#1', name: '#_TIMEOUT', newValue: '10000', expression: '@t' });
    dispatch('state_exited', 215, { state: 'Wait2#1' });
    assert.equal(t.frames.length, 1, 'skill exit does not add another snapshot');
    assert.equal(t.frames[0].closed, true);
    assert.equal(t.frames[0].finalParameters['Wait2#1:#_TIMEOUT'].value, '10000');
    assert.equal(t.frames[0].changes.length, 1);
    dispatch('datamodel_assignment', 216, { scope: 'global', location: 'hello', sourceState: 'Wait2#1', newValueJson: '"welp"' });
    dispatch('transition', 217, { source: 'Wait2#1', target: 'Wait2#2', event: 'Wait.success' });
    assert.equal(t.frames.length, 2);
    assert.deepEqual(t.frames.map((f) => f.type), ['state_entered', 'transition']);
    assert.equal(t.frames[1].scopes.global.hello.value, 'welp');
    dispatch('state_entered', 218, { state: 'Wait2#2' });
    assert.equal(t.frames.length, 3);
    assert.deepEqual(t.frames.map((f) => f.state), ['Wait2#1', '', 'Wait2#2']);
    dispatch('state_exited', 219, { state: 'Wait2#2' });
    dispatch('transition', 220, { source: 'Wait2#2', target: 'End' });
    dispatch('state_entered', 221, { state: 'End' });
    dispatch('state_exited', 222, { state: 'End' });
    assert.equal(t.frames.length, 4, 'terminal state must not add a skill snapshot');
    dispatch('completed', 223, { state: 'End', outcome: 'success' });
    assert.equal(t.status, 'COMPLETED');
    assert.equal(t.frames.length, 4);
});

test('repeated skill occurrences preserve separate entry snapshots', () => {
    let t = emptyRuntimeTimeline();
    for (const msg of [e('state_entered', 1, {state:'Wait#1'}), e('state_exited', 2, {state:'Wait#1'}),
        e('transition', 3, {source:'Wait#1',target:'Wait#1'}), e('state_entered', 4, {state:'Wait#1'}),
        e('state_exited', 5, {state:'Wait#1'})]) t = appendRuntimeEvent(t, msg);
    assert.deepEqual(t.frames.filter((f) => f.type === 'state_entered').map((f) => f.occurrence), [1, 2]);
    assert.equal(t.frames.length, 3);
    assert.equal(t.frames[0].exitSequence, 2);
    assert.equal(t.frames[2].exitSequence, 5);
});

test('gaps clear active truth but preserve previous snapshots and new entries', () => {
    let t = emptyRuntimeTimeline();
    t = appendRuntimeEvent(t, e('state_entered', 1, { state: 'Wait2#1' }));
    t = appendRuntimeEvent(t, e('parameter', 2, { state: 'Wait2#1', name: '#_TIMEOUT', value: '500' }));
    t = appendRuntimeEvent(t, e('state_exited', 3, { state: 'Wait2#1' }));
    t = invalidateRuntimeTimeline(t);
    assert.deepEqual(t.activeStates, []);
    assert.equal(t.hasGap, true);
    assert.equal(t.partiallyUnknown, true);
    assert.equal(t.parameters['Wait2#1:#_TIMEOUT'].stale, true);
    assert.deepEqual(t.frames[0].activeStates, ['Wait2#1']);
    assert.equal(t.frames[0].finalParameters['Wait2#1:#_TIMEOUT'].stale, false);
    t = appendRuntimeEvent(t, e('state_entered', 5, { state: 'Wait2#2' }));
    assert.deepEqual(t.activeStates, ['Wait2#2']);
    assert.equal(t.frames.length, 2);
    assert.equal(t.partiallyUnknown, true);
});

test('local and global variables are grouped by underscore, not engine scope, and parameters excluded', () => {
    const t = appendRuntimeEvent(emptyRuntimeTimeline(), e('datamodel_scope_initialized', 4,
        { scope: 'global', valuesJson: JSON.stringify({ '#_SLOTS': { $bonsaiUnsupportedType: 'org.apache.xerces.dom.ElementNSImpl' },
            _shared: 'yes', hello: 'world', counter: 4, '#_TIMEOUT': 1000 }) }));
    const items = getRuntimeVariableValues([{id:'counter',expr:'0'}], t.scopes);
    assert.equal(items.find((v) => v.name === '_shared')?.scope, 'global');
    assert.equal(items.find((v) => v.name === 'hello')?.scope, 'local');
    assert.equal(items.find((v) => v.name === 'counter')?.value, '4');
    assert.equal(items.find((v) => v.name === '#_TIMEOUT'), undefined);
    assert.equal(t.scopes.global['#_SLOTS'], undefined);
});

test('unsupported datamodel values are displayed safely', () => {
    const event = e('datamodel_scope_initialized', 4, { scope: 'global',
        valuesJson: JSON.stringify({ '#_SLOTS': { $bonsaiUnsupportedType: 'org.apache.xerces.dom.ElementNSImpl' },
            custom: { $bonsaiUnsupportedType: 'com.example.Unknown' }, count: 4 }) });
    const t = appendRuntimeEvent(emptyRuntimeTimeline(), event);
    assert.equal(t.scopes.global['#_SLOTS'], undefined);
    assert.equal(t.scopes.global.custom.value, '[Unsupported: com.example.Unknown]');
    assert.equal(t.scopes.global.count.value, '4');
});

test('non-skill entries update active states without snapshots', () => {
    let t = appendRuntimeEvent(emptyRuntimeTimeline(), { ...e('state_entered', 1, { state: 'Parallel' }), skillSnapshot: false });
    t = appendRuntimeEvent(t, { ...e('state_exited', 2, { state: 'Parallel' }), skillSnapshot: false });
    t = appendRuntimeEvent(t, e('state_entered', 3, { state: 'End' }));
    assert.deepEqual(t.activeStates, ['End']);
    assert.equal(t.frames.length, 0);
});
