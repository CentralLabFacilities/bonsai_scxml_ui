import { useCallback, useState } from "react";

export function useEditorUiState({ showPanel, onDetailsRequested }) {
  const [selectedPackage, setSelectedPackage] = useState(null);
  const [selectedSubPackage, setSelectedSubPackage] = useState(null);
  const [activeFilter, setActiveFilter] = useState("Everything");
  const [searchText, setSearchText] = useState("");
  const [contextMenu, setContextMenu] = useState(null);
  const [controlPointInsertRequest, setControlPointInsertRequest] = useState(null);
  const [leftLibraryTab, setLeftLibraryTab] = useState("skills");
  const [isHintPageOpen, setIsHintPageOpen] = useState(false);
  const [activeMode, setActiveModeState] = useState("overview");
  const [isCreateSlotModalOpen, setIsCreateSlotModalOpen] = useState(false);
  const [pendingSubMachineCreation, setPendingSubMachineCreation] = useState(null);
  const [stateMachineLoading, setStateMachineLoading] = useState(null);
  const [activeTab, setActiveTab] = useState("allgemein");
  const [rightPanelTab, setRightPanelTabState] = useState("datamodel");

  const beginStateMachineLoad = useCallback((label = "State machine") => {
    setStateMachineLoading({ label });
  }, []);

  const endStateMachineLoad = useCallback(() => {
    setStateMachineLoading(null);
  }, []);

  const setRightPanelTab = useCallback(
    (tab) => {
      setRightPanelTabState(tab);
      if (tab === "details") {
        showPanel("inspector");
        onDetailsRequested?.();
      }
    },
    [showPanel, onDetailsRequested],
  );

  const setActiveMode = useCallback((nextMode) => {
    setActiveModeState(nextMode);
    if (nextMode !== "slots" && nextMode !== "overview") {
      setIsCreateSlotModalOpen(false);
    }
  }, []);

  return {
    selectedPackage,
    setSelectedPackage,
    selectedSubPackage,
    setSelectedSubPackage,
    activeFilter,
    setActiveFilter,
    searchText,
    setSearchText,
    contextMenu,
    setContextMenu,
    controlPointInsertRequest,
    setControlPointInsertRequest,
    leftLibraryTab,
    setLeftLibraryTab,
    isHintPageOpen,
    setIsHintPageOpen,
    activeMode,
    setActiveMode,
    isCreateSlotModalOpen,
    setIsCreateSlotModalOpen,
    pendingSubMachineCreation,
    setPendingSubMachineCreation,
    stateMachineLoading,
    beginStateMachineLoad,
    endStateMachineLoad,
    activeTab,
    setActiveTab,
    rightPanelTab,
    setRightPanelTab,
  };
}
