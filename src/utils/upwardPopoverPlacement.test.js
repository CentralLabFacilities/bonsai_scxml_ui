import test from "node:test";
import assert from "node:assert/strict";
import { getUpwardPopoverPosition } from "./upwardPopoverPlacement.js";

test("assignment autocomplete opens above the input without extending below the viewport", () => {
    const rect = { left: 250, top: 630, bottom: 659, width: 280 };
    const position = getUpwardPopoverPosition(rect, 1024, 768);
    assert.equal(position.position, "fixed");
    assert.equal(position.bottom, 143);
    assert.equal(position.maxHeight, 180);
    assert.equal(position.left, 250);
    assert.equal(position.width, 280);
});

test("constrains upward suggestions to the available viewport space", () => {
    const position = getUpwardPopoverPosition({left: 700, top: 85, bottom: 115, width: 300}, 800, 600);
    assert.equal(position.left, 492);
    assert.equal(position.maxHeight, 72);
    assert.equal(position.bottom, 520);
});

test("returns no visible popup when the input is offscreen or has no upward space", () => {
    assert.equal(getUpwardPopoverPosition({left: 20, top: 16, bottom: 40, width: 300}, 800, 600), null);
    assert.equal(getUpwardPopoverPosition({left: 20, top: 900, bottom: 930, width: 300}, 800, 600), null);
});
