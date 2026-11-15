// The chart layout: rows counted (or summed) by a property, as bars, horizontal bars, a line or a donut.
// Marks follow the data-viz rules: bars at most 24px thick with 4px rounded ends square at the baseline, 2px gaps
// between touching marks, a 2px line, hairline grid, one axis, a legend whenever there are two or more series,
// and a hover tooltip on every mark. Colours come from the validated categorical palette (--series-1…8), in order.
import { useEffect, useMemo, useRef, useState } from "react";
import { aggregate, allProps, canGroupBy, ChartConfig, ChartType, fvalue, formatNumber, groupRows, kindOf, Page } from "../../../shared/db";
import { updateView } from "../../store";
import type { ViewCtx } from "./views";

const Y_FNS = [
  { fn: "count", label: "Count" },
  { fn: "sum", label: "Sum" },
  { fn: "average", label: "Average" },
  { fn: "median", label: "Median" },
  { fn: "min", label: "Min" },
  { fn: "max", label: "Max" },
];
const TYPES: { id: ChartType; label: string }[] = [
  { id: "bar", label: "Vertical bar" },
  { id: "hbar", label: "Horizontal bar" },
  { id: "line", label: "Line" },
  { id: "donut", label: "Donut" },
];
const MAX_SERIES = 8;

interface Datum {
  key: string;
  label: string;
  value: number;
  parts: { key: string; label: string; value: number; slot: number }[];
}

function niceTicks(max: number, whole = false): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  let step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  if (whole) step = Math.max(1, Math.ceil(step));
  const out: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) out.push(+v.toFixed(10));
  if (out[out.length - 1] < max) out.push(out[out.length - 1] + step);
  return out;
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** A rounded-top bar (square at the baseline). */
function barPath(x: number, y: number, w: number, h: number, horizontal: boolean, round = true): string {
  const r = round ? Math.min(4, (horizontal ? w : h) / 2, (horizontal ? h : w) / 2) : 0;
  if (h <= 0 || w <= 0) return "";
  if (!horizontal) return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
}

export function ChartView({ ctx }: { ctx: ViewCtx }) {
  const { db, view, rows, c } = ctx;
  const cfg: ChartConfig = view.chart ?? { type: "bar", y: { fn: "count" } };
  const set = (p: Partial<ChartConfig>) => updateView(db.id, view.id, { chart: { ...cfg, ...p } });
  const props = allProps(db);
  const groupable = props.filter((p) => canGroupBy(p) && p.id !== "title");
  const numeric = ctx.props.filter((p) => kindOf(p, c, db) === "number");
  const xProp = props.find((p) => p.id === cfg.x);
  const stackProp = cfg.type === "bar" || cfg.type === "hbar" ? props.find((p) => p.id === cfg.stack) : undefined;
  const yFn = cfg.y?.fn ?? "count";
  const yProp = yFn === "count" ? undefined : ctx.props.find((p) => p.id === cfg.y?.propId);
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<{ x: number; y: number; title: string; lines: string[] } | null>(null);

  const measure = (list: Page[]) => (yFn === "count" || !yProp ? list.length : (aggregate(yFn, list.map((r) => fvalue(r, yProp, c))) as number) ?? 0);
  const fmt = (n: number) => (yProp ? formatNumber(n, yProp) : formatNumber(n, { numberFormat: "comma", decimals: Number.isInteger(n) ? 0 : 1 }));

  const { data, series } = useMemo(() => {
    if (!xProp) return { data: [] as Datum[], series: [] as { key: string; label: string; slot: number }[] };
    const groups = groupRows(rows, xProp, { groupDate: view.groupDate, hideEmptyGroups: cfg.hideEmpty, hiddenGroups: view.hiddenGroups }, c, db);
    // Series (stack groups) keep one colour each, by their order across all rows, so filters never repaint them.
    let series: { key: string; label: string; slot: number }[] = [];
    if (stackProp) {
      const all = groupRows(rows, stackProp, {}, c, db).filter((g) => g.rows.length);
      const keep = all.length <= MAX_SERIES ? all : all.slice(0, MAX_SERIES - 1);
      series = keep.map((g, i) => ({ key: g.group.key, label: g.group.label, slot: i + 1 }));
      if (all.length > MAX_SERIES) series.push({ key: "__other", label: "Other", slot: MAX_SERIES });
    }
    let data: Datum[] = groups.map(({ group, rows: list }) => {
      const parts: Datum["parts"] = [];
      if (stackProp) {
        const sub = groupRows(list, stackProp, {}, c, db);
        for (const s of series) {
          const members = s.key === "__other" ? sub.filter((g) => !series.some((x) => x.key === g.group.key)).flatMap((g) => g.rows) : (sub.find((g) => g.group.key === s.key)?.rows ?? []);
          const v = measure(members);
          if (v) parts.push({ key: s.key, label: s.label, value: v, slot: s.slot });
        }
      }
      return { key: group.key, label: group.label || "Empty", value: measure(list), parts };
    });
    if (cfg.hideEmpty) data = data.filter((d) => d.value !== 0);
    if (cfg.sortBy === "y") data = [...data].sort((a, b) => b.value - a.value);
    return { data, series };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, xProp, stackProp, yFn, yProp, cfg.hideEmpty, cfg.sortBy, view.groupDate, view.hiddenGroups, c, db]);

  const controls = (
    <div className="chart-controls">
      <label>
        <span className="muted small">Chart</span>
        <select value={cfg.type} onChange={(e) => set({ type: e.target.value as ChartType })}>
          {TYPES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span className="muted small">{cfg.type === "donut" ? "Slices" : cfg.type === "hbar" ? "Y axis" : "X axis"}</span>
        <select value={cfg.x ?? ""} onChange={(e) => set({ x: e.target.value || undefined })}>
          <option value="">Choose…</option>
          {groupable.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span className="muted small">Value</span>
        <select
          value={yFn === "count" ? "count" : `${yFn}:${cfg.y?.propId ?? ""}`}
          onChange={(e) => {
            const [fn, propId] = e.target.value.split(":");
            set({ y: fn === "count" ? { fn } : { fn, propId } });
          }}
        >
          <option value="count">Count of rows</option>
          {numeric.flatMap((p) =>
            Y_FNS.filter((f) => f.fn !== "count").map((f) => (
              <option key={f.fn + p.id} value={`${f.fn}:${p.id}`}>
                {f.label} of {p.name}
              </option>
            )),
          )}
        </select>
      </label>
      {(cfg.type === "bar" || cfg.type === "hbar") && (
        <label>
          <span className="muted small">Split by</span>
          <select value={cfg.stack ?? ""} onChange={(e) => set({ stack: e.target.value || undefined })}>
            <option value="">Nothing</option>
            {groupable
              .filter((p) => p.id !== cfg.x)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
        </label>
      )}
      <label>
        <span className="muted small">Order</span>
        <select value={cfg.sortBy ?? "x"} onChange={(e) => set({ sortBy: e.target.value === "y" ? "y" : undefined })}>
          <option value="x">As grouped</option>
          <option value="y">Largest first</option>
        </select>
      </label>
      <label className="chart-check">
        <input type="checkbox" checked={!!cfg.hideEmpty} onChange={(e) => set({ hideEmpty: e.target.checked || undefined })} />
        <span className="small">Hide empty</span>
      </label>
      {cfg.type !== "donut" && (
        <label className="chart-check">
          <input type="checkbox" checked={!!cfg.showLabels} onChange={(e) => set({ showLabels: e.target.checked || undefined })} />
          <span className="small">Show values</span>
        </label>
      )}
    </div>
  );

  if (!xProp) {
    return (
      <div className="chart-wrap">
        {controls}
        <div className="db-empty">
          <p>Choose a property to group rows by, and the chart counts the rows in each group.</p>
        </div>
      </div>
    );
  }

  const valueName = yFn === "count" ? "Rows" : `${Y_FNS.find((f) => f.fn === yFn)?.label} of ${yProp?.name ?? "…"}`;
  const tipFor = (d: Datum) => [`${valueName}: ${fmt(d.value)}`, ...d.parts.map((p) => `${p.label || "Empty"}: ${fmt(p.value)}`)];
  const show = (e: React.MouseEvent | React.FocusEvent, d: Datum) => {
    const box = ref.current!.getBoundingClientRect();
    const t = (e.currentTarget as Element).getBoundingClientRect();
    setTip({ x: t.left + t.width / 2 - box.left, y: t.top - box.top, title: d.label, lines: tipFor(d) });
  };

  return (
    <div className="chart-wrap">
      {controls}
      <div className="chart" ref={ref} onMouseLeave={() => setTip(null)}>
        {data.length === 0 ? (
          <div className="db-empty">
            <p>No rows to chart.</p>
          </div>
        ) : cfg.type === "donut" ? (
          <Donut data={data} width={width} fmt={fmt} show={show} hide={() => setTip(null)} />
        ) : cfg.type === "line" ? (
          <Line data={data} width={width} fmt={fmt} labels={!!cfg.showLabels} show={show} hide={() => setTip(null)} whole={yFn === "count"} />
        ) : (
          <Bars data={data} width={width} fmt={fmt} labels={!!cfg.showLabels} horizontal={cfg.type === "hbar"} stacked={!!stackProp} show={show} hide={() => setTip(null)} whole={yFn === "count"} />
        )}
        {tip && (
          <div className="chart-tip" style={{ left: tip.x, top: tip.y }} role="tooltip">
            <b>{tip.title}</b>
            {tip.lines.map((l, i) => (
              <span key={i}>{l}</span>
            ))}
          </div>
        )}
        {(series.length > 1 || cfg.type === "donut") && (
          <div className="chart-legend" aria-hidden>
            {(cfg.type === "donut" ? data.slice(0, MAX_SERIES).map((d, i) => ({ key: d.key, label: d.label, slot: i + 1 })) : series).map((s) => (
              <span key={s.key} className="legend-item">
                <span className={"legend-swatch s" + s.slot} />
                {s.label || "Empty"}
              </span>
            ))}
            {cfg.type === "donut" && data.length > MAX_SERIES && (
              <span className="legend-item">
                <span className={"legend-swatch s" + MAX_SERIES} />
                Other
              </span>
            )}
          </div>
        )}
        <table className="sr-only">
          <caption>
            {valueName} by {xProp.name}
          </caption>
          <thead>
            <tr>
              <th>{xProp.name}</th>
              <th>{valueName}</th>
            </tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.key}>
                <td>{d.label}</td>
                <td>{fmt(d.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

type Show = (e: React.MouseEvent | React.FocusEvent, d: Datum) => void;

function Bars({ data, width, fmt, labels, horizontal, stacked, show, hide, whole }: { data: Datum[]; width: number; fmt: (n: number) => string; labels: boolean; horizontal: boolean; stacked: boolean; show: Show; hide: () => void; whole: boolean }) {
  const max = Math.max(0, ...data.map((d) => d.value));
  const ticks = niceTicks(max, whole);
  const top = ticks[ticks.length - 1] || 1;
  if (horizontal) {
    const labelW = Math.min(180, Math.max(70, Math.round(width * 0.24)));
    const band = 32;
    const thick = 20;
    const plotW = width - labelW - 56;
    const h = data.length * band + 28;
    const sx = (v: number) => (v / top) * plotW;
    return (
      <svg width={width} height={h} className="chart-svg" role="img" aria-label="Bar chart">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={labelW + sx(t)} x2={labelW + sx(t)} y1={0} y2={h - 22} className="grid" />
            <text x={labelW + sx(t)} y={h - 6} className="axis" textAnchor="middle">
              {fmt(t)}
            </text>
          </g>
        ))}
        <line x1={labelW} x2={labelW} y1={0} y2={h - 22} className="baseline" />
        {data.map((d, i) => {
          const y = i * band + (band - thick) / 2;
          let x = labelW;
          const segs = stacked && d.parts.length ? d.parts : [{ key: "all", label: d.label, value: d.value, slot: 1 }];
          return (
            <g key={d.key} className="mark" tabIndex={0} onMouseEnter={(e) => show(e, d)} onFocus={(e) => show(e, d)} onBlur={hide}>
              <rect x={labelW} y={i * band} width={plotW} height={band} className="hit" />
              <text x={labelW - 8} y={y + thick / 2} className="cat" textAnchor="end" dominantBaseline="middle">
                {d.label.length > 22 ? d.label.slice(0, 21) + "…" : d.label}
              </text>
              {segs.map((s, j) => {
                const w = sx(s.value);
                const gap = j < segs.length - 1 ? 2 : 0;
                const path = barPath(x, y, Math.max(0, w - gap), thick, true, j === segs.length - 1);
                x += w;
                return path ? <path key={s.key} d={path} className={"fill s" + s.slot} /> : null;
              })}
              {labels && (
                <text x={labelW + sx(d.value) + 6} y={y + thick / 2} className="val" dominantBaseline="middle">
                  {fmt(d.value)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    );
  }
  const h = 280;
  const left = 48;
  const bottom = 46;
  const plotH = h - bottom - 12;
  const plotW = width - left - 8;
  const band = plotW / data.length;
  const thick = Math.min(24, Math.max(4, band * 0.6));
  const sy = (v: number) => (v / top) * plotH;
  const rotate = band < 64;
  return (
    <svg width={width} height={h} className="chart-svg" role="img" aria-label="Bar chart">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={left} x2={width - 8} y1={12 + plotH - sy(t)} y2={12 + plotH - sy(t)} className={t === 0 ? "baseline" : "grid"} />
          <text x={left - 6} y={12 + plotH - sy(t)} className="axis" textAnchor="end" dominantBaseline="middle">
            {fmt(t)}
          </text>
        </g>
      ))}
      {data.map((d, i) => {
        const x = left + i * band + (band - thick) / 2;
        let y = 12 + plotH;
        const segs = stacked && d.parts.length ? d.parts : [{ key: "all", label: d.label, value: d.value, slot: 1 }];
        const lx = left + i * band + band / 2;
        return (
          <g key={d.key} className="mark" tabIndex={0} onMouseEnter={(e) => show(e, d)} onFocus={(e) => show(e, d)} onBlur={hide}>
            <rect x={left + i * band} y={12} width={band} height={plotH} className="hit" />
            {segs.map((s, j) => {
              const hh = sy(s.value);
              const gap = j < segs.length - 1 ? 2 : 0;
              y -= hh;
              const path = barPath(x, y + gap, thick, Math.max(0, hh - gap), false, j === segs.length - 1);
              return path ? <path key={s.key} d={path} className={"fill s" + s.slot} /> : null;
            })}
            {labels && (
              <text x={lx} y={12 + plotH - sy(d.value) - 6} className="val" textAnchor="middle">
                {fmt(d.value)}
              </text>
            )}
            <text
              x={lx}
              y={12 + plotH + 16}
              className="cat"
              textAnchor={rotate ? "end" : "middle"}
              transform={rotate ? `rotate(-35 ${lx} ${12 + plotH + 16})` : undefined}
            >
              {d.label.length > 14 ? d.label.slice(0, 13) + "…" : d.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function Line({ data, width, fmt, labels, show, hide, whole }: { data: Datum[]; width: number; fmt: (n: number) => string; labels: boolean; show: Show; hide: () => void; whole: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(0, ...data.map((d) => d.value));
  const ticks = niceTicks(max, whole);
  const top = ticks[ticks.length - 1] || 1;
  const h = 280;
  const left = 48;
  const bottom = 46;
  const plotH = h - bottom - 12;
  const plotW = width - left - 16;
  const step = data.length > 1 ? plotW / (data.length - 1) : 0;
  const px = (i: number) => left + (data.length > 1 ? i * step : plotW / 2);
  const py = (v: number) => 12 + plotH - (v / top) * plotH;
  const path = data.map((d, i) => `${i ? "L" : "M"}${px(i)},${py(d.value)}`).join("");
  const every = Math.max(1, Math.ceil(data.length / Math.max(1, Math.floor(plotW / 70))));
  return (
    <svg width={width} height={h} className="chart-svg" role="img" aria-label="Line chart">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={left} x2={width - 8} y1={py(t)} y2={py(t)} className={t === 0 ? "baseline" : "grid"} />
          <text x={left - 6} y={py(t)} className="axis" textAnchor="end" dominantBaseline="middle">
            {fmt(t)}
          </text>
        </g>
      ))}
      {hover != null && <line x1={px(hover)} x2={px(hover)} y1={12} y2={12 + plotH} className="crosshair" />}
      <path d={path} className="line s1" />
      {data.map((d, i) => (
        <g
          key={d.key}
          className="mark"
          tabIndex={0}
          onMouseEnter={(e) => (setHover(i), show(e, d))}
          onFocus={(e) => (setHover(i), show(e, d))}
          onBlur={() => (setHover(null), hide())}
          onMouseLeave={() => setHover(null)}
        >
          <rect x={px(i) - Math.max(step, 24) / 2} y={12} width={Math.max(step, 24)} height={plotH} className="hit" />
          {(hover === i || data.length === 1) && <circle cx={px(i)} cy={py(d.value)} r={4} className="dot s1" />}
          {labels && (i === data.length - 1 || i === data.findIndex((x) => x.value === max)) && (
            <text x={px(i)} y={py(d.value) - 10} className="val" textAnchor="middle">
              {fmt(d.value)}
            </text>
          )}
          {i % every === 0 && (
            <text x={px(i)} y={12 + plotH + 16} className="cat" textAnchor="middle">
              {d.label.length > 12 ? d.label.slice(0, 11) + "…" : d.label}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}

function Donut({ data, width, fmt, show, hide }: { data: Datum[]; width: number; fmt: (n: number) => string; show: Show; hide: () => void }) {
  const size = Math.min(260, width - 16);
  const r = size / 2 - 4;
  const inner = r * 0.62;
  const cx = width / 2;
  const cy = size / 2 + 4;
  const shown = data.slice(0, MAX_SERIES - (data.length > MAX_SERIES ? 1 : 0));
  const rest = data.slice(shown.length);
  const slices: (Datum & { slot: number })[] = shown.map((d, i) => ({ ...d, slot: i + 1 }));
  if (rest.length) slices.push({ key: "__other", label: "Other", value: rest.reduce((a, b) => a + b.value, 0), parts: [], slot: MAX_SERIES });
  const total = slices.reduce((a, b) => a + Math.max(0, b.value), 0);
  let angle = -Math.PI / 2;
  const arc = (a0: number, a1: number) => {
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p = (rad: number, rr: number) => `${cx + rr * Math.cos(rad)},${cy + rr * Math.sin(rad)}`;
    return `M${p(a0, r)}A${r},${r} 0 ${large} 1 ${p(a1, r)}L${p(a1, inner)}A${inner},${inner} 0 ${large} 0 ${p(a0, inner)}Z`;
  };
  return (
    <svg width={width} height={size + 8} className="chart-svg" role="img" aria-label="Donut chart">
      {total > 0 &&
        slices.map((s) => {
          const span = (Math.max(0, s.value) / total) * Math.PI * 2;
          const a0 = angle;
          angle += span;
          if (span <= 0) return null;
          const full = span >= Math.PI * 2 - 1e-6;
          return (
            <g key={s.key} className="mark" tabIndex={0} onMouseEnter={(e) => show(e, s)} onFocus={(e) => show(e, s)} onBlur={hide}>
              {full ? (
                <>
                  <circle cx={cx} cy={cy} r={(r + inner) / 2} className={"ring s" + s.slot} strokeWidth={r - inner} fill="none" />
                </>
              ) : (
                <path d={arc(a0, a0 + span)} className={"fill s" + s.slot + " slice"} />
              )}
            </g>
          );
        })}
      <text x={cx} y={cy - 6} className="donut-total" textAnchor="middle">
        {fmt(total)}
      </text>
      <text x={cx} y={cy + 14} className="axis" textAnchor="middle">
        Total
      </text>
    </svg>
  );
}

