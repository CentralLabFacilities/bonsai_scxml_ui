import test from "node:test";
import assert from "node:assert/strict";
import { runtimeSocketAddresses } from "./runtimeSocketAddresses.js";

test("Tauri and localhost origins use the plain WebCommander ws:// endpoint", () => {
    assert.deepEqual(runtimeSocketAddresses("tauri.localhost"), [
        "ws://localhost:8080/bonsai/events", "ws://127.0.0.1:8080/bonsai/events",
    ]);
    assert.deepEqual(runtimeSocketAddresses("localhost"), [
        "ws://localhost:8080/bonsai/events", "ws://127.0.0.1:8080/bonsai/events",
    ]);
});

test("IPv4 loopback origins prefer IPv4 and fall back to localhost", () => {
    assert.deepEqual(runtimeSocketAddresses("127.0.0.1"), [
        "ws://127.0.0.1:8080/bonsai/events", "ws://localhost:8080/bonsai/events",
    ]);
});
