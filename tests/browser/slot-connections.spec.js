import { test, expect } from "@playwright/test";

const skill = "demo.skills.Work";
const definition = {
  params: [],
  events: [{ event: "done" }],
  inSlots: [{ key: "input", type: "String" }],
  outSlots: [{ key: "output", type: "String" }],
};

async function addWork(page) {
  await page.route("**/api/**", (route) =>
    route.fulfill({
      json: new URL(route.request().url()).pathname === "/api/skills" ? { skills: [skill] } : definition,
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: `Add ${skill} to canvas`, exact: true }).click();
  await expect(page.locator(".react-flow__node-custom")).toHaveCount(1);
}

async function startDrag(page, handle) {
  const bounds = await handle.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
}
async function emptyPoint(page, fraction = 0.75) {
  const bounds = await page.locator(".react-flow__pane").boundingBox();
  return { x: bounds.x + bounds.width * fraction, y: bounds.y + bounds.height * 0.8 };
}
async function moveTo(page, handle) {
  const bounds = await handle.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, { steps: 10 });
}

test("read and write empty drops show a transient preview and create connected typed slots", async ({ page }) => {
  await addWork(page);
  await expect(page.locator(".canvas-controls").getByRole("button", { name: /New Slot/i })).toHaveCount(0);
  for (const [access, fraction] of [
    ["read", 0.75],
    ["write", 0.35],
  ]) {
    const before = await page.locator(".react-flow__node-slot").count();
    await startDrag(page, page.locator(`.react-flow__node-custom .slot-skill-${access}-handle`));
    const point = await emptyPoint(page, fraction);
    await page.mouse.move(point.x, point.y, { steps: 12 });
    await expect(page.locator(".slot-connection-preview")).toBeVisible();
    await expect(page.locator(".slot-connection-preview-type")).toContainText("String");
    await expect(page.locator(".react-flow__node-slot")).toHaveCount(before);
    await page.mouse.up();
    await expect(page.locator(".slot-connection-preview")).toHaveCount(0);
    await expect(page.locator(".react-flow__node-slot")).toHaveCount(before + 1);
    await expect(page.locator(`.react-flow__edge[data-id^="edge-slot-${access}-"]`)).toHaveCount(1);
  }
});

test("a slot-origin read drag connects an existing slot to a second skill without creating a default", async ({
  page,
}) => {
  await addWork(page);
  await startDrag(page, page.locator(".react-flow__node-custom .slot-skill-read-handle"));
  const point = await emptyPoint(page);
  await page.mouse.move(point.x, point.y, { steps: 12 });
  await page.mouse.up();
  await expect(page.locator(".react-flow__node-slot")).toHaveCount(1);
  await page.getByRole("button", { name: `Add ${skill} to canvas`, exact: true }).click();
  await expect(page.locator(".react-flow__node-custom")).toHaveCount(2);
  const target = page.locator(".react-flow__node-custom").last().locator(".slot-skill-read-handle");
  await startDrag(page, page.locator(".slot-node-read-handle"));
  await moveTo(page, target);
  await page.mouse.up();
  await expect(page.locator('.react-flow__edge[data-id^="edge-slot-read-"]')).toHaveCount(2);
  await expect(page.locator(".react-flow__node-slot")).toHaveCount(1);
  await expect(page.locator(".slot-connection-preview")).toHaveCount(0);
});

test("default slot previews and their created nodes stay at the cursor after zooming and panning", async ({ page }) => {
  await addWork(page);
  const pane = page.locator(".react-flow__pane");
  const viewport = page.locator(".react-flow__viewport");
  await page.locator(".react-flow__controls-zoomout").click();
  await expect
    .poll(() => viewport.evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).a))
    .toBeLessThan(0.95);
  const bounds = await pane.boundingBox();
  await page.mouse.move(bounds.x + 70, bounds.y + 70);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(bounds.x + 190, bounds.y + 130, { steps: 12 });
  await page.mouse.up({ button: "middle" });

  const handle = page.locator(".react-flow__node-custom .slot-skill-read-handle");
  await startDrag(page, handle);
  const point = await emptyPoint(page, 0.65);
  await page.mouse.move(point.x, point.y, { steps: 12 });
  const preview = page.locator(".slot-connection-preview");
  await expect(preview).toBeVisible();
  await expect
    .poll(async () => {
      const box = await preview.boundingBox();
      return Math.max(Math.abs(box.x - point.x), Math.abs(box.y - point.y));
    })
    .toBeLessThan(2);
  await page.mouse.up();
  const slot = page.locator(".react-flow__node-slot");
  await expect(slot).toHaveCount(1);
  await expect
    .poll(async () => {
      const box = await slot.boundingBox();
      return Math.max(Math.abs(box.x - point.x), Math.abs(box.y - point.y));
    })
    .toBeLessThan(2);
});

test("Escape and invalid target releases leave slot declarations and the graph untouched", async ({ page }) => {
  await addWork(page);
  const handle = page.locator(".react-flow__node-custom .slot-skill-read-handle");
  await startDrag(page, handle);
  const point = await emptyPoint(page);
  await page.mouse.move(point.x, point.y, { steps: 12 });
  await expect(page.locator(".slot-connection-preview")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(page.locator(".slot-connection-preview")).toHaveCount(0);
  await expect(page.locator(".react-flow__node-slot")).toHaveCount(0);
  await startDrag(page, handle);
  await moveTo(page, page.locator(".react-flow__node-custom .slot-skill-write-handle"));
  await page.mouse.up();
  await expect(page.locator(".react-flow__node-slot")).toHaveCount(0);
  await expect(page.locator('.react-flow__edge[data-id^="edge-slot-"]')).toHaveCount(0);
});

test("overview INITIAL badges fit inside skill headers while all hit areas remain enlarged", async ({ page }) => {
  await addWork(page);
  const node = page.locator(".react-flow__node-custom");
  await node.click();
  await page.locator(".initial-button").click();
  const badge = node.locator(".initial-state-badge-inline");
  await expect(badge).toBeVisible();
  const card = await node.boundingBox();
  const bounds = await badge.boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(card.x);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(card.x + card.width);
  expect(bounds.y).toBeGreaterThanOrEqual(card.y);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(card.y + card.height);
  expect(
    await node.locator(".custom-node-label").evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
});

test.describe("instance-specific configured slot problems", () => {
  const talkSkill = "demo.skills.dialog.Talk";

  for (const [access, slotProperty, key, title] of [
    ["read", "inSlots", "text", "Input"],
    ["write", "outSlots", "result", "Output"],
  ]) {
    test(`${title} requests retire and restore only their exact Talk owner`, async ({ page }) => {
      test.setTimeout(60_000);
      let includeDisabledRequest = false;
      const configuredRequests = [];
      await page.route("**/api/**", async (route) => {
        const request = route.request();
        if (new URL(request.url()).pathname === "/api/skills") {
          await route.fulfill({ json: { skills: [talkSkill] } });
          return;
        }
        const params = request.method() === "POST" ? request.postDataJSON().params : {};
        configuredRequests.push(params);
        const active = params.mode !== "off" || includeDisabledRequest;
        await route.fulfill({
          json: {
            params: [{ key: "mode", type: "String", default: "'on'" }],
            events: [{ event: "done" }],
            inSlots: [],
            outSlots: [],
            [slotProperty]: [...(active ? [{ key, type: "String" }] : []), { key: "later", type: "String" }],
          },
        });
      });
      await page.goto("/");
      await page.getByRole("textbox", { name: "Search skills" }).fill("Talk");
      const add = page.getByRole("button", { name: `Add ${talkSkill} to canvas`, exact: true });
      const nodes = page.locator(".react-flow__node-custom");
      await add.click();
      await expect(nodes).toHaveCount(1);
      await add.click();
      await expect(nodes).toHaveCount(2);
      const firstId = await nodes.nth(0).getAttribute("data-id");
      const secondId = await nodes.nth(1).getAttribute("data-id");
      expect(firstId).not.toBe(secondId);
      const first = page.locator(`.react-flow__node-custom[data-id="${firstId}"]`);
      const second = page.locator(`.react-flow__node-custom[data-id="${secondId}"]`);
      await expect(first.locator(".node-title-label")).toHaveText("Talk");
      await expect(first.locator(".node-instance-id")).toHaveText("#1");
      await expect(second.locator(".node-title-label")).toHaveText("Talk");
      await expect(second.locator(".node-instance-id")).toHaveText("#2");

      // Library insertion offsets overlap tall parameterized cards. Move
      // the second card so both owners remain reachable by real clicks.
      const header = second.locator(".custom-node-label");
      const headerBounds = await header.boundingBox();
      await startDrag(page, header);
      await page.mouse.move(
        headerBounds.x + headerBounds.width / 2 - 170,
        headerBounds.y + headerBounds.height / 2 - 80,
        { steps: 12 },
      );
      await page.mouse.up();

      const messages = page.locator(".problem-item-message");
      async function openProblems(node) {
        await node.locator(".custom-node-label").click();
        await page.getByRole("tab", { name: /^Problems/ }).click();
      }
      async function openSlots(node) {
        await node.locator(".custom-node-label").click();
        await page.getByRole("tab", { name: "Skill Detail", exact: true }).click();
        await page.getByRole("tab", { name: "Slots", exact: true }).click();
      }
      async function setMode(value) {
        await second.locator(".custom-node-label").click();
        await page.getByRole("tab", { name: "Skill Detail", exact: true }).click();
        await page.getByRole("tab", { name: "Parameter", exact: true }).click();
        const input = page.locator(".parameter-card").getByRole("combobox");
        await input.fill(`'${value}'`);
        await input.press("Enter");
      }
      const earlyHandle = second.locator(`[data-handleid="slot-skill-${access}-0"]`);
      const laterHandle = second.locator(`[data-handleid="slot-skill-${access}-1"]`);
      const laterInput = page.locator(`[id="${access === "read" ? "in" : "out"}-slot-${secondId}-1"]`);

      // Leave the early request empty but connect the later original index.
      await startDrag(page, laterHandle);
      const point = await emptyPoint(page);
      await page.mouse.move(point.x, point.y, { steps: 12 });
      await page.mouse.up();
      await expect(page.locator(".react-flow__node-slot")).toHaveCount(1);
      const edge = page.locator(`.react-flow__edge[data-id^="edge-slot-${access}-"]`);
      await expect(edge).toHaveCount(1);
      const edgeId = await edge.getAttribute("data-id");
      await openSlots(second);
      await expect(laterInput).not.toHaveValue("");
      const laterPath = await laterInput.inputValue();

      await openProblems(first);
      await expect(messages).toHaveText([`Talk#1.${key} has no slot path.`, "Talk#1.later has no slot path."]);
      await expect(page.locator(".problems-panel")).toContainText('Problems for "Talk#1"');
      await openProblems(second);
      await expect(messages).toHaveText([`Talk#2.${key} has no slot path.`]);
      await expect(page.locator(".problem-item-title")).toHaveText(`${title} slot is not connected`);
      await expect(second.locator(".node-warning-badge")).toBeVisible();
      await page.getByRole("button", { name: "Show all", exact: true }).click();
      await expect(messages).toHaveCount(3);
      await expect(messages.filter({ hasText: `Talk#2.${key} has no slot path.` })).toHaveCount(1);

      async function expectRetired() {
        await expect(earlyHandle).toHaveCount(0);
        await expect(laterHandle).toHaveCount(1);
        await expect(second.locator(".node-warning-badge")).toHaveCount(0);
        await expect(first.locator(".node-warning-badge")).toBeVisible();
        await openSlots(second);
        await expect(page.locator(".compact-slot-name")).toHaveText(["later"]);
        await expect(laterInput).toHaveValue(laterPath);
        await expect(edge).toHaveAttribute("data-id", edgeId);
        await openProblems(second);
        await expect(messages).toHaveCount(0);
        await expect(page.locator(".problems-panel")).toContainText("No problems for this node");
        // The empty selected-node view intentionally has no scope toggle.
        await page.locator(".react-flow__pane").click({ position: { x: 10, y: 10 } });
        await page.getByRole("tab", { name: /^Problems/ }).click();
        await expect(messages).toHaveText([`Talk#1.${key} has no slot path.`, "Talk#1.later has no slot path."]);
      }
      async function expectRestored() {
        await expect(earlyHandle).toHaveCount(1);
        await expect(laterHandle).toHaveCount(1);
        await expect(second.locator(".node-warning-badge")).toBeVisible();
        await openSlots(second);
        await expect(page.locator(".compact-slot-name")).toHaveText([key, "later"]);
        await expect(laterInput).toHaveValue(laterPath);
        await expect(edge).toHaveAttribute("data-id", edgeId);
        await openProblems(second);
        await expect(messages).toHaveText([`Talk#2.${key} has no slot path.`]);
      }

      // Automatic configuration inspection must invalidate flag-only changes.
      await setMode("off");
      await expect.poll(() => configuredRequests.some((params) => params.mode === "off")).toBe(true);
      await expectRetired();
      await setMode("on");
      await expectRestored();
      await setMode("off");
      await expectRetired();

      // A changed service definition is also applied by explicit refresh,
      // with each instance's own parameters rather than the selected one's.
      includeDisabledRequest = true;
      let requestCount = configuredRequests.length;
      await page.getByRole("button", { name: "Refresh skill nodes", exact: true }).click();
      await expectRestored();
      expect(configuredRequests.slice(requestCount)).toEqual(
        expect.arrayContaining([expect.objectContaining({ mode: "off" })]),
      );
      includeDisabledRequest = false;
      requestCount = configuredRequests.length;
      await page.getByRole("button", { name: "Refresh skill nodes", exact: true }).click();
      await expectRetired();
      expect(configuredRequests.slice(requestCount).some((params) => params.mode !== "off")).toBe(true);

      // Navigate a global missing-path row after selecting the other Talk.
      await setMode("on");
      await expectRestored();
      await openProblems(first);
      await page.getByRole("button", { name: "Show all", exact: true }).click();
      await page
        .locator(".problem-item")
        .filter({ hasText: `Talk#2.${key} has no slot path.` })
        .click();
      await expect(second).toHaveClass(/selected/);
      await expect(first).not.toHaveClass(/selected/);
      await expect(page.getByRole("tab", { name: "Slots", exact: true })).toHaveAttribute("aria-selected", "true");
      await expect(page.locator(`[id="${access === "read" ? "in" : "out"}-slot-${secondId}-0"]`)).toHaveValue("");
      await expect(laterInput).toHaveValue(laterPath);
    });
  }
});
