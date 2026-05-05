import { test, expect } from "@playwright/test";

test("Ask AI launcher opens, sends, streams a response with at least one citation", async ({ page }) => {
  await page.goto("/chapter-1-introduction/");
  await page.locator(".chat-launcher").click();
  await expect(page.locator(".chat-window")).toBeVisible();

  await page.evaluate(() => (window as any).MirrorBactChatTest?.send("Summarize this chapter."));

  await expect(page.locator(".chat-msg-assistant .chat-msg-bubble")).not.toBeEmpty({ timeout: 30_000 });
  const link = page.locator(".chat-msg-assistant .chat-msg-bubble a[href*='#']");
  await expect(link.first()).toBeVisible({ timeout: 30_000 });
});
