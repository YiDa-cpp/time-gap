import { getCurrentWindow } from "@tauri-apps/api/window";

/* ============================================================
   主题：浅色 / 深色 / 跟随系统（三态循环，持久化）
   ============================================================ */

type ThemeMode = "light" | "dark" | "system";

const THEME_KEY = "timegap:theme-mode";
const THEME_CYCLE: ThemeMode[] = ["light", "dark", "system"];
const THEME_LABEL: Record<ThemeMode, string> = {
  light: "浅色",
  dark: "深色",
  system: "跟随系统",
};

const prefersDark = window.matchMedia("(prefers-color-scheme: dark)");

function readStoredTheme(): ThemeMode {
  try {
    const value = localStorage.getItem(THEME_KEY);
    if (value === "dark" || value === "system") return value;
  } catch {
    // localStorage 不可用时退回默认值
  }
  return "light";
}

function storeTheme(mode: ThemeMode): void {
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch {
    // 忽略写入失败，本次会话内主题仍然生效
  }
}

function applyTheme(mode: ThemeMode): void {
  const root = document.documentElement;
  const effective = mode === "system" ? (prefersDark.matches ? "dark" : "light") : mode;

  root.dataset.mode = mode;
  root.dataset.theme = effective;

  const button = document.querySelector<HTMLButtonElement>("#theme-btn");
  if (button) {
    button.setAttribute("aria-label", `当前主题：${THEME_LABEL[mode]}，点击切换`);
    button.title = `当前主题：${THEME_LABEL[mode]}（点击切换：浅色 → 深色 → 跟随系统）`;
  }
}

function setupTheme(): void {
  let mode = readStoredTheme();
  applyTheme(mode);

  prefersDark.addEventListener("change", () => {
    if (mode === "system") applyTheme(mode);
  });

  document.querySelector<HTMLButtonElement>("#theme-btn")?.addEventListener("click", () => {
    mode = THEME_CYCLE[(THEME_CYCLE.indexOf(mode) + 1) % THEME_CYCLE.length] ?? "light";
    storeTheme(mode);
    applyTheme(mode);
  });
}

/* ============================================================
   世界时钟：永远显示系统真实时间，与倒计时完全解耦
   ============================================================ */

const WORLD_DIGITS = Array.from(document.querySelectorAll<HTMLElement>("[data-digit]"));

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

function renderWorldClock(): void {
  const now = new Date();
  const digits =
    pad2(now.getHours()) + pad2(now.getMinutes()) + pad2(now.getSeconds());

  WORLD_DIGITS.forEach((el, index) => {
    const next = digits.charAt(index) || "0";
    if (el.textContent !== next) el.textContent = next;
  });

  document
    .getElementById("clock")
    ?.setAttribute(
      "aria-label",
      `当前时间 ${digits.slice(0, 2)}:${digits.slice(2, 4)}:${digits.slice(4, 6)}`,
    );
}

function startWorldClock(): void {
  renderWorldClock();

  // 对齐到真实秒边界，避免整秒漂移
  const delay = 1000 - (Date.now() % 1000);
  window.setTimeout(() => {
    renderWorldClock();
    window.setInterval(renderWorldClock, 1000);
  }, delay);
}

/* ============================================================
   倒计时：默认 25:00，可开始 / 暂停 / 继续，归零后重新开始
   ============================================================ */

const FOCUS_MS = 25 * 60 * 1000;
const TICK_MS = 100;

type Phase = "idle" | "running" | "paused" | "finished";

let phase: Phase = "idle";
let remainingMs = FOCUS_MS;
let deadline = 0;
let ticker: number | null = null;

const primaryButton = document.querySelector<HTMLButtonElement>("#primary-btn");
const countdownEl = document.getElementById("countdown");
const progressEl = document.getElementById("progress");
const progressFillEl = document.getElementById("progress-fill");

function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  return `${pad2(Math.floor(totalSeconds / 60))}:${pad2(totalSeconds % 60)}`;
}

function renderCountdown(): void {
  if (countdownEl) countdownEl.textContent = formatCountdown(remainingMs);

  const barVisible = phase === "running" || phase === "paused";
  progressEl?.classList.toggle("is-visible", barVisible);

  if (progressFillEl) {
    const ratio = Math.max(0, Math.min(1, remainingMs / FOCUS_MS));
    progressFillEl.style.width = `${(ratio * 100).toFixed(2)}%`;
  }

  if (primaryButton) {
    primaryButton.textContent =
      phase === "running" ? "暂停" : phase === "paused" ? "继续" : "开始专注";
    primaryButton.setAttribute("aria-pressed", String(phase === "running"));
  }

  document.documentElement.dataset.phase = phase;
}

function stopTicker(): void {
  if (ticker !== null) {
    window.clearInterval(ticker);
    ticker = null;
  }
}

function handleTick(): void {
  remainingMs = Math.max(0, deadline - performance.now());

  if (remainingMs <= 0) {
    finishFocus();
    return;
  }

  renderCountdown();
}

function startTicker(ms: number): void {
  stopTicker();
  remainingMs = ms;
  deadline = performance.now() + ms;
  ticker = window.setInterval(handleTick, TICK_MS);
  handleTick();
}

function finishFocus(): void {
  stopTicker();
  phase = "finished";
  remainingMs = 0;
  renderCountdown();

  if (primaryButton) {
    primaryButton.classList.remove("flash");
    // 强制重排以便动画可以重复触发
    void primaryButton.offsetWidth;
    primaryButton.classList.add("flash");
  }
}

function toggleFocus(): void {
  if (phase === "running") {
    remainingMs = Math.max(0, deadline - performance.now());
    stopTicker();
    phase = "paused";
    renderCountdown();
    return;
  }

  const nextMs = phase === "paused" ? remainingMs : FOCUS_MS;
  primaryButton?.classList.remove("flash");
  phase = "running";
  startTicker(nextMs);
}

/* ============================================================
   科目标签：点击即可输入，本地记住上次填写的内容
   ============================================================ */

const SUBJECT_KEY = "timegap:subject";

function setupSubject(): void {
  const input = document.querySelector<HTMLInputElement>("#subject");
  if (!input) return;

  try {
    const saved = localStorage.getItem(SUBJECT_KEY);
    if (saved) input.value = saved;
  } catch {
    // 忽略读取失败
  }

  input.addEventListener("input", () => {
    try {
      localStorage.setItem(SUBJECT_KEY, input.value);
    } catch {
      // 忽略写入失败
    }
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") input.blur();
  });
}

/* ============================================================
   快捷键：Space 开始 / 暂停（仅在窗口内生效，输入时让位）
   ============================================================ */

function setupKeyboard(): void {
  window.addEventListener("keydown", (event) => {
    if (event.code !== "Space") return;

    const target = event.target as HTMLElement | null;
    const typing =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      Boolean(target?.isContentEditable);
    if (typing) return;

    event.preventDefault();
    toggleFocus();
  });
}

/* ============================================================
   窗口关闭
   ============================================================ */

function setupCloseButton(): void {
  document
    .querySelector<HTMLButtonElement>("#close-btn")
    ?.addEventListener("click", async (event) => {
      event.stopPropagation();
      await getCurrentWindow().close();
    });
}

/* ============================================================
   启动
   ============================================================ */

window.addEventListener("DOMContentLoaded", () => {
  setupTheme();
  setupCloseButton();
  setupSubject();
  setupKeyboard();
  setupFocusButton();
  startWorldClock();
  renderCountdown();
});

function setupFocusButton(): void {
  primaryButton?.addEventListener("click", toggleFocus);
}
