import { getCurrentWindow, currentMonitor, cursorPosition } from "@tauri-apps/api/window";
import { LogicalSize, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";

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
    // 忽略写入失败
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
   窗口实例（惰性获取，避免非 Tauri 环境模块加载即抛错）
   ============================================================ */

let cachedWindow: ReturnType<typeof getCurrentWindow> | null = null;

function appWindow(): ReturnType<typeof getCurrentWindow> {
  cachedWindow ??= getCurrentWindow();
  return cachedWindow;
}

/* ============================================================
   翻页时钟：世界时间，上下半页 3D 翻折叠
   ============================================================ */

interface FlipCard {
  value: string;
  faceTop: HTMLElement[];
  faceBottom: HTMLElement[];
  flapTop: HTMLElement[];
  flapBottom: HTMLElement[];
  timer: number | null;
}

const FLIP_MS = 640;
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const FLIP_LAYOUT = `
  <div class="face top"><span></span><span></span></div>
  <div class="face bottom"><span></span><span></span></div>
  <div class="flap top"><span></span><span></span></div>
  <div class="flap bottom"><span></span><span></span></div>
`;

function createFlipCard(el: HTMLElement): FlipCard {
  el.innerHTML = FLIP_LAYOUT;
  const pickAll = (selector: string): HTMLElement[] =>
    Array.from(el.querySelectorAll<HTMLElement>(selector));

  return {
    value: "",
    faceTop: pickAll(".face.top span"),
    faceBottom: pickAll(".face.bottom span"),
    flapTop: pickAll(".flap.top span"),
    flapBottom: pickAll(".flap.bottom span"),
    timer: null,
  };
}

const flipCards = Array.from(document.querySelectorAll<HTMLElement>(".flip-card")).map(
  (el) => ({ el, card: createFlipCard(el) }),
);

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

function writePair(spans: HTMLElement[], value: string): void {
  spans.forEach((span, index) => {
    span.textContent = value.charAt(index) || "0";
  });
}

/** 一张卡片承载两位数字（如 13）；上半页绕中线折下，下半页接住 */
function setPair(entry: { el: HTMLElement; card: FlipCard }, next: string, animate: boolean): void {
  const { el, card } = entry;
  if (card.value === next) return;

  const previous = card.value || next;
  card.value = next;

  writePair(card.faceTop, next);
  writePair(card.flapTop, previous);
  writePair(card.flapBottom, next);

  if (card.timer !== null) {
    window.clearTimeout(card.timer);
    card.timer = null;
  }

  if (!animate || reduceMotion.matches) {
    writePair(card.faceBottom, next);
    el.classList.remove("is-flipping");
    return;
  }

  writePair(card.faceBottom, previous);
  el.classList.remove("is-flipping");
  // 强制重排，保证连续两次变化也能重启动画
  void el.offsetHeight;
  el.classList.add("is-flipping");

  card.timer = window.setTimeout(() => {
    writePair(card.faceBottom, next);
    el.classList.remove("is-flipping");
    card.timer = null;
  }, FLIP_MS);
}

function renderWorldClock(animate: boolean): void {
  const now = new Date();
  const digits =
    pad2(now.getHours()) + pad2(now.getMinutes()) + pad2(now.getSeconds());
  const pairs = [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 6)];

  flipCards.forEach((entry, index) => {
    setPair(entry, pairs[index] ?? "00", animate);
  });

  document
    .getElementById("clock")
    ?.setAttribute(
      "aria-label",
      `当前时间 ${digits.slice(0, 2)}:${digits.slice(2, 4)}:${digits.slice(4, 6)}`,
    );
}

function startWorldClock(): void {
  renderWorldClock(false);

  // 对齐到真实秒边界，避免整秒漂移
  const delay = 1000 - (Date.now() % 1000);
  window.setTimeout(() => {
    renderWorldClock(true);
    window.setInterval(() => renderWorldClock(true), 1000);
  }, delay);
}

/* ============================================================
   倒计时：默认 25:00，可在待机时自定义；可开始 / 暂停 / 结束
   ============================================================ */

const DEFAULT_FOCUS_MINUTES = 25;
const MIN_FOCUS_MINUTES = 1;
const MAX_FOCUS_MINUTES = 180;
const TICK_MS = 100;
const DURATION_KEY = "timegap:focus-minutes";

function readStoredMinutes(): number {
  try {
    const raw = Number(localStorage.getItem(DURATION_KEY));
    if (Number.isFinite(raw) && raw >= MIN_FOCUS_MINUTES && raw <= MAX_FOCUS_MINUTES) {
      return Math.round(raw);
    }
  } catch {
    // 忽略读取失败
  }
  return DEFAULT_FOCUS_MINUTES;
}

type Phase = "idle" | "running" | "paused" | "finished";

let phase: Phase = "idle";
let focusMs = readStoredMinutes() * 60 * 1000;
let remainingMs = focusMs;
let deadline = 0;
let ticker: number | null = null;

const primaryButton = document.querySelector<HTMLButtonElement>("#primary-btn");
const resetButton = document.querySelector<HTMLButtonElement>("#reset-btn");
const countdownEl = document.querySelector<HTMLButtonElement>("#countdown");
const progressEl = document.getElementById("progress");
const progressFillEl = document.getElementById("progress-fill");

function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  return `${pad2(Math.floor(totalSeconds / 60))}:${pad2(totalSeconds % 60)}`;
}

let lastPhase: Phase | null = null;

function renderCountdown(): void {
  const text = formatCountdown(remainingMs);

  if (countdownEl) {
    if (countdownEl.textContent !== text) {
      countdownEl.textContent = text;
      countdownEl.setAttribute(
        "aria-label",
        `倒计时 ${text}${phase === "idle" ? "，点击设置专注时长" : ""}`,
      );
    }
    countdownEl.disabled = phase !== "idle" || layout === "compact";
  }

  if (progressFillEl) {
    const ratio = Math.max(0, Math.min(1, remainingMs / focusMs));
    progressFillEl.style.width = `${(ratio * 100).toFixed(2)}%`;
  }

  // 阶段相关的 UI 只在阶段真正变化时更新，避免每 100ms 触发无效重排
  if (lastPhase !== phase) {
    lastPhase = phase;

    progressEl?.classList.toggle("is-visible", phase === "running" || phase === "paused");

    if (primaryButton) {
      primaryButton.textContent =
        phase === "running" ? "暂停" : phase === "paused" ? "继续" : "开始专注";
      primaryButton.setAttribute("aria-pressed", String(phase === "running"));
    }

    if (resetButton) {
      resetButton.disabled = phase === "idle";
    }

    document.documentElement.dataset.phase = phase;
  }
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

  const nextMs = phase === "paused" ? remainingMs : focusMs;
  primaryButton?.classList.remove("flash");
  closeDurationPopover();
  phase = "running";
  startTicker(nextMs);
}

function resetFocus(): void {
  stopTicker();
  phase = "idle";
  remainingMs = focusMs;
  primaryButton?.classList.remove("flash");
  renderCountdown();
}

/* ---------- 待机时自定义专注时长 ---------- */

const durationPop = document.getElementById("duration-pop");
const durationInput = document.querySelector<HTMLInputElement>("#duration-input");

function openDurationPopover(): void {
  if (phase !== "idle" || layout !== "normal" || !durationPop || !durationInput) return;

  durationInput.value = String(Math.round(focusMs / 60000));
  durationPop.hidden = false;
  durationInput.focus();
  durationInput.select();
}

function closeDurationPopover(): void {
  if (durationPop) durationPop.hidden = true;
}

function applyDuration(): void {
  if (!durationInput) {
    closeDurationPopover();
    return;
  }

  const raw = Number(durationInput.value);
  const minutes = Number.isFinite(raw)
    ? Math.min(MAX_FOCUS_MINUTES, Math.max(MIN_FOCUS_MINUTES, Math.round(raw)))
    : DEFAULT_FOCUS_MINUTES;

  focusMs = minutes * 60 * 1000;
  remainingMs = focusMs;

  try {
    localStorage.setItem(DURATION_KEY, String(minutes));
  } catch {
    // 忽略写入失败
  }

  renderCountdown();
  closeDurationPopover();
}

/* ============================================================
   置顶开关（默认不置顶，由用户决定）
   ============================================================ */

let pinned = false;

async function applyPinned(next: boolean): Promise<void> {
  pinned = next;
  document.documentElement.dataset.pinned = String(pinned);

  document.querySelectorAll<HTMLButtonElement>(".pin-btn").forEach((button) => {
    button.setAttribute("aria-pressed", String(pinned));
    button.setAttribute("aria-label", pinned ? "取消置顶" : "置顶窗口");
    button.title = pinned ? "取消置顶" : "置顶窗口";
  });

  try {
    await appWindow().setAlwaysOnTop(pinned);
  } catch (error) {
    console.warn("切换置顶失败", error);
  }
}

/* ============================================================
   窗口形态：常规 / 全屏专注 / 精简胶囊（可拖拽 + 贴边半隐藏）
   ============================================================ */

type Layout = "normal" | "fullscreen" | "compact";

const COMPACT_WIDTH = 300;
const COMPACT_HEIGHT = 80;
const NORMAL_WIDTH = 900;
const NORMAL_HEIGHT = 540;
const DOCK_EDGE = 14;

let layout: Layout = "normal";
let savedBounds: { x: number; y: number; width: number; height: number } | null = null;

let dockSide: "left" | "right" | "top" | "bottom" | null = null;
let dockTimer: number | null = null;
let adjustingUntil = 0;
let suppressDockUntil = 0;

function applyLayout(next: Layout): void {
  layout = next;
  document.documentElement.dataset.layout = next;
  closeDurationPopover();
  renderCountdown();
}

async function moveTo(x: number, y: number): Promise<void> {
  adjustingUntil = Date.now() + 450;
  try {
    await appWindow().setPosition(new PhysicalPosition(Math.round(x), Math.round(y)));
  } catch (error) {
    console.warn("移动窗口失败", error);
  }
}

let slideId = 0;

/** 逐帧插值的窗口滑动，避免贴边收放时“跳”一下 */
async function slideTo(targetX: number, targetY: number): Promise<void> {
  const id = ++slideId;

  let start: { x: number; y: number };
  try {
    const position = await appWindow().outerPosition();
    start = { x: position.x, y: position.y };
  } catch {
    return;
  }

  const dx = targetX - start.x;
  const dy = targetY - start.y;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;

  const duration = 200;
  const begin = performance.now();
  adjustingUntil = Date.now() + duration + 350;

  await new Promise<void>((resolve) => {
    const step = async (): Promise<void> => {
      if (id !== slideId) {
        resolve();
        return;
      }

      const progress = Math.min(1, (performance.now() - begin) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);

      try {
        await appWindow().setPosition(
          new PhysicalPosition(
            Math.round(start.x + dx * eased),
            Math.round(start.y + dy * eased),
          ),
        );
      } catch {
        resolve();
        return;
      }

      if (progress < 1) {
        requestAnimationFrame(() => void step());
      } else {
        resolve();
      }
    };

    void step();
  });
}

async function enterFullscreen(): Promise<void> {
  if (layout === "compact") await restoreFromCompact();
  try {
    await appWindow().setFullscreen(true);
    applyLayout("fullscreen");
  } catch (error) {
    console.warn("setFullscreen 失败", error);
  }
}

async function exitFullscreen(): Promise<void> {
  try {
    await appWindow().setFullscreen(false);
  } catch (error) {
    console.warn("setFullscreen 失败", error);
  }
  applyLayout("normal");
}

async function toggleFullscreen(): Promise<void> {
  if (layout === "fullscreen") {
    await exitFullscreen();
  } else {
    await enterFullscreen();
  }
}

async function enterCompact(): Promise<void> {
  if (layout === "compact") return;
  if (layout === "fullscreen") await exitFullscreen();

  dockSide = null;
  dockRevealed = false;
  stopDockPolling();

  try {
    const position = await appWindow().outerPosition();
    const size = await appWindow().outerSize();
    savedBounds = {
      x: position.x,
      y: position.y,
      width: size.width,
      height: size.height,
    };

    const monitor = await currentMonitor();
    const scale = monitor?.scaleFactor ?? 1;
    const width = Math.round(COMPACT_WIDTH * scale);
    const height = Math.round(COMPACT_HEIGHT * scale);

    suppressDockUntil = Date.now() + 900;
    await appWindow().setSize(new PhysicalSize(width, height));
    // 胶囊形态锁定尺寸，避免拖拽时被拉变形
    await appWindow().setResizable(false);

    if (monitor) {
      // 初始停靠在当前屏幕右上角，留 16px 边距，之后可自由拖拽
      const margin = Math.round(16 * scale);
      const x = monitor.position.x + monitor.size.width - width - margin;
      const y = monitor.position.y + margin;
      await moveTo(x, y);
    }
  } catch (error) {
    console.warn("切换精简模式失败", error);
  }

  applyLayout("compact");
}

async function restoreFromCompact(): Promise<void> {
  if (layout !== "compact") return;

  dockSide = null;
  dockRevealed = false;
  stopDockPolling();
  suppressDockUntil = 0;

  try {
    await appWindow().setResizable(true);
    if (savedBounds) {
      await appWindow().setSize(new PhysicalSize(savedBounds.width, savedBounds.height));
      await moveTo(savedBounds.x, savedBounds.y);
    } else {
      await appWindow().setSize(new LogicalSize(NORMAL_WIDTH, NORMAL_HEIGHT));
    }
  } catch (error) {
    console.warn("还原窗口失败", error);
  }

  applyLayout("normal");
}

/* ---------- 贴边完全隐藏 ---------- */

const DOCK_PEEK = 2;
const DOCK_BAND = 10;

let dockPollTimer: number | null = null;
let dockRevealed = false;

async function applyDock(visible: boolean): Promise<void> {
  if (!dockSide) return;

  const position = await appWindow().outerPosition();
  const size = await appWindow().outerSize();
  const monitor = await currentMonitor();
  if (!monitor) return;

  const monX = monitor.position.x;
  const monY = monitor.position.y;
  const monWidth = monitor.size.width;
  const monHeight = monitor.size.height;

  let { x, y } = position;

  if (dockSide === "left") {
    x = visible ? monX : monX - size.width + DOCK_PEEK;
    y = position.y;
  } else if (dockSide === "right") {
    x = visible ? monX + monWidth - size.width : monX + monWidth - DOCK_PEEK;
    y = position.y;
  } else if (dockSide === "top") {
    x = position.x;
    y = visible ? monY : monY - size.height + DOCK_PEEK;
  } else {
    x = position.x;
    y = visible ? monY + monHeight - size.height : monY + monHeight - DOCK_PEEK;
  }

  dockRevealed = visible;
  await slideTo(x, y);
}

async function evaluateDock(): Promise<void> {
  if (layout !== "compact" || Date.now() < suppressDockUntil) return;

  const position = await appWindow().outerPosition();
  const size = await appWindow().outerSize();
  const monitor = await currentMonitor();
  if (!monitor) return;

  const monX = monitor.position.x;
  const monY = monitor.position.y;
  const monWidth = monitor.size.width;
  const monHeight = monitor.size.height;

  let side: typeof dockSide = null;
  if (position.x <= monX + DOCK_EDGE) side = "left";
  else if (position.x + size.width >= monX + monWidth - DOCK_EDGE) side = "right";
  else if (position.y <= monY + DOCK_EDGE) side = "top";
  else if (position.y + size.height >= monY + monHeight - DOCK_EDGE) side = "bottom";

  if (side === dockSide) return;

  dockSide = side;
  dockRevealed = false;

  if (side) {
    await applyDock(false);
    startDockPolling();
  } else {
    stopDockPolling();
  }
}

/** 完全隐藏后无法靠 mouseenter 唤醒，改为轮询光标位置 */
function startDockPolling(): void {
  stopDockPolling();
  dockPollTimer = window.setInterval(() => void pollDockCursor(), 160);
}

function stopDockPolling(): void {
  if (dockPollTimer !== null) {
    window.clearInterval(dockPollTimer);
    dockPollTimer = null;
  }
}

async function pollDockCursor(): Promise<void> {
  if (layout !== "compact" || !dockSide || Date.now() < adjustingUntil) return;

  let cursor: { x: number; y: number };
  let position: { x: number; y: number };
  let size: { width: number; height: number };
  let monitor: Awaited<ReturnType<typeof currentMonitor>>;

  try {
    [cursor, position, size, monitor] = await Promise.all([
      cursorPosition(),
      appWindow().outerPosition(),
      appWindow().outerSize(),
      currentMonitor(),
    ]);
  } catch {
    return;
  }

  if (!monitor) return;

  const monX = monitor.position.x;
  const monY = monitor.position.y;
  const monRight = monX + monitor.size.width;
  const monBottom = monY + monitor.size.height;

  if (!dockRevealed) {
    // 光标贴到对应边缘的那一段，才把胶囊拉出来
    const nearVerticalSpan =
      cursor.y >= position.y - 40 && cursor.y <= position.y + size.height + 40;
    const nearHorizontalSpan =
      cursor.x >= position.x - 40 && cursor.x <= position.x + size.width + 40;

    const inBand =
      dockSide === "left"
        ? cursor.x <= monX + DOCK_BAND && nearVerticalSpan
        : dockSide === "right"
          ? cursor.x >= monRight - DOCK_BAND && nearVerticalSpan
          : dockSide === "top"
            ? cursor.y <= monY + DOCK_BAND && nearHorizontalSpan
            : cursor.y >= monBottom - DOCK_BAND && nearHorizontalSpan;

    if (inBand) await applyDock(true);
    return;
  }

  // 已经展开：光标离开窗口范围就收回去
  const padding = 14;
  const outside =
    cursor.x < position.x - padding ||
    cursor.x > position.x + size.width + padding ||
    cursor.y < position.y - padding ||
    cursor.y > position.y + size.height + padding;

  if (outside || cursor.x < monX - 4 || cursor.x > monRight + 4 || cursor.y > monBottom + 4) {
    await applyDock(false);
  }
}

async function setupDockWatcher(): Promise<void> {
  try {
    await appWindow().onMoved(() => {
      if (layout !== "compact") return;
      if (Date.now() < adjustingUntil) return;

      if (dockTimer !== null) window.clearTimeout(dockTimer);
      dockTimer = window.setTimeout(() => {
        dockTimer = null;
        void evaluateDock();
      }, 280);
    });
  } catch (error) {
    console.warn("监听窗口移动失败", error);
  }
}

function setupDockHover(): void {
  const card = document.querySelector<HTMLElement>(".glass-card");
  if (!card) return;

  card.addEventListener("dblclick", () => {
    if (layout === "compact") void restoreFromCompact();
  });
}

/* ============================================================
   科目标签：点击输入，本地记住
   ============================================================ */

const SUBJECT_KEY = "timegap:subject";

function setupSubject(): void {
  const input = document.querySelector<HTMLInputElement>("#subject");
  if (!input) return;

  try {
    const saved = localStorage.getItem(SUBJECT_KEY);
    if (saved) input.value = saved;
  } catch {
    // 忽略
  }

  input.addEventListener("input", () => {
    try {
      localStorage.setItem(SUBJECT_KEY, input.value);
    } catch {
      // 忽略
    }
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") input.blur();
  });
}

/* ============================================================
   快捷键：Space 开始 / 暂停，Esc 退出全屏或还原胶囊
   ============================================================ */

function setupKeyboard(): void {
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (durationPop && !durationPop.hidden) {
        event.preventDefault();
        closeDurationPopover();
        return;
      }

      if (layout === "fullscreen") {
        event.preventDefault();
        void exitFullscreen();
      } else if (layout === "compact") {
        event.preventDefault();
        void restoreFromCompact();
      }
      return;
    }

    if (event.code !== "Space" && event.code !== "KeyF") return;

    const target = event.target as HTMLElement | null;
    const typing =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      Boolean(target?.isContentEditable);
    if (typing) return;

    event.preventDefault();

    if (event.code === "KeyF") {
      void toggleFullscreen();
      return;
    }

    toggleFocus();
  });
}

/* ============================================================
   按钮绑定
   ============================================================ */

function setupButtons(): void {
  primaryButton?.addEventListener("click", toggleFocus);
  resetButton?.addEventListener("click", resetFocus);

  countdownEl?.addEventListener("click", openDurationPopover);

  document
    .querySelector<HTMLButtonElement>("#duration-ok")
    ?.addEventListener("click", applyDuration);

  document
    .querySelector<HTMLButtonElement>("#duration-cancel")
    ?.addEventListener("click", closeDurationPopover);

  durationInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      applyDuration();
    }
  });

  document
    .querySelectorAll<HTMLButtonElement>(".pin-btn")
    .forEach((button) => button.addEventListener("click", () => void applyPinned(!pinned)));

  document
    .querySelector<HTMLButtonElement>("#fullscreen-btn")
    ?.addEventListener("click", () => void toggleFullscreen());

  document
    .querySelector<HTMLButtonElement>("#exit-fs-btn")
    ?.addEventListener("click", () => void exitFullscreen());

  document
    .querySelector<HTMLButtonElement>("#compact-btn")
    ?.addEventListener("click", () => void enterCompact());

  document
    .querySelector<HTMLButtonElement>("#expand-btn")
    ?.addEventListener("click", (event) => {
      event.stopPropagation();
      void restoreFromCompact();
    });

  document
    .querySelector<HTMLButtonElement>("#close-btn")
    ?.addEventListener("click", async (event) => {
      event.stopPropagation();
      await appWindow().close();
    });
}

/* ============================================================
   启动
   ============================================================ */

window.addEventListener("DOMContentLoaded", () => {
  setupTheme();
  setupSubject();
  setupKeyboard();
  setupButtons();
  setupDockHover();
  startWorldClock();
  renderCountdown();

  void applyPinned(false);
  void setupDockWatcher();
});
