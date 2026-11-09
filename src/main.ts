import { getCurrentWindow } from "@tauri-apps/api/window";

/** 主题模式：浅色 / 深色 / 跟随系统（三态循环） */
type ThemeMode = "light" | "dark" | "system";

const STORAGE_KEY = "timegap:theme-mode";
const CYCLE: ThemeMode[] = ["light", "dark", "system"];
const LABEL: Record<ThemeMode, string> = {
  light: "浅色",
  dark: "深色",
  system: "跟随系统",
};

const prefersDark = window.matchMedia("(prefers-color-scheme: dark)");

function readStoredMode(): ThemeMode {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === "dark" || value === "system") return value;
  } catch {
    // localStorage 不可用时退回默认值
  }
  return "light";
}

function storeMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // 忽略写入失败，主题在本次会话内仍然生效
  }
}

/** 解析出实际生效的明暗，再写到 <html data-theme>，按钮图标跟随 <html data-mode> */
function applyMode(mode: ThemeMode): void {
  const root = document.documentElement;
  const effective = mode === "system" ? (prefersDark.matches ? "dark" : "light") : mode;

  root.dataset.mode = mode;
  root.dataset.theme = effective;

  const button = document.querySelector<HTMLButtonElement>("#theme-btn");
  if (button) {
    button.setAttribute("aria-label", `当前主题：${LABEL[mode]}，点击切换`);
    button.title = `当前主题：${LABEL[mode]}（点击切换：浅色 → 深色 → 跟随系统）`;
  }
}

function setupTheme(): void {
  let mode = readStoredMode();
  applyMode(mode);

  prefersDark.addEventListener("change", () => {
    if (mode === "system") applyMode(mode);
  });

  document.querySelector<HTMLButtonElement>("#theme-btn")?.addEventListener("click", () => {
    mode = CYCLE[(CYCLE.indexOf(mode) + 1) % CYCLE.length] ?? "light";
    storeMode(mode);
    applyMode(mode);
  });
}

function setupCloseButton(): void {
  document.querySelector<HTMLButtonElement>("#close-btn")?.addEventListener("click", async (event) => {
    event.stopPropagation();
    await getCurrentWindow().close();
  });
}

window.addEventListener("DOMContentLoaded", () => {
  setupTheme();
  setupCloseButton();
});
