// Stage 4: turn provider confidence into a calibrated probability-of-correct, then pick a threshold on a dev set.
export interface Calibrator { fit(samples: { conf: number; correct: boolean }[]): void; apply(conf: number): number }

export class IdentityCalibrator implements Calibrator { fit() {} apply(c: number) { return c; } }

/** Isotonic regression (pool-adjacent-violators). Monotone, no parametric assumptions; needs a few hundred labelled lines. */
export class IsotonicCalibrator implements Calibrator {
  private xs: number[] = []; private ys: number[] = [];
  fit(samples: { conf: number; correct: boolean }[]) {
    const s = [...samples].sort((a, b) => a.conf - b.conf);
    const blocks: { x: number; y: number; w: number }[] = [];
    for (const p of s) {
      blocks.push({ x: p.conf, y: p.correct ? 1 : 0, w: 1 });
      while (blocks.length > 1 && blocks[blocks.length - 2].y > blocks[blocks.length - 1].y) {
        const b = blocks.pop()!, a = blocks.pop()!; const w = a.w + b.w;
        blocks.push({ x: b.x, y: (a.y * a.w + b.y * b.w) / w, w });
      }
    }
    this.xs = blocks.map(b => b.x); this.ys = blocks.map(b => b.y);
  }
  apply(c: number) {
    if (!this.xs.length) return c;
    const i = this.xs.findIndex(x => x >= c);
    return i < 0 ? this.ys[this.ys.length - 1] : this.ys[i];
  }
}

/** Lowest threshold whose auto-accepted set still meets the precision target → maximum coverage at that precision. */
export function chooseThreshold(samples: { conf: number; correct: boolean }[], targetPrecision: number, minAccepted = 20): { threshold: number; precision: number; coverage: number } {
  const s = [...samples].sort((a, b) => b.conf - a.conf);
  let ok = 0; let best = { threshold: 1.01, precision: 1, coverage: 0 };
  s.forEach((p, i) => {
    if (p.correct) ok++;
    const prec = ok / (i + 1);
    const nextSame = i + 1 < s.length && s[i + 1].conf === p.conf;
    if (!nextSame && i + 1 >= minAccepted && prec >= targetPrecision) best = { threshold: p.conf, precision: prec, coverage: (i + 1) / s.length };
  });
  return best;
}
