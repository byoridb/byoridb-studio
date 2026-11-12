/**
 * Native self-diagnosis. The WKWebView cannot be screenshotted without the screen
 * recording permission, so the app inspects its own rendered state and hands the
 * findings to the native shell.
 *
 * It runs only when the shell was started with BYORI_STUDIO_SELFTEST: the shell
 * then injects `window.__BYORI_SELFTEST__` before any page script and accepts the
 * report. Without that variable nothing loads this module and the shell has no
 * route that would take a report.
 */
import { invoke, isTauri } from "@tauri-apps/api/core";
import { rpc } from "./api";
import { playbackClock } from "./playbackClock";
import type { Project } from "./types";

type Json = Record<string, unknown>;
interface Collector {
  csp: Json[];
  errors: Json[];
  rejections: Json[];
}
declare global {
  interface Window {
    __BYORI_SELFTEST__?: Collector;
  }
}

const REPORT_PATH = "/__selftest/report";
const KOREAN_SAMPLE = "한국어 글꼴 확인 가나다라마바사 0123";
const KOREAN_INPUT = "한글 입력 확인 — 가나다 받침 값";

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const redact = (url: string) => url.replace(/token=[^&#]+/g, "token=REDACTED");
const message = (error: unknown) =>
  error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error);

async function until<T>(
  probe: () => T | null | undefined | false,
  timeoutMs: number,
  intervalMs = 100,
): Promise<T | null> {
  const started = performance.now();
  for (;;) {
    const value = probe();
    if (value) return value;
    if (performance.now() - started > timeoutMs) return null;
    await sleep(intervalMs);
  }
}

const rectOf = (element: Element) => {
  const r = element.getBoundingClientRect();
  return {
    x: Math.round(r.x * 10) / 10,
    y: Math.round(r.y * 10) / 10,
    width: Math.round(r.width * 10) / 10,
    height: Math.round(r.height * 10) / 10,
  };
};

const describe = (element: Element) => {
  const parts: string[] = [];
  let node: Element | null = element;
  while (node && node !== document.body && parts.length < 4) {
    const cls = typeof node.className === "string" && node.className.trim()
      ? `.${node.className.trim().split(/\s+/).slice(0, 2).join(".")}`
      : "";
    parts.unshift(`${node.tagName.toLowerCase()}${cls}`);
    node = node.parentElement;
  }
  return parts.join(" > ");
};

function environment(): Json {
  const ua = navigator.userAgent;
  return {
    userAgent: ua,
    // WKWebView reports AppleWebKit without a Chrome/Chromium token.
    isWebKit: /AppleWebKit/.test(ua) && !/Chrome|Chromium|Edg\//.test(ua),
    isTauri: isTauri(),
    origin: location.origin,
    language: navigator.language,
    window: {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      devicePixelRatio: window.devicePixelRatio,
      screenWidth: screen.width,
      screenHeight: screen.height,
      // A window taller than the space between menu bar and Dock is shortened by macOS.
      screenAvailWidth: screen.availWidth,
      screenAvailHeight: screen.availHeight,
    },
    visibilityState: document.visibilityState,
    hasFocus: document.hasFocus(),
  };
}

/** Counts animation frames and timer ticks over one second of wall time. */
async function timers(): Promise<Json> {
  let frames = 0;
  let running = true;
  const tick = () => {
    frames++;
    if (running) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  const started = performance.now();
  // The timeout itself may be throttled; a busy wait is not an option, so both are recorded.
  await sleep(1000);
  const elapsed = performance.now() - started;
  running = false;
  return {
    requestedMs: 1000,
    elapsedMs: Math.round(elapsed),
    animationFrames: frames,
    rafStalled: frames < 5,
    timerThrottled: elapsed > 1500,
  };
}

function fonts(): Json {
  const style = getComputedStyle(document.body);
  const family = style.fontFamily;
  const measure = (fontFamily: string) => {
    const span = document.createElement("span");
    span.textContent = KOREAN_SAMPLE;
    span.style.cssText =
      "position:absolute;left:-9999px;top:0;white-space:nowrap;visibility:hidden;font-size:40px;font-synthesis:none;";
    span.style.fontFamily = fontFamily;
    document.body.appendChild(span);
    const width = span.getBoundingClientRect().width;
    span.remove();
    return Math.round(width * 100) / 100;
  };
  const body = measure(family);
  const serif = measure("serif");
  const monospace = measure("monospace");
  const cursive = measure("cursive");
  const faces: Json[] = [];
  document.fonts.forEach((face) => faces.push({ family: face.family, status: face.status, weight: face.weight }));
  return {
    documentFontsStatus: document.fonts.status,
    documentFontsSize: document.fonts.size,
    faces: faces.slice(0, 40),
    failedFaces: faces.filter((face) => face.status === "error").map((face) => face.family),
    bodyFontFamily: family,
    bodyFontSize: style.fontSize,
    sample: KOREAN_SAMPLE,
    widthAt40px: { body, serif, monospace, cursive },
    // A missing glyph font collapses to zero or to the generic fallback's exact width.
    koreanRendered: body > 0,
    bodyDiffersFromSerif: Math.abs(body - serif) > 0.5,
    fontCheck: [
      "13px -apple-system",
      '13px "Noto Sans KR"',
      '13px "Apple SD Gothic Neo"',
    ].map((font) => ({ font, available: document.fonts.check(font, KOREAN_SAMPLE) })),
  };
}

function tokens(): Json {
  const names = new Set<string>();
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSStyleRule) || !/(^|,)\s*:root\s*(,|$)/.test(rule.selectorText)) continue;
      for (const name of Array.from(rule.style)) if (name.startsWith("--")) names.add(name);
    }
  }
  const root = getComputedStyle(document.documentElement);
  const values: Record<string, string> = {};
  const unresolved: string[] = [];
  for (const name of [...names].sort()) {
    const value = root.getPropertyValue(name).trim();
    values[name] = value;
    if (!value) unresolved.push(name);
  }
  return { count: names.size, unresolved, values };
}

const REGIONS: [string, string][] = [
  ["topbar", ".studio-topbar"],
  ["library", ".studio-library"],
  ["player", ".player-panel"],
  ["inspector", ".studio-inspector"],
  ["timeline", ".timeline-panel"],
  ["statusbar", ".studio-statusbar"],
];

function layout(): Json {
  const found: { name: string; element: Element; rect: ReturnType<typeof rectOf> }[] = [];
  const regions: Record<string, Json> = {};
  for (const [name, selector] of REGIONS) {
    const element = document.querySelector(selector);
    if (!element) {
      regions[name] = { selector, present: false };
      continue;
    }
    const rect = rectOf(element);
    const style = getComputedStyle(element);
    found.push({ name, element, rect });
    regions[name] = {
      selector,
      present: true,
      rect,
      zeroSized: rect.width < 1 || rect.height < 1,
      outsideViewport:
        rect.x < -0.5 ||
        rect.y < -0.5 ||
        rect.x + rect.width > window.innerWidth + 0.5 ||
        rect.y + rect.height > window.innerHeight + 0.5,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      overflowsX: element.scrollWidth > element.clientWidth + 1,
      backgroundColor: style.backgroundColor,
      color: style.color,
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
    };
  }
  const overlaps: Json[] = [];
  for (let i = 0; i < found.length; i++)
    for (let j = i + 1; j < found.length; j++) {
      const a = found[i].rect;
      const b = found[j].rect;
      const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      if (w > 1 && h > 1)
        overlaps.push({ a: found[i].name, b: found[j].name, width: Math.round(w), height: Math.round(h) });
    }
  // Text wider than a box that neither clips nor scrolls spills over its neighbours.
  // Inside a scrolling ancestor that is by design; under a clipping one the text is cut off.
  const spills: Json[] = [];
  let clippedOrScrolling = 0;
  for (const element of Array.from(document.body.querySelectorAll("*"))) {
    if (!(element instanceof HTMLElement) || element.clientWidth === 0) continue;
    if (element.scrollWidth <= element.clientWidth + 1) continue;
    const text = (element.textContent || "").trim();
    // Handles and hit areas reach past their own box on purpose.
    if (!text) continue;
    if (getComputedStyle(element).overflowX !== "visible") {
      clippedOrScrolling++;
      continue;
    }
    let container = "none";
    for (let up = element.parentElement; up && up !== document.body; up = up.parentElement) {
      const mode = getComputedStyle(up).overflowX;
      if (mode !== "visible") {
        container = mode === "auto" || mode === "scroll" ? "scrolls" : "clips";
        break;
      }
    }
    if (container === "scrolls") continue;
    if (spills.length < 40)
      spills.push({
        element: describe(element),
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        ancestor: container,
        text: text.slice(0, 40),
      });
  }
  const body = getComputedStyle(document.body);
  const root = document.documentElement;
  return {
    regions,
    overlaps,
    spills,
    clippedOrScrollingCount: clippedOrScrolling,
    document: {
      scrollWidth: root.scrollWidth,
      clientWidth: root.clientWidth,
      scrollHeight: root.scrollHeight,
      clientHeight: root.clientHeight,
      overflowsX: root.scrollWidth > root.clientWidth + 1,
      overflowsY: root.scrollHeight > root.clientHeight + 1,
    },
    body: { backgroundColor: body.backgroundColor, color: body.color },
  };
}

function images(scope: ParentNode = document): Json {
  const all = Array.from(scope.querySelectorAll("img"));
  const list = all.map((img) => ({
    src: redact(img.currentSrc || img.src).slice(0, 160),
    complete: img.complete,
    naturalWidth: img.naturalWidth,
    naturalHeight: img.naturalHeight,
    className: img.className,
  }));
  return {
    count: list.length,
    broken: list.filter((img) => img.complete && img.naturalWidth === 0),
    pending: list.filter((img) => !img.complete).length,
    images: list.slice(0, 80),
  };
}

async function settleImages(scope: ParentNode, timeoutMs: number) {
  await until(
    () => Array.from(scope.querySelectorAll("img")).every((img) => img.complete),
    timeoutMs,
  );
}

/** React reads the value through the native setter; assigning `.value` directly is ignored. */
function typeInto(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

async function textInput(): Promise<Json> {
  let target = "inspector";
  let field: HTMLInputElement | HTMLTextAreaElement | null = null;
  const clip = document.querySelector<HTMLElement>(".timeline-clip.text .clip-body");
  if (clip) {
    try {
      const at = clip.getBoundingClientRect();
      const init = {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
        button: 0,
        clientX: at.x + Math.min(6, at.width / 2),
        clientY: at.y + at.height / 2,
      };
      clip.dispatchEvent(new PointerEvent("pointerdown", { ...init, buttons: 1 }));
      clip.dispatchEvent(new PointerEvent("pointerup", { ...init, buttons: 0 }));
    } catch {
      /* falls back to the project name below */
    }
    field = await until(
      () => document.querySelector<HTMLTextAreaElement>(".inspector-text-field textarea"),
      3000,
    );
  }
  if (!field) {
    target = "projectName";
    field = document.querySelector<HTMLInputElement>('input[aria-label="프로젝트 이름"]');
  }
  if (!field) return { ok: false, reason: "텍스트 입력 필드를 찾지 못했습니다" };
  const original = field.value;
  field.focus();
  typeInto(field, KOREAN_INPUT);
  await sleep(300);
  const after = field.value;
  const stillMounted = field.isConnected;
  // Restored without a blur, so nothing is committed to the project.
  if (stillMounted) typeInto(field, original);
  await sleep(100);
  return {
    ok: after === KOREAN_INPUT,
    target,
    typed: KOREAN_INPUT,
    valueAfter: after,
    stillMounted,
    restored: stillMounted ? field.value === original : null,
    focused: document.activeElement === field,
  };
}

/** The ACL is checked before arguments are parsed, so a malformed call never opens a dialog. */
async function capabilities(): Promise<Json> {
  if (!isTauri()) return { tauri: false };
  const probe = async (command: string, args: Json) => {
    try {
      await invoke(command, args);
      return { command, allowed: true, note: "호출이 성공했습니다" };
    } catch (error) {
      const text = message(error);
      const denied = /not allowed|ACL|permission|not found/i.test(text);
      return { command, allowed: !denied, error: text.slice(0, 240) };
    }
  };
  return {
    tauri: true,
    studioOpenFiles: await probe("studio_open_files", { extensions: 7 }),
    studioSaveFile: await probe("studio_save_file", {}),
    // No path: refused for its arguments, so Finder is never opened.
    studioRevealFile: await probe("studio_reveal_file", {}),
    // A command the shell never declared must stay unreachable.
    undeclared: await probe("studio_selftest_probe", {}),
  };
}

/** The findings a reader should look at first; an empty list means every check passed. */
function problems(report: Json): string[] {
  const found: string[] = [];
  const get = (path: string) =>
    path.split(".").reduce<unknown>((value, key) => (value as Json | undefined)?.[key], report);
  const count = (path: string) => (get(path) as unknown[] | undefined)?.length ?? 0;
  for (const entry of report.steps as Json[])
    if (!entry.ok) found.push(`${entry.name} 단계 실패: ${entry.error}`);
  if (get("environment.isWebKit") !== true) found.push("WebKit 웹뷰가 아닙니다");
  if (count("csp")) found.push(`CSP 위반 ${count("csp")}건`);
  if (count("errors")) found.push(`스크립트·리소스 오류 ${count("errors")}건`);
  if (count("rejections")) found.push(`처리되지 않은 거부 ${count("rejections")}건`);
  if (get("timers.rafStalled")) found.push("requestAnimationFrame 이 멈춰 있습니다");
  if (get("timers.timerThrottled")) found.push("타이머가 지연되고 있습니다");
  if (get("rpc.projectGet.ok") !== true || get("rpc.projectList.ok") !== true)
    found.push("서비스 RPC 왕복 실패");
  if (get("fonts.koreanRendered") !== true) found.push("한국어 글꼴이 그려지지 않습니다");
  if (count("fonts.failedFaces")) found.push(`불러오지 못한 글꼴 ${count("fonts.failedFaces")}개`);
  if (count("tokens.unresolved")) found.push(`해석되지 않은 CSS 변수 ${count("tokens.unresolved")}개`);
  if (!get("example.firstClipFound")) found.push("예제 프로젝트의 클립이 타임라인에 나타나지 않았습니다");
  else if (get("example.domClips") !== get("example.projectClips"))
    found.push("타임라인의 클립 수가 프로젝트와 다릅니다");
  for (const name of ["layout", "finalLayout"]) {
    const regions = (get(`${name}.regions`) ?? {}) as Record<string, Json>;
    for (const [region, info] of Object.entries(regions)) {
      if (!info.present) found.push(`${name}: ${region} 영역이 없습니다`);
      else if (info.zeroSized) found.push(`${name}: ${region} 영역의 크기가 0입니다`);
      else if (info.outsideViewport) found.push(`${name}: ${region} 영역이 창 밖으로 나갔습니다`);
      if (info.overflowsX) found.push(`${name}: ${region} 영역이 가로로 넘칩니다`);
    }
    if (count(`${name}.overlaps`)) found.push(`${name}: 겹치는 영역 ${count(`${name}.overlaps`)}쌍`);
    if (count(`${name}.spills`)) found.push(`${name}: 넘치는 글자 ${count(`${name}.spills`)}곳`);
    if (get(`${name}.document.overflowsX`) || get(`${name}.document.overflowsY`))
      found.push(`${name}: 문서가 창보다 큽니다`);
  }
  if (get("playback.ok") !== true) found.push(`재생: ${get("playback.note") ?? get("playback.reason")}`);
  if (get("preciseFrame.ok") !== true) found.push("정밀 프레임 이미지를 불러오지 못했습니다");
  for (const name of ["homeScreen.images", "workspaceImages", "stickers"])
    if (count(`${name}.broken`)) found.push(`${name}: 깨진 이미지 ${count(`${name}.broken`)}개`);
  if (get("stickers.ok") !== true) found.push("스티커 이미지를 불러오지 못했습니다");
  if (get("textInput.ok") !== true) found.push("한국어 입력 값이 유지되지 않았습니다");
  if (get("capabilities.studioOpenFiles.allowed") !== true || get("capabilities.studioSaveFile.allowed") !== true)
    found.push("파일 대화상자 명령이 capabilities 로 허용되지 않았습니다");
  if (get("capabilities.studioRevealFile.allowed") !== true)
    found.push("파일 위치 열기 명령이 capabilities 로 허용되지 않았습니다");
  if (get("capabilities.undeclared.allowed") === true) found.push("선언하지 않은 명령이 호출됩니다");
  return found;
}

async function send(report: Json, final: boolean) {
  try {
    const response = await fetch(`${REPORT_PATH}?final=${final ? 1 : 0}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function runSelfTest() {
  const collector = window.__BYORI_SELFTEST__;
  if (!collector) return;
  const startedAt = performance.now();
  const report: Json = {
    schema: 1,
    startedAt: new Date().toISOString(),
    completed: false,
    stage: "start",
    steps: [] as Json[],
    csp: collector.csp,
    errors: collector.errors,
    rejections: collector.rejections,
  };
  const step = async (name: string, run: () => Promise<unknown> | unknown) => {
    report.stage = name;
    const began = performance.now();
    const entry: Json = { name };
    try {
      report[name] = await run();
      entry.ok = true;
    } catch (error) {
      entry.ok = false;
      entry.error = message(error);
    }
    entry.ms = Math.round(performance.now() - began);
    (report.steps as Json[]).push(entry);
    report.elapsedMs = Math.round(performance.now() - startedAt);
    // Each stage is handed over at once: a frozen timer later still leaves what was collected.
    await send(report, false);
  };

  await step("environment", environment);
  await step("appReady", async () => {
    const screen = await until(
      () => document.querySelector(".home-screen, .studio-topbar, .connection-screen .inline-error"),
      30000,
    );
    return {
      shown: screen ? describe(screen) : null,
      connectionError: document.querySelector(".connection-screen .inline-error")?.textContent ?? null,
    };
  });
  await step("timers", timers);
  await step("rpc", async () => {
    const began = performance.now();
    const project = await rpc<Project>("project.get");
    const getMs = Math.round(performance.now() - began);
    const listBegan = performance.now();
    const list = await rpc<{ id: string; name: string }[]>("project.list");
    return {
      projectGet: { ok: !!project?.id, ms: getMs, revision: project?.revision, clips: project?.clips?.length },
      projectList: { ok: Array.isArray(list), ms: Math.round(performance.now() - listBegan), count: list?.length },
    };
  });
  await step("fonts", async () => {
    await Promise.race([document.fonts.ready, sleep(3000)]);
    return fonts();
  });
  await step("tokens", tokens);
  await step("homeScreen", async () => {
    const home = document.querySelector(".home-screen");
    if (!home) return { present: false };
    await settleImages(home, 5000);
    return {
      present: true,
      rect: rectOf(home),
      overflowsX: home.scrollWidth > home.clientWidth + 1,
      backgroundColor: getComputedStyle(home).backgroundColor,
      color: getComputedStyle(home).color,
      images: images(home),
    };
  });
  await step("example", async () => {
    const began = performance.now();
    // The home screen's own button (in the heading, or in the empty state).
    const open = [...document.querySelectorAll<HTMLButtonElement>(".home-screen button")].find(
      (button) => button.textContent?.trim() === "예제 열기",
    );
    let opened = "homeButton";
    if (open) open.click();
    else {
      // Already in the workspace: the same validated command the menu uses.
      opened = "rpc";
      await rpc("project.demo");
    }
    const clip = await until(() => document.querySelector(".timeline-clip"), 120000, 200);
    const project = await rpc<Project>("project.get");
    return {
      opened,
      workspaceShown: !!document.querySelector(".studio-topbar"),
      ms: Math.round(performance.now() - began),
      domClips: document.querySelectorAll(".timeline-clip").length,
      projectClips: project.clips.length,
      projectTracks: project.tracks.length,
      projectMedia: project.media.length,
      projectName: project.name,
      firstClipFound: !!clip,
      error: document.querySelector(".inline-error, .studio-banner")?.textContent ?? null,
    };
  });
  await step("layout", async () => {
    await sleep(500);
    return layout();
  });
  await step("playback", async () => {
    const button = document.querySelector<HTMLButtonElement>(".play-button");
    if (!button) return { ok: false, reason: "재생 버튼을 찾지 못했습니다" };
    if (button.disabled) return { ok: false, reason: "재생 버튼이 비활성 상태입니다" };
    playbackClock.seek(0);
    await sleep(100);
    const before = playbackClock.get();
    let frames = 0;
    let counting = true;
    const tick = () => {
      frames++;
      if (counting) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const began = performance.now();
    button.click();
    await sleep(1000);
    const after = playbackClock.get();
    const elapsed = performance.now() - began;
    counting = false;
    const title = button.title;
    // Whatever state it reached, leave the player stopped.
    if (/일시정지|취소/.test(button.title)) button.click();
    await sleep(300);
    playbackClock.seek(0);
    return {
      ok: after > before,
      clockBefore: before,
      clockAfter: after,
      advancedSeconds: Math.round((after - before) * 1000) / 1000,
      wallMs: Math.round(elapsed),
      animationFrames: frames,
      rafStalled: frames < 5,
      buttonTitleWhilePlaying: title,
      playbackError: document.querySelector(".preview-playback-error")?.textContent ?? null,
      note:
        after > before
          ? "재생 시계가 진행했습니다"
          : frames < 5
            ? "requestAnimationFrame 이 멈춘 환경이라 재생 시계가 진행하지 않았습니다"
            : "애니메이션 프레임은 돌았지만 재생 시계가 진행하지 않았습니다",
    };
  });
  await step("preciseFrame", async () => {
    const began = performance.now();
    const img = await until(() => {
      const found = document.querySelector<HTMLImageElement>("img.rendered-preview");
      return found && found.complete ? found : null;
    }, 30000, 200);
    if (!img) {
      // The image only mounts once the service answered; ask directly to tell the two apart.
      let direct: Json;
      try {
        const project = await rpc<Project>("project.get");
        const frame = await rpc<{ assetId: string }>(
          "preview.frame",
          { time: 0, width: 320, expectedRevision: project.revision, client: "selftest" },
          project.id,
        );
        direct = { ok: true, assetId: !!frame.assetId };
      } catch (error) {
        direct = { ok: false, error: message(error) };
      }
      return { ok: false, reason: "정밀 프레임 이미지가 나타나지 않았습니다", directRpc: direct };
    }
    return {
      ok: img.naturalWidth > 0,
      ms: Math.round(performance.now() - began),
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      rect: rectOf(img),
      src: redact(img.src).slice(0, 160),
    };
  });
  await step("workspaceImages", async () => {
    await settleImages(document, 5000);
    return images();
  });
  await step("stickers", async () => {
    const tab = document.querySelector<HTMLButtonElement>('.library-tabs [role="tab"][aria-label="스티커"]');
    if (!tab) return { ok: false, reason: "스티커 탭을 찾지 못했습니다" };
    tab.click();
    const grid = await until(() => document.querySelector(".sticker-grid img")?.closest(".sticker-grid"), 5000);
    if (!grid) return { ok: false, reason: "스티커 이미지가 나타나지 않았습니다" };
    await settleImages(grid, 10000);
    const result = images(grid);
    return {
      ok: (result.count as number) > 0 && (result.broken as unknown[]).length === 0 && result.pending === 0,
      selected: tab.getAttribute("aria-selected"),
      tiles: grid.querySelectorAll(".sticker-tile").length,
      ...result,
    };
  });
  await step("textInput", textInput);
  await step("capabilities", capabilities);
  await step("finalLayout", layout);

  report.problems = problems(report);
  report.completed = true;
  report.stage = "done";
  report.elapsedMs = Math.round(performance.now() - startedAt);
  report.finishedAt = new Date().toISOString();
  await send(report, true);
}
