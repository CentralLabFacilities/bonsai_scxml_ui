import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FiChevronDown, FiChevronRight, FiChevronUp, FiCopy, FiPause, FiPlay, FiSearch, FiTrash2, FiX } from 'react-icons/fi';
import { useRunLogSocket } from '../../hooks/editor/useRunLogSocket.js';
import { filterRunLogs, flattenRunLogLines, RUN_LOG_ROW_HEIGHT } from '../../utils/runLogData.js';
import './RunLogPanel.css';

const LEVELS = ['ALL', 'TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];
const readHeight = () => {
    try {
        const saved = Number(localStorage.getItem('bonsai:runLogHeight'));
        return Number.isFinite(saved) && saved >= 120 && saved <= 800 ? saved : 245;
    } catch { return 245; }
};

/** Rendered outside the canvas and memoized; socket messages never rerender App/React Flow. */
const RunLogPanel = memo(function RunLogPanel({ session }) {
    const { logs, status, connectionIssue, clear } = useRunLogSocket(session);
    const [expanded, setExpanded] = useState(false);
    const [height, setHeight] = useState(readHeight);
    const [level, setLevel] = useState('ALL');
    const [query, setQuery] = useState('');
    const [pausedThrough, setPausedThrough] = useState(null);
    const [autoScroll, setAutoScroll] = useState(true);
    const [expandedTraceIds, setExpandedTraceIds] = useState(() => new Set());
    const [scrollTop, setScrollTop] = useState(0);
    const [viewportHeight, setViewportHeight] = useState(180);
    const listRef = useRef(null);
    const resizerRef = useRef(null);
    const resizeRef = useRef(null);
    const latestId = logs.length ? logs[logs.length - 1].id : 0;
    const filtered = useMemo(() => expanded
        ? filterRunLogs(logs, { level, query, pausedThrough }) : [], [expanded, logs, level, query, pausedThrough]);
    const rows = useMemo(() => flattenRunLogLines(filtered, expandedTraceIds), [filtered, expandedTraceIds]);
    const totalRows = rows.length;
    const totalHeight = totalRows * RUN_LOG_ROW_HEIGHT;
    // Closing a long trace can shrink the virtual list considerably; keep the
    // window valid even before the browser reports its new clamped scrollTop.
    const effectiveScrollTop = Math.min(scrollTop, Math.max(0, totalHeight - viewportHeight));
    const first = Math.max(0, Math.floor(effectiveScrollTop / RUN_LOG_ROW_HEIGHT) - 8);
    const count = Math.ceil(viewportHeight / RUN_LOG_ROW_HEIGHT) + 18;
    const visible = rows.slice(first, first + count);
    const unseen = pausedThrough === null ? 0 : logs.filter((entry) => entry.id > pausedThrough).length;
    const changeQuery = (value) => {
        setQuery(value);
        setScrollTop(0);
        setAutoScroll(false);
        if (listRef.current) listRef.current.scrollTop = 0;
    };

    useLayoutEffect(() => {
        if (!expanded || !listRef.current) return;
        const element = listRef.current;
        const onResize = () => setViewportHeight(element.clientHeight);
        onResize();
        if (typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(onResize);
        observer.observe(element);
        return () => observer.disconnect();
    }, [expanded]);

    useLayoutEffect(() => {
        if (!expanded || !autoScroll || !listRef.current) return;
        const element = listRef.current;
        element.scrollTop = Math.max(0, totalHeight - element.clientHeight);
        setScrollTop(element.scrollTop);
    }, [expanded, autoScroll, totalHeight]);

    const onScroll = (event) => {
        const element = event.currentTarget;
        setScrollTop(element.scrollTop);
        const atBottom = element.scrollHeight - element.clientHeight - element.scrollTop <= 30;
        setAutoScroll(atBottom);
    };
    const resizeStart = (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        resizeRef.current = { y: event.clientY, height };
        resizerRef.current?.setPointerCapture?.(event.pointerId);
    };
    const resizeMove = (event) => {
        if (!resizeRef.current) return;
        const max = Math.max(180, window.innerHeight - 240);
        setHeight(Math.max(120, Math.min(max, resizeRef.current.height + resizeRef.current.y - event.clientY)));
    };
    const resizeEnd = () => {
        if (!resizeRef.current) return;
        resizeRef.current = null;
        try { localStorage.setItem('bonsai:runLogHeight', String(height)); } catch { /* optional preference */ }
    };
    const toggleStackTrace = (entryId) => {
        // Keep the clicked row in view rather than jumping to the latest log.
        setAutoScroll(false);
        setExpandedTraceIds((current) => {
            const next = new Set(current);
            if (next.has(entryId)) next.delete(entryId);
            else next.add(entryId);
            return next;
        });
    };
    const copyVisible = async () => {
        const text = filtered.map((entry) => [entry.level, entry.logger, entry.message, entry.stackTrace]
            .filter(Boolean).join(' ')).join('\n');
        try { await navigator.clipboard.writeText(text); } catch { /* clipboard permission denied */ }
    };

    return (
        <section className={`run-log-panel${expanded ? ' open' : ''}`} style={{ height: expanded ? height : 35 }}
            aria-label="Run Logs" data-connection={status}>
            {expanded && <div ref={resizerRef} className="run-log-resize" role="separator"
                aria-label="Resize Run Logs panel" aria-orientation="horizontal"
                onPointerDown={resizeStart} onPointerMove={resizeMove} onPointerUp={resizeEnd}
                onLostPointerCapture={resizeEnd} />}
            <div className="run-log-header">
                <button type="button" className="run-log-title" onClick={() => setExpanded((value) => !value)}
                    aria-expanded={expanded} title={expanded ? 'Collapse Run Logs' : 'Open Run Logs'}>
                    {expanded ? <FiChevronDown /> : <FiChevronUp />}
                    <span>Run Logs</span>
                    <span className={`run-log-dot ${status}`} aria-hidden="true" />
                    <span className="run-log-status">{status === 'idle' ? 'Load a state machine to connect' : status}</span>
                </button>
                <span className="run-log-count">{logs.length.toLocaleString()} messages</span>
                {expanded && <div className="run-log-actions">
                    <label className="run-log-search"><FiSearch /><input aria-label="Search logs" value={query}
                        placeholder="Search" onChange={(event) => changeQuery(event.target.value)} />
                        {query && <button type="button" className="run-log-search-clear"
                            title="Clear log search" aria-label="Clear log search"
                            onClick={() => changeQuery('')}><FiX /></button>}
                    </label>
                    <select aria-label="Log level" value={level} onChange={(event) => setLevel(event.target.value)}>
                        {LEVELS.map((entry) => <option key={entry} value={entry}>{entry === 'ALL' ? 'All levels' : entry}</option>)}
                    </select>
                    <button type="button" title={pausedThrough === null ? 'Pause display (keep receiving)' : 'Resume display'}
                        aria-label={pausedThrough === null ? 'Pause log display' : 'Resume log display'}
                        onClick={() => setPausedThrough((current) => current === null ? latestId : null)}>
                        {pausedThrough === null ? <FiPause /> : <FiPlay />}</button>
                    <button type="button" className={autoScroll ? 'active' : ''} title="Follow latest logs"
                        aria-label="Follow latest logs" aria-pressed={autoScroll} onClick={() => setAutoScroll((value) => !value)}>↓</button>
                    <button type="button" title="Copy matching logs" aria-label="Copy matching logs"
                        onClick={() => void copyVisible()}><FiCopy /></button>
                    <button type="button" title="Clear logs" aria-label="Clear logs" onClick={() => {
                        clear(); setPausedThrough(null); setScrollTop(0); setExpandedTraceIds(new Set());
                    }}><FiTrash2 /></button>
                </div>}
            </div>
            {expanded && <>
                {connectionIssue && <div className="run-log-issue" role="status">{connectionIssue}</div>}
                <div className="run-log-viewport" ref={listRef} tabIndex={0} onScroll={onScroll}
                    role="log" aria-label="Log messages" aria-live="off">
                    <div className="run-log-virtual-space" style={{ height: totalHeight }}>
                        {visible.map((row, index) => <div key={row.key}
                            className={`run-log-row level-${row.level.toLowerCase()}${row.extra ? ' extra' : ''}`}
                            style={{ top: (first + index) * RUN_LOG_ROW_HEIGHT, height: RUN_LOG_ROW_HEIGHT }}
                            title={row.logger || undefined}>
                            <span className="run-log-time">{row.time}</span>
                            <span className="run-log-level">{row.extra ? '' : row.level}</span>
                            {row.logger && <span className="run-log-logger" title={row.logger}>{row.logger.split('.').slice(-2).join('.')}</span>}
                            {row.traceToggle ? (
                                <button type="button" className="run-log-stack-toggle"
                                    aria-expanded={row.expanded}
                                    aria-label={`${row.expanded ? 'Collapse' : 'Expand'} ${row.text}`}
                                    onClick={() => toggleStackTrace(row.entryId)}>
                                    {row.expanded ? <FiChevronDown aria-hidden="true" /> : <FiChevronRight aria-hidden="true" />}
                                    <span>{row.text}</span>
                                </button>
                            ) : (
                                <span className={`run-log-message${row.traceLine ? ' run-log-stack-line' : ''}`}>{row.text}</span>
                            )}
                        </div>)}
                    </div>
                    {!totalRows && <div className="run-log-empty">{session ? 'Waiting for log messages…' : 'Load a state machine to receive logs.'}</div>}
                </div>
                <footer className="run-log-footer">
                    <span>{pausedThrough !== null ? `Display paused · ${unseen} newer` : status === 'connected' ? 'Receiving logs' : status}</span>
                    <span>{filtered.length.toLocaleString()} matching · buffer limit 5,000</span>
                </footer>
            </>}
        </section>
    );
});

export default RunLogPanel;
