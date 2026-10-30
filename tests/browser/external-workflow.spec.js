import { test, expect } from "@playwright/test";

// Deterministic IPC images exercise the real app/coordinator/notice surface.
// Native byte safety is covered separately by the headless Rust acceptance run.
export async function installExternalWorkflowFixture(page) {
  await page.addInitScript(() => {
    const skill = "demo.skills.Work";
    const definition = { description: "Fixture work", params: [], inSlots: [], outSlots: [], events: [] };
    const image = (path, version) => ({
      path,
      fileName: path.split("/").pop(),
      fileVersion: version,
      content: `<scxml name="${version}"/>`,
      behaviorExitEvents: [],
      inheritedSlots: [],
      localDataModel: [],
      workflow: { states: [], transitions: [], dataModel: [{ id: "external", expression: `'${version}'` }] },
    });
    const fixture = (window.__externalFixture = {
      images: { "/workflow.xml": image("/workflow.xml", "A") },
      writes: [],
      commands: [],
      destination: { path: "/copy.xml", fileVersion: null },
      revision: 0,
      replace: (version) => {
        fixture.images["/workflow.xml"] = image("/workflow.xml", version);
        window.dispatchEvent(new Event("focus"));
      },
    });
    let callback = 0;
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" } },
      transformCallback: () => ++callback,
      unregisterCallback() {},
      invoke: async (command, args) => {
        fixture.commands.push(command);
        switch (command) {
          case "api_request":
            return {
              status: 200,
              body: JSON.stringify(args.path === "/api/skills" ? { skills: [skill] } : definition),
            };
          case "plugin:event|listen":
            return args.handler;
          case "plugin:event|unlisten":
            return null;
          case "open_file":
            return "/workflow.xml";
          case "inspect_workflow_source":
            return fixture.images[args.src];
          case "revalidate_workflow_sources":
            return args.requests.map(({ src, fileVersion }) => {
              const current = fixture.images[src];
              if (!current) return { state: "missing", error: `No such file: ${src}` };
              if (current.state) return current;
              return {
                state: current.fileVersion === fileVersion ? "unchanged" : "changed",
                path: current.path,
                fileVersion: current.fileVersion,
                inspection: current,
              };
            });
          case "serialize_editor_workflow":
            return JSON.stringify(args.request);
          case "select_save_destination":
            return fixture.destination;
          case "save_file": {
            const current = fixture.images[args.path];
            if ((current?.fileVersion || null) !== args.expectedFileVersion)
              return {
                status: "conflict",
                state: current ? "changed" : "missing",
                observedFileVersion: current?.fileVersion,
                error: "The destination changed on disk; no bytes were written.",
              };
            const version = `save-${fixture.writes.length}`;
            fixture.writes.push({ path: args.path, content: args.content });
            fixture.images[args.path] = image(args.path, version);
            return {
              status: "saved",
              success: true,
              path: args.path,
              file_name: args.path.split("/").pop(),
              fileVersion: version,
            };
          }
          case "replace_active_editor_workflow_document":
          case "apply_workflow_command":
            return { revision: ++fixture.revision, patch: {} };
          case "validate_active_workflow":
          case "validate_editor_workflow":
            return { revision: fixture.revision, issues: [] };
          case "analyze_editor_transitions":
            return { transitions: [], issues: [] };
          case "resolve_behavior_directory":
            return null;
          default:
            throw new Error(`Unexpected fixture IPC: ${command}`);
        }
      },
    };
  });
}

test("dirty external conflict controls preserve local content, block stale Save and support non-destructive Save As", async ({
  page,
}) => {
  await installExternalWorkflowFixture(page);
  await page.goto("/");
  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.getByRole("menuitem", { name: "Open", exact: true }).click();
  await expect(page.getByRole("tab", { name: /^workflow$/ })).toBeVisible();
  await page.getByRole("button", { name: "Toggle library", exact: true }).click();
  await page.locator(".datamodel-compact-value-input").fill("'local'");
  await page.locator(".datamodel-compact-value-input").press("Enter");
  await page.getByRole("button", { name: "Add demo.skills.Work to canvas", exact: true }).click();
  await expect(page.locator(".react-flow__node-custom")).toHaveCount(1);
  const search = page.getByRole("textbox", { name: "Search skills" });
  await search.focus();
  await page.evaluate(() => window.__externalFixture.replace("B"));
  const notice = page.getByRole("region", { name: "File operation feedback" });
  await expect(notice.getByRole("button", { name: "Reload from disk", exact: true })).toBeVisible();
  await expect(search).toBeFocused();
  await notice.getByRole("button", { name: "Keep local", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(notice.getByRole("button", { name: "Keeping local", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.getByRole("menuitem", { name: "Save", exact: true }).click();
  await expect(notice).toContainText("no bytes were written");
  expect(await page.evaluate(() => window.__externalFixture.writes)).toEqual([]);
  await expect(page.locator(".react-flow__node-custom")).toHaveCount(1);
  await notice.getByRole("button", { name: "Save As...", exact: true }).click();
  await expect(page.getByRole("tab", { name: /^copy$/ })).toBeVisible();
  await expect(notice).toHaveCount(0);
  await expect(page.locator(".react-flow__node-custom")).toHaveCount(1);
  const snapshot = await page.evaluate(() => ({
    writes: window.__externalFixture.writes,
    external: window.__externalFixture.images["/workflow.xml"].fileVersion,
  }));
  expect(snapshot.external).toBe("B");
  const saved = JSON.parse(snapshot.writes[0].content);
  expect(saved.dataModel).toEqual([{ id: "external", expression: "'local'" }]);
  expect(saved.nodes[0].label).toBe("Work");
});

test("clean external replacement reloads without a modal; invalid and missing images retain usable content", async ({
  page,
}) => {
  await installExternalWorkflowFixture(page);
  await page.goto("/");
  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.getByRole("menuitem", { name: "Open", exact: true }).click();
  await expect(page.locator(".workflow-panel .datamodel-compact-value-input")).toHaveValue("'A'");
  await page.evaluate(() => window.__externalFixture.replace("B"));
  await expect(page.locator(".workflow-panel .datamodel-compact-value-input")).toHaveValue("'B'");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await page.evaluate(() => {
    window.__externalFixture.images["/workflow.xml"] = {
      state: "invalid",
      fileVersion: "broken",
      error: "Unclosed SCXML element",
    };
    window.dispatchEvent(new Event("focus"));
  });
  const notice = page.getByRole("region", { name: "File operation feedback" });
  await expect(notice).toContainText("Unclosed SCXML element");
  await expect(notice.getByRole("button", { name: "Reload from disk" })).toHaveCount(0);
  await expect(page.locator(".workflow-panel .datamodel-compact-value-input")).toHaveValue("'B'");
  await page.evaluate(() => {
    delete window.__externalFixture.images["/workflow.xml"];
    window.dispatchEvent(new Event("focus"));
  });
  await expect(notice).toContainText("No such file");
  await page.evaluate(() => window.__externalFixture.replace("C"));
  await expect(notice).toHaveCount(0);
  await expect(page.locator(".workflow-panel .datamodel-compact-value-input")).toHaveValue("'C'");
});

test("first import waits for real measurements, fits once, and same-ID reload preserves navigation", async ({
  page,
}) => {
  await installExternalWorkflowFixture(page);
  await page.addInitScript(() => {
    const NativeResizeObserver = window.ResizeObserver;
    const pending = new Map();
    window.__holdCameraMeasurements = true;
    // React Flow can also measure through explicit updateNodeInternals,
    // outside ResizeObserver. Hold both real readiness paths.
    for (const property of ["offsetWidth", "offsetHeight"]) {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, property);
      Object.defineProperty(HTMLElement.prototype, property, {
        configurable: true,
        get() {
          return window.__holdCameraMeasurements && this.classList.contains("react-flow__node")
            ? 0
            : descriptor.get.call(this);
        },
      });
    }
    window.__releaseCameraMeasurements = () => {
      window.__holdCameraMeasurements = false;
      for (const [observer, { callback, entries }] of pending) callback(entries, observer);
      pending.clear();
    };
    window.ResizeObserver = class extends NativeResizeObserver {
      constructor(callback) {
        super((entries, observer) => {
          const delayed = entries.filter((entry) => entry.target.closest(".react-flow__node"));
          const immediate = entries.filter((entry) => !entry.target.closest(".react-flow__node"));
          if (immediate.length) callback(immediate, observer);
          if (!window.__holdCameraMeasurements) {
            if (delayed.length) callback(delayed, observer);
          } else if (delayed.length) {
            pending.set(observer, { callback, entries: delayed });
          }
        });
      }
      disconnect() {
        pending.delete(this);
        super.disconnect();
      }
    };
  });
  await page.goto("/");
  await page.evaluate(() => {
    const image = window.__externalFixture.images["/workflow.xml"];
    image.workflow.states = [0, 1].map((index) => ({
      id: `state-${index}`,
      scxmlId: `demo.skills.Work#${index + 1}`,
      fullSkillName: "demo.skills.Work",
      label: "Work",
      kind: "skill",
      parentId: null,
      parameters: [],
      slots: [],
      events: [],
      onEntry: [],
      onExit: [],
      editor: {
        x: index * 1500,
        y: index * 500,
        positions: [{ x: index * 1500, y: index * 500, instanceId: String(index + 1) }],
      },
    }));
    image.workflow.initialStateId = "state-0";
    image.workflow.initialScxmlStateId = "demo.skills.Work#1";
  });
  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.getByRole("menuitem", { name: "Open", exact: true }).click();
  await expect(page.locator(".react-flow__node-custom")).toHaveCount(2);
  await expect(page.locator(".react-flow")).toHaveAttribute("data-viewport-ready", "false");
  await expect(page.locator(".react-flow__viewport")).toHaveCSS("opacity", "0");
  // Adjacent controls and a real canvas resize remain usable while measuring.
  await page.getByRole("button", { name: "Toggle library", exact: true }).click();
  await page.getByRole("button", { name: "Options", exact: true }).click();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".react-flow")).toHaveAttribute("data-viewport-ready", "false");
  await page.evaluate(() => {
    const transforms = (window.__importCameraTransforms = []);
    const root = document.querySelector(".react-flow");
    const viewport = root.querySelector(".react-flow__viewport");
    const record = () => {
      if (
        getComputedStyle(viewport).opacity !== "0" &&
        [...root.querySelectorAll(".react-flow__node")].every((node) => node.getBoundingClientRect().width > 0)
      ) {
        transforms.push(viewport.style.transform);
      }
    };
    const observer = new MutationObserver(record);
    observer.observe(root, { subtree: true, attributes: true });
    window.__stopImportCameraRecording = () => {
      record();
      observer.disconnect();
      return transforms;
    };
    window.__releaseCameraMeasurements();
  });
  await expect(page.locator(".react-flow")).toHaveAttribute("data-viewport-ready", "true");
  const fit = await page.evaluate(() => {
    const root = document.querySelector(".react-flow");
    const viewport = root.querySelector(".react-flow__viewport");
    const matrix = new DOMMatrix(viewport.style.transform);
    return {
      zoom: matrix.a,
      transform: viewport.style.transform,
      canvas: root.getBoundingClientRect().toJSON(),
      nodes: [...root.querySelectorAll(".react-flow__node")].map((node) => node.getBoundingClientRect().toJSON()),
    };
  });
  await test.info().attach("initial-camera-bounds", { body: JSON.stringify(fit), contentType: "application/json" });
  expect(fit.zoom).toBeLessThan(0.7);
  for (const node of fit.nodes) {
    expect(node.width).toBeGreaterThan(0);
    expect(node.x).toBeGreaterThanOrEqual(fit.canvas.x);
    expect(node.y).toBeGreaterThanOrEqual(fit.canvas.y);
    expect(node.right).toBeLessThanOrEqual(fit.canvas.right);
    expect(node.bottom).toBeLessThanOrEqual(fit.canvas.bottom);
  }
  await page.evaluate(async () => {
    for (let i = 0; i < 18; i++) await new Promise(requestAnimationFrame);
  });
  const transforms = await page.evaluate(() => window.__stopImportCameraRecording());
  expect(transforms.length).toBeGreaterThan(0);
  expect([...new Set(transforms)]).toEqual([fit.transform]);
  await page.getByRole("button", { name: "Zoom Out", exact: true }).click();
  await page.evaluate(async () => {
    for (let i = 0; i < 18; i++) await new Promise(requestAnimationFrame);
  });
  const navigated = await page.locator(".react-flow__viewport").evaluate((element) => element.style.transform);
  expect(navigated).not.toBe(fit.transform);
  await page.getByRole("button", { name: "Toggle library", exact: true }).click();
  await page.evaluate(async () => {
    for (let i = 0; i < 18; i++) await new Promise(requestAnimationFrame);
  });
  expect(await page.locator(".react-flow__viewport").evaluate((element) => element.style.transform)).toBe(navigated);
  await page.evaluate(() => {
    const image = window.__externalFixture.images["/workflow.xml"];
    image.fileVersion = "B";
    image.workflow.dataModel = [{ id: "external", expression: "'B'" }];
    window.dispatchEvent(new Event("focus"));
  });
  await expect(page.locator(".workflow-panel .datamodel-compact-value-input")).toHaveValue("'B'");
  await expect(page.locator(".react-flow")).toHaveAttribute("data-viewport-ready", "true");
  await expect(page.locator(".react-flow__viewport")).toHaveCSS("opacity", "1");
  expect(await page.locator(".react-flow__viewport").evaluate((element) => element.style.transform)).toBe(navigated);
  await expect(page.locator(".react-flow__node-custom")).toHaveCount(2);
});
