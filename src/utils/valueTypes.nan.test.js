import test from 'node:test';
import assert from 'node:assert/strict';
import {
    VALUE_TYPES, inferLiteralValueType, getVariableType,
    normalizeDatamodelValue, normalizeTypedValue,
} from './valueTypes.js';
import { validateAssignmentExpression } from './assignmentExpressions.js';

test('NaN is a Double literal, never automatically quoted as a String', () => {
    assert.equal(inferLiteralValueType('NaN'), VALUE_TYPES.DOUBLE);
    assert.equal(inferLiteralValueType('NaNExtra'), VALUE_TYPES.STRING);
    assert.equal(inferLiteralValueType("'NaN'"), VALUE_TYPES.STRING);
    assert.equal(normalizeDatamodelValue(' NaN '), 'NaN');
    assert.equal(getVariableType({ id: 'default', expr: 'NaN' }), VALUE_TYPES.DOUBLE);
});

test('NaN can be assigned to Double, but not to Integer or String', () => {
    assert.equal(normalizeTypedValue('NaN', VALUE_TYPES.DOUBLE).valid, true);
    assert.equal(normalizeTypedValue('NaN', VALUE_TYPES.INTEGER).valid, false);
    assert.equal(normalizeTypedValue('NaN', VALUE_TYPES.STRING).valid, false);
    assert.equal(validateAssignmentExpression('NaN', { id: 'x', type: 'Double' }).valid, true);
});
