import test from 'node:test';
import assert from 'node:assert/strict';
import { configuredSkillSlots, latestSlotObservation, normalizeMemoryPath } from './runtimeMemorySlots.js';

test('skill slot mapping respects inherited xpath, access directions and unmapped slots', () => {
    const entries = configuredSkillSlots({ type: 'custom', data: {
        inSlots: [{ key: 'Input', path: '/old', type: 'java.lang.String', inherited: { xpath: '/inherited' } }],
        outSlots: [{ key: 'Result', path: '/result' }, { key: 'Result', path: '/result' }],
    } });
    assert.equal(entries[0].path, '/inherited');
    assert.equal(entries[1].path, '/result');
    assert.equal(entries.length, 2);
    assert.equal(normalizeMemoryPath('result'), '/result');
});

test('slot history chooses latest observation per configured path without peeking into future', () => {
    const observations = [
        { state: 'A', occurrence: 1, observedAtPerf: 10, observedAt: 'first', slots: [{ path: '/x', status: 'available', value: 'one' }] },
        { state: 'B', occurrence: 1, observedAtPerf: 20, observedAt: 'second', slots: [{ path: '/y', status: 'available', value: 'two' }] },
        { state: 'C', occurrence: 1, observedAtPerf: 30, observedAt: 'third', slots: [{ path: '/x', status: 'available', value: 'three' }] },
    ];
    assert.equal(latestSlotObservation(observations, '/x', 25).value, 'one');
    assert.equal(latestSlotObservation(observations, '/y', 25).value, 'two');
    assert.equal(latestSlotObservation(observations, '/x', 5), null);
});

test('skill snapshot is linked to its entry frame even though slot GET finishes after exit', async () => {
    const { observationForRuntimeFrame } = await import('./runtimeMemorySlots.js');
    const observations = [
        { state:'Wait#1', kind:'skill-exit', sequence:15, entrySequence:10, occurrence:1,
            observedAtPerf:20, observedAt:'2026-10-24T16:30:34Z', slots:[{ path:'/x', status:'available', value:'hello' }] },
        { state:'Wait#2', kind:'transition', sequence:17, observedAtPerf:30,
            observedAt:'2026-10-24T16:30:35Z', slots:[{ path:'/x', status:'available', value:'other' }] },
    ];
    const skill = observationForRuntimeFrame(observations, {type:'state_entered',state:'Wait#1',sequence:10});
    assert.equal(skill?.slots[0].value, 'hello');
    assert.equal(observationForRuntimeFrame(observations, {type:'transition',sequence:17})?.slots[0].value, 'other');
    assert.equal(observationForRuntimeFrame(observations, {type:'state_entered',state:'Wait#2',sequence:20}), null);
});

test('runtime skill matching removes package prefix without losing instance identity', async () => {
    const { skillForRuntimeState } = await import('./runtimeMemorySlots.js');
    const tabs = [{ id: 'root', nodes: [
        { id: 'first', type: 'custom', data: { fullSkillName: 'de.unibi.citec.clf.bonsai.skills.Wait2#1',
            outSlots: [{ key: 'Result', path: '/defaultslot' }] } },
        { id: 'second', type: 'custom', data: { fullSkillName: 'de.unibi.citec.clf.bonsai.skills.Wait2#2' } },
    ] }];
    const matched = skillForRuntimeState(tabs, 'Wait2#1');
    assert.equal(matched?.node.id, 'first');
    assert.deepEqual(configuredSkillSlots(matched.node).map((slot) => slot.path), ['/defaultslot']);
    assert.equal(skillForRuntimeState(tabs, 'Wait2#2')?.node.id, 'second');
    assert.equal(skillForRuntimeState(tabs, 'Wait2#3'), null);
});

test('ambiguous package-stripped names cannot cross-attribute slot snapshots', async () => {
    const { skillForRuntimeState } = await import('./runtimeMemorySlots.js');
    const tabs = [{ id: 'root', nodes: [
        { id: 'a', type: 'custom', data: { fullSkillName: 'package.a.Wait#1' } },
        { id: 'b', type: 'custom', data: { fullSkillName: 'package.b.Wait#1' } },
    ] }];
    assert.equal(skillForRuntimeState(tabs, 'Wait#1'), null);
    assert.equal(skillForRuntimeState(tabs, 'package.a.Wait#1')?.node.id, 'a');
});

test('skill entry snapshot retains captured value after exit even with a later observation time', async () => {
    const { skillForRuntimeState, observationForRuntimeFrame } = await import('./runtimeMemorySlots.js');
    const tabs = [{ id:'root', nodes:[{id:'first', type:'custom', data:{
        fullSkillName:'de.unibi.citec.clf.bonsai.skills.Wait2#1',
        outSlots:[{key:'Result',path:'/defaultslot'}],
    }}]}];
    const skill = skillForRuntimeState(tabs, 'Wait2#1');
    assert.ok(skill, 'exit state must resolve to skill to trigger capture');
    const captured = [{ state:'Wait2#1', kind:'skill-exit', entrySequence:7, sequence:9,
        observedAtPerf:150, observedAt:'2026-10-24T16:30:45Z',
        slots:[{...configuredSkillSlots(skill.node)[0], status:'available', value:'hello'}] }];
    const earlierFrame = {type:'state_entered',state:'Wait2#1',sequence:7,receivedAtPerf:50};
    assert.equal(observationForRuntimeFrame(captured, earlierFrame)?.slots[0].value, 'hello');
});

test('capture fetches a configured slot even when getUsedSlots has not listed it', async () => {
    const { readMappedSlotEntries } = await import('./runtimeMemorySlots.js');
    const calls = [];
    const [value] = await readMappedSlotEntries(
        [{ path: '/defaultslot', key: 'Default', type: 'java.lang.String', access: 'write' }],
        [], async (path) => { calls.push(path); return { path, type: 'java.lang.String', value: 'hello', status: 'available' }; }
    );
    assert.deepEqual(calls, ['/defaultslot']);
    assert.equal(value.status, 'available');
    assert.equal(value.value, 'hello');
});

test('slot read errors retain incomplete status but never fabricate a value', async () => {
    const { readMappedSlotEntries } = await import('./runtimeMemorySlots.js');
    const paths = [{path:'/used'}, {path:'/unlisted'}];
    const list = [{path:'/used',type:'java.lang.String'}];
    const result = await readMappedSlotEntries(paths, list, async () => { throw new Error('unavailable'); });
    assert.equal(result[0].status, 'unavailable');
    assert.equal(result[1].status, 'not-accessed');
});

test('canvas and inspector choose same post-exit value for linked skill entry', async () => {
    const { historicalSlotValue } = await import('./runtimeMemorySlots.js');
    const observations = [
        {state:'Wait#1',entrySequence:10,sequence:11,kind:'skill-exit',observedAtPerf:50,
            observedAt:'2026-10-24T16:30:33Z',slots:[{path:'/defaultslot',value:'hello',status:'available'}]}
    ];
    const frame = {state:'Wait#1',sequence:10,type:'state_entered',receivedAtPerf:20};
    assert.equal(historicalSlotValue(observations,frame,'/defaultslot')?.value,'hello');
});

test('a missing used-list entry does not mask an earlier valid historical value', async () => {
    const { historicalSlotValue } = await import('./runtimeMemorySlots.js');
    const observations = [
        {state:'Wait#1',entrySequence:1,kind:'skill-exit',observedAtPerf:10,
            slots:[{path:'/defaultslot',value:'first',status:'available'}]},
        {state:'Wait#2',entrySequence:20,kind:'skill-exit',observedAtPerf:35,
            slots:[{path:'/defaultslot',status:'not-accessed'}]},
    ];
    const frame = {state:'Wait#2',sequence:20,type:'state_entered',receivedAtPerf:25};
    assert.equal(historicalSlotValue(observations,frame,'/defaultslot')?.value,'first');
});

test('failed capture remains unavailable instead of silently showing an earlier value', async () => {
    const { historicalSlotValue } = await import('./runtimeMemorySlots.js');
    const observations = [
        {state:'Wait#1',entrySequence:1,kind:'skill-exit',observedAtPerf:10,
            slots:[{path:'/x',value:'first',status:'available'}]},
        {state:'Wait#2',entrySequence:20,kind:'skill-exit',observedAtPerf:35,
            slots:[{path:'/x',status:'unavailable'}]},
    ];
    const frame = {state:'Wait#2',sequence:20,type:'state_entered',receivedAtPerf:25};
    assert.equal(historicalSlotValue(observations,frame,'/x')?.status,'unavailable');
});

test('out-of-order async capture completion does not change latest historical value', () => {
    const observations = [
        {state:'B',observedAtPerf:30,slots:[{path:'/x',status:'available',value:'newer'}]},
        {state:'A',observedAtPerf:10,slots:[{path:'/x',status:'available',value:'older'}]},
    ];
    assert.equal(latestSlotObservation(observations,'/x',40)?.value,'newer');
    assert.equal(latestSlotObservation(observations,'/x',20)?.value,'older');
});

test('run-wide slot cache rescues replay when entry skill has no resolved slot mappings', async () => {
    const { captureSlotEntries, historicalSlotValue } = await import('./runtimeMemorySlots.js');
    const captured = await captureSlotEntries([], [
        { path: '/defaultslot', type: 'java.lang.String' }
    ], {}, async (path) => ({ path, value: 'hello', type: 'java.lang.String', status: 'available' }));
    assert.equal(captured.slots.length, 0, 'do not invent an attribution to the skill');
    assert.equal(captured.cache.length, 1, 'still save the known runtime value');
    const history = [{ state: 'Wait#2', kind: 'skill-exit', sequence: 299, entrySequence: 295,
        observedAtPerf: 200, observedAt: '2026-10-24T16:30:33Z', ...captured }];
    const frame = { type: 'state_entered', state: 'Wait#2', sequence: 295, receivedAtPerf: 50 };
    assert.equal(historicalSlotValue(history, frame, '/defaultslot')?.value, 'hello');
    assert.equal(historicalSlotValue(history, frame, '/other'), null);
});

test('capture preserves skill-specific slots while caching other used paths for canvas', async () => {
    const { captureSlotEntries, historicalSlotValue } = await import('./runtimeMemorySlots.js');
    const captured = await captureSlotEntries([
        {path:'/input', key:'Input', access:'read'}
    ], [
        {path:'/input',type:'java.lang.String'},
        {path:'/result',type:'java.lang.String'}
    ], {}, async (path) => ({path, value: path === '/input' ? 'in' : 'out', status:'available'}));
    assert.deepEqual(captured.slots.map((item) => item.path), ['/input']);
    assert.deepEqual(captured.cache.map((item) => item.path), ['/input', '/result']);
    const history = [{state:'A',kind:'transition',sequence:4,observedAtPerf:20,
        observedAt:'2026-10-24T16:30:33Z',...captured}];
    assert.equal(historicalSlotValue(history,{type:'transition',sequence:4,receivedAtPerf:9},'/result')?.value,'out');
});

test('fallback preserves already seen SSE value when Memory GET fails', async () => {
    const { captureSlotEntries, historicalSlotValue } = await import('./runtimeMemorySlots.js');
    const captured = await captureSlotEntries([], [], {
        '/defaultslot': {path:'/defaultslot',value:'hello',status:'available',observedAt:'2026-10-24T10:00:00Z'}
    }, async () => { throw new Error('no network'); });
    assert.equal(captured.cache[0].value, 'hello');
    assert.equal(captured.cache[0].observationSource, 'event-cache');
    const history = [{state:'Wait#2',kind:'skill-exit',entrySequence:10,observedAtPerf:100,
        observedAt:'2026-10-24T10:10:00Z',...captured}];
    const replay = historicalSlotValue(history,{type:'state_entered',state:'Wait#2',sequence:10,receivedAtPerf:30},'/defaultslot');
    assert.equal(replay?.value, 'hello');
    assert.equal(replay?.observedAt, '2026-10-24T10:00:00Z', 'old SSE value must not be misdated as an exit GET');
});

test('cache retrieval respects separate skill occurrences and does not leak future observations', async () => {
    const { historicalSlotValue } = await import('./runtimeMemorySlots.js');
    const history = [
        {state:'Wait',kind:'skill-exit',entrySequence:1,observedAtPerf:11,
            observedAt:'first',cache:[{path:'/defaultslot',value:'first',status:'available'}]},
        {state:'Wait',kind:'skill-exit',entrySequence:3,observedAtPerf:31,
            observedAt:'second',cache:[{path:'/defaultslot',value:'second',status:'available'}]},
    ];
    assert.equal(historicalSlotValue(history,{type:'state_entered',state:'Wait',sequence:1,receivedAtPerf:1},'/defaultslot')?.value,'first');
    assert.equal(historicalSlotValue(history,{type:'state_entered',state:'Wait',sequence:3,receivedAtPerf:20},'/defaultslot')?.value,'second');
    assert.equal(historicalSlotValue(history,{type:'transition',sequence:2,receivedAtPerf:15},'/defaultslot')?.value,'first');
});


test('a value observed on SSE at the skill exit remains fixed even if a later GET observes another skill write', async () => {
    const { captureSlotEntries, historicalSlotValue } = await import('./runtimeMemorySlots.js');
    const slot = {path: '/result', key: 'Result', access: 'write'};
    const first = await captureSlotEntries([slot], [{path: '/result', type: 'String'}], {
        '/result': {path: '/result', value: 'Kitchen', status: 'available', observedAt: '2026-10-24T20:00:01Z'}
    }, async () => ({path: '/result', value: 'Bedroom', status: 'available'}));
    const second = await captureSlotEntries([slot], [{path: '/result', type: 'String'}], {
        '/result': {path: '/result', value: 'Bedroom', status: 'available', observedAt: '2026-10-24T20:00:02Z'}
    }, async () => ({path: '/result', value: 'Bedroom', status: 'available'}));
    assert.equal(first.cache[0].value, 'Kitchen');
    assert.equal(first.cache[0].observationSource, 'event-cache');
    const observations = [
        {state: 'Navigate#1', entrySequence: 1, kind: 'skill-exit', observedAtPerf: 20, observedAt: '2026-10-24T20:00:03Z', ...first},
        {state: 'Navigate#2', entrySequence: 3, kind: 'skill-exit', observedAtPerf: 30, observedAt: '2026-10-24T20:00:04Z', ...second},
    ];
    assert.equal(historicalSlotValue(observations, {type: 'state_entered', state: 'Navigate#1', sequence: 1, receivedAtPerf: 5}, '/result')?.value, 'Kitchen');
    assert.equal(historicalSlotValue(observations, {type: 'state_entered', state: 'Navigate#2', sequence: 3, receivedAtPerf: 25}, '/result')?.value, 'Bedroom');
});

test('a slot first written during the HTTP capture is not backdated to the earlier skill', async () => {
    const { captureSlotEntries } = await import('./runtimeMemorySlots.js');
    const result = await captureSlotEntries([{path:'/result', key:'Result'}], [], {},
        async (path) => ({path, status:'available', value:'future'}),
        {changedAfterEvent: (path) => path === '/result'});
    assert.equal(result.slots[0].status, 'unavailable');
    assert.equal(result.cache[0].value, undefined);
});

test('missing SSE observations remain explicitly post-event best-effort GET samples', async () => {
    const { captureSlotEntries } = await import('./runtimeMemorySlots.js');
    const result = await captureSlotEntries([{path:'/result', key:'Result'}], [], {},
        async (path) => ({path, status:'available', value:'sampled-late'}));
    assert.equal(result.slots[0].value, 'sampled-late');
    assert.equal(result.slots[0].observationSource, 'getSlot-after-event');
});

test('historical skill and transition frames freeze successive slot values within one run', async () => {
    const { freezeSlotEventBoundary, historicalSlotValue } = await import('./runtimeMemorySlots.js');
    const mapped = [{ path: '/defaultslot', key: 'StringSlot', access: 'read/write' }];
    const live = (value) => ({ '/defaultslot': {
        path: '/defaultslot', status: 'available', value, observedAt: `at-${value}`,
    } });
    // A writes Kitchen, B later writes Bedroom. The later GET must never
    // make A's entry or A -> B transition appear to have Bedroom.
    const observations = [
        freezeSlotEventBoundary(mapped, live('Kitchen'), {
            kind: 'skill-exit', state: 'A#1', sequence: 12, entrySequence: 10,
            observedAtPerf: 12, observedAt: 'time-12',
        }),
        freezeSlotEventBoundary(mapped, live('Kitchen'), {
            kind: 'transition', state: 'A#1', sequence: 13,
            observedAtPerf: 13, observedAt: 'time-13',
        }),
        freezeSlotEventBoundary(mapped, live('Bedroom'), {
            kind: 'skill-exit', state: 'B#1', sequence: 17, entrySequence: 15,
            observedAtPerf: 17, observedAt: 'time-17',
        }),
        // A delayed read completes after B wrote Bedroom. It is a later
        // observation, not the value that existed at A's earlier boundary.
        { kind: 'http-read', state: 'A#1', sequence: null, observedAtPerf: 25,
            slots: [], cache: [{ path: '/defaultslot', status: 'available', value: 'Bedroom' }] },
    ];
    assert.equal(historicalSlotValue(observations,
        { type: 'state_entered', state: 'A#1', sequence: 10, receivedAtPerf: 10 }, '/defaultslot')?.value, 'Kitchen');
    assert.equal(historicalSlotValue(observations,
        { type: 'transition', sequence: 13, receivedAtPerf: 13 }, '/defaultslot')?.value, 'Kitchen');
    assert.equal(historicalSlotValue(observations,
        { type: 'state_entered', state: 'B#1', sequence: 15, receivedAtPerf: 15 }, '/defaultslot')?.value, 'Bedroom');
});

test('slot not known at a snapshot is not filled by a subsequent write or GET', async () => {
    const { freezeSlotEventBoundary, historicalSlotValue } = await import('./runtimeMemorySlots.js');
    const first = freezeSlotEventBoundary([{ path: '/defaultslot' }], {}, {
        kind: 'transition', state: 'A#1', sequence: 2, observedAtPerf: 2,
    });
    const after = freezeSlotEventBoundary([{ path: '/defaultslot' }], {
        '/defaultslot': { path: '/defaultslot', status: 'available', value: 'hello' },
    }, { kind: 'transition', state: 'B#1', sequence: 5, observedAtPerf: 5 });
    const history = [first, after,
        { kind: 'http-read', sequence: null, observedAtPerf: 8, slots: [],
            cache: [{ path: '/defaultslot', status: 'available', value: 'hello' }] },
    ];
    const before = historicalSlotValue(history,
        { type: 'transition', sequence: 2, receivedAtPerf: 2 }, '/defaultslot');
    assert.notEqual(before?.status, 'available');
    assert.equal(historicalSlotValue(history,
        { type: 'transition', sequence: 5, receivedAtPerf: 5 }, '/defaultslot')?.value, 'hello');
});

test('compressed SSE deliveries are assigned to consecutive likely slot-writing skills, not the last value everywhere', async () => {
    const { inferSlotWriteHistory, historicalSlotValue } = await import('./runtimeMemorySlots.js');
    const writes = [
        {path:'/defaultslot',value:'hello',observedAtMs:1000,observedAt:'2026-10-24T21:00:01Z',order:0},
        {path:'/defaultslot',value:'world',observedAtMs:1001,observedAt:'2026-10-24T21:00:01.001Z',order:1},
    ];
    const skills = [
        {state:'Wait#1',entrySequence:1,exitSequence:3,endedAtMs:995,slots:[]},
        {state:'slots.SlotIO#1',entrySequence:7,exitSequence:9,endedAtMs:998,
            slots:[{key:'StringSlot',path:'',access:'write'}]},
        {state:'slots.SlotIO#2',entrySequence:13,exitSequence:15,endedAtMs:1002,slots:[]},
        {state:'Wait#2',entrySequence:19,exitSequence:21,endedAtMs:1010,slots:[]},
    ];
    const linked = inferSlotWriteHistory(writes, skills, '/defaultslot');
    assert.deepEqual(linked.map((item) => [item.value,item.sourceState,item.assignedSequence]), [
        ['hello','slots.SlotIO#1',9],['world','slots.SlotIO#2',15],
    ]);
    const history = [{state:'Wait#1',kind:'skill-exit',entrySequence:1,sequence:3,observedAtPerf:50,
        cache:[{path:'/defaultslot',status:'available',value:'world'}]}];
    const get = (type, state, sequence) => historicalSlotValue(history,{type,state,sequence,receivedAtPerf:200},'/defaultslot',writes,skills)?.value;
    assert.equal(get('state_entered','Wait#1',1), undefined, 'later writes cannot leak into Wait');
    assert.equal(get('transition','',6), undefined, 'before first writer there is no confirmed value');
    assert.equal(get('state_entered','slots.SlotIO#1',7), 'hello');
    assert.equal(get('transition','',10), 'hello', 'write persists into following transition');
    assert.equal(get('state_entered','slots.SlotIO#2',13), 'world');
    assert.equal(get('transition','',17), 'world');
    assert.equal(get('state_entered','Wait#2',19), 'world', 'value persists until next write');
});

test('inferred writes use slot paths, not proximity to a different configured writer', async () => {
    const { inferSlotWriteHistory } = await import('./runtimeMemorySlots.js');
    const writers = [
        {state:'WriteA#1',exitSequence:10,endedAtMs:1000,slots:[{path:'/a',access:'write'}]},
        {state:'WriteB#1',exitSequence:12,endedAtMs:1001,slots:[{path:'/b',access:'write'}]},
    ];
    assert.equal(inferSlotWriteHistory([{path:'/a',value:'A',observedAtMs:1001}], writers, '/a')[0].assignedSequence,10);
    assert.equal(inferSlotWriteHistory([{path:'/b',value:'B',observedAtMs:1000}], writers, '/b')[0].assignedSequence,12);
});

test('historical writer matching uses skill instance and repeated visits', async () => {
    const { historicalSlotValue } = await import('./runtimeMemorySlots.js');
    const skills = [
        {state:'Write#1',entrySequence:2,exitSequence:4,endedAtMs:1000,slots:[{path:'/x',access:'write'}]},
        {state:'Write#1',entrySequence:9,exitSequence:11,endedAtMs:2000,slots:[{path:'/x',access:'write'}]},
    ];
    const writes = [
        {path:'/x',value:'first',order:0,observedAtMs:1000},
        {path:'/x',value:'second',order:1,observedAtMs:2000},
    ];
    assert.equal(historicalSlotValue([], {type:'state_entered',state:'Write#1',sequence:2}, '/x', writes, skills).value,'first');
    assert.equal(historicalSlotValue([], {type:'state_entered',state:'Write#1',sequence:9}, '/x', writes, skills).value,'second');
});

test('different MemorySlot paths keep independent write histories', async () => {
    const { historicalSlotValue } = await import('./runtimeMemorySlots.js');
    const skills = [
        {state:'A',entrySequence:2,exitSequence:3,endedAtMs:1000,slots:[{path:'/a',access:'write'}]},
        {state:'B',entrySequence:5,exitSequence:6,endedAtMs:2000,slots:[{path:'/b',access:'write'}]},
    ];
    const writes = [
        {path:'/a',value:'first',observedAtMs:1000,order:0},
        {path:'/b',value:'other',observedAtMs:2000,order:1},
    ];
    assert.equal(historicalSlotValue([], {type:'state_entered',state:'B',sequence:5}, '/a',writes,skills)?.value,'first');
    assert.equal(historicalSlotValue([], {type:'state_entered',state:'A',sequence:2}, '/b',writes,skills),null);
});

test('rapid consecutive writes cannot be attributed to intervening non-writing skills', async () => {
    const { inferSlotWriteHistory, historicalSlotValue } = await import('./runtimeMemorySlots.js');
    // SSE receive timestamps can be much earlier than the corresponding
    // state-exited message on the separate SCXML stream. The old matcher
    // preferred the nearby Wait#2 for the second write, hiding it at SlotIO#2.
    const writes = [
        {path:'/defaultslot',value:'hello',observedAtMs:1000,order:0},
        {path:'/defaultslot',value:'world',observedAtMs:1001,order:1},
    ];
    const skills = [
        {state:'Wait#1',entrySequence:1,exitSequence:3,endedAtMs:995,slots:[]},
        {state:'slots.SlotIO#1',entrySequence:7,exitSequence:9,endedAtMs:1600,
            slots:[{key:'StringSlot',path:'',access:'write'}]},
        {state:'Wait#middle',entrySequence:10,exitSequence:12,endedAtMs:1000,slots:[]},
        {state:'slots.SlotIO#2',entrySequence:13,exitSequence:15,endedAtMs:1800,slots:[]},
        {state:'Wait#2',entrySequence:16,exitSequence:18,endedAtMs:1001,slots:[]},
    ];
    const assigned = inferSlotWriteHistory(writes, skills, '/defaultslot');
    assert.deepEqual(assigned.map(({value,sourceState})=>[value,sourceState]), [
        ['hello','slots.SlotIO#1'], ['world','slots.SlotIO#2']
    ]);
    const at = (type, state, sequence) => historicalSlotValue([], {type,state,sequence},
        '/defaultslot',writes,skills)?.value;
    assert.equal(at('state_entered','Wait#1',1), undefined);
    assert.equal(at('state_entered','slots.SlotIO#1',7), 'hello');
    assert.equal(at('transition','',10), 'hello');
    assert.equal(at('state_entered','slots.SlotIO#2',13), 'world', 'second write stays recorded');
    assert.equal(at('transition','',16), 'world');
});

test('write-family inference excludes a sibling explicitly bound to another path', async () => {
    const { inferSlotWriteHistory } = await import('./runtimeMemorySlots.js');
    const skills = [
        {state:'slots.SlotIO#1',exitSequence:10,endedAtMs:1000,
            slots:[{path:'/result',access:'write'}]},
        {state:'slots.SlotIO#2',exitSequence:20,endedAtMs:1001,
            slots:[{path:'/other',access:'write'}]},
        {state:'slots.SlotIO#3',exitSequence:30,endedAtMs:1002,slots:[]},
    ];
    const writes = [{path:'/result',value:'first',observedAtMs:1001,order:0},
        {path:'/result',value:'second',observedAtMs:1002,order:1}];
    const linked = inferSlotWriteHistory(writes,skills,'/result');
    assert.deepEqual(linked.map((item)=>item.sourceState), ['slots.SlotIO#1','slots.SlotIO#3']);
});
