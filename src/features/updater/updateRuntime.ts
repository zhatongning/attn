export function shouldCheckForUpdates(isProductionBuild: boolean, isTauriRuntime: boolean) {
  return isProductionBuild && isTauriRuntime;
}

export function isPackagedUpdaterRuntime() {
  const isTauriRuntime = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  return shouldCheckForUpdates(import.meta.env.PROD, isTauriRuntime);
}
