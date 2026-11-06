import { test, expect } from "@playwright/test";

// Deterministic IPC images exercise the real app/coordinator/notice surface.
// Native byte safety is covered separately by the headless Rust acceptance run.
export async function installExternalWorkflowFixture(page) {
    await page.addInitScript(() => {
        const skill = "demo.skills.Work";
        const definition = { description: "Fixture work", params: [], inSlots: [], outSlots: [], events: [] };
        const image = (path, version) => ({ path, fileName: path.split("/").pop(), fileVersion: version,
            content: `<scxml name="${version}"/>`, behaviorExitEvents: [], inheritedSlots: [], localDataModel: [],
            workflow: { states: [], transitions: [], dataModel: [{ id: "external", expression: `'${version}'` }] } });
        const fixture = window.__externalFixture = { images: { "/workflow.xml": image("/workflow.xml", "A") },
            writes: [], commands: [], destination: { path: "/copy.xml", fileVersion: null }, revision: 0,
            replace: (version) => { fixture.images["/workflow.xml"] = image("/workflow.xml", version); window.dispatchEvent(new Event("focus")); } };
        let callback = 0;
        window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
        window.__TAURI_INTERNALS__ = {
            metadata: { currentWindow: { label: "main" } },
            transformCallback: () => ++callback,
            unregisterCallback() {},
            invoke: async (command, args) => {
                fixture.commands.push(command);
                switch (command) {
                    case "api_request": return { status: 200, body: JSON.stringify(args.path === "/api/skills" ? { skills: [skill] } : definition) };
                    case "plugin:event|listen": return args.handler;
                    case "plugin:event|unlisten": return null;
                    case "open_file": return "/workflow.xml";
                    case "inspect_workflow_source": return fixture.images[args.src];
                    case "revalidate_workflow_sources": return args.requests.map(({ src, fileVersion }) => {
                        const current = fixture.images[src];
                        if (!current) return { state: "missing", error: `No such file: ${src}` };
                        if (current.state) return current;
                        return { state: current.fileVersion === fileVersion ? "unchanged" : "changed",
                            path: current.path, fileVersion: current.fileVersion, inspection: current };
                    });
                    case "serialize_editor_workflow": return JSON.stringify(args.request);
                    case "select_save_destination": return fixture.destination;
                    case "save_file": {
                        const current = fixture.images[args.path];
                        if ((current?.fileVersion || null) !== args.expectedFileVersion)
                            return { status: "conflict", state: current ? "changed" : "missing", observedFileVersion: current?.fileVersion,
                                error: "The destination changed on disk; no bytes were written." };
                        const version = `save-${fixture.writes.length}`;
                        fixture.writes.push({ path: args.path, content: args.content });
                        fixture.images[args.path] = image(args.path, version);
                        return { status: "saved", success: true, path: args.path, file_name: args.path.split("/").pop(), fileVersion: version };
                    }
                    case "replace_active_editor_workflow_document":
                    case "apply_workflow_command": return { revision: ++fixture.revision, patch: {} };
                    case "validate_active_workflow":
                    case "validate_editor_workflow": return { revision: fixture.revision, issues: [] };
                    case "analyze_editor_transitions": return { transitions: [], issues: [] };
                    case "resolve_behavior_directory": return null;
                    default: throw new Error(`Unexpected fixture IPC: ${command}`);
                }
            },
        };
    });
}

test("dirty external conflict controls preserve local content, block stale Save and support non-destructive Save As", async ({ page }) => {
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
    const snapshot = await page.evaluate(() => ({ writes: window.__externalFixture.writes,
        external: window.__externalFixture.images["/workflow.xml"].fileVersion }));
    expect(snapshot.external).toBe("B");
    const saved = JSON.parse(snapshot.writes[0].content);
    expect(saved.dataModel).toEqual([{ id: "external", expression: "'local'" }]);
    expect(saved.nodes[0].label).toBe("Work");
});

test("clean external replacement reloads without a modal; invalid and missing images retain usable content", async ({ page }) => {
    await installExternalWorkflowFixture(page);
    await page.goto("/");
    await page.getByRole("button", { name: "File", exact: true }).click();
    await page.getByRole("menuitem", { name: "Open", exact: true }).click();
    await expect(page.locator(".workflow-panel .datamodel-compact-value-input")).toHaveValue("'A'");
    await page.evaluate(() => window.__externalFixture.replace("B"));
    await expect(page.locator(".workflow-panel .datamodel-compact-value-input")).toHaveValue("'B'");
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await page.evaluate(() => {
        window.__externalFixture.images["/workflow.xml"] = { state: "invalid", fileVersion: "broken", error: "Unclosed SCXML element" };
        window.dispatchEvent(new Event("focus"));
    });
    const notice = page.getByRole("region", { name: "File operation feedback" });
    await expect(notice).toContainText("Unclosed SCXML element");
    await expect(notice.getByRole("button", { name: "Reload from disk" })).toHaveCount(0);
    await expect(page.locator(".workflow-panel .datamodel-compact-value-input")).toHaveValue("'B'");
    await page.evaluate(() => { delete window.__externalFixture.images["/workflow.xml"]; window.dispatchEvent(new Event("focus")); });
    await expect(notice).toContainText("No such file");
    await page.evaluate(() => window.__externalFixture.replace("C"));
    await expect(notice).toHaveCount(0);
    await expect(page.locator(".workflow-panel .datamodel-compact-value-input")).toHaveValue("'C'");
});
