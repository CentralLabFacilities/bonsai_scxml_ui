import test from 'node:test';
import assert from 'node:assert/strict';
import { appendRuntimeEvent, emptyRuntimeTimeline } from './runtimeEventFrames.js';
import { changesForRuntimeSnapshot, formatRuntimeChangeValue, snapshotVariableValues } from './runtimeSnapshotChanges.js';

const msg = (type, sequence, timestamp, details = {}) => ({ type, sequence, timestamp, details });
const times = (ms) => new Date(Date.parse('2026-10-25T07:00:00.000Z') + ms).toISOString();
const replay = (messages) => messages.reduce((timeline, item) => appendRuntimeEvent(timeline, item), emptyRuntimeTimeline());

test('each SCXML assignment appears once under the completed skill or transition, with its old and new values', () => {
    const timeline = replay([
        msg('datamodel_scope_initialized', 1, times(1), {scope:'global', valuesJson:'{"str":"hello"}'}),
        msg('state_entered', 2, times(2), {state:'Writer#1'}),
        msg('datamodel_assignment', 3, times(3), {scope:'global', location:'str', newValueJson:'"world"', sourceState:'Writer#1'}),
        msg('datamodel_assignment', 4, times(4), {scope:'global', location:'_count', oldValue:'0', oldValueKnown:true, newValueJson:'1', sourceState:'Writer#1'}),
        msg('state_exited', 5, times(5), {state:'Writer#1'}),
        msg('datamodel_assignment', 6, times(6), {scope:'global', location:'str', oldValue:'world', oldValueKnown:true, newValueJson:'"later"'}),
        msg('transition', 7, times(7), {source:'Writer#1', target:'Next#1'}),
        msg('state_entered', 8, times(8), {state:'Next#1'}),
    ]);
    const first = changesForRuntimeSnapshot(timeline, timeline.frames[0]);
    assert.deepEqual(first.map(({name,value}) => [name,value]), [['str','world'],['_count','1']]);
    assert.equal(first[0].previous, 'hello');
    assert.equal(first[1].previous, '0');
    const transition = changesForRuntimeSnapshot(timeline, timeline.frames[1]);
    assert.deepEqual(transition.map(({name,previous,value}) => [name,previous,value]), [['str','world','later']]);
    assert.deepEqual(changesForRuntimeSnapshot(timeline,timeline.frames[2]), []);
    assert.equal(timeline.frames.length, 3, 'no new timeline snapshots');
});

test('two rapid MemorySlot writes remain distinct and follow their writer snapshots', () => {
    const timeline = replay([
        msg('state_entered', 10, times(1), {state:'Wait#1'}),
        msg('state_exited', 11, times(20), {state:'Wait#1'}),
        msg('transition', 12, times(21), {source:'Wait#1',target:'slots.SlotIO#1'}),
        msg('state_entered', 13, times(22), {state:'slots.SlotIO#1'}),
        msg('state_exited', 14, times(24), {state:'slots.SlotIO#1'}),
        msg('transition', 15, times(25), {source:'slots.SlotIO#1',target:'slots.SlotIO#2'}),
        msg('state_entered', 16, times(26), {state:'slots.SlotIO#2'}),
        msg('state_exited', 17, times(28), {state:'slots.SlotIO#2'}),
        msg('transition', 18, times(29), {source:'slots.SlotIO#2',target:'End'}),
    ]);
    const memory = {writes: [
        {path:'/defaultslot',value:'hello',order:0,observedAt:times(26),observedAtMs:Date.parse(times(26))},
        {path:'/defaultslot',value:'world',order:1,observedAt:times(26),observedAtMs:Date.parse(times(26))},
    ], skillExecutions: [
        {state:'Wait#1',entrySequence:10,exitSequence:11,endedAtMs:Date.parse(times(20)),slots:[]},
        {state:'slots.SlotIO#1',entrySequence:13,exitSequence:14,endedAtMs:Date.parse(times(24)),slots:[{path:'/defaultslot',access:'write'}]},
        {state:'slots.SlotIO#2',entrySequence:16,exitSequence:17,endedAtMs:Date.parse(times(28)),slots:[]},
    ],used:{'/defaultslot':'java.lang.String'}};
    assert.deepEqual(changesForRuntimeSnapshot(timeline,timeline.frames[0],memory), []);
    const first = changesForRuntimeSnapshot(timeline,timeline.frames[2],memory);
    const second = changesForRuntimeSnapshot(timeline,timeline.frames[4],memory);
    assert.deepEqual(first.map((c) => [c.previousKnown,c.value,c.sourceState]), [[false,'hello','slots.SlotIO#1']]);
    assert.deepEqual(second.map((c) => [c.previous,c.value,c.sourceState]), [['hello','world','slots.SlotIO#2']]);
    assert.deepEqual(changesForRuntimeSnapshot(timeline,timeline.frames[3],memory), [], 'transition does not duplicate skill write');
    assert.deepEqual(changesForRuntimeSnapshot(timeline,timeline.frames[5],memory), [], 'following transition does not repeat slot write');
});

test('variable assignments and inferred slot writes share one timestamp-sorted list', () => {
    const timeline = replay([
        msg('state_entered', 10, times(10), {state:'Writer#1'}),
        msg('datamodel_assignment', 11, times(40), {scope:'global',location:'text',oldValue:'one',oldValueKnown:true,newValueJson:'"two"'}),
        msg('state_exited', 12, times(50), {state:'Writer#1'}),
    ]);
    const memory = {writes:[{path:'/abc',value:'changed',order:0,observedAt:times(20),observedAtMs:Date.parse(times(20))}],
        skillExecutions:[{state:'Writer#1',entrySequence:10,exitSequence:12,endedAtMs:Date.parse(times(50)),slots:[{path:'/abc',access:'write'}]}]};
    assert.deepEqual(changesForRuntimeSnapshot(timeline,timeline.frames[0],memory).map((item)=>item.kind), ['slot','variable']);
});

test('displays string quotes safely and never fabricates an old value', () => {
    assert.equal(formatRuntimeChangeValue("hello'world", 'java.lang.String'), "'hello\\'world'");
    assert.equal(formatRuntimeChangeValue('world', 'StringSlot'), "'world'");
    assert.equal(formatRuntimeChangeValue('10', 'int'), '10');
    assert.equal(formatRuntimeChangeValue('null', 'StringSlot'), 'null');
    assert.equal(formatRuntimeChangeValue(undefined, 'StringSlot', false), '?');
});

test('two writes by a single skill are both shown in original order', () => {
    const timeline = replay([
        msg('state_entered', 8, times(10), {state:'Writer#1'}),
        msg('state_exited', 9, times(50), {state:'Writer#1'}),
    ]);
    const memory = {writes:[
        {path:'/slot',value:'hello',order:0,observedAt:times(20),observedAtMs:Date.parse(times(20))},
        {path:'/slot',value:'world',order:1,observedAt:times(21),observedAtMs:Date.parse(times(21))},
    ],skillExecutions:[{state:'Writer#1',entrySequence:8,exitSequence:9,endedAtMs:Date.parse(times(50)),slots:[{path:'/slot',access:'write'}]}]};
    const changes = changesForRuntimeSnapshot(timeline,timeline.frames[0],memory);
    assert.deepEqual(changes.map((e) => [e.previous,e.value]), [[undefined,'hello'],['hello','world']]);
});

test('unfinished live skill includes its already received assignments', () => {
    const timeline = replay([
        msg('state_entered', 1, times(1), {state:'Writer#1'}),
        msg('datamodel_assignment', 2, times(2), {scope:'global',location:'str',oldValueKnown:true,oldValue:'hello',newValueJson:'"world"'}),
    ]);
    assert.deepEqual(changesForRuntimeSnapshot(timeline,timeline.frames[0]).map((e) => e.value), ['world']);
});


test('manual advancement lists scope changes even without datamodel_assignment events', () => {
    const timeline = replay([
        msg('state_entered', 10, times(10), {state:'Writer#1'}),
        msg('datamodel_scope_initialized', 11, times(11), {scope:'global', valuesJson:'{"str":"hello","_count":1}'}),
        msg('state_exited', 12, times(15), {state:'Writer#1'}),
        msg('transition', 13, times(16), {source:'Writer#1',target:'Writer#2'}),
        msg('state_entered', 14, times(17), {state:'Writer#2'}),
        msg('datamodel_scope_initialized', 15, times(18), {scope:'global', valuesJson:'{"str":"world","_count":2}'}),
        msg('state_exited', 16, times(19), {state:'Writer#2'}),
    ]);
    const first = changesForRuntimeSnapshot(timeline, timeline.frames[0]);
    const second = changesForRuntimeSnapshot(timeline, timeline.frames[2]);
    assert.deepEqual(first.map(({name,value}) => [name,value]), [['str','hello'],['_count','1']]);
    assert.deepEqual(second.map(({name,previous,value}) => [name,previous,value]),
        [['str','hello','world'],['_count','1','2']]);
    assert.deepEqual(changesForRuntimeSnapshot(timeline, timeline.frames[1]), []);
    assert.deepEqual(Object.fromEntries(Object.entries(snapshotVariableValues(timeline, timeline.frames[2]))
        .map(([name,item]) => [name,item.value])), {str:'world',_count:'2'});
});

test('manual live skill lists new scoped values before it exits', () => {
    const timeline = { ...replay([
        msg('state_entered', 10, times(10), {state:'Writer#1'}),
        msg('datamodel_scope_initialized', 11, times(11), {scope:'global', valuesJson:'{"str":"hello"}'}),
    ]), watching: true };
    assert.equal(snapshotVariableValues(timeline,timeline.frames[0]).str.value, 'hello');
    assert.deepEqual(changesForRuntimeSnapshot(timeline, timeline.frames[0]).map(c=>[c.name,c.value]), [['str','hello']]);
});

test('manual snapshot derives slot change from linked historical values if no write event exists', () => {
    const timeline = replay([
        msg('state_entered', 10, times(1), {state:'Writer#1'}),
        msg('state_exited', 11, times(2), {state:'Writer#1'}),
        msg('transition', 12, times(3), {source:'Writer#1',target:'Writer#2'}),
        msg('state_entered', 13, times(4), {state:'Writer#2'}),
        msg('state_exited', 14, times(5), {state:'Writer#2'}),
    ]);
    const memory = {observations:[
        {state:'Writer#1',kind:'skill-exit',entrySequence:10,sequence:11,observedAt:times(2),cache:[{path:'/slot',status:'available',value:'hello'}]},
        {state:'Writer#2',kind:'skill-exit',entrySequence:13,sequence:14,observedAt:times(5),cache:[{path:'/slot',status:'available',value:'world'}]},
    ]};
    assert.deepEqual(changesForRuntimeSnapshot(timeline,timeline.frames[2],memory).map(c=>[c.previous,c.value]),[['hello','world']]);
    assert.deepEqual(changesForRuntimeSnapshot(timeline,timeline.frames[1],memory), []);
});

test('a recorded assignment is not repeated by inferred value-difference fallback', () => {
    const timeline = replay([
        msg('state_entered', 10, times(1), {state:'Writer#1'}),
        msg('datamodel_assignment', 11, times(2), {scope:'global',location:'str',oldValue:'hello',oldValueKnown:true,newValueJson:'"world"'}),
        msg('state_exited', 12, times(3), {state:'Writer#1'}),
    ]);
    assert.deepEqual(changesForRuntimeSnapshot(timeline,timeline.frames[0]).map(c=>c.value),['world']);
});


test('manual skill exposes scope value initialized just before its state_entered event', () => {
    const timeline = replay([
        msg('state_entered', 20, times(1), {state:'Wait#1'}),
        msg('datamodel_scope_initialized', 21, times(2), {scope:'global', valuesJson:'{"str":"hello"}'}),
        msg('state_exited', 22, times(3), {state:'Wait#1'}),
        msg('transition', 23, times(4), {source:'Wait#1',target:'Writer#1'}),
        msg('datamodel_scope_initialized', 24, times(5), {scope:'global', valuesJson:'{"str":"world"}'}),
        msg('state_entered', 25, times(6), {state:'Writer#1'}),
        msg('state_exited', 26, times(7), {state:'Writer#1'}),
    ]);
    assert.deepEqual(changesForRuntimeSnapshot(timeline,timeline.frames[2])
        .map(({name,previous,value})=>[name,previous,value]),[['str','hello','world']]);
});

test('a current manually-stepped skill shows its slot write before state_exited arrives', () => {
    const timeline = {...replay([
        msg('state_entered', 31, times(30), {state:'slots.Writer#1'}),
    ]), watching: true};
    const memory = {writes:[
        {path:'/slot', value:'hello', order:0, observedAt:times(32), observedAtMs:Date.parse(times(32))},
    ], skillExecutions:[]};
    assert.deepEqual(changesForRuntimeSnapshot(timeline, timeline.frames[0], memory)
        .map(({kind,previousKnown,value}) => [kind,previousKnown,value]), [['slot',false,'hello']]);
});

test('active manually-stepped skill shows both writes with the correct previous value', () => {
    const timeline = {...replay([
        msg('state_entered', 30, times(30), {state:'slots.Writer#1'}),
    ]), watching: true};
    const memory = {writes:[
        {path:'/slot', value:'hello', order:0, observedAt:times(32), observedAtMs:Date.parse(times(32))},
        {path:'/slot', value:'world', order:1, observedAt:times(33), observedAtMs:Date.parse(times(33))},
    ], skillExecutions:[]};
    assert.deepEqual(changesForRuntimeSnapshot(timeline, timeline.frames[0], memory)
        .map(({previous,previousKnown,value}) => [previous,previousKnown,value]),
        [[undefined,false,'hello'], ['hello',true,'world']]);
});

test('current live skill displays writes despite previous completed writer attracting inferred attribution', () => {
    const timeline = {...replay([
        msg('state_entered', 11, times(10), {state:'slots.Writer#1'}),
        msg('state_exited', 12, times(12), {state:'slots.Writer#1'}),
        msg('transition', 13, times(20), {source:'slots.Writer#1',target:'slots.Writer#2'}),
        msg('state_entered', 14, times(30), {state:'slots.Writer#2'}),
    ]), watching: true};
    const memory = {writes:[
        {path:'/slot', value:'hello', order:0, observedAt:times(11), observedAtMs:Date.parse(times(11))},
        {path:'/slot', value:'world', order:1, observedAt:times(31), observedAtMs:Date.parse(times(31))},
    ], skillExecutions:[{state:'slots.Writer#1',entrySequence:11,exitSequence:12,
        endedAtMs:Date.parse(times(12)), slots:[{path:'/slot',access:'write'}]}]};
    assert.deepEqual(changesForRuntimeSnapshot(timeline, timeline.frames[2], memory)
        .map(({previous,value}) => [previous,value]), [['hello','world']]);
});

test('live tail assignments after skill exit are visible before a new snapshot is emitted', () => {
    const timeline = {...replay([
        msg('state_entered', 10, times(10), {state:'Writer#1'}),
        msg('state_exited', 11, times(12), {state:'Writer#1'}),
        msg('datamodel_assignment', 12, times(14), {scope:'global',location:'str',oldValue:'hello',oldValueKnown:true,newValueJson:'"world"'}),
    ]), watching: true};
    assert.deepEqual(changesForRuntimeSnapshot(timeline, timeline.frames[0])
        .map(({previous,value}) => [previous,value]), [['hello','world']]);
});

test('historical inspection does not show subsequent pending SSE writes as earlier snapshot changes', () => {
    const timeline = {...replay([
        msg('state_entered', 10, times(10), {state:'Writer#1'}),
    ]), watching:false};
    const memory = {writes:[{path:'/slot',value:'world',order:0, observedAt:times(15),observedAtMs:Date.parse(times(15))}],skillExecutions:[]};
    assert.deepEqual(changesForRuntimeSnapshot(timeline, timeline.frames[0], memory), []);
});

test('live writing skill accepts an SSE event delivered just before its entry message', () => {
    const timeline = {...replay([msg('state_entered', 40, times(40), {state:'slots.Writer#1'})]), watching:true};
    const memory = {writes:[
        {path:'/slot',value:'hello',order:0,observedAt:times(35),observedAtMs:Date.parse(times(35))},
    ],skillExecutions:[]};
    assert.deepEqual(changesForRuntimeSnapshot(timeline, timeline.frames[0], memory), [],
        'without a declared writer, an earlier event cannot be assumed to belong to this skill');
    assert.deepEqual(changesForRuntimeSnapshot(timeline, timeline.frames[0], memory, {writerPaths:['/slot']})
        .map(({value,provisional})=>[value,provisional]),[['hello',true]]);
});

test('after skill exit a write appears exactly once through historical attribution', () => {
    const timeline = {...replay([
        msg('state_entered', 20, times(10), {state:'slots.Writer#1'}),
        msg('state_exited', 22, times(40), {state:'slots.Writer#1'}),
    ]), watching:true};
    const memory = {writes:[
        {path:'/slot',value:'hello',order:0,observedAt:times(20),observedAtMs:Date.parse(times(20))},
    ],skillExecutions:[{state:'slots.Writer#1',entrySequence:20,exitSequence:22,
        endedAtMs:Date.parse(times(40)),slots:[{path:'/slot',access:'write'}]}]};
    const changes = changesForRuntimeSnapshot(timeline, timeline.frames[0], memory, {writerPaths:['/slot']});
    assert.deepEqual(changes.map(({value})=>value),['hello']);
    assert.equal(changes[0].provisional, undefined, 'the completed skill uses stable historical attribution');
});

test('live scope initialization after exit shows immediately while historical values remain frozen', () => {
    const timeline = {...replay([
        msg('state_entered', 10, times(10), {state:'Writer#1'}),
        msg('datamodel_scope_initialized', 11, times(11), {scope:'global',valuesJson:'{"str":"hello"}'}),
        msg('state_exited', 12, times(12), {state:'Writer#1'}),
        msg('datamodel_scope_initialized', 13, times(13), {scope:'global',valuesJson:'{"str":"world"}'}),
    ]), watching:true};
    assert.equal(snapshotVariableValues(timeline, timeline.frames[0]).str.value, 'world');
    assert.deepEqual(changesForRuntimeSnapshot(timeline, timeline.frames[0]).map(({value})=>value),['world']);
    const historical = {...timeline,watching:false};
    assert.equal(snapshotVariableValues(historical,historical.frames[0]).str.value,'hello');
});
