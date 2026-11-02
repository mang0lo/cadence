import { useEffect, useMemo, useRef } from 'react';
import { useChartTheme } from '@/components/charts/theme';
import { useT } from '@/lib/i18n';

/** Standard ECG paper: 25 mm per second, 10 mm per millivolt, 1 mm small squares and 5 mm bold squares. */
export const MM_PER_SECOND = 25;
export const MM_PER_MV = 10;
const GUTTER_MM = 14;
const RULER_MM = 6;

const toMm = (microvolts: number) => (microvolts / 1000) * MM_PER_MV;

export interface EcgPaperProps {
  /** µV */
  samples: number[];
  rateHz: number;
  /** sample indices of the R peaks */
  rPeaks?: number[];
  showPeaks?: boolean;
  /** screen pixels per millimetre of paper (zoom) */
  pxPerMm: number;
  ariaLabel: string;
}

/**
 * The recording drawn on ECG paper (canvas 2D): red millimetre grid with bold 5 mm lines, a 1 mV calibration pulse,
 * the trace and a seconds ruler. The canvas is as wide as the strip (25 mm/s), the container scrolls sideways.
 */
export function EcgPaper({ samples, rateHz, rPeaks = [], showPeaks = false, pxPerMm, ariaLabel }: EcgPaperProps) {
  const t = useT();
  const theme = useChartTheme();
  const ref = useRef<HTMLCanvasElement>(null);

  const geo = useMemo(() => {
    let lo = 0;
    let hi = 0;
    for (const v of samples) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const seconds = rateHz > 0 ? samples.length / rateHz : 0;
    const topMm = Math.max(20, Math.ceil((toMm(hi) + 4) / 5) * 5);
    const botMm = Math.max(20, Math.ceil((-toMm(lo) + 4) / 5) * 5);
    const widthMm = Math.ceil(GUTTER_MM + seconds * MM_PER_SECOND + 4);
    return { seconds, topMm, botMm, widthMm, heightMm: topMm + botMm + RULER_MM };
  }, [samples, rateHz]);

  const width = geo.widthMm * pxPerMm;
  const height = geo.heightMm * pxPerMm;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const px = pxPerMm;
    const dark = theme.dark;

    // paper
    ctx.fillStyle = dark ? theme.surface : '#fffafa';
    ctx.fillRect(0, 0, width, height);
    // grid: 1 mm hairlines, 5 mm bold
    const minor = dark ? 'rgba(240,110,110,0.13)' : 'rgba(229,115,115,0.22)';
    const major = dark ? 'rgba(240,110,110,0.30)' : 'rgba(229,115,115,0.48)';
    ctx.lineWidth = 1;
    for (const [color, step] of [
      [minor, 1],
      [major, 5],
    ] as const) {
      ctx.strokeStyle = color;
      ctx.beginPath();
      for (let mm = 0; mm <= geo.widthMm; mm += step) {
        if (step === 1 && mm % 5 === 0) continue; // drawn by the bold pass
        const x = Math.round(mm * px) + 0.5;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height - RULER_MM * px);
      }
      for (let mm = 0; mm <= geo.topMm + geo.botMm; mm += step) {
        if (step === 1 && mm % 5 === 0) continue;
        const y = Math.round(mm * px) + 0.5;
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
      }
      ctx.stroke();
    }

    const y0 = geo.topMm * px; // baseline (0 µV)
    const x0 = GUTTER_MM * px;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // calibration pulse: 1 mV = 10 mm tall, 5 mm wide
    ctx.strokeStyle = theme.fg;
    ctx.lineWidth = Math.max(1.2, px * 0.3);
    ctx.beginPath();
    ctx.moveTo(2 * px, y0);
    ctx.lineTo(4 * px, y0);
    ctx.lineTo(4 * px, y0 - MM_PER_MV * px);
    ctx.lineTo(9 * px, y0 - MM_PER_MV * px);
    ctx.lineTo(9 * px, y0);
    ctx.lineTo(x0 - px, y0);
    ctx.stroke();

    // trace
    ctx.lineWidth = Math.max(1.25, px * 0.3);
    ctx.beginPath();
    const dx = (MM_PER_SECOND * px) / rateHz;
    samples.forEach((v, i) => {
      const x = x0 + i * dx;
      const y = y0 - toMm(v) * px;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // detected heartbeats: small markers above the R peaks
    if (showPeaks) {
      ctx.fillStyle = dark ? '#ff8a3d' : theme.accent;
      for (const p of rPeaks) {
        const v = samples[p];
        if (v === undefined) continue;
        const x = x0 + p * dx;
        const y = y0 - toMm(v) * px - 2.5 * px;
        ctx.beginPath();
        ctx.moveTo(x - 1.4 * px, y - 2.4 * px);
        ctx.lineTo(x + 1.4 * px, y - 2.4 * px);
        ctx.lineTo(x, y);
        ctx.closePath();
        ctx.fill();
      }
    }

    // seconds ruler
    ctx.fillStyle = theme.muted;
    ctx.strokeStyle = theme.muted;
    ctx.lineWidth = 1;
    ctx.font = `${Math.max(10, px * 2.6)}px ${theme.font}`;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    const rulerY = (geo.topMm + geo.botMm) * px;
    ctx.beginPath();
    for (let s = 0; s <= geo.seconds; s++) {
      const x = Math.round(x0 + s * MM_PER_SECOND * px) + 0.5;
      ctx.moveTo(x, rulerY + 1);
      ctx.lineTo(x, rulerY + 0.8 * px);
    }
    ctx.stroke();
    const labelStep = px >= 3 ? 1 : 2;
    for (let s = 0; s <= geo.seconds; s += labelStep) {
      ctx.fillText(`${s} s`, x0 + s * MM_PER_SECOND * px, rulerY + 1.1 * px);
    }
  }, [samples, rateHz, rPeaks, showPeaks, pxPerMm, theme, geo, width, height]);

  return (
    <div
      className="overflow-x-auto rounded-control border border-border scrollbar-thin"
      tabIndex={0}
      role="group"
      aria-label={t('health.ecg.paper.title')}
    >
      <canvas ref={ref} role="img" aria-label={ariaLabel} style={{ width, height, display: 'block' }} />
    </div>
  );
}
