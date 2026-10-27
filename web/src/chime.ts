// A short two-tone chime, made in the browser (no sound file to ship or fetch). Used when an AI's question
// arrives on the board, so the person notices it even while looking at another window.
//
// Browsers only let a page make sound after the person has interacted with it: the audio context is
// created and unlocked on the first click or key press, and a chime before that is silently skipped.

let ctx: AudioContext | null = null;

function unlock() {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
  } catch {
    ctx = null; // no Web Audio here: the dialog still appears, just without sound
  }
}
if (typeof window !== "undefined" && typeof AudioContext !== "undefined") {
  for (const e of ["pointerdown", "keydown"] as const) window.addEventListener(e, unlock, { once: true, capture: true });
}

export function chime(): void {
  if (!ctx || ctx.state !== "running") return;
  const start = ctx.currentTime;
  // High then lower note, each fading out: noticeable, not alarming.
  for (const [freq, at] of [
    [880, 0],
    [660, 0.18],
  ] as const) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, start + at);
    gain.gain.exponentialRampToValueAtTime(0.25, start + at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + at + 0.45);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start + at);
    osc.stop(start + at + 0.5);
  }
}
