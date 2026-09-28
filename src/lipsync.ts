// Drives the mouth from cues computed offline (Rhubarb Lip Sync) against the
// audio element's own clock, so the lips never drift from the voice. Shapes
// are blended with a short exponential approach rather than snapped, which
// reads as muscle rather than as a flip-book.
import {
  REST,
  SHAPES,
  lerpShape,
  openness,
  renderMouth,
  type MouthElements,
  type MouthShape,
} from "./mouth";

export interface CueSheet {
  duration: number;
  cues: [number, string][];
}

export interface Caption {
  at: number;
  text: string;
}

export interface Speaker {
  /** Begin following the audio clock. */
  start(): void;
  /** Relax back to rest and clear the caption. */
  stop(): void;
}

/** Blend time constant, in seconds. */
const TAU = 0.05;
/** Captions lead the audio slightly so a phrase is readable as it begins. */
const CAPTION_LEAD = 0.08;

export function parseCueSheet(raw: unknown): CueSheet {
  const sheet = raw as { duration?: unknown; cues?: unknown };
  const cues: [number, string][] = [];
  if (Array.isArray(sheet.cues)) {
    for (const cue of sheet.cues as unknown[]) {
      if (Array.isArray(cue) && cue.length >= 2) {
        cues.push([Number(cue[0]), String(cue[1])]);
      }
    }
  }
  return { duration: Number(sheet.duration ?? 0), cues };
}

export function shapeAt(sheet: CueSheet, t: number): MouthShape {
  let lo = 0;
  let hi = sheet.cues.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const cue = sheet.cues[mid];
    if (cue && cue[0] <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const key = found >= 0 ? sheet.cues[found]?.[1] : undefined;
  return (key !== undefined ? SHAPES[key] : undefined) ?? REST;
}

export function captionAt(captions: Caption[], t: number): number {
  let index = -1;
  for (let i = 0; i < captions.length; i++) {
    const caption = captions[i];
    if (caption && caption.at <= t + CAPTION_LEAD) index = i;
  }
  return index;
}

export function createLipSync(
  audio: HTMLAudioElement,
  mouth: MouthElements,
  sheet: CueSheet,
  captions: Caption[],
  captionEl: HTMLElement,
  root: HTMLElement,
  onTalk: (level: number) => void = () => undefined,
): Speaker {
  let raf = 0;
  let last = 0;
  let current: MouthShape = { ...REST };
  let captionIndex = -1;

  const settled = (): boolean =>
    Math.abs(current.top - REST.top) < 0.03 &&
    Math.abs(current.bot - REST.bot) < 0.03 &&
    Math.abs(current.w - REST.w) < 0.05;

  const frame = (now: number): void => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;

    const speaking = !audio.paused && !audio.ended;
    const t = audio.currentTime;
    const target = speaking ? shapeAt(sheet, t) : REST;
    current = lerpShape(current, target, 1 - Math.exp(-dt / TAU));
    renderMouth(mouth, current);
    const level = openness(current);
    root.style.setProperty("--talk", level.toFixed(3));
    onTalk(level);

    const wanted = speaking ? captionAt(captions, t) : captionIndex;
    if (wanted !== captionIndex) {
      captionIndex = wanted;
      captionEl.textContent = wanted >= 0 ? (captions[wanted]?.text ?? "") : "";
    }

    if (!speaking && settled()) {
      raf = 0;
      current = { ...REST };
      renderMouth(mouth, current);
      root.style.setProperty("--talk", "0");
      onTalk(0);
      return;
    }
    raf = requestAnimationFrame(frame);
  };

  const run = (): void => {
    last = performance.now();
    if (!raf) raf = requestAnimationFrame(frame);
  };

  return {
    start: run,
    stop() {
      captionIndex = -1;
      captionEl.textContent = "";
      run();
    },
  };
}
