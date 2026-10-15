// Implementaciones de navegador de las interfaces del notificador: Web Audio y Notification API.

// Notas por tipo: [frecuencia Hz, inicio s, duración s]. Todo con osciladores suaves y envolvente corta.
const TONES = {
  task_done: { wave: "sine", notes: [[784, 0, 0.18]], gain: 0.12 },
  delivered: { wave: "sine", notes: [[523.25, 0, 0.16], [783.99, 0.14, 0.26]], gain: 0.14 },
  error: { wave: "triangle", notes: [[155.56, 0, 0.32], [130.81, 0.2, 0.34]], gain: 0.16 },
  limit: { wave: "triangle", notes: [[196, 0, 0.22], [196, 0.3, 0.22]], gain: 0.14 }
};

export function createWebAudioSound() {
  let ctx = null;
  return {
    play(type) {
      const tone = TONES[type];
      if (!tone) return;
      try {
        const AC = window.AudioContext ?? window.webkitAudioContext;
        if (!AC) return;
        ctx ??= new AC();
        if (ctx.state === "suspended") ctx.resume();
        const t0 = ctx.currentTime + 0.01;
        for (const [freq, at, dur] of tone.notes) {
          const osc = ctx.createOscillator();
          const g = ctx.createGain();
          osc.type = tone.wave;
          osc.frequency.value = freq;
          g.gain.setValueAtTime(0.0001, t0 + at);
          g.gain.exponentialRampToValueAtTime(tone.gain, t0 + at + 0.02);
          g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
          osc.connect(g).connect(ctx.destination);
          osc.start(t0 + at);
          osc.stop(t0 + at + dur + 0.05);
        }
      } catch { /* sin audio disponible: se ignora */ }
    }
  };
}

export function createBrowserNotify() {
  return {
    show(title, body) {
      try {
        if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
        new Notification(title, { body, tag: title });
      } catch { /* se ignora */ }
    }
  };
}

export const notificationsSupported = () => typeof Notification !== "undefined";

// Solo se llama desde un clic del usuario. Devuelve true si queda concedido.
export async function requestNotificationPermission() {
  if (!notificationsSupported()) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  try { return (await Notification.requestPermission()) === "granted"; } catch { return false; }
}

export const safeStorage = () => { try { return window.localStorage; } catch { return null; } };
