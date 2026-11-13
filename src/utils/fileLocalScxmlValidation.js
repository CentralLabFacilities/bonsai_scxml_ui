/**
 * Validate the SCXML bytes that are being opened, without consulting src=
 * references, parent tabs, skill APIs or behavior-directory mappings.
 *
 * Run on the original text before importing the graph: import projection can
 * normalize/merge slot declarations and loses duplicate SCXML ids.
 */
export function validateFileLocalScxml(xmlText) {
  const document = new DOMParser().parseFromString(String(xmlText || ""), "application/xml");
  const parserError = document.getElementsByTagName("parsererror")[0];
  if (parserError) {
    return [makeProblem("xml-syntax", "Workflow", "Invalid XML", parserError.textContent?.trim() || "XML cannot be parsed.")];
  }

  const root = document.documentElement;
  if (root?.localName !== "scxml") {
    return [makeProblem("xml-root", "Workflow", "Invalid SCXML root", "Expected an <scxml> root element.")];
  }

  const directChildren = (element, localName) =>
    [...(element?.children || [])].filter((child) => child.localName === localName);
  const descendants = (element, localNames) =>
    [...element.getElementsByTagName("*")].filter((child) => localNames.has(child.localName));
  const attr = (element, name) => String(element.getAttribute(name) || "").trim();
  const problems = [];

  // SCXML state ids are unique across the entire single file, including
  // nested compound/parallel regions. Do not follow <state src="...">.
  const stateIds = new Map();
  const states = descendants(root, new Set(["state", "parallel", "final"]));
  states.forEach((state) => {
    const id = attr(state, "id");
    if (!id) return; // The SCXML importer already handles missing state ids.
    if (stateIds.has(id)) {
      if (!stateIds.get(id).reported) {
        problems.push(makeProblem(`state-duplicate-${id}`, "States", "Duplicate state ID", `The state ID '${id}' is declared more than once in this SCXML file.`, id));
        stateIds.get(id).reported = true;
      }
    } else {
      stateIds.set(id, { reported: false });
    }
  });

  // A targetless <transition> can send events and is valid. Multi-target
  // transitions use whitespace-separated SCXML ids.
  descendants(root, new Set(["transition"])).forEach((transition, index) => {
    const target = attr(transition, "target");
    if (!target) return;
    const owner = transition.parentElement;
    const sourceId = owner && ["state", "parallel", "final"].includes(owner.localName) ? attr(owner, "id") : "";
    for (const targetId of new Set(target.split(/\s+/).filter(Boolean))) {
      if (stateIds.has(targetId)) continue;
      problems.push(makeProblem(
        `transition-target-${index}-${targetId}`,
        "Transitions",
        "Unknown transition target",
        `Transition${sourceId ? ` from '${sourceId}'` : ""} targets '${targetId}', which is not a state in this file.`,
        sourceId,
      ));
    }
  });

  // Only the root document's #_SLOTS data belongs to this validation. Slots
  // of referenced sub-state machines are expressly out of scope.
  const declarations = directChildren(root, "datamodel")
    .flatMap((model) => directChildren(model, "data"))
    .filter((entry) => attr(entry, "id") === "#_SLOTS")
    .flatMap((entry) => descendants(entry, new Set(["slot", "inheritSlot"])));
  const groups = new Map();
  declarations.forEach((declaration, index) => {
    const kind = declaration.localName;
    const key = attr(declaration, "key");
    const state = attr(declaration, "state");
    const xpath = attr(declaration, "xpath");
    const missing = ["state", "key", "xpath"].filter((name) => !attr(declaration, name));
    if (missing.length) {
      problems.push(makeProblem(
        `slot-missing-${index}`,
        "Slots",
        "Incomplete slot declaration",
        `<${kind}>${state || key ? ` for ${state || "?"}.${key || "?"}` : ""} is missing ${missing.join(", ")}.`,
        state === "*" ? "" : state,
      ));
    }
    if (!state || !key || !xpath) return;
    const groupKey = `${state}\u0000${key}`;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push({ kind, xpath, index });
  });

  groups.forEach((entries, identity) => {
    if (entries.length < 2) return;
    const [state, key] = identity.split("\u0000");
    const kinds = new Set(entries.map((item) => item.kind));
    const paths = new Set(entries.map((item) => item.xpath));
    const ownerId = state === "*" ? "" : state;
    if (kinds.size > 1) {
      problems.push(makeProblem(
        `slot-kind-${state}-${key}`, "Slots", "Conflicting slot kinds",
        `The key '${key}' for state '${state}' is declared as both <slot> and <inheritSlot> in this file.`, ownerId,
      ));
    }
    if (paths.size > 1) {
      problems.push(makeProblem(
        `slot-path-${state}-${key}`, "Slots", "Conflicting slot paths",
        `The key '${key}' for state '${state}' has multiple XPaths: ${[...paths].join(", ")}.`, ownerId,
      ));
    }
    if (entries.length > new Set(entries.map((item) => `${item.kind}\u0000${item.xpath}`)).size) {
      problems.push(makeProblem(
        `slot-duplicate-${state}-${key}`, "Slots", "Duplicate slot declaration",
        `The key '${key}' for state '${state}' contains an identical slot declaration more than once.`, ownerId,
      ));
    }
  });

  return problems;
}

function makeProblem(id, category, title, message, stateId = "") {
  return { id: `scxml-file-${id}`, severity: "error", category, title, message, stateId };
}

/** Attach imported file diagnostics to visible nodes for the Problems panel. */
export function attachFileProblemsToNodes(problems, nodes) {
  const byScxmlId = new Map();
  (nodes || []).forEach((node) => {
    const name = String(node?.data?.fullSkillName || "").trim();
    if (!name) return;
    if (!byScxmlId.has(name)) byScxmlId.set(name, []);
    if (!node?.data?.isSlotClone && !node?.data?.isStateClone && !node?.data?.isSkillClone) {
      byScxmlId.get(name).push(node.id);
    }
  });
  return (problems || []).map(({ stateId, ...problem }) => {
    const ids = byScxmlId.get(stateId) || [];
    return {
      ...problem,
      ...(ids.length ? { nodeId: ids[0], focusNodeIds: ids, mode: "overview" } : {}),
      ...(problem.category === "Slots" ? { detailTab: "slots" } : {}),
    };
  });
}

/** Keep the popup concise; all individual diagnostics remain in Problems. */
export function notifyFileValidationErrors(notify, fileName, problems) {
  if (!problems?.length) return;
  const count = problems.length;
  notify({
    id: "scxml-file-configuration-errors",
    tone: "danger",
    title: `Opened ${fileName} with ${count} configuration ${count === 1 ? "error" : "errors"}`,
    message: `${problems.slice(0, 2).map((problem) => problem.message).join("  ")}${count > 2 ? `  (+${count - 2} more)` : ""} Review the Problems panel for details.`,
    duration: 12000,
  });
}
