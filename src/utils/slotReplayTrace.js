/** Temporary runtime MemorySlot diagnostics (UI only).
 * Writes one JSON string per event so Safari/WebKit does not collapse the
 * interesting fields into unexpandable `Object` entries. No network or disk IO.
 * Remove this module after the root cause has been identified. */
const MAX_ENTRIES = 300;
const lastSignature = new Map();

export const summarizeSlot = (entry) => entry ? ({
    path: String(entry.path || ""), status: String(entry.status || ""),
    value: entry.value == null ? null : String(entry.value).slice(0, 200),
    type: String(entry.type || ""), source: entry.observationSource || "",
    observedAt: entry.observedAt || "", stale: Boolean(entry.stale),
    inferred: Boolean(entry.inferred), sourceState: String(entry.sourceState || ""),
    assignedSequence: entry.assignedSequence ?? null,
}) : null;

export function traceSlot(stage, fields = {}, signature = null) {
    if (typeof window === "undefined") return;
    if (signature !== null && lastSignature.get(stage) === signature) return;
    if (signature !== null) lastSignature.set(stage, signature);
    const row = { time: new Date().toISOString(), stage, ...fields };
    const entries = window.__BONSAI_SLOT_TRACE__ || (window.__BONSAI_SLOT_TRACE__ = []);
    entries.push(row);
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
    // Serializing *before* console.log is crucial for the WebKit inspector.
    console.info(`[Bonsai slot debug] ${JSON.stringify(row)}`);
}
