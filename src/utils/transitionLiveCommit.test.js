import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareLiveTransitionCommit } from './transitionLiveCommit.js';
const vars = [{id:'attempts',expr:'0'}];
const base = {transitionId:'t1',event:'success',target:'old',conditionEnabled:false,conditionVariable:'attempts',conditionOperator:'==',conditionValue:'',assignments:[]};
const run = (draft,committed=[base],activeId='t1',kind='target',assignmentId=null) => prepareLiveTransitionCommit({draft,committed,variables:vars,activeId,kind,assignmentId});
test('target change does not prematurely commit an unfinished condition',()=>{
 const next={...base,target:'new',conditionEnabled:true,conditionValue:''};
 assert.equal(run([next])[0].target,'new');
 assert.equal(run([next])[0].conditionEnabled,false);
});
test('Enter on condition commits a complete condition',()=>{
 const next={...base,conditionEnabled:true,conditionValue:'3'};
 assert.equal(run([next],[base],'t1','condition')[0].conditionValue,'3');
});
test('pending new rows do not prevent existing target updates',()=>{
 assert.equal(run([{...base,target:'new'},{...base,transitionId:'t2',target:''}]).length,1);
});
test('unfinished assignment does not overwrite previously committed assignments',()=>{
 const committed={...base,assignments:[{assignmentId:'a1',location:'attempts',expr:'1'}]};
 const next={...committed,target:'new',assignments:[{assignmentId:'a1',location:'attempts',expr:''}]};
 assert.deepEqual(run([next],[committed])[0].assignments,committed.assignments);
});
test('assignment Enter commits only that assignment, even with another unfinished assignment',()=>{
 const a1={assignmentId:'a1',location:'attempts',expr:'2'};
 const a2={assignmentId:'a2',location:'attempts',expr:''};
 const next={...base,assignments:[a1,a2]};
 assert.deepEqual(run([next],[base],'t1','assignment','a1')[0].assignments,[a1]);
});
test('assignment Enter preserves other existing assignments without committing their unsubmitted edits',()=>{
 const original={assignmentId:'a1',location:'attempts',expr:'1'};
 const updated={assignmentId:'a2',location:'attempts',expr:'2'};
 const saved={...base,assignments:[original,{...updated,expr:'0'}]};
 const next={...saved,assignments:[{...original,expr:'unfinished'},updated]};
 assert.deepEqual(run([next],[saved],'t1','assignment','a2')[0].assignments,[original,updated]);
});
test('deleting an assignment publishes the deletion but keeps unrelated valid assignments',()=>{
 const a1={assignmentId:'a1',location:'attempts',expr:'1'};
 const a2={assignmentId:'a2',location:'attempts',expr:'2'};
 const saved={...base,assignments:[a1,a2]};
 assert.deepEqual(run([{...base,assignments:[a2]}],[saved],'t1','assignment-delete')[0].assignments,[a2]);
});
test('target selection publishes a new edge with previously entered valid condition and assignment',()=>{
 const fresh={...base,transitionId:'t3',edgeId:'edge-t3',target:'new',conditionEnabled:true,conditionValue:'1',assignments:[{assignmentId:'a1',location:'attempts',expr:'1'}]};
 const result=run([fresh],[], 't3', 'target');
 assert.equal(result[0].edgeId,'edge-t3');
 assert.equal(result[0].conditionEnabled,true);
 assert.equal(result[0].conditionValue,'1');
 assert.deepEqual(result[0].assignments,fresh.assignments);
});
test('target selection on a new transition keeps incomplete expressions out of SCXML',()=>{
 const newDraft={...base,transitionId:'t4',target:'new',conditionEnabled:true,conditionValue:'',assignments:[
   {assignmentId:'valid',location:'attempts',expr:'2'},
   {assignmentId:'unfinished',location:'attempts',expr:''},
 ]};
 const result=run([newDraft],[], 't4','target');
 assert.equal(result[0].conditionEnabled,false);
 assert.deepEqual(result[0].assignments,[newDraft.assignments[0]]);
});
