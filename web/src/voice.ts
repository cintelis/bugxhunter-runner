/**
 * Browser-native voice I/O via the Web Speech API.
 *
 * Used because SCX's `scx-tts` / `scx-stt` audio endpoints are gated on this
 * tier. NOTE: Web Speech sends audio to the browser vendor's cloud service —
 * for data-residency-sensitive deployments, swap these for the SCX audio
 * endpoints (`/v1/audio/speech`, `/v1/audio/transcriptions`) once enabled.
 */

type SR = any;

export function speechSupported(): boolean {
  return typeof window !== "undefined" && !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
}

/** One-shot dictation. Resolves with the transcript (or "" if nothing heard). */
export function dictate(opts: {
  onPartial?: (text: string) => void;
  onStart?: () => void;
  onEnd?: () => void;
}): { stop: () => void; promise: Promise<string> } {
  const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  if (!Ctor) return { stop: () => {}, promise: Promise.resolve("") };
  const rec: SR = new Ctor();
  rec.lang = navigator.language || "en-US";
  rec.interimResults = true;
  rec.continuous = false;
  let finalText = "";

  const promise = new Promise<string>((resolve) => {
    rec.onresult = (e: any) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += t;
        else interim += t;
      }
      opts.onPartial?.(finalText + interim);
    };
    rec.onend = () => {
      opts.onEnd?.();
      resolve(finalText.trim());
    };
    rec.onerror = () => resolve(finalText.trim());
    opts.onStart?.();
    rec.start();
  });

  return { stop: () => rec.stop(), promise };
}

let currentUtterance: SpeechSynthesisUtterance | null = null;

export function speak(text: string) {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  const clean = text.replace(/[*_`#>]/g, "").replace(/\[(\d+)\]/g, "").trim();
  if (!clean) return;
  window.speechSynthesis.cancel();
  currentUtterance = new SpeechSynthesisUtterance(clean);
  currentUtterance.rate = 1.05;
  window.speechSynthesis.speak(currentUtterance);
}

export function stopSpeaking() {
  if (typeof window !== "undefined" && window.speechSynthesis) window.speechSynthesis.cancel();
  currentUtterance = null;
}
