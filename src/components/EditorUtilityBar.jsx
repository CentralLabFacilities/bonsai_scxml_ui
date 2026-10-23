import { lazy, Suspense, useId, useRef, useState } from 'react';
import { FiHelpCircle, FiRefreshCw } from 'react-icons/fi';

const EditorShortcutHelp = lazy(() => import('./overlays/EditorShortcutHelp.jsx'));

/** Small, docked controls: never overlay the canvas or the Run Logs panel. */
export default function EditorUtilityBar({ onQuickGuide, shortcuts, onRefresh, canRefresh = true }) {
    const [refreshing, setRefreshing] = useState(false);
    const [message, setMessage] = useState('');
    const shortcutsId = useId();
    const shortcutsButtonRef = useRef(null);
    const refreshRef = useRef(false);
    const runRefresh = async () => {
        if (refreshRef.current || !canRefresh) return;
        refreshRef.current = true;
        setRefreshing(true);
        setMessage('Refreshing skill definitions…');
        try {
            const result = await onRefresh?.();
            setMessage(result?.message || 'Skill nodes refreshed');
        } catch (error) {
            setMessage(`Refresh failed: ${error?.message || error}`);
        } finally {
            refreshRef.current = false;
            setRefreshing(false);
        }
    };
    return (
        <footer className="editor-utility-bar nodrag nopan" aria-label="Editor utilities">
            <div className="editor-utility-actions">
                <button type="button" className="editor-utility-button" onClick={() => void runRefresh()}
                    disabled={refreshing || !canRefresh} aria-label="Refresh skill nodes"
                    title="Fetch current skill definitions and refresh canvas nodes (preserves configured bindings)">
                    <FiRefreshCw className={refreshing ? 'is-spinning' : ''} aria-hidden="true" />
                    <span>Refresh nodes</span>
                </button>
                <span className="editor-utility-status" role="status">{message}</span>
            </div>
            <div className="editor-utility-actions" onBlurCapture={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) shortcuts.setIsOpen?.(false);
            }} onKeyDown={(event) => {
                if (event.key === 'Escape' && shortcuts.isOpen) {
                    event.preventDefault();
                    event.stopPropagation();
                    shortcuts.setIsOpen?.(false);
                    shortcutsButtonRef.current?.focus();
                }
            }}>
                <button type="button" className="editor-utility-button" title="Quick guide"
                    aria-label="Open Bonsai UI quick guide" onClick={onQuickGuide}>
                    <FiHelpCircle aria-hidden="true" />
                </button>
                <button ref={shortcutsButtonRef} type="button" className="editor-utility-button"
                    aria-label="Show keyboard shortcuts" title="Keyboard shortcuts"
                    aria-expanded={Boolean(shortcuts.isOpen)} aria-controls={shortcutsId}
                    onClick={() => shortcuts.setIsOpen?.(!shortcuts.isOpen)}>
                    <span aria-hidden="true">⌨</span>
                </button>
                <Suspense fallback={null}>
                    {shortcuts.isOpen && <EditorShortcutHelp id={shortcutsId} />}
                </Suspense>
            </div>
        </footer>
    );
}
