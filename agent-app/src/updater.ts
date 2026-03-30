import { check } from "@tauri-apps/plugin-updater";

export async function checkForUpdates(): Promise<void> {
  try {
    const update = await check();
    if (!update) return;
    console.log(`Update available: ${update.version}`);
    await update.downloadAndInstall();
    console.log("Update installed — will apply on next restart");
  } catch (e) {
    // Non-fatal: update checks should never block the app
    console.warn("Update check failed:", e);
  }
}
