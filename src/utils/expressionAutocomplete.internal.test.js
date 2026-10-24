import assert from 'node:assert/strict';
import test from 'node:test';
import { getMatchingExpressionVariables } from '../components/inputs/expressionAutocomplete.js';

test('assignment autocomplete excludes only internal state-prefix declaration by default', () => {
    const variables = [
        { id: '#_STATE_PREFIX', expr: "'pkg.'" },
        { id: '#_TIMEOUT', expr: '500' },
        { id: 'attempts', expr: '0' },
    ];
    const result = getMatchingExpressionVariables('@', 1, variables);
    assert.deepEqual(result.matches.map(v => v.id).sort(), ['#_TIMEOUT', 'attempts']);
    assert.deepEqual(getMatchingExpressionVariables('@#_', 3, variables).matches.map(v => v.id), ['#_TIMEOUT']);
    assert.deepEqual(getMatchingExpressionVariables('@attempt', 8, variables).matches.map(v => v.id), ['attempts']);
});
