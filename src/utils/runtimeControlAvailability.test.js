import assert from "node:assert/strict";
import test from "node:test";
import { runtimeControlAvailability } from "./runtimeControlAvailability.js";
const ready = { configuration: "/tmp/config.xml", status: "INITIALIZED", loadedCurrent: true, eventConnection: "connected" };
test("ready engine enables load and start", () => {
    const result = runtimeControlAvailability(ready);
    assert.equal(result.canLoad, true);
    assert.equal(result.canStart, true);
});
test("offline event socket leaves load possible via HTTP but disables start with explanation", () => {
    const result = runtimeControlAvailability({ ...ready, eventConnection: "reconnecting" });
    assert.equal(result.canLoad, true);
    assert.match(result.startReason, /connection.*offline/i);
});
test("stale running status blocks load until engine is rechecked", () => {
    const result = runtimeControlAvailability({ ...ready, status: "RUNNING", statusStale: true });
    assert.equal(result.canLoad, false);
    assert.match(result.loadReason, /last known/i);
});
test("disconnected engine has useful reasons for both controls", () => {
    const result = runtimeControlAvailability({ ...ready, status: null, eventConnection: "reconnecting" });
    assert.equal(result.canLoad, false);
    assert.equal(result.canStart, false);
    assert.match(result.loadReason, /port 8080/i);
});
test("start requires current loaded workflow", () => {
    const result = runtimeControlAvailability({ ...ready, loadedCurrent: false });
    assert.equal(result.canLoad, true);
    assert.equal(result.canStart, false);
    assert.match(result.startReason, /Load the current version/i);
});
test("running backend gives reason why load and start are disabled", () => {
    const result = runtimeControlAvailability({ ...ready, status: "RUNNING" });
    assert.match(result.loadReason, /Stop/i);
    assert.match(result.startReason, /already running/i);
});
