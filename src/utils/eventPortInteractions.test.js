import test from "node:test";
import assert from "node:assert/strict";
import { eventDoubleClickHandlers } from "./eventPortInteractions.js";

const syntheticEvent = (key) => {
    const calls = [];
    return {
        key, calls,
        stopPropagation: () => calls.push("stop"),
        preventDefault: () => calls.push("prevent"),
    };
};

test("single click on skill event never opens transition editor", () => {
    let activations = 0;
    const handlers = eventDoubleClickHandlers(() => { activations += 1; });
    handlers.onMouseDown(syntheticEvent());
    const click = syntheticEvent();
    handlers.onClick(click);
    assert.deepEqual(click.calls, ["stop"]);
    assert.equal(activations, 0);
    assert.equal(handlers.role, "button");
    assert.equal(handlers.tabIndex, 0);
});

test("double click and keyboard activation open exactly once without bubbling", () => {
    let activations = 0;
    const handlers = eventDoubleClickHandlers(() => { activations += 1; });
    const dblClick = syntheticEvent();
    handlers.onDoubleClick(dblClick);
    assert.deepEqual(dblClick.calls, ["prevent", "stop"]);
    assert.equal(activations, 1);
    for (const key of ["Enter", " "]) {
        handlers.onKeyDown(syntheticEvent(key));
    }
    handlers.onKeyDown(syntheticEvent("Escape"));
    assert.equal(activations, 3);
});
