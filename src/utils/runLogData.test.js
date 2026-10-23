import test from 'node:test';
import assert from 'node:assert/strict';
import {
    parseRunLogMessage, appendRunLogs, filterRunLogs, flattenRunLogLines,
    formatRunLogTimestamp, runLogRetryDelay, RUN_LOG_LIMIT, RUN_LOG_URL,
} from './runLogData.js';

test('parses the server log protocol with epoch milliseconds and nullable stack trace', () => {
    const entry = parseRunLogMessage(JSON.stringify({
        timestamp: 1792670400000, level: 'INFO',
        logger: 'de.unibi.citec.clf.bonsai.engine.SCXMLStarter',
        message: 'State machine started', stackTrace: null,
    }));
    assert.equal(entry.timestamp, 1792670400000);
    assert.equal(entry.level, 'INFO');
    assert.equal(entry.message, 'State machine started');
    assert.equal(entry.stackTrace, '');
    assert.match(formatRunLogTimestamp(entry.timestamp), /^\d\d:\d\d:\d\d\.\d{3}$/);
    assert.equal(RUN_LOG_URL, 'ws://127.0.0.1:8765/bonsai/logs');
});

test('malformed messages are ignored rather than crashing the stream', () => {
    assert.equal(parseRunLogMessage('hello'), null);
    assert.equal(parseRunLogMessage('[]'), null);
    assert.equal(parseRunLogMessage('{"timestamp":1}'), null);
    assert.equal(parseRunLogMessage(null), null);
});

test('stack traces and multiline messages produce searchable, independent console lines', () => {
    const entry = { ...parseRunLogMessage({ timestamp: 1, level: 'ERROR', logger: 'Engine',
        message: 'Runtime failed\nReason follows', stackTrace: 'java.lang.Exception\n\tat Test.java:10' }), id: 7 };
    const lines = flattenRunLogLines([entry]);
    assert.equal(lines.length, 4);
    assert.equal(lines[0].level, 'ERROR');
    assert.equal(lines[0].logger, 'Engine');
    assert.equal(lines[3].text, '\tat Test.java:10');
    assert.deepEqual(filterRunLogs([entry], { query: 'Test.java' }), [entry]);
    assert.deepEqual(filterRunLogs([entry], { level: 'WARN' }), []);
});

test('buffer remains bounded, preserving ordering during many batches', () => {
    const first = Array.from({ length: RUN_LOG_LIMIT }, (_, index) => ({ id: index + 1 }));
    const next = appendRunLogs(first, Array.from({ length: 250 }, (_, index) => ({ id: RUN_LOG_LIMIT + index + 1 })));
    assert.equal(next.length, RUN_LOG_LIMIT);
    assert.equal(next[0].id, 251);
    assert.equal(next[next.length - 1].id, 5250);
    assert.equal(first.length, RUN_LOG_LIMIT);
    assert.equal(appendRunLogs(first, []), first);
});

test('pause filters by sequence while incoming messages can continue buffering', () => {
    const entries = [1, 2, 3].map((id) => ({ id, level: 'INFO', message: String(id), logger: '', stackTrace: '' }));
    assert.deepEqual(filterRunLogs(entries, { pausedThrough: 2 }).map((entry) => entry.id), [1, 2]);
    assert.deepEqual(filterRunLogs(entries).map((entry) => entry.id), [1, 2, 3]);
});

test('reconnect uses capped exponential backoff', () => {
    assert.equal(runLogRetryDelay(0), 400);
    assert.equal(runLogRetryDelay(1), 800);
    assert.equal(runLogRetryDelay(100), 5000);
});
