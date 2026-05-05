import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  timeout: 60_000,
  use: { baseURL: process.env.SITE_URL || "http://localhost:8765" },
});
