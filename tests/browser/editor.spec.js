import { test, expect } from "@playwright/test";

const skill = "demo.skills.Work";
const definition = {
    description: "Deterministic browser-test skill",
    params: [{ key: "count", type: "Integer", default: "1", required: true }],
    inSlots: [{ key: "input", type: "String" }], outSlots: [],
    events: [{ event: "done", description: "Work completed" }],
};

test.beforeEach(async ({ page }) => {
    await page.route("**/api/**", async (route) => {
        const pathname = new URL(route.request().url()).pathname;
        await route.fulfill({ json: pathname === "/api/skills" ? { skills: [skill] } : definition });
    });
});

async function openEditor(page) {
    await page.goto("/");
    await expect(page.getByRole("button", { name: `Add ${skill} to canvas`, exact: true })).toBeVisible();
    // Pin available Linux fonts for cross-machine screenshot reproducibility.
    await page.addStyleTag({ content: ":root { --ui-font-family: 'Liberation Sans', sans-serif; } code, pre, .code-area { font-family: 'Liberation Mono', monospace; }" });
    await page.evaluate(() => document.fonts.ready);
}

test("desktop layout and collapsed panels retain their visual baseline", async ({ page }) => {
    await openEditor(page);
    await expect(page.locator(".app")).toHaveAttribute("data-panel-mode", "docked");
    await expect(page).toHaveScreenshot("desktop-editor.png");
    await page.locator(".editor-panel-ledge-library").click();
    await page.locator(".editor-panel-ledge-inspector").click();
    await expect(page).toHaveScreenshot("desktop-collapsed.png");
    await expect(page.locator(".react-flow")).toBeVisible();
});

test("narrow drawers fit the viewport and restore keyboard focus", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    const ledge = page.locator(".editor-panel-ledge-library");
    await ledge.click();
    await expect(page.getByRole("button", { name: `Add ${skill} to canvas`, exact: true })).toBeVisible();
    const panel = page.locator("#editor-library-panel");
    const bounds = await panel.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
    await page.addStyleTag({ content: ":root { --ui-font-family: 'Liberation Sans', sans-serif; }" });
    await expect(page).toHaveScreenshot("mobile-library.png");
    await page.getByRole("textbox", { name: "Search skills" }).focus();
    await page.keyboard.press("Escape");
    await expect(ledge).toBeFocused();
    await expect(panel).toHaveAttribute("aria-hidden", "true");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("keyboard Add and real HTML dragging insert full skill nodes", async ({ page }) => {
    await openEditor(page);
    const add = page.getByRole("button", { name: `Add ${skill} to canvas`, exact: true });
    await add.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".react-flow__node-custom")).toHaveCount(1);
    await expect(page.locator(".skill-add-feedback")).toContainText("Added Work");
    await page.locator(".skill-item-name").dragTo(page.locator(".react-flow__pane"), { targetPosition: { x: 300, y: 300 } });
    await expect(page.locator(".react-flow__node-custom")).toHaveCount(2);
    await page.getByRole("button", { name: "Overview Mode", exact: true }).click();
    await expect(page).toHaveScreenshot("editor-with-skills.png");
});

test("failed backend loading is distinct from empty and recovers with retry", async ({ page }) => {
    await page.unroute("**/api/**");
    let failed = true;
    await page.route("**/api/**", (route) => route.fulfill({ status: failed ? 503 : 200, json: { skills: [] } }));
    await page.goto("/");
    await expect(page.locator('.skill-library [role="alert"]')).toContainText("503");
    await expect(page.getByText("The skill library is empty", { exact: true })).toHaveCount(0);
    failed = false;
    await page.getByRole("button", { name: "Retry loading skills", exact: true }).click();
    await expect(page.locator('.skill-library [role="alert"]')).toHaveCount(0);
    await expect(page.getByText("The skill library is empty", { exact: true })).toBeVisible();
});

test("skill finding accepts noncontiguous fuzzy matches and recovers from no match", async ({ page }) => {
    await openEditor(page);
    const search = page.getByRole("textbox", { name: "Search skills" });
    await search.fill("wk");
    await expect(page.getByRole("button", { name: `Add ${skill} to canvas`, exact: true })).toBeVisible();
    await search.fill("zzzzzzzzzzzzzz");
    await expect(page.getByText("No matching skills", { exact: true })).toBeVisible();
    await search.fill("");
    await expect(page.getByRole("button", { name: `Add ${skill} to canvas`, exact: true })).toBeVisible();
});

test("a committed Integer mismatch shows a badge and clearing a valid row works with an invalid sibling", async ({ page }) => {
    const parameters = [
        { key: "count", type: "Integer", default: "1", required: true },
        { key: "broken", type: "Integer", default: "'not-an-integer'", required: true },
    ];
    await page.route("**/api/skill/**", (route) => route.fulfill({ json: { ...definition, params: parameters, inSlots: [], outSlots: [] } }));
    await openEditor(page);
    await page.getByRole("button", { name: `Add ${skill} to canvas`, exact: true }).click();
    const node = page.locator(".react-flow__node-custom");
    await expect(node.locator(".node-warning-badge")).toBeVisible();
    await expect(node.locator(".node-warning-badge")).toHaveAttribute("title", /broken.*Integer|Integer.*broken/);
    await node.click();
    await page.getByRole("tab", { name: "Parameter", exact: true }).click();
    const groups = page.locator(".parameter-card");
    const count = groups.nth(0).getByRole("combobox");
    const broken = groups.nth(1).getByRole("combobox");
    await count.fill("7");
    await count.press("Enter");
    await expect(count).toHaveValue("7");
    await count.fill("");
    await count.press("Enter");
    await page.getByRole("tab", { name: "Overall", exact: true }).click();
    await page.getByRole("tab", { name: "Parameter", exact: true }).click();
    await expect(count).toHaveValue("");
    await expect(broken).toHaveValue("");
    await expect(broken).toHaveAttribute("placeholder", "'not-an-integer'");
    await broken.fill("9");
    await broken.press("Enter");
    await expect(node.locator(".node-warning-badge")).toHaveCount(0);
    await page.getByRole("tab", { name: "Problems", exact: true }).click();
    await expect(page.locator(".problems-panel")).toContainText("Full workflow validation unavailable");
    await expect(page.getByText("No problems found", { exact: true })).toHaveCount(0);
});

test("all connection points are smaller circles with the original large hit areas", async ({ page }) => {
    await openEditor(page);
    await page.getByRole("button", { name: `Add ${skill} to canvas`, exact: true }).click();
    const node = page.locator(".react-flow__node-custom");
    const paint = (element) => {
        const style = getComputedStyle(element, "::after");
        const outline = getComputedStyle(element, "::before");
        const bounds = element.getBoundingClientRect();
        return { clipPath: style.clipPath, borderRadius: style.borderRadius, visibleWidth: style.width,
            outlineWidth: outline.width, width: bounds.width, height: bounds.height };
    };
    for (const name of [".source-handle", ".target-handle", ".slot-skill-read-handle"]) {
        const style = await node.locator(name).first().evaluate(paint);
        expect(style.clipPath).toBe("none");
        expect(style.borderRadius).toBe("50%");
        expect(style.visibleWidth).toBe("10px");
        expect(style.outlineWidth).toBe("14px");
        expect(style.width).toBeGreaterThanOrEqual(24);
        expect(style.height).toBeGreaterThanOrEqual(24);
    }
});

test("slow skill inspection cannot append to a newly active workflow", async ({ page }) => {
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    await page.route("**/api/skill/**", async (route) => { await pending; await route.fulfill({ json: definition }); });
    await openEditor(page);
    await page.getByRole("button", { name: `Add ${skill} to canvas`, exact: true }).click();
    await page.keyboard.press("Control+n");
    await expect(page.getByRole("tablist", { name: "Workflow tabs" }).getByRole("tab")).toHaveCount(2);
    release();
    await expect(page.locator(".skill-add-feedback")).toContainText("workflow changed");
    await expect(page.locator(".react-flow__node-custom")).toHaveCount(0);
});

test("creation dialogs trap focus and block underlying editor commands", async ({ page }) => {
    await openEditor(page);
    await page.locator(".react-flow__pane").click({ button: "right", position: { x: 250, y: 220 } });
    await page.locator(".context-menu").getByRole("button", { name: "New Slot", exact: true }).click();
    const dialog = page.locator("dialog[open]");
    await expect(dialog).toBeVisible();
    const buttons = dialog.getByRole("button", { name: "Cancel", exact: true });
    await buttons.focus();
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("Control+n");
    await expect(page.getByRole("tablist", { name: "Workflow tabs" }).getByRole("tab")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(".react-flow__node")).toHaveCount(0);
});

test("native file requirements are visible without corrupting the browser workflow", async ({ page }) => {
    await openEditor(page);
    const open = page.locator(".header").getByRole("button", { name: "Open", exact: true });
    await open.click();
    await expect(page.locator('.editor-operation-notice [role="alert"]')).toContainText("Bonsai desktop app");
    await page.getByRole("button", { name: "Dismiss operation feedback", exact: true }).click();
    await expect(open).toBeFocused();
    await expect(page.getByRole("tablist", { name: "Workflow tabs" }).getByRole("tab")).toHaveCount(1);
});

test("context actions skip disabled choices and support arrows, Home, End and Escape", async ({ page }) => {
    await openEditor(page);
    await page.locator(".react-flow__pane").click({ button: "right", position: { x: 650, y: 650 } });
    const menu = page.locator(".context-menu");
    const first = menu.getByRole("button", { name: "New Compound State", exact: true });
    await expect(first).toBeFocused();
    await page.keyboard.press("End");
    await expect(menu.getByRole("button", { name: "New Slot", exact: true })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(first).toBeFocused();
    await page.keyboard.press("Home");
    await expect(first).toBeFocused();
    const bounds = await menu.boundingBox();
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(1440);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(900);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
});

test("clipboard paste choices are natively modal and cancellation preserves the graph", async ({ page }) => {
    await openEditor(page);
    await page.getByRole("button", { name: `Add ${skill} to canvas`, exact: true }).click();
    const node = page.locator(".react-flow__node-custom");
    await node.click();
    await node.focus();
    await page.keyboard.press("Control+c");
    await page.keyboard.press("Control+v");
    const dialog = page.locator("dialog.skill-paste-choice-overlay[open]");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("Control+n");
    await expect(page.getByRole("tablist", { name: "Workflow tabs" }).getByRole("tab")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(node).toHaveCount(1);
});

const workflowTabs = (page) => page.getByRole("tablist", { name: "Workflow tabs" }).getByRole("tab");

async function settledCamera(page) {
    await expect(page.locator('.react-flow[data-viewport-ready="true"]')).toBeVisible();
    return page.evaluate(async () => {
        let previous;
        let stable = 0;
        while (stable < 6) {
            await new Promise(requestAnimationFrame);
            const transform = document.querySelector(".react-flow__viewport")?.style.transform;
            stable = transform && transform === previous ? stable + 1 : 0;
            previous = transform;
        }
        return {
            transform: previous,
            nodes: [...document.querySelectorAll(".react-flow__node")].map((node) => {
                const bounds = node.getBoundingClientRect();
                return { id: node.dataset.id, x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
            }),
        };
    });
}

// Observe the real DOM, including mutation-time visibility, not just the final
// transform. A permanently hidden or unmeasured incoming graph cannot pass.
async function startCameraRecording(page) {
    await page.evaluate(() => {
        const outgoing = document.querySelector(".react-flow");
        const started = performance.now();
        const samples = [];
        let frame;
        const sample = (kind) => {
            const root = document.querySelector(".react-flow");
            const viewport = root?.querySelector(".react-flow__viewport");
            const nodes = [...(root?.querySelectorAll(".react-flow__node") ?? [])].map((node) => {
                const bounds = node.getBoundingClientRect();
                let visible = bounds.width > 0 && bounds.height > 0;
                for (let element = node; element; element = element.parentElement) {
                    const style = getComputedStyle(element);
                    if (style.visibility !== "visible" || style.display === "none" || Number(style.opacity) === 0) visible = false;
                }
                return { id: node.dataset.id, visible, x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
            });
            samples.push({
                kind, time: performance.now() - started, incoming: Boolean(root && root !== outgoing),
                tab: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
                transform: viewport?.style.transform, nodes,
            });
        };
        const observer = new MutationObserver(() => sample("mutation"));
        observer.observe(document.body, {
            subtree: true, childList: true, attributes: true,
            attributeFilter: ["style", "class", "aria-selected", "data-viewport-ready"],
        });
        const tick = () => { sample("frame"); frame = requestAnimationFrame(tick); };
        frame = requestAnimationFrame(tick);
        window.__stopCameraRecording = () => {
            cancelAnimationFrame(frame);
            observer.disconnect();
            delete window.__stopCameraRecording;
            return samples;
        };
    });
}

async function finishCameraRecording(page) {
    // Include subsequent paints so a late fit/restore after the first correct
    // frame is also caught. This is observation, never application readiness.
    await page.evaluate(async () => {
        for (let i = 0; i < 18; i++) await new Promise(requestAnimationFrame);
    });
    return page.evaluate(() => window.__stopCameraRecording());
}

function expectVisibleCamera(samples, saved, tabName, { compareBounds = true, requireFrame = true, incomingOnly = true } = {}) {
    const expectedIds = saved.nodes.map((node) => node.id).sort();
    const visible = samples.filter((sample) => (!incomingOnly || sample.incoming) && sample.tab === tabName && sample.nodes.some((node) => node.visible));
    expect(visible.length, "incoming graph must actually become visible").toBeGreaterThan(0);
    if (requireFrame) expect(visible.some((sample) => sample.kind === "frame"), "at least one painted-frame candidate must contain the graph").toBe(true);
    // Batch failures: tracing thousands of individual per-node expectations
    // obscures the switch itself and can dominate the medium-graph scenario.
    const failures = [];
    for (const sample of visible) {
        const label = `${sample.kind} at ${sample.time.toFixed(1)} ms`;
        if (sample.transform !== saved.transform) failures.push({ label, transform: sample.transform, expected: saved.transform });
        if (JSON.stringify(sample.nodes.map((node) => node.id).sort()) !== JSON.stringify(expectedIds)) {
            failures.push({ label, nodes: sample.nodes.map((node) => node.id), expectedIds });
        }
        for (const node of sample.nodes) {
            if (!node.visible || node.width <= 0 || node.height <= 0) failures.push({ label, node });
            if (compareBounds) {
                const expected = saved.nodes.find((candidate) => candidate.id === node.id);
                if (expected && ["x", "y", "width", "height"].some((key) => Math.abs(node[key] - expected[key]) >= 1)) {
                    failures.push({ label, node, expected });
                }
            }
        }
    }
    expect(failures).toEqual([]);
}

async function addCameraSkills(page, count) {
    const add = page.getByRole("button", { name: `Add ${skill} to canvas`, exact: true });
    for (let i = 0; i < count; i++) {
        await add.click();
        await expect(page.locator(".react-flow__node-custom")).toHaveCount(i + 1);
    }
}

async function dragCameraHandle(page, handle, target) {
    const bounds = await handle.boundingBox();
    expect(bounds).not.toBeNull();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 12 });
    await page.mouse.up();
}

async function addRepresentativeCameraGraph(page) {
    await addCameraSkills(page, 2);
    const second = page.locator(".react-flow__node-custom").nth(1);
    const bounds = await second.boundingBox();
    await page.mouse.move(bounds.x + 70, bounds.y + 18);
    await page.mouse.down();
    await page.mouse.move(bounds.x + 350, bounds.y + 18, { steps: 12 });
    await page.mouse.up();
    const first = page.locator(".react-flow__node-custom").first();
    const target = await second.locator(".target-handle").boundingBox();
    await dragCameraHandle(page, first.locator('[data-handleid="done"]'), { x: target.x + target.width / 2, y: target.y + target.height / 2 });
    const pane = await page.locator(".react-flow__pane").boundingBox();
    await dragCameraHandle(page, first.locator(".slot-skill-read-handle"), { x: pane.x + 150, y: pane.y + pane.height - 70 });
    await expect(page.locator(".react-flow__node-slot")).toHaveCount(1);
    await expect(page.locator(".react-flow__edge")).toHaveCount(2);
    await page.locator(".react-flow__pane").click({ button: "right", position: { x: 70, y: 90 } });
    await page.getByRole("button", { name: "New Compound State", exact: true }).click();
    await expect(page.locator(".react-flow__node-compound")).toHaveCount(1);
    await page.getByRole("button", { name: "Fit View", exact: true }).click();
    await settledCamera(page);
}

async function distinctCameraWorkflows(page, fixture = "one-node") {
    await openEditor(page);
    if (fixture === "representative") await addRepresentativeCameraGraph(page);
    else await addCameraSkills(page, fixture === "80-node" ? 80 : 1);
    for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "Zoom Out", exact: true }).click();
    const first = await settledCamera(page);
    await page.getByRole("button", { name: "Create new workflow tab", exact: true }).click();
    await addCameraSkills(page, 1);
    await page.getByRole("button", { name: "Zoom In", exact: true }).click();
    const second = await settledCamera(page);
    expect(first.transform).not.toBe(second.transform);
    return [first, second];
}

for (const fixture of ["one-node", "80-node", "representative"]) {
    test(`saved cameras are correct on the first visible incoming ${fixture} graph`, async ({ page }) => {
        test.setTimeout(60000);
        const cameras = await distinctCameraWorkflows(page, fixture);
        for (const index of [0, 1, 0, 1]) {
            await startCameraRecording(page);
            await workflowTabs(page).nth(index).click();
            await settledCamera(page);
            const samples = await finishCameraRecording(page);
            expectVisibleCamera(samples, cameras[index], `Workflow ${index + 1}`);
        }
    });
}

test("mode changes and Code remounts preserve each workflow camera", async ({ page }) => {
    const cameras = await distinctCameraWorkflows(page);
    for (const mode of ["Overview Mode", "Event Mode", "Slot Mode", "Event Mode"]) {
        await startCameraRecording(page);
        await page.getByRole("button", { name: mode, exact: true }).click();
        expect((await settledCamera(page)).transform).toBe(cameras[1].transform);
        expectVisibleCamera(await finishCameraRecording(page), cameras[1], "Workflow 2", { compareBounds: false, incomingOnly: false });
    }
    await page.getByRole("button", { name: "Code View", exact: true }).click();
    await expect(page.locator(".react-flow")).toHaveCount(0);
    await startCameraRecording(page);
    await page.getByRole("button", { name: "Event Mode", exact: true }).click();
    await settledCamera(page);
    expectVisibleCamera(await finishCameraRecording(page), cameras[1], "Workflow 2", { compareBounds: false });
    // The tab switch happens while there is no mounted React Flow store to read.
    await page.getByRole("button", { name: "Code View", exact: true }).click();
    await expect(page.locator(".react-flow")).toHaveCount(0);
    await workflowTabs(page).nth(0).click();
    await startCameraRecording(page);
    await page.getByRole("button", { name: "Event Mode", exact: true }).click();
    await settledCamera(page);
    expectVisibleCamera(await finishCameraRecording(page), cameras[0], "Workflow 1", { compareBounds: false });
    await page.getByRole("button", { name: "Code View", exact: true }).click();
    await expect(page.locator(".react-flow")).toHaveCount(0);
    await workflowTabs(page).nth(1).click();
    await startCameraRecording(page);
    await page.getByRole("button", { name: "Event Mode", exact: true }).click();
    await settledCamera(page);
    expectVisibleCamera(await finishCameraRecording(page), cameras[1], "Workflow 2", { compareBounds: false });
});

test("empty first placement becomes ready and stays interactive without a delayed fit", async ({ page }) => {
    await openEditor(page);
    for (let index = 0; index < 2; index++) {
        if (index) await page.getByRole("button", { name: "Create new workflow tab", exact: true }).click();
        const root = page.locator('.react-flow[data-viewport-ready="true"]');
        await expect(root).toBeVisible();
        const bounds = await root.boundingBox();
        expect(bounds.width).toBeGreaterThan(0);
        expect(bounds.height).toBeGreaterThan(0);
        await expect(page.locator(".react-flow__node")).toHaveCount(0);
        await addCameraSkills(page, 1);
        await page.getByRole("button", { name: "Zoom Out", exact: true }).click();
        const camera = await settledCamera(page);
        await startCameraRecording(page);
        await page.getByRole("button", { name: "Overview Mode", exact: true }).click();
        const samples = await finishCameraRecording(page);
        const visible = samples.filter((sample) => sample.nodes.some((node) => node.visible));
        expect(visible.length).toBeGreaterThan(0);
        for (const sample of visible) expect(sample.transform).toBe(camera.transform);
    }
});

test("rapid A to B to A activation cannot corrupt either saved camera", async ({ page }) => {
    const cameras = await distinctCameraWorkflows(page);
    await workflowTabs(page).nth(0).click();
    await settledCamera(page);
    await startCameraRecording(page);
    // Invoke the actual tab buttons, returning to A in the mutation microtask
    // that first sees B's mounted root, before a delayed placement frame.
    await page.evaluate(() => new Promise((resolve) => {
        const tabs = [...document.querySelectorAll('[role="tablist"][aria-label="Workflow tabs"] [role="tab"]')];
        const outgoing = document.querySelector(".react-flow");
        const observer = new MutationObserver(() => {
            if (document.querySelector(".react-flow") === outgoing || tabs[1].getAttribute("aria-selected") !== "true") return;
            observer.disconnect();
            tabs[0].click();
            resolve();
        });
        observer.observe(document.body, { childList: true, subtree: true });
        tabs[1].click();
    }));
    await settledCamera(page);
    const samples = await finishCameraRecording(page);
    expectVisibleCamera(samples, cameras[0], "Workflow 1");
    const intermediate = samples.filter((sample) => sample.incoming && sample.tab === "Workflow 2" && sample.nodes.some((node) => node.visible));
    if (intermediate.length) expectVisibleCamera(intermediate, cameras[1], "Workflow 2", { requireFrame: false });
    for (const index of [1, 0]) {
        await startCameraRecording(page);
        await workflowTabs(page).nth(index).click();
        await settledCamera(page);
        expectVisibleCamera(await finishCameraRecording(page), cameras[index], `Workflow ${index + 1}`);
    }
});
