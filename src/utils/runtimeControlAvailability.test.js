import assert from "node:assert/strict";
import test from "node:test";
import { runtimeControlAvailability, runtimeBadgeStatus } from "./runtimeControlAvailability.js";
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


test("run badge: before any load, connected engine reports nothing loaded", () => {
    assert.deepEqual(runtimeBadgeStatus({ configuration: "/tmp/config.xml", httpConnected: true, engineStatus: "UNKNOWN" }),
        { label: "Nothing loaded", tone: "neutral" });
});
test("run badge: unsuccessful HTTP load is loaded with errors, even with no messages", () => {
    assert.equal(runtimeBadgeStatus({ configuration: "/tmp/config.xml", httpConnected: true, engineStatus: "UNKNOWN", loadSucceeded: false }).label,
        "Loaded with errors");
});
test("run badge: successful HTTP load shows loaded", () => {
    assert.equal(runtimeBadgeStatus({ configuration: "/tmp/config.xml", httpConnected: true, loadSucceeded: true }).label, "Loaded");
});
test("run badge: engine run and pause override last loading outcome", () => {
    const base = { configuration: "/tmp/config.xml", httpConnected: true, loadSucceeded: false };
    assert.equal(runtimeBadgeStatus({ ...base, engineStatus: "RUNNING" }).label, "Running");
    assert.equal(runtimeBadgeStatus({ ...base, engineStatus: "PAUSED" }).label, "Paused");
});
test("run badge: loading and connection override other statuses", () => {
    const base = { configuration: "/tmp/config.xml", httpConnected: true, loadSucceeded: false };
    assert.equal(runtimeBadgeStatus({ ...base, loading: true }).label, "Loading");
    assert.equal(runtimeBadgeStatus({ ...base, engineStatus: "LOADING" }).label, "Loading");
    assert.equal(runtimeBadgeStatus({ ...base, httpConnected: false }).label, "No connection");
    assert.equal(runtimeBadgeStatus({ ...base, httpConnected: null }).label, "No connection");
});
test("run badge: no config selected takes precedence over an unstarted load", () => {
    assert.equal(runtimeBadgeStatus({ httpConnected: true, engineStatus: "UNKNOWN" }).label, "No config selected");
});
test("run badge: existing engine session can be reported from its HTTP status", () => {
    assert.equal(runtimeBadgeStatus({ configuration: "/tmp/config.xml", httpConnected: true, engineStatus: "INITIALIZED" }).label, "Loaded");
    assert.equal(runtimeBadgeStatus({ configuration: "/tmp/config.xml", httpConnected: true, engineStatus: "INITIALIZED_BUT_WARNINGS" }).label, "Loaded with errors");
});
test("run badge: WebSocket is deliberately not an input", () => {
    const connected = runtimeBadgeStatus({ configuration: "/tmp/config.xml", httpConnected: true, engineStatus: "INITIALIZED", eventConnection: "connected" });
    const offline = runtimeBadgeStatus({ configuration: "/tmp/config.xml", httpConnected: true, engineStatus: "INITIALIZED", eventConnection: "disconnected" });
    assert.deepEqual(connected, offline);
});
