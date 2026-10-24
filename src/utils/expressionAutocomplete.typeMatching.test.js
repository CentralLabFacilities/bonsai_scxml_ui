import assert from 'node:assert/strict';
import test from 'node:test';
import { getMatchingExpressionVariables } from '../components/inputs/expressionAutocomplete.js';

const vars = [
    { id: 'count', expr: '3' },
    { id: '#_TIMEOUT', expr: '500' },
    { id: 'ratio', expr: '0.5' },
    { id: 'invalidNumber', expr: 'NaN' },
    { id: 'ready', expr: 'true' },
    { id: 'message', expr: "'hello'" },
    { id: '#_STATE_PREFIX', expr: "'pkg.'" },
];

const suggestions = (expression, target, extra = {}) =>
    getMatchingExpressionVariables(expression, expression.length, vars, {
        targetVariable: target,
        requireCompatibleType: true,
        ...extra,
    }).matches.map(variable => variable.id);

test('Integer assignments offer only Integer references, including # parameters', () => {
    assert.deepEqual(suggestions('@', { id: 'destination', type: 'Integer' }), ['#_TIMEOUT', 'count']);
});

test('Double assignments accept both Integer and Double, including NaN defaults', () => {
    assert.deepEqual(suggestions('@', { id: 'destination', type: 'Double' }), [
        '#_TIMEOUT', 'count', 'invalidNumber', 'ratio',
    ]);
});

test('Boolean and String assignments expose their own scalar type only', () => {
    assert.deepEqual(suggestions('@', { id: 'destination', type: 'Boolean' }), ['ready']);
    assert.deepEqual(suggestions('@', { id: 'destination', type: 'String' }), ['message']);
});

test('numeric operands remain valid in Boolean comparison expressions', () => {
    assert.deepEqual(suggestions('@count > @', { id: 'destination', type: 'Boolean' }), [
        '#_TIMEOUT', 'count', 'invalidNumber', 'ratio',
    ]);
    assert.deepEqual(suggestions('@message == @', { id: 'destination', type: 'Boolean' }), ['message']);
});

test('numeric operators reject string and Boolean references', () => {
    assert.deepEqual(suggestions('@count + @', { id: 'destination', type: 'Integer' }), [
        '#_TIMEOUT', 'count',
    ]);
});

test('unselected target does not advertise every type as a valid completion', () => {
    assert.deepEqual(suggestions('@', null), []);
});

test('search order and internal #_STATE_PREFIX exclusion remain intact', () => {
    assert.deepEqual(suggestions('@ra', { id: 'destination', type: 'Double' }), ['ratio']);
    assert.deepEqual(suggestions('@#_', { id: 'destination', type: 'Integer' }), ['#_TIMEOUT']);
});
