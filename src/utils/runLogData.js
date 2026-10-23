/** Log stream values are deliberately independent of SCXML runtime events. */
export const RUN_LOG_URL = 'ws://127.0.0.1:8765/bonsai/logs';
export const RUN_LOG_LIMIT = 5000;
export const RUN_LOG_ROW_HEIGHT = 23;

export function parseRunLogMessage(raw) {
    let value;
    try { value = typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch { return null; }
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || typeof value.message !== 'string') return null;
    const timestamp = Number(value.timestamp);
    const stackTrace = Array.isArray(value.stackTrace)
        ? value.stackTrace.map(String).join('\n')
        : typeof value.stackTrace === 'string' ? value.stackTrace : '';
    return {
        timestamp: Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null,
        level: String(value.level || 'INFO').toUpperCase(),
        logger: String(value.logger || ''),
        message: value.message,
        stackTrace,
    };
}

export function appendRunLogs(current, incoming, limit = RUN_LOG_LIMIT) {
    if (!incoming.length) return current;
    const next = current.concat(incoming);
    return next.length <= limit ? next : next.slice(-limit);
}

export function formatRunLogTimestamp(timestamp) {
    if (timestamp === null || !Number.isFinite(timestamp)) return '--:--:--.---';
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return '--:--:--.---';
    return [date.getHours(), date.getMinutes(), date.getSeconds()]
        .map((number) => String(number).padStart(2, '0')).join(':')
        + '.' + String(date.getMilliseconds()).padStart(3, '0');
}

export function filterRunLogs(entries, { level = 'ALL', query = '', pausedThrough = null } = {}) {
    const term = query.trim().toLowerCase();
    return entries.filter((entry) => (pausedThrough === null || entry.id <= pausedThrough)
        && (level === 'ALL' || entry.level === level)
        && (!term || [entry.level, entry.logger, entry.message, entry.stackTrace]
            .some((part) => part.toLowerCase().includes(term))));
}

/** Each stack trace line is its own fixed-height virtual row. */
export function flattenRunLogLines(entries) {
    const rows = [];
    for (const entry of entries) {
        const messageLines = entry.message.split(/\r?\n/);
        messageLines.forEach((line, index) => rows.push({
            key: `${entry.id}:m${index}`, level: entry.level, logger: index === 0 ? entry.logger : '',
            time: index === 0 ? formatRunLogTimestamp(entry.timestamp) : '',
            text: line, extra: index > 0,
        }));
        if (entry.stackTrace) {
            entry.stackTrace.split(/\r?\n/).forEach((line, index) => rows.push({
                key: `${entry.id}:s${index}`, level: entry.level, logger: '', time: '', text: line, extra: true,
            }));
        }
    }
    return rows;
}

export function runLogRetryDelay(attempt) {
    return Math.min(5000, 400 * 2 ** Math.min(attempt, 4));
}
