import { chromium } from "playwright-core";
import { simulatedDevice } from "../tests/fixtures/iot/device.mjs";
import { parseNvs } from "../services/api/src/nvs.js";
import assert from "node:assert/strict";
import { importPKCS8, SignJWT } from "jose";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const origin = process.env.TEST_SITE_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw Error("Expected a local TEST_SITE_URL");

const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN || "/usr/bin/google-chrome",
  args: ["--no-sandbox", "--no-proxy-server"],
});
const issuer = "https://clerk.esphub.ai";
const privateKey = await importPKCS8(process.env.TEST_SIGNING_KEY, "RS256");
// Match the signed session-token category enforced by the Clerk SDK.
const sessionHeader = {
  alg: "RS256",
  kid: "test",
  typ: "JWT",
  cat: "cl_B7d4PD111AAA",
};
const user = "user_" + randomUUID().replaceAll("-", "");
const jwt = await new SignJWT({ sid: "sess_qa", azp: origin })
  .setProtectedHeader(sessionHeader)
  .setSubject(user)
  .setIssuer(issuer)
  .setIssuedAt()
  .setExpirationTime("5m")
  .sign(privateKey);

let mcu;
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
  });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  let signedIn = false;
  await page.route("https://clerk.esphub.ai/npm/**", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      headers: { "Access-Control-Allow-Origin": "*" },
      body:
        "window.Clerk={load:async()=>{},session:" +
        (signedIn
          ? "{getToken:async()=>" + JSON.stringify(jwt) + "}"
          : "null") +
        ",signOut:async(options)=>{if(options.redirectUrl!=='https://esphub.ai/')throw Error('Unexpected redirect');location.assign('/signed-out')}}",
    }),
  );
  await page.route("https://accounts.esphub.ai/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "Hosted sign-in" }),
  );
  await page.route(origin + "/signed-out", (route) =>
    route.fulfill({ contentType: "text/html", body: "Signed out" }),
  );
  // Route the CDN hostname to the local Worker's real R2 and Images bindings.
  await page.route("https://cdn.esphub.ai/boards/**", async (route) => {
    const url = new URL(route.request().url());
    const response = await page.request.get(
      origin + "/backend/__cdn" + url.pathname + url.search,
    );
    await route.fulfill({ response });
  });

  // Landing page, SKILL.md, and Connect EspHub prompt copy.
  await page.goto(origin);
  await page.getByRole("heading", { name: "Vibe OTA your ESP32." }).waitFor();
  await page
    .context()
    .grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  assert.equal((await page.request.get(origin + "/SKILL.md")).status(), 200);
  await page.getByRole("button", { name: "Connect EspHub" }).click();
  await page.getByRole("button", { name: "Cursor", exact: true }).click();
  const connect = page.getByRole("dialog", { name: "Connect EspHub" });
  await connect.getByText(/Paste this prompt into Cursor/).waitFor();
  await connect.getByRole("button", { name: "Copy prompt" }).click();
  assert.match(
    await page.evaluate(() => navigator.clipboard.readText()),
    /https:\/\/esphub\.ai\/SKILL\.md/,
  );
  await page.keyboard.press("Escape");

  // Board gallery navigates directly to the board detail page (no product modal).
  const gallery = page.getByRole("region", { name: "Board gallery" });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const boards = await (
    await page.request.get(origin + "/backend/boards/gallery")
  ).json();
  const selected = boards.find(({ id }) => id === "m5stack/stopwatch");
  assert.ok(selected);
  const tile = gallery.getByRole("link", { name: selected.model, exact: true });
  await tile.scrollIntoViewIfNeeded();
  await tile.click();
  await page.waitForURL(origin + "/boards/" + selected.id);
  await page.getByRole("heading", { name: selected.name, exact: true }).waitFor();
  await page
    .getByRole("img", { name: selected.model })
    .evaluate((img) => img.decode());
  assert.equal(
    await page.getByRole("link", { name: "Product page" }).getAttribute("href"),
    selected.product_url,
  );
  await page.getByRole("heading", { name: /Runnable Projects/ }).waitFor();
  assert.equal(
    await page.locator('a[href*="/bootloaders/"], a[href$="/app"]').count(),
    0,
  );
  await page.getByRole("button", { name: /Connect to coding agent/ }).click();
  const detailPrompt = page.getByRole("dialog");
  await detailPrompt.getByRole("button", { name: "Codex", exact: true }).click();
  await detailPrompt.getByRole("button", { name: /Copy prompt/ }).click();
  assert.ok(
    (await page.evaluate(() => navigator.clipboard.readText())).includes(
      selected.id,
    ),
  );
  await page.keyboard.press("Escape");

  // Boards detail specs & clickable breadcrumb navigation.
  assert.equal(await page.locator(".bh-spec-cell").count(), 3);
  assert.equal(await page.locator(".bh-detail-nav").count(), 0);
  const breadcrumb = page.locator(".bh-breadcrumb");
  await breadcrumb.getByRole("link", { name: "M5Stack", exact: true }).click();
  await page.waitForURL(origin + "/boards?vendor=m5stack");
  await page.getByRole("link", { name: /StopWatch/ }).first().click();
  await page.waitForURL(origin + "/boards/m5stack/stopwatch");
  await breadcrumb.getByRole("link", { name: "Boards", exact: true }).click();
  await page.waitForURL(origin + "/boards");
  await page.getByRole("heading", { name: "Supported ESP32 Boards." }).waitFor();
  await page.getByRole("textbox", { name: "Search boards" }).fill("stopwatch");
  await page.getByRole("link", { name: /StopWatch/ }).first().click();
  await page.waitForURL(origin + "/boards/m5stack/stopwatch");

  // Directory shows only the cover. Detail shows the cover and the other images
  // in publication order, including when the cover isn't first in the list.
  const projectId = randomUUID();
  const imageBase = `https://cdn.esphub.ai/projects/${projectId}/images/`;
  const screenshots = ["1", "2", "3"].map(
    (n) => imageBase + n.repeat(64) + ".webp",
  );
  const pictured = {
    id: projectId,
    name: "Project with screenshots",
    description: "A project with a cover and two screenshots.",
    cover_image_url: screenshots[1],
    boards: [],
  };
  const noImages = {
    ...pictured,
    id: randomUUID(),
    name: "Project without screenshots",
    description: "A headless project.",
    cover_image_url: null,
  };
  await page.route(origin + "/backend/projects?*", (route) =>
    route.fulfill({
      json: {
        items: [pictured, noImages],
        total: 2,
        total_pages: 1,
        facets: { vendors: [], socs: [] },
      },
    }),
  );
  await page.route(origin + "/backend/projects/" + pictured.id, (route) =>
    route.fulfill({
      json: { ...pictured, images: screenshots.map((url) => ({ url })) },
    }),
  );
  await page.route(origin + "/backend/projects/" + noImages.id, (route) =>
    route.fulfill({ json: { ...noImages, images: [] } }),
  );
  await page.route(imageBase + "**", (route) =>
    route.fulfill({
      path: fileURLToPath(new URL("../tests/fixtures/board-photo.webp", import.meta.url)),
      contentType: "image/webp",
    }),
  );
  await page.getByRole("link", { name: "Projects", exact: true }).click();
  await page.waitForURL(origin + "/projects");
  await page.getByRole("heading", { name: "Runnable ESP32 Projects." }).waitFor();
  const picturedLink = page.getByRole("link", {
    name: /^Project with screenshots/,
  });
  const cardCover = picturedLink.locator("img");
  await cardCover.scrollIntoViewIfNeeded();
  assert.equal(await cardCover.getAttribute("src"), pictured.cover_image_url);
  await cardCover.evaluate((img) => img.decode());
  const noImagesLink = page.getByRole("link", {
    name: /^Project without screenshots/,
  });
  assert.equal(await noImagesLink.locator("img").count(), 0);

  await cardCover.click();
  await page.waitForURL(origin + "/projects/" + pictured.id);
  const detailCover = page.getByRole("link", {
    name: pictured.name + " cover image",
  });
  assert.equal(await detailCover.getAttribute("href"), pictured.cover_image_url);
  await detailCover.getByRole("img").evaluate((img) => img.decode());
  const galleryLinks = page.getByRole("region", { name: "Gallery" }).getByRole("link");
  assert.deepEqual(
    await galleryLinks.evaluateAll((links) => links.map((link) => link.href)),
    [screenshots[0], screenshots[2]],
  );
  for (const link of await galleryLinks.all()) {
    await link.scrollIntoViewIfNeeded();
    await link.getByRole("img").evaluate((img) => img.decode());
  }

  await page
    .getByRole("navigation", { name: "Breadcrumb" })
    .getByRole("link", { name: "Projects" })
    .click();
  await noImagesLink.click();
  await page.getByRole("heading", { name: noImages.name }).waitFor();
  assert.equal(await page.getByRole("region", { name: "Gallery" }).count(), 0);
  assert.equal(await page.locator(".pj-detail-cover").count(), 0);

  // Unauthenticated workspace redirect.
  await page.getByRole("link", { name: "Open workspace" }).click();
  await page.waitForURL("https://accounts.esphub.ai/sign-in?**");
  assert.equal(
    new URL(page.url()).searchParams.get("redirect_url"),
    origin + "/devices",
  );

  // Signed-in console: empty state -> MCP device creation -> live Online refresh.
  signedIn = true;
  await page.goto(origin + "/devices");
  await page.getByText("No devices yet.").waitFor();

  const accessToken = await new SignJWT({
    iss: issuer,
    aud: "https://api.esphub.ai/mcp",
    sub: user,
    jti: randomUUID(),
    client_id: "test-public-client",
    scope: "devices:read devices:write",
  })
    .setProtectedHeader({ alg: "RS256", kid: "test", typ: "at+jwt" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  const operate = async (name, args = {}) => {
    const response = await fetch(origin + "/backend/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + accessToken,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    assert.equal(response.status, 200, name);
    const body = await response.text();
    const data = body.split("\n").find((line) => line.startsWith("data: "));
    const { result } = JSON.parse(data ? data.slice(6) : body);
    assert.ok(!result.isError, name + ": " + result.content?.[0]?.text);
    return JSON.parse(result.content[0].text);
  };

  const board = await operate("devices_create", {
    name: "Paper Color integration",
    board: "m5stack/paper-color",
  });
  await page.reload();

  const card = page
    .locator('[data-slot="card"]')
    .filter({ hasText: "Paper Color integration" });
  await card.getByText("m5stack/paper-color", { exact: true }).waitFor();
  await card.getByText("Offline", { exact: true }).waitFor();
  const photo = card.locator("img");
  await photo.waitFor();
  assert.ok(
    (await photo.evaluate(async (img) => {
      await img.decode();
      return img.naturalWidth;
    })) > 0,
  );

  const nvs = board.flash.files.find((file) => file.name === "nvs.bin");
  const nvsResponse = await fetch(
    origin + "/backend" + new URL(nvs.url).pathname,
    { headers: nvs.headers },
  );
  assert.equal(nvsResponse.status, 200);
  const boardToken = parseNvs(
    new Uint8Array(await nvsResponse.arrayBuffer()),
  ).eh.tok;
  mcu = simulatedDevice(origin, boardToken);
  await mcu.hello({ bootloader_version: "test", role: "bootloader" });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await card.getByText("Online", { exact: true }).waitFor();

  // Workspace Projects tab: private by default -> toggle public in Web UI.
  const personal = await operate("projects_create", {
    name: "Browser E2E Personal App",
    description: "Personal project visibility smoke test.",
  });
  assert.equal(personal.visibility, "private");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.getByRole("tab", { name: /^Projects \(1\)/ }).click();
  const projectCard = page
    .locator('[data-slot="card"]')
    .filter({ hasText: "Browser E2E Personal App" });
  await projectCard.getByText("Private", { exact: true }).waitFor();
  assert.equal(await projectCard.locator("select").count(), 0);
  await projectCard.getByRole("button", { name: "Make public" }).click();
  await projectCard.getByText("Public", { exact: true }).waitFor();
  await projectCard.getByRole("button", { name: "Make private" }).waitFor();
  await page.getByRole("tab", { name: /^Devices/ }).click();

  // Console MCP prompt dialogs and sign-out.
  for (const name of ["Manage devices", "Bind my ESP32"]) {
    await page.getByRole("button", { name, exact: true }).click();
    const dialog = page.getByRole("dialog", { name });
    const prompt = await dialog.getByLabel("Prompt").inputValue();
    assert.ok(prompt.includes("https://api.esphub.ai/mcp"), name);
    await dialog.getByRole("button", { name: "Copy prompt" }).click();
    await dialog.getByRole("button", { name: "Copied", exact: true }).waitFor();
    assert.equal(
      await page.evaluate(() => navigator.clipboard.readText()),
      prompt,
    );
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
  }

  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL(origin + "/signed-out");
  assert.deepEqual(errors, []);
  console.log(
    "PASS landing, board gallery, project images, hosted auth, device console, live status, MCP prompts",
  );
} finally {
  mcu?.close();
  await browser.close();
}
