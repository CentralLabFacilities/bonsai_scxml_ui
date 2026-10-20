import { EditorPanel, EditorPanelLedge } from "../EditorChrome.jsx";
import RuntimeValuesPanel from "../inspector/RuntimeValuesPanel.jsx";

export default function RuntimeValuesDrawer({ available, isOpen, onClose, width = 400, ...values }) {
    const open = Boolean(available && isOpen);
    const panels = { valuesOpen: open, isDocked: false, closePanel: onClose, togglePanel: onClose };
    const style = { "--runtime-values-width": `${width}px` };
    return <>
        <EditorPanel side="values" panels={panels} className="runtime-values-drawer" style={style}>
            {open && <RuntimeValuesPanel {...values} />}
        </EditorPanel>
        {open && <EditorPanelLedge side="values" panels={panels} style={style} />}
    </>;
}
