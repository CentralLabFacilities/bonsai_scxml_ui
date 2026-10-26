/** The WebCommander runtime endpoint is plain ws:// on loopback.
 * Do not infer its protocol from the UI's own origin (Tauri may use HTTPS).
 * Fall back between the two loopback names: Java often binds to only one. */
export function runtimeSocketAddresses(hostname = "") {
    const preferred = hostname === "127.0.0.1" ? "127.0.0.1" : "localhost";
    const alternative = preferred === "localhost" ? "127.0.0.1" : "localhost";
    return [preferred, alternative].map((host) => `ws://${host}:8080/bonsai/events`);
}
