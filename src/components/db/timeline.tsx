// The timeline layout: each row is a bar from its start date to its end date. Drag a bar to move it, drag its
// ends to change when it starts or ends, click an empty row's track to give it a date.
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { dateVal, DateVal, daysBetween, moveDate, shiftDay, storeDate, ymd } from "../../../shared/db";
import { isFresh, Page, setRowProp, updateView } from "../../store";
import { EditableValue } from "./values";
import { useRowMenu, type ViewCtx } from "./views";

type Scale = "day" | "week" | "month" | "quarter" | "year";
const PX: Record<Scale, number> = { day: 44, week: 16, month: 5, quarter: 2.2, year: 0.75 };
const SCALES: { id: Scale; label: string }[] = [
  { id: "day", label: "Day" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
  { id: "quarter", label: "Quarter" },
  { id: "year", label: "Year" },
];
const ROW_H = 36;

function addDays(day: string, n: number) {
  return shiftDay(day, n).slice(0, 10);
}

export function TimelineView({ ctx }: { ctx: ViewCtx }) {
  const { db, view, rows, props, locked } = ctx;
  const startProp = props.find((p) => p.id === view.dateProp && (p.type === "date" || p.type === "created_time" || p.type === "last_edited_time"));
  const endProp = props.find((p) => p.id === view.endProp && p.type === "date");
  const scale: Scale = view.timelineScale ?? "week";
  const px = PX[scale];
  const scroller = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ id: string; mode: "move" | "start" | "end"; dx: number } | null>(null);
  const today = ymd(new Date());
  const rm = useRowMenu(ctx);

  const spanOf = (r: Page): [string, string] | null => {
    if (!startProp) return null;
    if (startProp.type === "created_time") return [ymd(r.createdAt), ymd(r.createdAt)];
    if (startProp.type === "last_edited_time") return [ymd(r.updatedAt), ymd(r.updatedAt)];
    const d = dateVal(r.props?.[startProp.id]);
    if (!d) return null;
    const a = d.start.slice(0, 10);
    let b = (d.end ?? d.start).slice(0, 10);
    if (endProp) {
      const e = dateVal(r.props?.[endProp.id]);
      if (e) b = e.start.slice(0, 10);
    }
    return b < a ? [a, a] : [a, b];
  };

  // The visible stretch of time: every row's dates plus some room, and never less than a few months around today.
  const origin = useMemo(() => {
    let lo = addDays(today, -45);
    let hi = addDays(today, 120);
    for (const r of rows) {
      const s = spanOf(r);
      if (!s) continue;
      if (s[0] < lo) lo = addDays(s[0], -14);
      if (s[1] > hi) hi = addDays(s[1], 30);
    }
    const [y, m] = lo.split("-").map(Number);
    return { start: ymd(new Date(y, m - 1, 1)), days: daysBetween(ymd(new Date(y, m - 1, 1)), hi) + 1 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, startProp?.id, endProp?.id, today]);

  // Open on today.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = Math.max(0, daysBetween(origin.start, today) * px - el.clientWidth / 3);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale, startProp?.id]);

  // Months (and, zoomed in, days) along the top.
  const header = useMemo(() => {
    const months: { label: string; x: number; w: number }[] = [];
    const ticks: { label: string; x: number; weekend?: boolean; today?: boolean }[] = [];
    for (let i = 0; i < origin.days; i++) {
      const day = addDays(origin.start, i);
      const [y, m, d] = day.split("-").map(Number);
      const date = new Date(y, m - 1, d);
      if (d === 1 || i === 0) {
        const len = new Date(y, m, 0).getDate() - d + 1;
        months.push({ label: date.toLocaleDateString(undefined, scale === "year" || scale === "quarter" ? { month: "short", year: "2-digit" } : { month: "long", year: "numeric" }), x: i * px, w: len * px });
      }
      if (scale === "day") ticks.push({ label: String(d), x: i * px, weekend: date.getDay() === 0 || date.getDay() === 6, today: day === today });
      else if (scale === "week" && date.getDay() === 1) ticks.push({ label: String(d), x: i * px });
    }
    return { months, ticks };
  }, [origin, px, scale, today]);

  if (!startProp) {
    return (
      <div className="db-empty">
        <p>A timeline shows each row as a bar across the dates in a date property.</p>
        <button className="btn" onClick={() => updateView(db.id, view.id, { dateProp: props.find((p) => p.type === "date")?.id })} disabled={!props.some((p) => p.type === "date")}>
          Choose a date property
        </button>
      </div>
    );
  }
  const editable = !locked && startProp.type === "date";
  const total = origin.days * px;
  const xOf = (day: string) => daysBetween(origin.start, day) * px;

  const commit = (r: Page, mode: "move" | "start" | "end", days: number) => {
    if (!days) return;
    const d = dateVal(r.props?.[startProp.id]) as DateVal | null;
    if (!d) return;
    if (endProp) {
      const e = dateVal(r.props?.[endProp.id]);
      if (mode !== "end") setRowProp(r.id, startProp.id, storeDate({ start: shiftDay(d.start, days) }));
      if (mode !== "start" && e) setRowProp(r.id, endProp.id, storeDate({ start: shiftDay(e.start, days) }));
      if (mode === "end" && !e) setRowProp(r.id, endProp.id, addDays(d.start, days));
      return;
    }
    if (mode === "move") return setRowProp(r.id, startProp.id, storeDate(moveDate(d, addDays(d.start, days))));
    const start = mode === "start" ? shiftDay(d.start, days) : d.start;
    let end = mode === "end" ? shiftDay(d.end ?? d.start, days) : (d.end ?? d.start);
    if (end.slice(0, 10) < start.slice(0, 10)) end = start;
    setRowProp(r.id, startProp.id, storeDate({ start, end: end.slice(0, 10) === start.slice(0, 10) && !d.end ? undefined : end }));
  };

  const begin = (e: React.PointerEvent, r: Page, mode: "move" | "start" | "end") => {
    if (!editable || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    let moved = false;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0;
      if (Math.abs(dx) > 3) moved = true;
      setDrag({ id: r.id, mode, dx });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDrag(null);
      if (!moved) return mode === "move" && ctx.open(r.id);
      commit(r, mode, Math.round((ev.clientX - x0) / px));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const showTable = view.showTable !== false;
  return (
    <div className="timeline">
      {rm.node}
      <div className="tl-head">
        <div className="seg" role="group" aria-label="Zoom">
          {SCALES.map((s) => (
            <button key={s.id} className={scale === s.id ? "active" : ""} onClick={() => updateView(db.id, view.id, { timelineScale: s.id === "week" ? undefined : s.id })}>
              {s.label}
            </button>
          ))}
        </div>
        <button
          className="btn-ghost small"
          onClick={() => {
            const el = scroller.current;
            if (el) el.scrollTo({ left: Math.max(0, xOf(today) - el.clientWidth / 3), behavior: "smooth" });
          }}
        >
          Today
        </button>
      </div>
      <div className="tl-body">
        {showTable && (
          <div className="tl-table">
            <div className="tl-cell tl-th">Name</div>
            {rows.map((r) => (
              <div key={r.id} className={"tl-cell" + (isFresh(r) ? " fresh" : "")} onClick={() => ctx.open(r.id)} onContextMenu={(e) => rm.open(e, r)}>
                {view.showIcons !== false && r.icon && <span className="row-icon">{r.icon}</span>}
                <EditableValue dbId={db.id} row={r} prop={{ id: "title", name: "Name", type: "text" }} c={ctx.c} locked={locked} className="title-value" />
              </div>
            ))}
            {!locked && (
              <button className="add-row" onClick={() => ctx.open(ctx.addRow({ [startProp.id]: today }))}>
                <Plus size={14} /> New
              </button>
            )}
          </div>
        )}
        <div className="tl-scroll" ref={scroller}>
          <div className="tl-canvas" style={{ width: total }}>
            <div className="tl-months">
              {header.months.map((m) => (
                <div key={m.x} className="tl-month" style={{ left: m.x, width: m.w }}>
                  <span>{m.label}</span>
                </div>
              ))}
            </div>
            <div className="tl-ticks">
              {header.ticks.map((t) => (
                <div key={t.x} className={"tl-tick" + (t.weekend ? " weekend" : "") + (t.today ? " today" : "")} style={{ left: t.x, width: scale === "day" ? px : undefined }}>
                  {t.label}
                </div>
              ))}
            </div>
            <div className="tl-rows" style={{ height: rows.length * ROW_H + (locked ? 0 : ROW_H) }}>
              {scale === "day" &&
                header.ticks.filter((t) => t.weekend).map((t) => <div key={"w" + t.x} className="tl-weekend" style={{ left: t.x, width: px }} />)}
              <div className="tl-today" style={{ left: xOf(today) + (scale === "day" ? px / 2 : 0) }} aria-hidden />
              {rows.map((r, i) => {
                const s = spanOf(r);
                const top = i * ROW_H;
                if (!s) {
                  return (
                    <div
                      key={r.id}
                      className={"tl-row empty" + (editable ? " can-set" : "")}
                      style={{ top }}
                      onClick={(e) => {
                        if (!editable) return;
                        const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
                        setRowProp(r.id, startProp.id, addDays(origin.start, Math.floor((e.clientX - box.left) / px)));
                      }}
                      title={editable ? "Click to place it on this day" : undefined}
                    >
                      {!showTable && <span className="tl-undated">{r.title?.trim() || "Untitled"}: no date</span>}
                    </div>
                  );
                }
                let x = xOf(s[0]);
                let w = (daysBetween(s[0], s[1]) + 1) * px;
                if (drag?.id === r.id) {
                  if (drag.mode === "move") x += drag.dx;
                  else if (drag.mode === "start") {
                    x += Math.min(drag.dx, w - px);
                    w -= Math.min(drag.dx, w - px);
                  } else w = Math.max(px, w + drag.dx);
                }
                return (
                  <div key={r.id} className="tl-row" style={{ top }}>
                    <div
                      className={"tl-bar" + (drag?.id === r.id ? " dragging" : "") + (isFresh(r) ? " fresh" : "") + (Math.max(8, w) < 90 ? " narrow" : "")}
                      style={{ left: x, width: Math.max(8, w) }}
                      onPointerDown={(e) => (editable ? begin(e, r, "move") : undefined)}
                      onClick={() => !editable && ctx.open(r.id)}
                      onContextMenu={(e) => rm.open(e, r)}
                      title={`${r.title?.trim() || "Untitled"} · ${s[0]}${s[1] !== s[0] ? " → " + s[1] : ""}`}
                    >
                      {editable && <span className="tl-grip start" onPointerDown={(e) => begin(e, r, "start")} aria-hidden />}
                      <span className="tl-bar-label">
                        {view.showIcons !== false && r.icon ? r.icon + " " : ""}
                        {r.title?.trim() || "Untitled"}
                      </span>
                      {editable && <span className="tl-grip end" onPointerDown={(e) => begin(e, r, "end")} aria-hidden />}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

