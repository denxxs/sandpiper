// The database toolbar's menus: filters (with and/or groups), sorts, and the view's settings.
import { useRef } from "react";
import { ChevronRight, Copy, Eye, EyeOff, GripVertical, Layers, Plus, Trash2, X } from "lucide-react";
import {
  allProps,
  canGroupBy,
  DbCtx,
  DbFilter,
  DbFilterGroup,
  FilterItem,
  GROUP_DATES,
  isGroup,
  kindOf,
  opsFor,
  RELATIVE_DAYS,
  VIEW_LABEL,
  VIEW_TYPES,
  WITHIN,
} from "../../../shared/db";
import { DbProperty, DbSort, DbView, moveProperty, nid, Page, updatePage, updateView, User } from "../../store";
import { Dropdown, MenuItem, MenuLabel, MenuSep, Toggle } from "../ui";
import { AddPropertyMenu } from "./propMenu";
import { PROP_ICON } from "./values";
import { VIEW_ICON } from "./icons";

export interface BarCtx {
  db: Page;
  view: DbView;
  props: DbProperty[];
  c: DbCtx;
  users: Record<string, User>;
}

// ---------------------------------------------------------------- filters

function FilterValue({ f, prop, ctx, patch }: { f: DbFilter; prop: DbProperty; ctx: BarCtx; patch: (p: Partial<DbFilter>) => void }) {
  const kind = kindOf(prop, ctx.c, ctx.db);
  if (f.op === "within") {
    return (
      <select className="grow" value={f.value ?? ""} onChange={(e) => patch({ value: e.target.value || undefined })}>
        <option value="">Choose…</option>
        {WITHIN.map((w) => (
          <option key={w.id} value={w.id}>
            {w.label}
          </option>
        ))}
      </select>
    );
  }
  if (prop.type === "select" || prop.type === "multi_select" || prop.type === "status") {
    return (
      <select className="grow" value={f.value ?? ""} onChange={(e) => patch({ value: e.target.value || undefined })}>
        <option value="">Select…</option>
        {prop.type === "status" && (
          <optgroup label="Groups">
            <option value="group:todo">To-do (any)</option>
            <option value="group:doing">In progress (any)</option>
            <option value="group:done">Complete (any)</option>
          </optgroup>
        )}
        {(prop.options ?? []).map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    );
  }
  if (prop.type === "person" || prop.type === "created_by" || prop.type === "last_edited_by") {
    return (
      <select className="grow" value={f.value ?? ""} onChange={(e) => patch({ value: e.target.value || undefined })}>
        <option value="">Select…</option>
        {Object.values(ctx.users).map((u) => (
          <option key={u.id} value={u.id}>
            {u.name}
          </option>
        ))}
      </select>
    );
  }
  if (prop.type === "relation") {
    const target = prop.relation ? ctx.c.pages[prop.relation.dbId] : undefined;
    const rows = Object.values(ctx.c.pages).filter((p) => p.parentId === target?.id && p.isRow && !p.trashed);
    return (
      <select className="grow" value={f.value ?? ""} onChange={(e) => patch({ value: e.target.value || undefined })}>
        <option value="">Select…</option>
        {rows.map((r) => (
          <option key={r.id} value={r.id}>
            {r.title?.trim() || "Untitled"}
          </option>
        ))}
      </select>
    );
  }
  if (kind === "date") {
    const relative = RELATIVE_DAYS.some((r) => r.id === f.value);
    return (
      <span className="grow row gap">
        <select value={relative ? f.value : "exact"} onChange={(e) => patch({ value: e.target.value === "exact" ? "" : e.target.value })}>
          <option value="exact">Exact date</option>
          {RELATIVE_DAYS.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>
        {!relative && <input type="date" className="grow" value={f.value ?? ""} onChange={(e) => patch({ value: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />}
      </span>
    );
  }
  return (
    <input
      className="grow"
      type={kind === "number" ? "number" : "text"}
      value={f.value ?? ""}
      placeholder="Value"
      onChange={(e) => patch({ value: e.target.value })}
      onKeyDown={(e) => e.stopPropagation()}
    />
  );
}

function FilterRow({ f, ctx, lead, onChange, onRemove }: { f: DbFilter; ctx: BarCtx; lead: React.ReactNode; onChange: (f: DbFilter) => void; onRemove: () => void }) {
  const all = allProps(ctx.db).filter((p) => p.type !== "button");
  const prop = all.find((p) => p.id === f.propId);
  if (!prop) return null;
  const ops = opsFor(prop, ctx.c, ctx.db);
  const def = ops.find((o) => o.op === f.op) ?? ops[0];
  const patch = (p: Partial<DbFilter>) => onChange({ ...f, ...p });
  return (
    <div className="filter-row">
      <span className="filter-lead">{lead}</span>
      <select
        value={f.propId}
        onChange={(e) => {
          const np = all.find((p) => p.id === e.target.value)!;
          onChange({ id: f.id, propId: np.id, op: opsFor(np, ctx.c, ctx.db)[0]?.op ?? "contains" });
        }}
      >
        {all.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <select value={def?.op} onChange={(e) => patch({ op: e.target.value, value: e.target.value === "within" ? "this_week" : f.op === "within" ? undefined : f.value })}>
        {ops.map((o) => (
          <option key={o.op} value={o.op}>
            {o.label}
          </option>
        ))}
      </select>
      {def?.noValue ? <span className="grow" /> : <FilterValue f={f} prop={prop} ctx={ctx} patch={patch} />}
      <button className="icon-btn tiny" onClick={onRemove} title="Remove filter">
        <X size={14} />
      </button>
    </div>
  );
}

function Conj({ op, first, onChange }: { op: "and" | "or"; first: boolean; onChange?: (op: "and" | "or") => void }) {
  if (first) return <span className="muted small">Where</span>;
  if (!onChange) return <span className="muted small">{op === "or" ? "Or" : "And"}</span>;
  return (
    <select className="conj" value={op} onChange={(e) => onChange(e.target.value as "and" | "or")} aria-label="How filters combine">
      <option value="and">And</option>
      <option value="or">Or</option>
    </select>
  );
}

export function FilterMenu({ ctx }: { ctx: BarCtx }) {
  const { db, view } = ctx;
  const set = (filters: FilterItem[]) => updateView(db.id, view.id, { filters });
  const op = view.filterOp ?? "and";
  const replace = (id: string, item: FilterItem | null) => set(item ? view.filters.map((f) => (f.id === id ? item : f)) : view.filters.filter((f) => f.id !== id));
  const firstProp = allProps(db)[0];
  const blank = (): DbFilter => ({ id: nid(6), propId: firstProp.id, op: opsFor(firstProp, ctx.c, db)[0]?.op ?? "contains" });
  return (
    <div className="menu filter-menu">
      {view.filters.length === 0 && <div className="muted small pad">No filters yet. Add one to show only the rows you want.</div>}
      {view.filters.map((f, i) => {
        const lead = <Conj op={op} first={i === 0} onChange={i === 1 ? (o) => updateView(db.id, view.id, { filterOp: o }) : undefined} />;
        if (!isGroup(f)) return <FilterRow key={f.id} f={f} ctx={ctx} lead={lead} onChange={(n) => replace(f.id, n)} onRemove={() => replace(f.id, null)} />;
        const g = f as DbFilterGroup;
        const setG = (p: Partial<DbFilterGroup>) => replace(g.id, { ...g, ...p });
        return (
          <div key={g.id} className="filter-group-wrap">
            <span className="filter-lead">{lead}</span>
            <div className="filter-group">
              {g.filters.map((x, j) => (
                <FilterRow
                  key={x.id}
                  f={x}
                  ctx={ctx}
                  lead={<Conj op={g.group} first={j === 0} onChange={j === 1 ? (o) => setG({ group: o }) : undefined} />}
                  onChange={(n) => setG({ filters: g.filters.map((y) => (y.id === x.id ? n : y)) })}
                  onRemove={() => {
                    const rest = g.filters.filter((y) => y.id !== x.id);
                    replace(g.id, rest.length ? { ...g, filters: rest } : null);
                  }}
                />
              ))}
              <div className="row gap">
                <button className="btn-ghost small" onClick={() => setG({ filters: [...g.filters, blank()] })}>
                  <Plus size={13} /> Add a filter to this group
                </button>
                <span className="grow" />
                <button className="icon-btn tiny" onClick={() => replace(g.id, null)} title="Remove group">
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          </div>
        );
      })}
      <MenuSep />
      <MenuItem icon={<Plus size={14} />} label="Add a filter" onClick={() => set([...view.filters, blank()])} />
      <MenuItem icon={<Layers size={14} />} label="Add a filter group" onClick={() => set([...view.filters, { id: nid(6), group: "or", filters: [blank(), blank()] }])} />
      {view.filters.length > 0 && <MenuItem icon={<Trash2 size={14} />} label="Clear all filters" onClick={() => set([])} />}
    </div>
  );
}

// ---------------------------------------------------------------- sorts

export function SortMenu({ ctx }: { ctx: BarCtx }) {
  const { db, view } = ctx;
  const all = allProps(db).filter((p) => p.type !== "button");
  const set = (sorts: DbSort[]) => updateView(db.id, view.id, { sorts });
  const unused = all.filter((p) => !view.sorts.some((s) => s.propId === p.id));
  const drag = useRef<number | null>(null);
  return (
    <div className="menu filter-menu">
      {view.sorts.length === 0 && <div className="muted small pad">No sorts. Rows keep their manual order.</div>}
      {view.sorts.map((s, i) => (
        <div
          key={s.propId}
          className="filter-row"
          draggable
          onDragStart={() => (drag.current = i)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={() => {
            if (drag.current == null || drag.current === i) return;
            const list = [...view.sorts];
            const [m] = list.splice(drag.current, 1);
            list.splice(i, 0, m);
            set(list);
            drag.current = null;
          }}
        >
          <GripVertical size={13} className="muted grip" />
          <select className="grow" value={s.propId} onChange={(e) => set(view.sorts.map((x) => (x === s ? { ...x, propId: e.target.value } : x)))}>
            {all
              .filter((p) => p.id === s.propId || unused.includes(p))
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
          <select value={s.dir} onChange={(e) => set(view.sorts.map((x) => (x === s ? { ...x, dir: e.target.value as "asc" | "desc" } : x)))}>
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </select>
          <button className="icon-btn tiny" onClick={() => set(view.sorts.filter((x) => x !== s))} title="Remove sort">
            <X size={14} />
          </button>
        </div>
      ))}
      <MenuSep />
      {unused.length > 0 && <MenuItem icon={<Plus size={14} />} label="Add a sort" onClick={() => set([...view.sorts, { propId: unused[0].id, dir: "asc" }])} />}
      {view.sorts.length > 0 && <MenuItem icon={<Trash2 size={14} />} label="Clear all sorts" onClick={() => set([])} />}
    </div>
  );
}

// ---------------------------------------------------------------- view settings

function Sub({ label, hint, width = 240, children }: { label: string; hint?: React.ReactNode; width?: number; children: (close: () => void) => React.ReactNode }) {
  return (
    <Dropdown side="right" width={width} trigger={(open, isOpen) => <MenuItem label={label} active={isOpen} hint={<>{hint}<ChevronRight size={14} /></>} onClick={open} />}>
      {children}
    </Dropdown>
  );
}

function Switch({ label, on, onChange }: { label: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="menu-item static">
      <span className="menu-label">{label}</span>
      <Toggle on={on} onChange={onChange} />
    </div>
  );
}

function PropPicker({ props, current, onPick, none }: { props: DbProperty[]; current?: string; onPick: (id: string | undefined) => void; none?: string }) {
  return (
    <div className="menu">
      {none && <MenuItem label={none} checked={!current} onClick={() => onPick(undefined)} />}
      {props.map((p) => (
        <MenuItem key={p.id} icon={PROP_ICON[p.type]} label={p.name} checked={current === p.id} onClick={() => onPick(p.id)} />
      ))}
      {!props.length && <div className="muted small pad">No suitable properties yet.</div>}
    </div>
  );
}

export function ViewOptionsMenu({ ctx, setActive }: { ctx: BarCtx; setActive: (id: string) => void }) {
  const { db, view, props } = ctx;
  const set = (p: Partial<DbView>) => updateView(db.id, view.id, p);
  const hidden = view.hidden ?? [];
  const all = [allProps(db)[0], ...props];
  const groupProp = all.find((p) => p.id === view.groupBy);
  const dates = props.filter((p) => p.type === "date" || p.type === "created_time" || p.type === "last_edited_time" || (p.type === "formula" && kindOf(p, ctx.c, db) === "date"));
  const files = props.filter((p) => p.type === "files");
  const drag = useRef<string | null>(null);
  const views = db.views ?? [];
  return (
    <div className="menu view-options">
      <MenuLabel>View</MenuLabel>
      <input className="menu-input" defaultValue={view.name} aria-label="View name" onChange={(e) => set({ name: e.target.value || view.name })} onKeyDown={(e) => e.stopPropagation()} />
      <Sub label="Layout" hint={<span className="muted small">{VIEW_LABEL[view.type]}</span>} width={220}>
        {(close) => (
          <div className="menu">
            {VIEW_TYPES.map((t) => (
              <MenuItem
                key={t}
                icon={VIEW_ICON[t]}
                label={VIEW_LABEL[t]}
                checked={view.type === t}
                onClick={() => {
                  const patch: Partial<DbView> = { type: t };
                  if (t === "board" && !view.groupBy) patch.groupBy = (props.find((p) => p.type === "status") ?? props.find((p) => p.type === "select"))?.id;
                  if ((t === "calendar" || t === "timeline") && !view.dateProp) patch.dateProp = props.find((p) => p.type === "date")?.id;
                  if (t === "chart" && !view.chart) patch.chart = { type: "bar", x: (props.find((p) => p.type === "status") ?? props.find((p) => p.type === "select"))?.id, y: { fn: "count" } };
                  set(patch);
                  close();
                }}
              />
            ))}
          </div>
        )}
      </Sub>
      {view.type !== "calendar" && view.type !== "timeline" && view.type !== "chart" && (
        <Sub label="Group" hint={<span className="muted small">{groupProp?.name ?? "None"}</span>} width={260}>
          {() => (
            <div className="menu">
              <MenuLabel>Group by</MenuLabel>
              <PropPicker props={all.filter(canGroupBy)} current={view.groupBy} none={view.type === "board" ? undefined : "None"} onPick={(id) => set({ groupBy: id, hiddenGroups: undefined, collapsedGroups: undefined })} />
              {groupProp && (
                <>
                  <MenuSep />
                  {["date", "created_time", "last_edited_time"].includes(groupProp.type) && (
                    <Sub label="Date by" hint={<span className="muted small">{GROUP_DATES.find((g) => g.id === (view.groupDate ?? (groupProp.type === "date" ? "month" : "relative")))?.label}</span>} width={180}>
                      {(close) => (
                        <div className="menu">
                          {GROUP_DATES.map((g) => (
                            <MenuItem key={g.id} label={g.label} checked={(view.groupDate ?? (groupProp.type === "date" ? "month" : "relative")) === g.id} onClick={() => (set({ groupDate: g.id }), close())} />
                          ))}
                        </div>
                      )}
                    </Sub>
                  )}
                  <Switch label="Hide empty groups" on={!!view.hideEmptyGroups} onChange={(v) => set({ hideEmptyGroups: v || undefined })} />
                  {view.type === "board" && <Switch label="Color columns" on={!!view.colorGroups} onChange={(v) => set({ colorGroups: v || undefined })} />}
                  {(view.hiddenGroups?.length ?? 0) > 0 && <MenuItem icon={<Eye size={14} />} label={`Show ${view.hiddenGroups!.length} hidden group${view.hiddenGroups!.length === 1 ? "" : "s"}`} onClick={() => set({ hiddenGroups: undefined })} />}
                </>
              )}
            </div>
          )}
        </Sub>
      )}
      {(view.type === "calendar" || view.type === "timeline") && (
        <>
          <Sub label={view.type === "calendar" ? "Show calendar by" : "Show timeline by"} hint={<span className="muted small">{props.find((p) => p.id === view.dateProp)?.name ?? "Choose"}</span>}>
            {(close) => <PropPicker props={dates} current={view.dateProp} onPick={(id) => (set({ dateProp: id }), close())} />}
          </Sub>
          {view.type === "timeline" && (
            <Sub label="End date" hint={<span className="muted small">{props.find((p) => p.id === view.endProp)?.name ?? "Same property"}</span>}>
              {(close) => <PropPicker props={dates.filter((p) => p.id !== view.dateProp)} current={view.endProp} none="The date's own end" onPick={(id) => (set({ endProp: id }), close())} />}
            </Sub>
          )}
          {view.type === "calendar" && (
            <>
              <Switch label="Start week on Monday" on={view.weekStart === 1} onChange={(v) => set({ weekStart: v ? 1 : undefined })} />
              <Switch label="Show weekends" on={view.showWeekends !== false} onChange={(v) => set({ showWeekends: v ? undefined : false })} />
            </>
          )}
          {view.type === "timeline" && <Switch label="Show table" on={view.showTable !== false} onChange={(v) => set({ showTable: v ? undefined : false })} />}
        </>
      )}
      {(view.type === "gallery" || view.type === "board") && (
        <>
          <Sub label="Card preview" hint={<span className="muted small">{view.cardPreview === "cover" ? "Page cover" : files.find((f) => f.id === view.cardPreview)?.name ?? (view.type === "gallery" ? "Page cover" : "None")}</span>}>
            {(close) => (
              <div className="menu">
                <MenuItem label="None" checked={(view.cardPreview ?? (view.type === "gallery" ? "cover" : "none")) === "none"} onClick={() => (set({ cardPreview: "none" }), close())} />
                <MenuItem label="Page cover" checked={(view.cardPreview ?? (view.type === "gallery" ? "cover" : "none")) === "cover"} onClick={() => (set({ cardPreview: "cover" }), close())} />
                {files.map((f) => (
                  <MenuItem key={f.id} icon={PROP_ICON.files} label={f.name} checked={view.cardPreview === f.id} onClick={() => (set({ cardPreview: f.id }), close())} />
                ))}
              </div>
            )}
          </Sub>
          <Sub label="Card size" hint={<span className="muted small">{({ small: "Small", medium: "Medium", large: "Large" } as const)[view.cardSize ?? "medium"]}</span>} width={160}>
            {(close) => (
              <div className="menu">
                {(["small", "medium", "large"] as const).map((s) => (
                  <MenuItem key={s} label={s[0].toUpperCase() + s.slice(1)} checked={(view.cardSize ?? "medium") === s} onClick={() => (set({ cardSize: s === "medium" ? undefined : s }), close())} />
                ))}
              </div>
            )}
          </Sub>
          <Switch label="Fit image" on={!!view.fitImage} onChange={(v) => set({ fitImage: v || undefined })} />
        </>
      )}
      {view.type === "table" && <Switch label="Wrap all columns" on={!!view.wrap} onChange={(wrap) => set({ wrap: wrap || undefined, wrapCols: undefined })} />}
      {view.type !== "chart" && <Switch label="Show page icons" on={view.showIcons !== false} onChange={(v) => set({ showIcons: v ? undefined : false })} />}
      <Sub label="Open pages in" hint={<span className="muted small">{({ side: "Side peek", center: "Center peek", full: "Full page" } as const)[view.openIn ?? "side"]}</span>} width={200}>
        {(close) => (
          <div className="menu">
            <MenuItem label="Side peek" checked={(view.openIn ?? "side") === "side"} onClick={() => (set({ openIn: undefined }), close())} />
            <MenuItem label="Center peek" checked={view.openIn === "center"} onClick={() => (set({ openIn: "center" }), close())} />
            <MenuItem label="Full page" checked={view.openIn === "full"} onClick={() => (set({ openIn: "full" }), close())} />
          </div>
        )}
      </Sub>
      {view.type !== "chart" && (
        <>
          <MenuSep />
          <MenuLabel>Properties</MenuLabel>
          {props.length === 0 && <div className="muted small pad">No properties yet.</div>}
          {props.map((p, i) => {
            const on = !hidden.includes(p.id);
            return (
              <div
                key={p.id}
                draggable
                onDragStart={() => (drag.current = p.id)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  if (drag.current && drag.current !== p.id) moveProperty(db.id, drag.current, i);
                  drag.current = null;
                }}
              >
                <MenuItem
                  icon={PROP_ICON[p.type]}
                  label={p.name}
                  hint={on ? <Eye size={14} /> : <EyeOff size={14} />}
                  onClick={() => set({ hidden: on ? [...hidden, p.id] : hidden.filter((x) => x !== p.id) })}
                />
              </div>
            );
          })}
          {props.length > 1 && (
            <div className="row gap pad-x">
              <button className="btn-ghost small" onClick={() => set({ hidden: undefined })}>
                Show all
              </button>
              <button className="btn-ghost small" onClick={() => set({ hidden: props.map((p) => p.id) })}>
                Hide all
              </button>
            </div>
          )}
          <Dropdown side="right" width={240} trigger={(open) => <MenuItem icon={<Plus size={14} />} label="New property" onClick={open} />}>
            {(close) => <AddPropertyMenu ctx={ctx} close={close} />}
          </Dropdown>
        </>
      )}
      <MenuSep />
      <MenuItem
        icon={<Copy size={14} />}
        label="Duplicate view"
        onClick={() => {
          const copy = { ...view, id: nid(6), name: view.name + " (copy)" };
          updatePage(db.id, { views: [...views, copy] }, false);
          setActive(copy.id);
        }}
      />
      <MenuItem
        icon={<Trash2 size={14} />}
        label="Delete view"
        danger
        disabled={views.length <= 1}
        onClick={() => {
          const rest = views.filter((x) => x.id !== view.id);
          updatePage(db.id, { views: rest }, false);
          setActive(rest[0].id);
        }}
      />
    </div>
  );
}

