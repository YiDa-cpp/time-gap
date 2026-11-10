import { getCurrentWindow, currentMonitor, cursorPosition } from "@tauri-apps/api/window";
import { LogicalSize, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import { invoke } from "@tauri-apps/api/core";

/* ============================================================
   主题：浅色 / 深色 / 跟随系统（三态循环，持久化）
   ============================================================ */

type ThemeMode = "light" | "dark" | "system";

const THEME_KEY = "timegap:theme-mode";

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

  document.querySelectorAll<HTMLButtonElement>("#theme-seg .seg-btn").forEach((button) => {
    const active = button.dataset.themeMode === mode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function setupTheme(): void {
  let mode = readStoredTheme();
  applyTheme(mode);

  prefersDark.addEventListener("change", () => {
    if (mode === "system") applyTheme(mode);
  });

  document.querySelectorAll<HTMLButtonElement>("#theme-seg .seg-btn").forEach((button) => {
    button.addEventListener("click", () => {
      const next = button.dataset.themeMode as ThemeMode | undefined;
      if (!next) return;
      mode = next;
      storeTheme(mode);
      applyTheme(mode);
    });
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
   番茄钟：专注 → 5 分钟休息 → 准备下一轮
   ============================================================ */

const DEFAULT_FOCUS_MINUTES = 25;
const MIN_FOCUS_MINUTES = 1;
const MAX_FOCUS_MINUTES = 180;
const BREAK_MS = 5 * 60 * 1000;
const DEFAULT_GOAL = 4;
const MIN_GOAL = 1;
const MAX_GOAL = 12;
const GOAL_KEY = "timegap:daily-goal";
const TICK_MS = 100;
const DURATION_KEY = "timegap:focus-minutes";
const MUTE_KEY = "timegap:muted";
const STARS_KEY = "timegap:stars";

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

type Phase = "idle" | "running" | "paused" | "break" | "ready";

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
const statusEl = document.getElementById("status");
const starsEl = document.getElementById("stars");
const rippleHost = document.getElementById("ripple");

/* ---------- 今日目标星星 ---------- */

function todayKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

function readStars(): number {
  try {
    const raw = localStorage.getItem(STARS_KEY);
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as { date?: string; count?: number };
    if (parsed.date !== todayKey() || typeof parsed.count !== "number") return 0;
    return Math.max(0, parsed.count);
  } catch {
    return 0;
  }
}

function readGoal(): number {
  try {
    const raw = Number(localStorage.getItem(GOAL_KEY));
    if (Number.isFinite(raw) && raw >= MIN_GOAL && raw <= MAX_GOAL) return Math.round(raw);
  } catch {
    // 忽略读取失败
  }
  return DEFAULT_GOAL;
}

let goal = readGoal();
let stars = readStars();

function renderStars(): void {
  if (!starsEl) return;
  const shown = Math.min(stars, goal);
  starsEl.replaceChildren();
  for (let index = 0; index < goal; index += 1) {
    const star = document.createElement("span");
    star.className = index < shown ? "star is-lit" : "star";
    star.textContent = "★";
    starsEl.appendChild(star);
  }
  starsEl.setAttribute("aria-label", `今日目标 ${shown}/${goal}，点击设置`);
}

function addStar(): void {
  stars = Math.min(goal, stars + 1);
  try {
    localStorage.setItem(STARS_KEY, JSON.stringify({ date: todayKey(), count: stars }));
  } catch {
    // 忽略写入失败
  }
  renderStars();
}

/* ---------- 今日目标设置（点击星星区域） ---------- */

const goalPop = document.getElementById("goal-pop");
const goalGrid = document.getElementById("goal-grid");

function renderGoalChips(): void {
  if (!goalGrid) return;
  goalGrid.replaceChildren();

  for (let value = MIN_GOAL; value <= MAX_GOAL; value += 1) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = value === goal ? "goal-chip is-active" : "goal-chip";
    chip.textContent = String(value);
    chip.addEventListener("click", (event) => {
      event.stopPropagation();
      goal = value;
      try {
        localStorage.setItem(GOAL_KEY, String(goal));
      } catch {
        // 忽略
      }
      renderGoalChips();
      renderStars();
      closeGoalPopover();
    });
    goalGrid.appendChild(chip);
  }
}

function openGoalPopover(): void {
  if (!goalPop) return;
  renderGoalChips();
  goalPop.hidden = false;
}

function closeGoalPopover(): void {
  if (goalPop) goalPop.hidden = true;
}

function setupGoalPicker(): void {
  starsEl?.addEventListener("click", (event) => {
    event.stopPropagation();
    if (goalPop?.hidden !== false) openGoalPopover();
    else closeGoalPopover();
  });

  document.addEventListener("click", (event) => {
    if (!goalPop || goalPop.hidden) return;
    const target = event.target as Node;
    if (goalPop.contains(target) || starsEl?.contains(target)) return;
    closeGoalPopover();
  });
}

/* ---------- 提示音（Web Audio 合成） ---------- */

let audioCtx: AudioContext | null = null;
let muted = readMuted();

function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

function playDing(kind: "focus" | "break" = "focus"): void {
  if (muted) return;

  try {
    audioCtx ??= new AudioContext();
    if (audioCtx.state === "suspended") void audioCtx.resume();

    const ctx = audioCtx;
    const now = ctx.currentTime;
    const base = kind === "focus" ? 880 : 660;

    [1, 1.5, 2].forEach((ratio, index) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = base * ratio;
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(0.16 / (index + 1), now + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.1);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 1.15);
    });
  } catch {
    // 音频不可用时静默失败
  }
}

/* ---------- 完成水波纹 ---------- */

function showRipple(): void {
  if (!rippleHost) return;

  [0, 130].forEach((delay) => {
    const ring = document.createElement("span");
    ring.className = "ripple-ring";
    ring.style.animationDelay = `${delay}ms`;
    ring.style.opacity = "0";
    rippleHost.appendChild(ring);
    window.setTimeout(() => ring.remove(), 900 + delay);
  });
}

/* ---------- 渲染 ---------- */

let lastPhase: Phase | null = null;

function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  return `${pad2(Math.floor(totalSeconds / 60))}:${pad2(totalSeconds % 60)}`;
}

function renderCountdown(): void {
  const text = formatCountdown(remainingMs);

  if (countdownEl) {
    if (countdownEl.textContent !== text) {
      countdownEl.textContent = text;
      countdownEl.setAttribute(
        "aria-label",
        `倒计时 ${text}${phase === "idle" || phase === "ready" ? "，点击设置专注时长" : ""}`,
      );
    }
    countdownEl.disabled = (phase !== "idle" && phase !== "ready") || layout === "compact";
  }

  if (progressFillEl) {
    const total = phase === "break" ? BREAK_MS : focusMs;
    const ratio = Math.max(0, Math.min(1, remainingMs / total));
    progressFillEl.style.width = `${(ratio * 100).toFixed(2)}%`;
  }

  // 阶段相关的 UI 只在阶段真正变化时更新，避免每 100ms 触发无效重排
  if (lastPhase !== phase) {
    lastPhase = phase;

    progressEl?.classList.toggle("is-visible", phase === "running" || phase === "paused" || phase === "break");

    if (primaryButton) {
      primaryButton.textContent =
        phase === "running"
          ? "暂停"
          : phase === "paused"
            ? "继续"
            : phase === "break"
              ? "跳过休息"
              : phase === "ready"
                ? "开始下一轮"
                : "开始专注";
      primaryButton.setAttribute("aria-pressed", String(phase === "running"));
    }

    if (resetButton) {
      resetButton.disabled = phase === "idle";
    }

    if (statusEl) {
      statusEl.textContent =
        phase === "break"
          ? "休息中 · 放松一下眼睛"
          : phase === "ready"
            ? "准备下一轮"
            : "";
      statusEl.classList.toggle("is-visible", phase === "break" || phase === "ready");
    }

    document.documentElement.dataset.phase = phase;
  }
}

/* ---------- 计时驱动 ---------- */

function stopTicker(): void {
  if (ticker !== null) {
    window.clearInterval(ticker);
    ticker = null;
  }
}

function handleTick(): void {
  remainingMs = Math.max(0, deadline - performance.now());

  if (remainingMs <= 0) {
    if (phase === "break") {
      finishBreak();
    } else {
      finishFocus();
    }
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

/* ---------- 状态流转 ---------- */

function startFocus(): void {
  phase = "running";
  primaryButton?.classList.remove("flash");
  closeDurationPopover();
  ensureAudio();
  startTicker(focusMs);
}

function finishFocus(): void {
  stopTicker();
  phase = "break";
  remainingMs = BREAK_MS;
  renderCountdown();

  addStar();
  showRipple();
  playDing("focus");
  recordFocusSession();

  if (statsPanel && !statsPanel.hidden) {
    void loadSessions().then(renderStats);
  }

  if (primaryButton) {
    primaryButton.classList.remove("flash");
    void primaryButton.offsetWidth;
    primaryButton.classList.add("flash");
  }

  startTicker(BREAK_MS);
}

function finishBreak(): void {
  stopTicker();
  phase = "ready";
  remainingMs = focusMs;
  renderCountdown();
  playDing("break");
}

function skipBreak(): void {
  if (phase !== "break") return;
  finishBreak();
}

function toggleFocus(): void {
  if (phase === "break") {
    skipBreak();
    return;
  }

  if (phase === "running") {
    remainingMs = Math.max(0, deadline - performance.now());
    stopTicker();
    phase = "paused";
    renderCountdown();
    return;
  }

  if (phase === "paused") {
    phase = "running";
    startTicker(remainingMs);
    return;
  }

  startFocus();
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
  if ((phase !== "idle" && phase !== "ready") || layout !== "normal" || !durationPop || !durationInput) {
    return;
  }

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
   四时段学习建议：按「日期 + 时段」确定性选取，同一天保持稳定
   ============================================================ */

const TIP_LIBRARY: Record<"morning" | "noon" | "afternoon" | "evening", string[]> = {
  morning: [
    "起床后 1–2 小时是记忆的黄金窗口，先攻最难的那科。",
    "开始前先写下一句话：这 25 分钟我要解决什么。",
    "把手机放到另一个房间，比调成静音有效十倍。",
    "用 5 分钟回顾昨天的笔记，比重新读一遍更牢。",
    "早晨别急着刷消息，先完成一个番茄再打开社交软件。",
    "困难任务放在上午，意志力像电池，早满晚空。",
    "先做 2 分钟起步动作：打开书、写下标题，惯性会接管。",
    "喝口水、拉开窗帘，光照会提升警觉度。",
    "今天只挑三个重点，其余都是加分项。",
    "用「教别人」的心态读这一章，理解会立刻变深。",
    "把大目标拆成能在 25 分钟内闭环的小块。",
    "开始前先做一次 30 秒深呼吸，让注意力落地。",
  ],
  noon: [
    "午饭后容易犯困，别硬扛，出门走 10 分钟比咖啡管用。",
    "中午适合做机械性任务：整理笔记、背单词、刷题。",
    "饭后 20 分钟内不要立刻高强度用脑，先消化。",
    "午睡控制在 20 分钟内，超过会进入深睡反而更累。",
    "把下午要做的三件事写在纸上，下午就不用再想。",
    "中午做一次「检索练习」：合上书复述上午学的。",
    "少食多餐，血糖平稳时专注力更稳。",
    "午间可以用 5 分钟整理桌面，环境整洁降低认知负荷。",
    "别在中午做重大决定，判断力在低谷。",
    "给下午设一个最小目标：只要开始 5 分钟就算成功。",
  ],
  afternoon: [
    "下午 2–4 点是身体的自然低谷，用短番茄（15 分钟）过渡。",
    "犯困时站起来学，走动比坐着更能维持清醒。",
    "把最难的理解题放在 3 点后，那是第二个小高峰。",
    "每 50 分钟看一次 20 英尺外的东西 20 秒，护眼也护专注。",
    "用番茄钟时把手机放到看不见的地方，视觉线索最勾人。",
    "遇到卡壳先写下问题，跳过去，回头再攻，避免陷进去。",
    "把「我要学完」改成「我要做完这三道题」，目标要可验证。",
    "下午适合输出：写小结、画思维导图、给别人讲一遍。",
    "学习前先关掉所有通知，中断一次平均要 23 分钟才能回神。",
    "给自己设「结束时间」而不是「学习时长」，效率会更高。",
    "换个座位或换个房间，环境变化能重启注意力。",
    "困的时候用冷水洗脸，比再喝一杯咖啡更立竿见影。",
  ],
  evening: [
    "晚上适合复习而不是新学，睡眠会帮你巩固白天内容。",
    "睡前 1 小时调暗灯光，蓝光会推迟褪黑素分泌。",
    "把明天要做的第一件事写下来，能显著降低入睡焦虑。",
    "用「间隔重复」回顾三天前的内容，记忆最牢。",
    "晚上做 10 分钟「自由回忆」：合上书，写下今天学了什么。",
    "别用熬夜补偿白天的低效，睡眠不足会抹掉记忆。",
    "把手机充电放在床外，早晨的第一小时会完全不同。",
    "晚上适合整理错题，把错误分类比重做更有效。",
    "睡前读纸质书比刷短视频更容易入睡。",
    "给今天留一句复盘：哪一步做对了，明天保留它。",
  ],
};

const tipEl = document.getElementById("tip");
let currentTipKey = "";

function slotOf(hour: number): keyof typeof TIP_LIBRARY {
  if (hour >= 6 && hour < 11) return "morning";
  if (hour >= 11 && hour < 13) return "noon";
  if (hour >= 13 && hour < 18) return "afternoon";
  return "evening";
}

function hashString(value: string): number {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

let lastTipIndex = -1;

function refreshTip(): void {
  if (!tipEl) return;

  const now = new Date();
  const slot = slotOf(now.getHours());
  const key = `${todayKey()}-${slot}`;
  if (key === currentTipKey) return;

  currentTipKey = key;
  const pool = TIP_LIBRARY[slot];
  lastTipIndex = hashString(key) % pool.length;
  tipEl.textContent = pool[lastTipIndex] ?? "";
}

/** 「换一换」：随机换到当前时段的另一条，不影响日期种子 */
function nextTip(): void {
  if (!tipEl) return;

  const pool = TIP_LIBRARY[slotOf(new Date().getHours())];
  if (pool.length <= 1) return;

  let index = lastTipIndex;
  while (index === lastTipIndex) {
    index = Math.floor(Math.random() * pool.length);
  }
  lastTipIndex = index;
  tipEl.textContent = pool[index] ?? "";
}

function setupTips(): void {
  refreshTip();
  window.setInterval(refreshTip, 30_000);
  document.querySelector<HTMLButtonElement>("#tip-next")?.addEventListener("click", (event) => {
    event.stopPropagation();
    nextTip();
  });
}

/* ============================================================
   静音开关（提示音）
   ============================================================ */

function ensureAudio(): void {
  if (muted) return;
  try {
    audioCtx ??= new AudioContext();
    if (audioCtx.state === "suspended") void audioCtx.resume();
  } catch {
    // 忽略
  }
}

function setupMute(): void {
  const toggle = document.querySelector<HTMLButtonElement>("#mute-toggle");

  const paint = (): void => {
    document.documentElement.dataset.muted = String(muted);
    if (!toggle) return;
    toggle.setAttribute("aria-checked", String(!muted));
    toggle.classList.toggle("is-on", !muted);
    toggle.setAttribute("aria-label", muted ? "提示音已关闭" : "提示音已开启");
  };

  paint();

  toggle?.addEventListener("click", (event) => {
    event.stopPropagation();
    muted = !muted;
    try {
      localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
    } catch {
      // 忽略
    }
    paint();
    if (!muted) playDing("focus");
  });
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
  await persistGeometry();
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

  // 进入胶囊前先把普通形态的坐标存下来，胶囊态不参与记忆
  await persistGeometry();

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

/* ---------- 窗口位置记忆（仅普通布局下保存） ---------- */

let geometryTimer: number | null = null;

async function persistGeometry(): Promise<void> {
  if (layout !== "normal") return;
  try {
    await invoke("save_window_state");
  } catch {
    // 非 Tauri 环境或命令失败时静默忽略
  }
}

function scheduleSaveGeometry(): void {
  if (layout !== "normal") return;
  if (geometryTimer !== null) window.clearTimeout(geometryTimer);
  geometryTimer = window.setTimeout(() => {
    geometryTimer = null;
    void persistGeometry();
  }, 600);
}

async function setupDockWatcher(): Promise<void> {
  try {
    await appWindow().onMoved(() => {
      scheduleSaveGeometry();

      if (layout !== "compact") return;
      if (Date.now() < adjustingUntil) return;

      if (dockTimer !== null) window.clearTimeout(dockTimer);
      dockTimer = window.setTimeout(() => {
        dockTimer = null;
        void evaluateDock();
      }, 280);
    });

    await appWindow().onResized(() => scheduleSaveGeometry());
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
const HISTORY_KEY = "timegap:subject-history";

function readHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string").slice(0, 8);
  } catch {
    return [];
  }
}

function rememberSubject(value: string): void {
  const trimmed = value.trim();
  if (!trimmed) return;

  const history = readHistory().filter((item) => item !== trimmed);
  history.unshift(trimmed);

  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 8)));
  } catch {
    // 忽略写入失败
  }
}

/* ---------- 自定义科目下拉（不用原生 datalist） ---------- */

const subjectInput = document.querySelector<HTMLInputElement>("#subject");
const subjectMenu = document.getElementById("subject-menu");
let subjectActiveIndex = -1;

function filterHistory(query: string): string[] {
  const history = readHistory();
  const keyword = query.trim().toLowerCase();
  if (!keyword) return history;
  return history.filter((item) => item.toLowerCase().includes(keyword));
}

function positionSubjectMenu(): void {
  if (!subjectInput || !subjectMenu) return;

  const host = subjectMenu.offsetParent as HTMLElement | null;
  const card = document.querySelector<HTMLElement>(".glass-card");
  const hostRect = (host ?? card)?.getBoundingClientRect();
  if (!hostRect) return;

  const inputRect = subjectInput.getBoundingClientRect();

  subjectMenu.style.left = `${Math.round(inputRect.left - hostRect.left)}px`;
  subjectMenu.style.top = `${Math.round(inputRect.bottom - hostRect.top + 6)}px`;
  subjectMenu.style.width = `${Math.round(inputRect.width)}px`;
}

function deleteHistory(value: string): void {
  const next = readHistory().filter((item) => item !== value);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {
    // 忽略
  }
  paintSubjectMenu();
  subjectInput?.focus();
}

function paintSubjectMenu(): void {
  if (!subjectInput || !subjectMenu) return;

  const items = filterHistory(subjectInput.value);
  subjectMenu.replaceChildren();

  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "subject-empty";
    empty.textContent = subjectInput.value.trim() ? "没有匹配的历史科目" : "还没有历史科目";
    subjectMenu.appendChild(empty);
  } else {
    items.forEach((value, index) => {
      const item = document.createElement("div");
      item.className = index === subjectActiveIndex ? "subject-item is-active" : "subject-item";
      item.setAttribute("role", "option");
      item.setAttribute("tabindex", "-1");
      item.dataset.value = value;

      const label = document.createElement("span");
      label.className = "subject-label";
      label.textContent = value;

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "subject-remove";
      remove.setAttribute("aria-label", `删除历史「${value}」`);
      remove.title = "从历史中删除";
      remove.textContent = "×";
      remove.addEventListener("mousedown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        deleteHistory(value);
      });

      item.append(remove, label);
      item.addEventListener("mousedown", (event) => {
        event.preventDefault();
        chooseSubject(value);
      });
      subjectMenu.appendChild(item);
    });
  }

  subjectActiveIndex = Math.min(subjectActiveIndex, items.length - 1);
  subjectMenu.hidden = false;
  positionSubjectMenu();
  subjectInput.setAttribute("aria-expanded", "true");
}

function closeSubjectMenu(): void {
  if (!subjectMenu) return;
  subjectMenu.hidden = true;
  subjectActiveIndex = -1;
  subjectInput?.setAttribute("aria-expanded", "false");
}

function chooseSubject(value: string): void {
  if (!subjectInput) return;
  subjectInput.value = value;
  try {
    localStorage.setItem(SUBJECT_KEY, value);
  } catch {
    // 忽略
  }
  closeSubjectMenu();
  subjectInput.blur();
}

function setupSubject(): void {
  if (!subjectInput) return;

  try {
    const saved = localStorage.getItem(SUBJECT_KEY);
    if (saved) subjectInput.value = saved;
  } catch {
    // 忽略
  }

  subjectInput.addEventListener("input", () => {
    try {
      localStorage.setItem(SUBJECT_KEY, subjectInput.value);
    } catch {
      // 忽略
    }
    subjectActiveIndex = -1;
    paintSubjectMenu();
  });

  subjectInput.addEventListener("focus", () => {
    subjectActiveIndex = -1;
    paintSubjectMenu();
  });

  subjectInput.addEventListener("blur", () => {
    rememberSubject(subjectInput.value);
    window.setTimeout(closeSubjectMenu, 120);
  });

  subjectInput.addEventListener("keydown", (event) => {
    const items = filterHistory(subjectInput.value);

    if (event.key === "ArrowDown") {
      event.preventDefault();
      subjectActiveIndex = Math.min(items.length - 1, subjectActiveIndex + 1);
      paintSubjectMenu();
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      subjectActiveIndex = Math.max(0, subjectActiveIndex - 1);
      paintSubjectMenu();
      return;
    }

    if (event.key === "Enter") {
      if (subjectActiveIndex >= 0 && items[subjectActiveIndex]) {
        event.preventDefault();
        chooseSubject(items[subjectActiveIndex]);
      } else {
        rememberSubject(subjectInput.value);
        closeSubjectMenu();
        subjectInput.blur();
      }
      return;
    }

    if (event.key === "Escape") {
      closeSubjectMenu();
    }
  });
}

/* ============================================================
   专注统计（M3）：会话落盘 + 统计面板
   ============================================================ */

interface SessionRecord {
  start: string;
  end: string;
  durationSec: number;
  subject: string;
  completed: boolean;
}

const SESSION_FALLBACK_KEY = "timegap:sessions";

function readFallbackSessions(): SessionRecord[] {
  try {
    const raw = localStorage.getItem(SESSION_FALLBACK_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as SessionRecord[]) : [];
  } catch {
    return [];
  }
}

function writeFallbackSessions(list: SessionRecord[]): void {
  try {
    localStorage.setItem(SESSION_FALLBACK_KEY, JSON.stringify(list.slice(-500)));
  } catch {
    // 忽略写入失败
  }
}

async function loadSessions(): Promise<SessionRecord[]> {
  try {
    const data = await invoke<SessionRecord[]>("load_sessions");
    return Array.isArray(data) ? data : [];
  } catch {
    // 非 Tauri 环境或命令失败：回退到本地缓存，保证面板仍可用
    return readFallbackSessions();
  }
}

async function persistSession(record: SessionRecord): Promise<void> {
  try {
    await invoke("save_session", { session: record });
  } catch {
    writeFallbackSessions([...readFallbackSessions(), record]);
  }
}

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** 连续专注天数：今天有记录从今天起算，否则从昨天起算，按本地日期逐天回溯 */
function computeStreak(sessions: SessionRecord[]): number {
  const activeDays = new Set<string>();

  sessions.forEach((session) => {
    const startedAt = new Date(session.start);
    if (!Number.isNaN(startedAt.getTime())) activeDays.add(dateKey(startedAt));
  });

  if (activeDays.size === 0) return 0;

  const cursor = new Date();
  if (!activeDays.has(dateKey(cursor))) {
    cursor.setDate(cursor.getDate() - 1);
    if (!activeDays.has(dateKey(cursor))) return 0;
  }

  let streak = 0;
  while (activeDays.has(dateKey(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }

  return streak;
}

const statsPanel = document.getElementById("stats-panel");
const statsChart = document.getElementById("stats-chart");
const statsHint = document.getElementById("stats-hint");

function renderStats(sessions: SessionRecord[]): void {
  const today = dateKey(new Date());
  let todaySeconds = 0;
  let todayCount = 0;
  let totalSeconds = 0;
  let longestSeconds = 0;
  const subjectTotals = new Map<string, number>();

  const days: { key: string; label: string; seconds: number }[] = [];
  for (let offset = 6; offset >= 0; offset -= 1) {
    const day = new Date();
    day.setDate(day.getDate() - offset);
    days.push({
      key: dateKey(day),
      label: `${day.getMonth() + 1}/${day.getDate()}`,
      seconds: 0,
    });
  }

  sessions.forEach((session) => {
    const startedAt = new Date(session.start);
    if (Number.isNaN(startedAt.getTime())) return;

    const key = dateKey(startedAt);
    const seconds = Math.max(0, Math.round(session.durationSec || 0));

    totalSeconds += seconds;
    longestSeconds = Math.max(longestSeconds, seconds);

    const subject = (session.subject || "未分类").trim() || "未分类";
    subjectTotals.set(subject, (subjectTotals.get(subject) ?? 0) + seconds);

    if (key === today) {
      todaySeconds += seconds;
      todayCount += 1;
    }

    const bucket = days.find((item) => item.key === key);
    if (bucket) bucket.seconds += seconds;
  });

  const minutesEl = document.getElementById("stat-today-min");
  const countEl = document.getElementById("stat-today-count");
  const totalEl = document.getElementById("stat-total-hours");
  const longestEl = document.getElementById("stat-longest");

  if (minutesEl) minutesEl.textContent = String(Math.round(todaySeconds / 60));
  if (countEl) countEl.textContent = String(todayCount);

  if (totalEl) {
    const hours = totalSeconds / 3600;
    totalEl.textContent =
      hours <= 0 ? "0" : hours < 10 ? hours.toFixed(1) : String(Math.round(hours));
  }

  if (longestEl) longestEl.textContent = String(Math.round(longestSeconds / 60));

  const streakEl = document.getElementById("stat-streak");
  if (streakEl) streakEl.textContent = String(computeStreak(sessions));

  if (statsChart) {
    statsChart.replaceChildren();
    const peak = Math.max(...days.map((day) => day.seconds), 1);

    days.forEach((day) => {
      const column = document.createElement("div");
      column.className = "chart-col";

      const bar = document.createElement("div");
      bar.className = "chart-bar";
      if (day.key === today) bar.classList.add("is-today");
      const height = day.seconds === 0 ? 3 : Math.max(8, Math.round((day.seconds / peak) * 86));
      bar.style.height = `${height}%`;
      bar.title = `${day.label} · ${Math.round(day.seconds / 60)} 分钟`;

      const label = document.createElement("span");
      label.className = "chart-day";
      label.textContent = day.label;

      column.append(bar, label);
      statsChart.appendChild(column);
    });
  }

  const subjectListEl = document.getElementById("subject-list");
  if (subjectListEl) {
    subjectListEl.replaceChildren();

    if (subjectTotals.size === 0) {
      const empty = document.createElement("span");
      empty.className = "subject-empty-line";
      empty.textContent = "暂无数据";
      subjectListEl.appendChild(empty);
    } else {
      const entries = [...subjectTotals.entries()]
        .sort((left, right) => right[1] - left[1])
        .slice(0, 5);
      const visibleTotal = entries.reduce((sum, entry) => sum + entry[1], 0) || 1;

      entries.forEach(([name, seconds]) => {
        const percent = Math.max(1, Math.round((seconds / visibleTotal) * 100));

        const row = document.createElement("div");
        row.className = "subject-row";

        const nameEl = document.createElement("span");
        nameEl.className = "subject-name";
        nameEl.textContent = name;
        nameEl.title = name;

        const track = document.createElement("span");
        track.className = "subject-track";
        const fill = document.createElement("span");
        fill.className = "subject-fill";
        fill.style.width = `${percent}%`;
        track.appendChild(fill);

        const percentEl = document.createElement("span");
        percentEl.className = "subject-percent";
        percentEl.textContent = `${percent}%`;

        row.append(nameEl, track, percentEl);
        subjectListEl.appendChild(row);
      });
    }
  }

  if (statsHint) {
    statsHint.textContent =
      sessions.length === 0
        ? "还没有记录，完成一个番茄后这里会有数据。"
        : `共记录 ${sessions.length} 个完成的番茄`;
  }
}

async function openStats(): Promise<void> {
  if (!statsPanel) return;
  renderStats(await loadSessions());
  statsPanel.hidden = false;
}

async function clearAllSessions(): Promise<void> {
  try {
    await invoke("clear_sessions");
  } catch {
    try {
      localStorage.removeItem(SESSION_FALLBACK_KEY);
    } catch {
      // 忽略
    }
  }
}

const confirmDialog = document.getElementById("confirm-dialog");

function openConfirm(): void {
  if (confirmDialog) confirmDialog.hidden = false;
}

function closeConfirm(): void {
  if (confirmDialog) confirmDialog.hidden = true;
}

function closeStats(): void {
  if (statsPanel) statsPanel.hidden = true;
  closeConfirm();
}

function recordFocusSession(): void {
  const endedAt = new Date();
  const startedAt = new Date(endedAt.getTime() - focusMs);
  const input = document.querySelector<HTMLInputElement>("#subject");
  const subject = input?.value.trim() || "未分类";

  void persistSession({
    start: startedAt.toISOString(),
    end: endedAt.toISOString(),
    durationSec: Math.round(focusMs / 1000),
    subject,
    completed: true,
  });
}

function setupStats(): void {
  document.querySelector<HTMLButtonElement>("#stats-btn")?.addEventListener("click", (event) => {
    event.stopPropagation();
    if (statsPanel && !statsPanel.hidden) closeStats();
    else void openStats();
  });

  document.querySelector<HTMLButtonElement>("#stats-close")?.addEventListener("click", (event) => {
    event.stopPropagation();
    closeStats();
  });

  document.querySelector<HTMLButtonElement>("#stats-clear")?.addEventListener("click", (event) => {
    event.stopPropagation();
    openConfirm();
  });

  document.querySelector<HTMLButtonElement>("#confirm-cancel")?.addEventListener("click", (event) => {
    event.stopPropagation();
    closeConfirm();
  });

  document
    .querySelector<HTMLButtonElement>("#confirm-ok")
    ?.addEventListener("click", async (event) => {
      event.stopPropagation();
      await clearAllSessions();
      closeConfirm();
      renderStats([]);
    });

  document.addEventListener("click", (event) => {
    if (!statsPanel || statsPanel.hidden) return;
    const target = event.target as Node;
    if (statsPanel.contains(target)) return;
    closeStats();
  });
}

/* ============================================================
   顶栏聚合菜单：显示模式 / 偏好
   ============================================================ */

const viewMenu = document.getElementById("view-menu");
const prefsMenu = document.getElementById("prefs-menu");
const appearancePanel = document.getElementById("appearance-panel");

function closeMenus(): void {
  if (viewMenu) viewMenu.hidden = true;
  if (prefsMenu) prefsMenu.hidden = true;
  document.querySelectorAll<HTMLElement>(".cluster-btn").forEach((button) => {
    button.setAttribute("aria-expanded", "false");
  });
}

function toggleMenu(buttonId: string, menu: HTMLElement | null): void {
  if (!menu) return;
  const willOpen = menu.hidden;
  closeMenus();
  menu.hidden = !willOpen;
  document.getElementById(buttonId)?.setAttribute("aria-expanded", String(!menu.hidden));
}

function setupMenus(): void {
  document.querySelector<HTMLButtonElement>("#view-btn")?.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleMenu("view-btn", viewMenu);
  });

  document.querySelector<HTMLButtonElement>("#prefs-btn")?.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleMenu("prefs-btn", prefsMenu);
  });

  ["#fullscreen-btn", "#compact-btn"].forEach((selector) => {
    document.querySelector<HTMLButtonElement>(selector)?.addEventListener("click", () => {
      window.setTimeout(closeMenus, 0);
    });
  });

  document.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (viewMenu?.contains(target) || prefsMenu?.contains(target)) return;
    if (target.closest(".cluster-btn")) return;
    if (target.closest("#appearance-panel")) return;
    closeMenus();
  });
}

/* ============================================================
   外观 DIY：主题色 / 背景图 / 背景参数
   ============================================================ */

interface AppearanceState {
  accent: string | null;
  image: string | null;
  blur: number;
  dim: number;
  scale: number;
  cardAlpha: number;
  folder: string | null;
}

const APPEARANCE_KEY = "timegap:appearance";
const ACCENT_PRESETS = ["#4fa8e0", "#2fbf8f", "#f2b93d", "#a78bfa", "#f27a7a", "#7c9cff"];

const DEFAULT_APPEARANCE: AppearanceState = {
  accent: null,
  image: null,
  blur: 0,
  dim: 0,
  scale: 100,
  cardAlpha: 100,
  folder: null,
};

function readAppearance(): AppearanceState {
  try {
    const raw = localStorage.getItem(APPEARANCE_KEY);
    if (!raw) return { ...DEFAULT_APPEARANCE };

    const parsed = JSON.parse(raw) as Partial<AppearanceState>;
    return {
      accent: typeof parsed.accent === "string" ? parsed.accent : null,
      image: typeof parsed.image === "string" ? parsed.image : null,
      blur: Number.isFinite(parsed.blur) ? Number(parsed.blur) : 0,
      dim: Number.isFinite(parsed.dim) ? Number(parsed.dim) : 0,
      scale: Number.isFinite(parsed.scale) ? Number(parsed.scale) : 100,
      cardAlpha: Number.isFinite(parsed.cardAlpha) ? Number(parsed.cardAlpha) : 100,
      folder: typeof parsed.folder === "string" ? parsed.folder : null,
    };
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
}

let appearance = readAppearance();

function hexToRgba(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const full = value.length === 3 ? value.split("").map((char) => char + char).join("") : value;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function accentStyleEl(): HTMLStyleElement {
  let element = document.getElementById("accent-style") as HTMLStyleElement | null;
  if (!element) {
    element = document.createElement("style");
    element.id = "accent-style";
    document.head.appendChild(element);
  }
  return element;
}

let lastToneImage: string | null = null;

/** 按背景图平均亮度切换页面文字的黑白，避免去掉遮罩后看不清 */
async function updateBgTone(): Promise<void> {
  const root = document.documentElement;

  if (!appearance.image) {
    delete root.dataset.bgTone;
    lastToneImage = null;
    return;
  }

  if (lastToneImage === appearance.image) return;
  lastToneImage = appearance.image;

  try {
    const image = new Image();
    image.src = appearance.image;
    await image.decode();

    const canvas = document.createElement("canvas");
    canvas.width = 24;
    canvas.height = 24;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return;

    context.drawImage(image, 0, 0, 24, 24);
    const { data } = context.getImageData(0, 0, 24, 24);

    let sum = 0;
    for (let index = 0; index < data.length; index += 4) {
      sum += 0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2];
    }

    const luminance = sum / (data.length / 4) / 255;
    root.dataset.bgTone = luminance > 0.6 ? "light" : "dark";
  } catch {
    delete root.dataset.bgTone;
  }
}

function applyAppearance(): void {
  const root = document.documentElement;
  const style = accentStyleEl();

  style.textContent = appearance.accent
    ? `:root[data-accent="on"]:not([data-phase="break"]) { --accent: ${appearance.accent}; --accent-soft: ${hexToRgba(appearance.accent, 0.16)}; }`
    : "";

  // 有主题色时，翻页钟切换为「深色玻璃牌 + 主题色数字」
  root.dataset.accent = appearance.accent ? "on" : "off";
  root.style.setProperty("--card-alpha-pct", `${appearance.cardAlpha}%`);

  const layer = document.getElementById("bg-layer");
  const dim = document.getElementById("bg-dim");

  if (layer) {
    layer.style.backgroundImage = appearance.image ? `url("${appearance.image}")` : "";
    layer.style.filter = appearance.image ? `blur(${appearance.blur}px)` : "none";
    layer.style.transform = `scale(${appearance.image ? appearance.scale / 100 : 1})`;
    layer.classList.toggle("is-on", Boolean(appearance.image));
  }

  if (dim) {
    dim.style.opacity = appearance.image ? String(appearance.dim / 100) : "0";
  }

  void updateBgTone();
}

function storeAppearance(): void {
  try {
    // 文件夹模式只记路径，不缓存图片本体，避免撑爆 localStorage
    const payload = { ...appearance, image: appearance.folder ? null : appearance.image };
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify(payload));
  } catch (error) {
    console.warn("外观设置写入失败（图片可能过大）", error);
  }
}

async function fileToDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const max = 1600;
  const ratio = Math.min(1, max / Math.max(bitmap.width, bitmap.height));

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
  canvas.height = Math.max(1, Math.round(bitmap.height * ratio));

  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建画布");
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  return canvas.toDataURL("image/jpeg", 0.82);
}

function paintAppearanceControls(): void {
  document.querySelectorAll<HTMLButtonElement>("#accent-swatches .swatch").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.color === appearance.accent);
  });

  const accentInput = document.querySelector<HTMLInputElement>("#accent-input");
  if (accentInput && appearance.accent) accentInput.value = appearance.accent;

  const blur = document.querySelector<HTMLInputElement>("#bg-blur");
  const dim = document.querySelector<HTMLInputElement>("#bg-dim");
  const scale = document.querySelector<HTMLInputElement>("#bg-scale");
  const alpha = document.querySelector<HTMLInputElement>("#card-alpha");
  const folderInput = document.querySelector<HTMLInputElement>("#folder-path");

  if (blur) blur.value = String(appearance.blur);
  if (dim) dim.value = String(appearance.dim);
  if (scale) scale.value = String(appearance.scale);
  if (alpha) alpha.value = String(appearance.cardAlpha);
  if (folderInput && appearance.folder) folderInput.value = appearance.folder;

  const blurVal = document.getElementById("bg-blur-val");
  const dimVal = document.getElementById("bg-dim-val");
  const scaleVal = document.getElementById("bg-scale-val");
  const alphaVal = document.getElementById("card-alpha-val");
  if (blurVal) blurVal.textContent = `${appearance.blur}px`;
  if (dimVal) dimVal.textContent = `${appearance.dim}%`;
  if (scaleVal) scaleVal.textContent = `${appearance.scale}%`;
  if (alphaVal) alphaVal.textContent = `${appearance.cardAlpha}%`;
}

function setFolderHint(text: string): void {
  const hint = document.getElementById("folder-hint");
  if (hint) hint.textContent = text;
}

/** 从文件夹随机取一张作为背景，成功返回 true */
async function loadWallpaperFromFolder(dir: string): Promise<boolean> {
  const folder = dir.trim();
  if (!folder) {
    setFolderHint("先填一个文件夹路径");
    return false;
  }

  try {
    const files = await invoke<string[]>("list_wallpapers", { dir: folder });
    if (files.length === 0) {
      setFolderHint("这个文件夹里没有 .jpg / .png 图片");
      return false;
    }

    const picked = files[Math.floor(Math.random() * files.length)] ?? files[0];
    const dataUrl = await invoke<string>("read_wallpaper", { path: picked });

    appearance.image = dataUrl;
    appearance.folder = folder;
    appearance.cardAlpha = Math.min(appearance.cardAlpha, 88);
    storeAppearance();
    applyAppearance();
    paintAppearanceControls();

    const name = picked.split(/[\\/]/).pop() ?? picked;
    setFolderHint(`已换：${name}（共 ${files.length} 张）`);
    return true;
  } catch (error) {
    console.warn("读取壁纸失败", error);
    setFolderHint("读取失败，检查路径或文件权限");
    return false;
  }
}

function setupAppearance(): void {
  const swatchHost = document.getElementById("accent-swatches");
  if (swatchHost) {
    ACCENT_PRESETS.forEach((color) => {
      const swatch = document.createElement("button");
      swatch.type = "button";
      swatch.className = "swatch";
      swatch.dataset.color = color;
      swatch.style.background = color;
      swatch.setAttribute("aria-label", `主题色 ${color}`);
      swatch.addEventListener("click", (event) => {
        event.stopPropagation();
        appearance.accent = color;
        storeAppearance();
        applyAppearance();
        paintAppearanceControls();
      });
      swatchHost.appendChild(swatch);
    });
  }

  document.querySelector<HTMLInputElement>("#accent-input")?.addEventListener("input", (event) => {
    const target = event.target as HTMLInputElement;
    appearance.accent = target.value;
    storeAppearance();
    applyAppearance();
    paintAppearanceControls();
  });

  document.querySelector<HTMLInputElement>("#bg-file")?.addEventListener("change", async (event) => {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    try {
      appearance.image = await fileToDataUrl(file);
      appearance.folder = null;
      appearance.cardAlpha = Math.min(appearance.cardAlpha, 88);
      storeAppearance();
      applyAppearance();
      paintAppearanceControls();
    } catch (error) {
      console.warn("读取图片失败", error);
    }

    input.value = "";
  });

  document.querySelector<HTMLButtonElement>("#bg-clear")?.addEventListener("click", (event) => {
    event.stopPropagation();
    appearance.image = null;
    storeAppearance();
    applyAppearance();
  });

  const bindSlider = (id: string, key: "blur" | "dim" | "scale" | "cardAlpha", suffix: string): void => {
    const slider = document.querySelector<HTMLInputElement>(`#${id}`);
    const label = document.getElementById(`${id}-val`);
    if (!slider) return;

    slider.addEventListener("input", () => {
      const value = Number(slider.value);
      appearance = { ...appearance, [key]: value };
      if (label) label.textContent = `${value}${suffix}`;
      applyAppearance();
    });
    slider.addEventListener("change", () => storeAppearance());
  };

  bindSlider("bg-blur", "blur", "px");
  bindSlider("bg-dim", "dim", "%");
  bindSlider("bg-scale", "scale", "%");
  bindSlider("card-alpha", "cardAlpha", "%");

  document.querySelector<HTMLButtonElement>("#appearance-btn")?.addEventListener("click", (event) => {
    event.stopPropagation();
    closeMenus();
    if (appearancePanel) appearancePanel.hidden = false;
    paintAppearanceControls();
  });

  document.querySelector<HTMLButtonElement>("#folder-pick")?.addEventListener("click", async (event) => {
    event.stopPropagation();
    try {
      const picked = await invoke<string | null>("pick_wallpaper_folder");
      const input = document.querySelector<HTMLInputElement>("#folder-path");
      if (picked && input) {
        input.value = picked;
        await loadWallpaperFromFolder(picked);
      }
    } catch (error) {
      console.warn("选择文件夹失败", error);
      setFolderHint("打开文件夹选择器失败");
    }
  });

  document.querySelector<HTMLButtonElement>("#folder-apply")?.addEventListener("click", async (event) => {
    event.stopPropagation();
    const input = document.querySelector<HTMLInputElement>("#folder-path");
    await loadWallpaperFromFolder(input?.value ?? "");
  });

  document.querySelector<HTMLButtonElement>("#folder-next")?.addEventListener("click", async (event) => {
    event.stopPropagation();
    const input = document.querySelector<HTMLInputElement>("#folder-path");
    const dir = appearance.folder || input?.value || "";
    if (!dir) {
      setFolderHint("先选一个文件夹");
      return;
    }
    await loadWallpaperFromFolder(dir);
  });

  document.querySelector<HTMLButtonElement>("#appearance-close")?.addEventListener("click", (event) => {
    event.stopPropagation();
    if (appearancePanel) appearancePanel.hidden = true;
  });

  document.querySelector<HTMLButtonElement>("#appearance-reset")?.addEventListener("click", (event) => {
    event.stopPropagation();
    appearance = { ...DEFAULT_APPEARANCE };
    storeAppearance();
    applyAppearance();
    paintAppearanceControls();
  });

  applyAppearance();
  paintAppearanceControls();

  // 启动时若已绑定壁纸文件夹，随机换一张
  if (appearance.folder) {
    void loadWallpaperFromFolder(appearance.folder);
  }
}

/* ---------- 开机自启 ---------- */

let autostartEnabled = false;

function paintAutostart(): void {
  const toggle = document.querySelector<HTMLButtonElement>("#autostart-toggle");
  if (!toggle) return;
  toggle.setAttribute("aria-checked", String(autostartEnabled));
  toggle.classList.toggle("is-on", autostartEnabled);
}

async function setupSettings(): Promise<void> {
  const toggle = document.querySelector<HTMLButtonElement>("#autostart-toggle");

  try {
    autostartEnabled = await invoke<boolean>("is_autostart_enabled");
  } catch {
    autostartEnabled = false;
  }
  paintAutostart();

  toggle?.addEventListener("click", async (event) => {
    event.stopPropagation();
    const next = !autostartEnabled;

    try {
      await invoke("set_autostart", { enabled: next });
      autostartEnabled = next;
    } catch (error) {
      console.warn("设置开机自启失败", error);
    }

    paintAutostart();
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

      if (confirmDialog && !confirmDialog.hidden) {
        event.preventDefault();
        closeConfirm();
        return;
      }

      if (appearancePanel && !appearancePanel.hidden) {
        event.preventDefault();
        appearancePanel.hidden = true;
        return;
      }

      if ((viewMenu && !viewMenu.hidden) || (prefsMenu && !prefsMenu.hidden)) {
        event.preventDefault();
        closeMenus();
        return;
      }

      if (statsPanel && !statsPanel.hidden) {
        event.preventDefault();
        closeStats();
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
  setupMute();
  setupSubject();
  setupKeyboard();
  setupButtons();
  setupDockHover();
  setupTips();
  setupGoalPicker();
  setupStats();
  setupMenus();
  setupAppearance();
  void setupSettings();
  startWorldClock();
  renderStars();
  renderCountdown();

  void applyPinned(false);
  void setupDockWatcher();

  window.addEventListener("beforeunload", () => {
    void persistGeometry();
  });
});
