import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { subscribeBonsaiEvents } from '../src/tauri-client.js';

function nativeEnvironment(context, allocate = async () => 42) {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const callbacks = new Map();
    const calls = [];
    let channel;
    let index = 0;
    let ackError;
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {
        __TAURI_INTERNALS__: {
            transformCallback(callback) { callbacks.set(1, callback); return 1; },
            unregisterCallback(id) { callbacks.delete(id); },
            async invoke(command, args) {
                calls.push({ command, args });
                if (command === 'subscribe_bonsai_events') {
                    channel = args.onEvent;
                    return allocate(channel);
                }
                if (command === 'ack_bonsai_events') {
                    if (ackError) throw ackError;
                    return;
                }
                assert.equal(command, 'cancel_bonsai_events');
            },
        },
    } });
    context.after(() => {
        if (original) Object.defineProperty(globalThis, 'window', original);
        else delete globalThis.window;
    });
    return {
        calls, callbacks,
        emit(event) { callbacks.get(channel.id)?.({ index: index++, message: event }); },
        end() { callbacks.get(channel.id)?.({ index, end: true }); },
        failAck(error) { ackError = error; },
    };
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

test('native subscription rejects outside desktop mode', async (context) => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
    delete globalThis.window;
    context.after(() => {
        if (original) Object.defineProperty(globalThis, 'window', original);
    });
    await assert.rejects(subscribeBonsaiEvents(), /only available in the Tauri app/);
});

test('already aborted subscriptions do not allocate channels or invoke native commands', async (context) => {
    const native = nativeEnvironment(context);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(subscribeBonsaiEvents({ signal: controller.signal }), { name: 'AbortError' });
    assert.equal(native.calls.length, 0);
    assert.equal(native.callbacks.size, 0);
});

test('allocation does not imply connection; raw data is forwarded and acknowledged', async (context) => {
    const native = nativeEnvironment(context);
    const messages = [];
    let settled = false;
    const pending = subscribeBonsaiEvents({ onMessage: (data) => messages.push(data) });
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(settled, false);
    native.emit({ type: 'connected' });
    const close = await pending;
    const raw = '{"type":"snapshot","details":{"status":"RUNNING"}}\nnot parsed';
    native.emit({ type: 'message', data: raw });
    assert.deepEqual(messages, [raw]);
    assert.deepEqual(native.calls.map(({ command }) => command), ['subscribe_bonsai_events', 'ack_bonsai_events']);
    assert.deepEqual(native.calls[1].args, { streamId: 42 });
    close(); close();
    native.emit({ type: 'message', data: 'late' });
    assert.deepEqual(messages, [raw]);
    assert.equal(native.calls.filter(({ command }) => command === 'cancel_bonsai_events').length, 1);
    native.end();
    assert.equal(native.callbacks.size, 0);
});

test('connection and first message can arrive before the allocation response', async (context) => {
    const allocation = deferred();
    const native = nativeEnvironment(context, () => allocation.promise);
    const messages = [];
    let settled = false;
    const pending = subscribeBonsaiEvents({ onMessage: (data) => messages.push(data) });
    void pending.then(() => { settled = true; });
    native.emit({ type: 'connected' });
    native.emit({ type: 'message', data: 'first' });
    await Promise.resolve();
    assert.equal(settled, false);
    assert.deepEqual(messages, ['first']);
    assert.equal(native.calls.length, 1);
    allocation.resolve(12);
    const close = await pending;
    assert.deepEqual(native.calls[1], { command: 'ack_bonsai_events', args: { streamId: 12 } });
    close(); native.end();
});

test('abort rejects immediately while allocation is pending and cancels once its ID arrives', async (context) => {
    const allocation = deferred();
    const native = nativeEnvironment(context, () => allocation.promise);
    const controller = new AbortController();
    const errors = [];
    const pending = subscribeBonsaiEvents({ signal: controller.signal, onError: (error) => errors.push(error) });
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    native.emit({ type: 'connected' });
    native.emit({ type: 'error', message: 'late error' });
    allocation.resolve(9);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(native.calls[1], { command: 'cancel_bonsai_events', args: { streamId: 9 } });
    assert.deepEqual(errors, []);
    native.end();
});

test('abort cancels a pending HTTP connection without reporting an error', async (context) => {
    const native = nativeEnvironment(context);
    const controller = new AbortController();
    const errors = [];
    const pending = subscribeBonsaiEvents({ signal: controller.signal, onError: (error) => errors.push(error) });
    await Promise.resolve(); await Promise.resolve();
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    native.emit({ type: 'connected' });
    native.emit({ type: 'error', message: 'late error' });
    assert.deepEqual(errors, []);
    assert.deepEqual(native.calls[1], { command: 'cancel_bonsai_events', args: { streamId: 42 } });
    native.end();
});

test('abort of a connected stream fences messages and errors and cleans up once', async (context) => {
    const native = nativeEnvironment(context);
    const controller = new AbortController();
    const messages = [];
    const errors = [];
    const pending = subscribeBonsaiEvents({ signal: controller.signal,
        onMessage: (data) => messages.push(data), onError: (error) => errors.push(error) });
    native.emit({ type: 'connected' });
    const close = await pending;
    controller.abort(); close();
    native.emit({ type: 'message', data: 'stale' });
    native.emit({ type: 'error', message: 'stale error' });
    assert.deepEqual(messages, []);
    assert.deepEqual(errors, []);
    assert.equal(native.calls.filter(({ command }) => command === 'cancel_bonsai_events').length, 1);
    native.end();
});

test('failed header validation reports an Error and rejects connection readiness', async (context) => {
    const native = nativeEnvironment(context);
    const errors = [];
    const pending = subscribeBonsaiEvents({ onError: (error) => errors.push(error) });
    native.emit({ type: 'error', message: 'Bonsai events returned HTTP 503' });
    await assert.rejects(pending, /HTTP 503/);
    assert.equal(errors.length, 1);
    assert.ok(errors[0] instanceof Error);
    await Promise.resolve();
    assert.equal(native.calls[1].command, 'cancel_bonsai_events');
    native.end();
});

test('stream errors after connection report once and cancel without further delivery', async (context) => {
    const native = nativeEnvironment(context);
    const errors = [];
    const messages = [];
    const pending = subscribeBonsaiEvents({ onMessage: (data) => messages.push(data), onError: (error) => errors.push(error) });
    native.emit({ type: 'connected' });
    await pending;
    native.emit({ type: 'error', message: 'Bonsai event stream closed unexpectedly' });
    native.emit({ type: 'error', message: 'duplicate' });
    native.emit({ type: 'message', data: 'late' });
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /closed unexpectedly/);
    assert.deepEqual(messages, []);
    native.end();
});

test('invoke failures clean up unowned callbacks and preserve error diagnostics', async (context) => {
    const native = nativeEnvironment(context, async () => { throw 'IPC unavailable'; });
    const errors = [];
    await assert.rejects(subscribeBonsaiEvents({ onError: (error) => errors.push(error) }), /IPC unavailable/);
    assert.equal(errors.length, 1);
    assert.equal(native.callbacks.size, 0);
    assert.equal(native.calls.length, 1);
});

test('consumer callback exceptions cannot break channel ordering or retain the stream', async (context) => {
    const native = nativeEnvironment(context);
    const pending = subscribeBonsaiEvents({
        onMessage() { throw new Error('invalid consumer event'); },
        onError() { throw new Error('consumer error callback failed'); },
    });
    native.emit({ type: 'connected' });
    await pending;
    assert.doesNotThrow(() => native.emit({ type: 'message', data: 'opaque' }));
    assert.deepEqual(native.calls.map(({ command }) => command), ['subscribe_bonsai_events', 'cancel_bonsai_events']);
    native.end();
    assert.equal(native.callbacks.size, 0);
});

test('acknowledgement failures surface as transport failures instead of hanging the stream', async (context) => {
    const native = nativeEnvironment(context);
    const errors = [];
    const pending = subscribeBonsaiEvents({ onError: (error) => errors.push(error) });
    native.emit({ type: 'connected' });
    await pending;
    native.failAck(new Error('ACK IPC failed'));
    native.emit({ type: 'message', data: 'raw' });
    await nextTurn();
    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, 'ACK IPC failed');
    assert.equal(native.calls[2].command, 'cancel_bonsai_events');
    native.end();
});
