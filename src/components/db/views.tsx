// The layouts a database view can take: table, board, list, gallery and calendar. (Timeline and chart have their own files.)
import { ReactNode, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, Copy, Ellipsis, EyeOff, Maximize2, PanelRight, Plus, Trash2 } from "lucide-react";
import {
  calculate,
  dateVal,
  DbCtx,
  filesVal,
  Group as DbGroup,
  groupRows,
  isEmptyValue,
  moveDate,
  ROLLUP_FNS,
  storeDate,
  TITLE,
  valueForGroupMove,
  ymd,
} from "../../../shared/db";
import { addOption, createPage, DbProperty, DbView, isFresh, moveProperty, Page, pageTitle, setRowProp, updateView, User } from "../../store";
import { go } from "../../nav";
import { coverStyle, Dropdown, MenuItem, MenuSep, Popover } from "../ui";
import { pageIcon, trashWithUndo } from "../Sidebar";
import { AddPropertyMenu, CalcList, ColumnMenu } from "./propMenu";
import { EditableValue, PROP_ICON, PropValue, Tag } from "./values";

export interface ViewCtx {
  db: Page;
  view: DbView;
  props: DbProperty[]; // all properties, without the title
  visible: DbProperty[]; // properties shown in this view
  rows: Page[];
  users: Record<string, User>;
  c: DbCtx;
  locked: boolean;
  addRow: (extra?: Record<string, any>, title?: string) => string;
  open: (rowId: string) => void;
}

const ROW_DRAG = "application/x-sandpiper-row";
const icons = (ctx: ViewCtx) => ctx.view.showIcons !== false;

export function RowTitle({ row, ctx }: { row: Page; ctx: ViewCtx }) {
  return (
    <>
      {icons(ctx) && row.icon && <span className="row-icon">{row.icon}</span>}
      <span className={"row-title" + (row.title.trim() ? "" : " untitled")}>{pageTitle(row)}</span>
    </>
  );
}

function RowMenu({ row, ctx, close }: { row: Page; ctx: ViewCtx; close: () => void }) {
  return (
    <div className="menu">
      <MenuItem icon={<PanelRight size={14} />} label="Open" onClick={() => (ctx.open(row.id), close())} />
      <MenuItem icon={<Maximize2 size={14} />} label="Open as full page" onClick={() => (go(row.id), close())} />
      {!ctx.locked && (
        <>
          <MenuItem
            icon={<Copy size={14} />}
            label="Duplicate"
            onClick={() => {
              // A copy gets its own ID numbers.
              const props = { ...(row.props ?? {}) };
              for (const p of ctx.props) if (p.type === "unique_id") delete props[p.id];
              createPage({ parentId: ctx.db.id, isRow: true, title: row.title, icon: row.icon, cover: row.cover, props, order: row.order + 0.5 });
              close();
            }}
          />
          <MenuSep />
          <MenuItem icon={<Trash2 size={14} />} label="Move to Trash" danger onClick={() => (trashWithUndo(row), close())} />
        </>
      )}
    </div>
  );
}

/** Right-clicking a row, card or calendar item opens its menu at the cursor. */
export function useRowMenu(ctx: ViewCtx) {
  const [menu, setMenu] = useState<{ row: Page; x: number; y: number } | null>(null);
  const open = (e: React.MouseEvent, row: Page) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ row, x: e.clientX, y: e.clientY });
  };
  const node = menu ? (
    <Popover anchor={{ x: menu.x, y: menu.y }} onClose={() => setMenu(null)} width={220}>
      <RowMenu row={menu.row} ctx={ctx} close={() => setMenu(null)} />
    </Popover>
  ) : null;
  return { open, node };
}

/** Props for the "+ New" in a group: the value that puts a new row in it. */
function presetFor(ctx: ViewCtx, prop: DbProperty | undefined, key: string): Record<string, any> {
  if (!prop || prop.id === "title") return {};
  const move = valueForGroupMove({ id: "", props: {} } as Page, prop, "", key, ctx.view);
  return move && move.value !== undefined ? { [prop.id]: move.value } : {};
}

function GroupLabel({ g, prop }: { g: DbGroup; prop?: DbProperty }) {
  if (g.key && g.color) return <Tag name={g.label} color={g.color} status={prop?.type === "status"} />;
  if (g.key && prop && (prop.type === "person" || prop.type === "created_by" || prop.type === "last_edited_by")) return <b>{g.label}</b>;
  return <span className={g.key ? "group-name" : "muted"}>{g.label || "Empty"}</span>;
}

/** Group header actions: hide this group. */
function GroupMenu({ ctx, g, close }: { ctx: ViewCtx; g: DbGroup; close: () => void }) {
  return (
    <div className="menu">
      <MenuItem
        icon={<EyeOff size={14} />}
        label="Hide group"
        onClick={() => {
          updateView(ctx.db.id, ctx.view.id, { hiddenGroups: [...(ctx.view.hiddenGroups ?? []), g.key] });
          close();
        }}
      />
    </div>
  );
}

function useGroups(ctx: ViewCtx) {
  const prop = ctx.view.groupBy ? [TITLE, ...ctx.props].find((p) => p.id === ctx.view.groupBy) : undefined;
  return { prop, groups: prop ? groupRows(ctx.rows, prop, ctx.view, ctx.c, ctx.db) : null };
}

/** Collapsible group sections, for table, list and gallery. */
function Grouped({ ctx, render, className }: { ctx: ViewCtx; render: (rows: Page[], group: DbGroup | null) => ReactNode; className?: string }) {
  const { prop, groups } = useGroups(ctx);
  if (!prop || !groups) return <>{render(ctx.rows, null)}</>;
  const collapsed = new Set(ctx.view.collapsedGroups ?? []);
  const toggle = (key: string) => {
    const next = new Set(collapsed);
    next.has(key) ? next.delete(key) : next.add(key);
    updateView(ctx.db.id, ctx.view.id, { collapsedGroups: [...next] });
  };
  return (
    <div className={"groups " + (className ?? "")}>
      {groups.map(({ group, rows }) => (
        <section key={group.key} className="group">
          <div className="group-head">
            <button className="icon-btn tiny" onClick={() => toggle(group.key)} aria-expanded={!collapsed.has(group.key)} title={collapsed.has(group.key) ? "Expand" : "Collapse"}>
              <ChevronDown size={14} className={collapsed.has(group.key) ? "rot-90" : ""} />
            </button>
            <GroupLabel g={group} prop={prop} />
            <span className="muted small">{rows.length}</span>
            {!ctx.locked && (
              <>
                <Dropdown width={180} trigger={(open) => (
                  <button className="icon-btn tiny hover-only" onClick={open} title="Group actions">
                    <Ellipsis size={14} />
                  </button>
                )}>
                  {(close) => <GroupMenu ctx={ctx} g={group} close={close} />}
                </Dropdown>
                <button className="icon-btn tiny hover-only" onClick={() => ctx.open(ctx.addRow(presetFor(ctx, prop, group.key)))} title="Add a row to this group">
                  <Plus size={14} />
                </button>
              </>
            )}
          </div>
          {!collapsed.has(group.key) && render(rows, group)}
        </section>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- table

function CalcCell({ ctx, prop, rows }: { ctx: ViewCtx; prop: DbProperty; rows: Page[] }) {
  const fn = ctx.view.calcs?.[prop.id];
  const label = fn ? ROLLUP_FNS.find((a) => a.fn === fn)?.label : null;
  const value = fn ? calculate(fn, rows, prop, ctx.c) : null;
  if (ctx.locked && !fn) return <div className="tf" />;
  return (
    <Dropdown width={220} trigger={(open) => (
      <button className={"tf" + (fn ? " on" : "")} onClick={ctx.locked ? undefined : open}>
        {fn ? (
          <>
            <span className="tf-label">{label}</span> <b>{value}</b>
          </>
        ) : (
          <span className="tf-hint">
            Calculate <ChevronDown size={12} />
          </span>
        )}
      </button>
    )}>
      {(close) => <CalcList ctx={ctx} prop={prop} close={close} />}
    </Dropdown>
  );
}

export function TableView({ ctx }: { ctx: ViewCtx }) {
  const { db, view, visible, users, locked } = ctx;
  const [widths, setWidths] = useState<Record<string, number>>(view.widths ?? {});
  useEffect(() => setWidths(view.widths ?? {}), [view.widths]);
  const [menu, setMenu] = useState<{ row: Page; x: number; y: number } | null>(null);
  const [dragCol, setDragCol] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<string | null>(null);
  const cols = [TITLE, ...visible];
  const w = (id: string) => widths[id] ?? (id === "title" ? 280 : 180);
  const freeze = Math.min(view.freeze ?? 0, cols.length);
  const lefts: number[] = [];
  cols.reduce((x, col, i) => ((lefts[i] = x), x + w(col.id)), 0);
  const sticky = (i: number) => (i < freeze ? { position: "sticky" as const, left: lefts[i], zIndex: 3 } : undefined);
  const wrapped = (id: string) => !!view.wrap || (view.wrapCols ?? []).includes(id);
  const hasCalcs = Object.keys(view.calcs ?? {}).length > 0;

  const startResize = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const start = w(id);
    let latest = start;
    const move = (ev: MouseEvent) => {
      latest = Math.max(80, Math.min(800, start + ev.clientX - startX));
      setWidths((cur) => ({ ...cur, [id]: latest }));
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      updateView(db.id, view.id, { widths: { ...(view.widths ?? {}), [id]: latest } });
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const rowEls = (rows: Page[]) =>
    rows.map((row) => (
      <div key={row.id} className={"tr" + (isFresh(row) ? " fresh" : "")} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenu({ row, x: e.clientX, y: e.clientY }); }}>
        {cols.map((c, i) =>
          c.id === "title" ? (
            <div key={c.id} className={"td td-title" + (i < freeze ? " frozen" : "") + (i === freeze - 1 ? " frozen-edge" : "") + (wrapped(c.id) ? " wrap" : "")} style={sticky(i)}>
              {icons(ctx) && row.icon && <span className="td-icon">{row.icon}</span>}
              <EditableValue dbId={db.id} row={row} prop={c} c={ctx.c} locked={locked} className="title-value" />
              <button className="open-btn" onClick={() => ctx.open(row.id)} title="Open">
                <PanelRight size={12} /> Open
              </button>
            </div>
          ) : (
            <div key={c.id} className={"td" + (i < freeze ? " frozen" : "") + (i === freeze - 1 ? " frozen-edge" : "") + (wrapped(c.id) ? " wrap" : "")} style={sticky(i)}>
              <EditableValue dbId={db.id} row={row} prop={c} c={ctx.c} locked={locked} />
            </div>
          ),
        )}
        <div className="td td-end">
          <button className="icon-btn tiny row-more" onClick={(e) => setMenu({ row, x: e.clientX, y: e.clientY })} title="Row actions">
            <Ellipsis size={14} />
          </button>
        </div>
      </div>
    ));

  const footer = (rows: Page[], key: string) =>
    (hasCalcs || !locked) && (
      <div className="tr tfoot" key={"foot-" + key}>
        {cols.map((c, i) => (
          <div key={c.id} className={"td-foot" + (i < freeze ? " frozen" : "")} style={sticky(i)}>
            <CalcCell ctx={ctx} prop={c} rows={rows} />
          </div>
        ))}
        <div className="td-foot" />
      </div>
    );

  const addRow = (preset: Record<string, any>, key: string) =>
    !locked && (
      <button key={"add-" + key} className="add-row in-grid" onClick={() => ctx.open(ctx.addRow(preset))}>
        <Plus size={14} /> New
      </button>
    );

  const { prop: groupProp, groups } = useGroups(ctx);
  const collapsed = new Set(view.collapsedGroups ?? []);
  const toggle = (key: string) => {
    const next = new Set(collapsed);
    next.has(key) ? next.delete(key) : next.add(key);
    updateView(db.id, view.id, { collapsedGroups: [...next] });
  };

  return (
    <div className="table-scroll">
      <div className="table" style={{ gridTemplateColumns: cols.map((c) => w(c.id) + "px").join(" ") + " 44px" }} role="table">
        {cols.map((c, i) => (
          <Dropdown key={c.id} width={260} trigger={(open) => (
            <div
              className={"th" + (i < freeze ? " frozen" : "") + (i === freeze - 1 ? " frozen-edge" : "") + (overCol === c.id && dragCol !== c.id ? " drop" : "")}
              style={sticky(i)}
              onClick={locked ? undefined : open}
              draggable={!locked && c.id !== "title"}
              onDragStart={(e) => {
                setDragCol(c.id);
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", c.name);
              }}
              onDragEnd={() => (setDragCol(null), setOverCol(null))}
              onDragOver={(e) => {
                if (!dragCol || c.id === "title") return;
                e.preventDefault();
                setOverCol(c.id);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragCol && dragCol !== c.id) moveProperty(db.id, dragCol, (db.properties ?? []).findIndex((p) => p.id === c.id));
                setDragCol(null);
                setOverCol(null);
              }}
              title={c.description || undefined}
            >
              <span className="th-icon">{PROP_ICON[c.type]}</span>
              <span className="th-name">{c.name}</span>
              <span className="col-resize" onMouseDown={(e) => startResize(e, c.id)} onClick={(e) => e.stopPropagation()} />
            </div>
          )}>
            {(close) => <ColumnMenu ctx={ctx} prop={c} close={close} index={i} />}
          </Dropdown>
        ))}
        {locked ? <div className="th" /> : (
          <Dropdown width={240} align="end" trigger={(open) => (
            <div className="th th-add" onClick={open} title="Add a property">
              <Plus size={15} />
            </div>
          )}>
            {(close) => <AddPropertyMenu ctx={ctx} close={close} />}
          </Dropdown>
        )}

        {groups && groupProp
          ? groups.map(({ group, rows }) => [
              <div key={"g-" + group.key} className="tgroup" role="rowgroup">
                <button className="icon-btn tiny" onClick={() => toggle(group.key)} aria-expanded={!collapsed.has(group.key)}>
                  <ChevronDown size={14} className={collapsed.has(group.key) ? "rot-90" : ""} />
                </button>
                <GroupLabel g={group} prop={groupProp} />
                <span className="muted small">{rows.length}</span>
                {!locked && (
                  <Dropdown width={180} trigger={(open) => (
                    <button className="icon-btn tiny hover-only" onClick={open} title="Group actions">
                      <Ellipsis size={14} />
                    </button>
                  )}>
                    {(close) => <GroupMenu ctx={ctx} g={group} close={close} />}
                  </Dropdown>
                )}
              </div>,
              ...(collapsed.has(group.key) ? [] : [...rowEls(rows), addRow(presetFor(ctx, groupProp, group.key), group.key), hasCalcs ? footer(rows, group.key) : null]),
            ])
          : [...rowEls(ctx.rows), addRow({}, "all")]}
        {(!groups || !hasCalcs) && footer(ctx.rows, "all")}
      </div>
      {menu && (
        <Popover anchor={{ x: menu.x, y: menu.y }} onClose={() => setMenu(null)} width={220}>
          <RowMenu row={menu.row} ctx={ctx} close={() => setMenu(null)} />
        </Popover>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- cards (board, gallery, list)

function CardProps({ row, ctx }: { row: Page; ctx: ViewCtx }) {
  const shown = ctx.visible.filter((p) => p.id !== ctx.view.groupBy && p.type !== "button" && !isEmptyValue(row, p, ctx.c));
  const buttons = ctx.visible.filter((p) => p.type === "button");
  if (!shown.length && !buttons.length) return null;
  return (
    <div className="card-props">
      {shown.map((p) => (
        <div key={p.id} className="card-prop" title={p.name}>
          <PropValue row={row} prop={p} c={ctx.c} />
        </div>
      ))}
      {buttons.map((p) => (
        <div key={p.id} className="card-prop">
          <EditableValue dbId={ctx.db.id} row={row} prop={p} c={ctx.c} locked={ctx.locked} />
        </div>
      ))}
    </div>
  );
}

/** The image at the top of a card: the page's cover, or the first image in a files property. */
function CardPreview({ row, ctx, gallery }: { row: Page; ctx: ViewCtx; gallery?: boolean }) {
  const mode = ctx.view.cardPreview ?? (gallery ? "cover" : "none");
  if (mode === "none") return null;
  let style: React.CSSProperties | null = null;
  if (mode === "cover") style = row.cover ? coverStyle(row.cover) : null;
  else {
    const img = filesVal(row.props?.[mode]).find((f) => /\.(png|jpe?g|gif|webp|avif|svg)(\?|$)/i.test(f.name || f.url) || /\.(png|jpe?g|gif|webp|avif|svg)(\?|$)/i.test(f.url));
    if (img) style = { backgroundImage: `url("${img.url.replace(/"/g, "%22")}")` };
  }
  if (!style && !gallery) return null;
  return (
    <div className={"card-cover" + (ctx.view.fitImage ? " fit" : "")} style={style ?? undefined}>
      {!style && icons(ctx) && row.icon && <span>{row.icon}</span>}
    </div>
  );
}

export function BoardView({ ctx }: { ctx: ViewCtx }) {
  const { db, view, props, locked } = ctx;
  const { prop: group, groups } = useGroups(ctx);
  const [over, setOver] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const rm = useRowMenu(ctx);
  if (!group || !groups) {
    return (
      <div className="db-empty">
        <p>A board groups rows into columns by a property, such as a status.</p>
        <button
          className="btn"
          onClick={() => updateView(db.id, view.id, { groupBy: (props.find((p) => p.type === "status") ?? props.find((p) => p.type === "select") ?? props[0])?.id })}
          disabled={!props.length}
        >
          Choose a property to group by
        </button>
      </div>
    );
  }
  const canAddGroup = group.type === "select" || group.type === "status" || group.type === "multi_select";
  return (
    <div className={"board size-" + (view.cardSize ?? "medium")}>
      {rm.node}
      {groups.map(({ group: g, rows }) => (
        <div
          key={g.key}
          className={"board-col" + (over === g.key ? " over" : "") + (view.colorGroups && g.color ? " tinted tint-" + g.color : "")}
          onDragOver={(e) => {
            if (locked) return;
            e.preventDefault();
            setOver(g.key);
          }}
          onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setOver(null)}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setOver(null);
            const [id, from] = e.dataTransfer.getData(ROW_DRAG).split("|");
            const row = ctx.c.pages[id];
            if (!row || from === g.key) return;
            const move = valueForGroupMove(row, group, from ?? "", g.key, view);
            if (move) setRowProp(id, group.id, move.value);
          }}
        >
          <div className="board-head">
            <GroupLabel g={g} prop={group} />
            <span className="muted small">{rows.length}</span>
            <span style={{ flex: 1 }} />
            {!locked && (
              <>
                <Dropdown width={180} trigger={(open) => (
                  <button className="icon-btn tiny hover-only" onClick={open} title="Group actions">
                    <Ellipsis size={14} />
                  </button>
                )}>
                  {(close) => <GroupMenu ctx={ctx} g={g} close={close} />}
                </Dropdown>
                <button className="icon-btn tiny" onClick={() => ctx.open(ctx.addRow(presetFor(ctx, group, g.key)))} title="Add a card">
                  <Plus size={14} />
                </button>
              </>
            )}
          </div>
          {rows.map((row) => (
            <div
              key={row.id}
              className={"card" + (isFresh(row) ? " fresh" : "")}
              draggable={!locked}
              onDragStart={(e) => {
                e.stopPropagation();
                e.dataTransfer.setData(ROW_DRAG, row.id + "|" + g.key);
                e.dataTransfer.effectAllowed = "move";
              }}
              onClick={() => ctx.open(row.id)}
              onContextMenu={(e) => rm.open(e, row)}
            >
              <CardPreview row={row} ctx={ctx} />
              <div className="card-title">
                <RowTitle row={row} ctx={ctx} />
              </div>
              <CardProps row={row} ctx={ctx} />
            </div>
          ))}
          {!locked && (
            <button className="add-card" onClick={() => ctx.open(ctx.addRow(presetFor(ctx, group, g.key)))}>
              <Plus size={14} /> New
            </button>
          )}
        </div>
      ))}
      {!locked &&
        canAddGroup &&
        (adding ? (
          <input
            className="board-add-input"
            autoFocus
            placeholder="Group name"
            onBlur={() => setAdding(false)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter" && e.currentTarget.value.trim()) {
                addOption(db.id, group.id, e.currentTarget.value);
                setAdding(false);
              } else if (e.key === "Escape") setAdding(false);
            }}
          />
        ) : (
          <button className="board-add" onClick={() => setAdding(true)}>
            <Plus size={14} /> Add a group
          </button>
        ))}
    </div>
  );
}

export function ListView({ ctx }: { ctx: ViewCtx }) {
  const { prop } = useGroups(ctx);
  const rm = useRowMenu(ctx);
  return (
    <div className="list-view">
      {rm.node}
      <Grouped
        ctx={ctx}
        render={(rows, g) => (
          <>
            {rows.map((row) => (
              <div key={row.id} className={"list-row" + (isFresh(row) ? " fresh" : "")} onClick={() => ctx.open(row.id)} onContextMenu={(e) => rm.open(e, row)}>
                <span className="list-title">
                  {icons(ctx) && <span className="row-icon">{pageIcon(row)}</span>}
                  <span className={"row-title" + (row.title.trim() ? "" : " untitled")}>{pageTitle(row)}</span>
                </span>
                <CardProps row={row} ctx={ctx} />
              </div>
            ))}
            {!ctx.locked && (
              <button className="add-row" onClick={() => ctx.open(ctx.addRow(g ? presetFor(ctx, prop, g.key) : {}))}>
                <Plus size={14} /> New
              </button>
            )}
          </>
        )}
      />
    </div>
  );
}

export function GalleryView({ ctx }: { ctx: ViewCtx }) {
  const { prop } = useGroups(ctx);
  const rm = useRowMenu(ctx);
  return (
    <>
    {rm.node}
    <Grouped
      ctx={ctx}
      render={(rows, g) => (
        <div className={"gallery size-" + (ctx.view.cardSize ?? "medium")}>
          {rows.map((row) => (
            <div key={row.id} className={"gallery-card" + (isFresh(row) ? " fresh" : "")} onClick={() => ctx.open(row.id)} onContextMenu={(e) => rm.open(e, row)}>
              <CardPreview row={row} ctx={ctx} gallery />
              <div className="gallery-body">
                <div className="card-title">
                  <RowTitle row={row} ctx={ctx} />
                </div>
                <CardProps row={row} ctx={ctx} />
              </div>
            </div>
          ))}
          {!ctx.locked && (
            <button className="gallery-card gallery-add" onClick={() => ctx.open(ctx.addRow(g ? presetFor(ctx, prop, g.key) : {}))}>
              <Plus size={16} /> New
            </button>
          )}
        </div>
      )}
    />
    </>
  );
}

// ---------------------------------------------------------------- calendar

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The first and last day a row covers on a date property (created/edited times count as one day). */
export function rowDays(row: Page, prop: DbProperty): [string, string] | null {
  if (prop.type === "created_time") return [ymd(row.createdAt), ymd(row.createdAt)];
  if (prop.type === "last_edited_time") return [ymd(row.updatedAt), ymd(row.updatedAt)];
  const d = dateVal(row.props?.[prop.id]);
  if (!d) return null;
  const a = d.start.slice(0, 10);
  const b = (d.end ?? d.start).slice(0, 10);
  return b < a ? [b, a] : [a, b];
}

export function CalendarView({ ctx }: { ctx: ViewCtx }) {
  const { db, view, rows, props, locked } = ctx;
  const dateProp = props.find((p) => p.id === view.dateProp && (p.type === "date" || p.type === "created_time" || p.type === "last_edited_time"));
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [over, setOver] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const rm = useRowMenu(ctx);
  if (!dateProp) {
    return (
      <div className="db-empty">
        <p>A calendar places rows on the days in a date property.</p>
        <button className="btn" onClick={() => updateView(db.id, view.id, { dateProp: props.find((p) => p.type === "date")?.id ?? undefined })} disabled={!props.some((p) => p.type === "date")}>
          Choose a date property
        </button>
      </div>
    );
  }
  const start = view.weekStart ?? 0;
  const weekends = view.showWeekends !== false;
  const lead = (month.getDay() - start + 7) % 7;
  const first = new Date(month.getFullYear(), month.getMonth(), 1 - lead);
  const lastDay = new Date(month.getFullYear(), month.getMonth() + 1, 0);
  const weeks = Math.ceil((lead + lastDay.getDate()) / 7);
  const days = Array.from({ length: weeks * 7 }, (_, i) => new Date(first.getFullYear(), first.getMonth(), first.getDate() + i)).filter((d) => weekends || (d.getDay() !== 0 && d.getDay() !== 6));
  const dows = Array.from({ length: 7 }, (_, i) => (i + start) % 7).filter((d) => weekends || (d !== 0 && d !== 6));
  const byDay = new Map<string, Page[]>();
  for (const r of rows) {
    const span = rowDays(r, dateProp);
    if (!span) continue;
    // A range shows on each of its days (up to two months, so a typo can't flood the calendar).
    let d = span[0];
    for (let i = 0; i < 62 && d <= span[1]; i++) {
      byDay.set(d, [...(byDay.get(d) ?? []), r]);
      const [y, m, dd] = d.split("-").map(Number);
      d = ymd(new Date(y, m - 1, dd + 1));
    }
  }
  const today = ymd(new Date());
  const undated = rows.filter((r) => !rowDays(r, dateProp)).length;
  const editable = !locked && dateProp.type === "date";
  return (
    <div className="calendar" ref={scroller}>
      {rm.node}
      <div className="cal-head">
        <b>{month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</b>
        {undated > 0 && <span className="muted small">{undated} without a date</span>}
        <span style={{ flex: 1 }} />
        <button className="icon-btn" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} title="Previous month">
          <ChevronLeft size={16} />
        </button>
        <button className="btn-ghost small" onClick={() => setMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}>
          Today
        </button>
        <button className="icon-btn" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} title="Next month">
          <ChevronRight size={16} />
        </button>
      </div>
      <div className="cal-grid cal-dow" style={{ gridTemplateColumns: `repeat(${dows.length}, minmax(0, 1fr))` }}>
        {dows.map((d) => (
          <div key={d}>{DOW[d]}</div>
        ))}
      </div>
      <div className="cal-grid" style={{ gridTemplateColumns: `repeat(${dows.length}, minmax(0, 1fr))` }}>
        {days.map((d) => {
          const key = ymd(d);
          const items = byDay.get(key) ?? [];
          return (
            <div
              key={key}
              className={"cal-day" + (d.getMonth() !== month.getMonth() ? " other" : "") + (over === key ? " over" : "")}
              onDragOver={(e) => {
                if (!editable) return;
                e.preventDefault();
                setOver(key);
              }}
              onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setOver(null)}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setOver(null);
                const id = e.dataTransfer.getData(ROW_DRAG).split("|")[0];
                const row = ctx.c.pages[id];
                if (!row) return;
                const old = dateVal(row.props?.[dateProp.id]);
                setRowProp(id, dateProp.id, storeDate(old ? moveDate(old, key) : { start: key }));
              }}
            >
              <div className="cal-day-head">
                {editable && (
                  <button className="icon-btn tiny cal-add" onClick={() => ctx.open(ctx.addRow({ [dateProp.id]: key }))} title="Add an item">
                    <Plus size={13} />
                  </button>
                )}
                <span className={"cal-num" + (key === today ? " today" : "")}>{d.getDate()}</span>
              </div>
              {items.map((row) => {
                const v = dateVal(row.props?.[dateProp.id]);
                const time = v && /T(\d{2}):(\d{2})/.exec(v.start);
                const span = rowDays(row, dateProp)!;
                return (
                  <div
                    key={row.id}
                    className={"cal-item" + (isFresh(row) ? " fresh" : "") + (span[0] !== span[1] ? " span" + (key === span[0] ? " span-start" : key === span[1] ? " span-end" : " span-mid") : "")}
                    draggable={editable}
                    onDragStart={(e) => {
                      e.stopPropagation();
                      e.dataTransfer.setData(ROW_DRAG, row.id);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onClick={() => ctx.open(row.id)}
                    onContextMenu={(e) => rm.open(e, row)}
                  >
                    {time && key === span[0] && <span className="cal-time">{new Date(2000, 0, 1, +time[1], +time[2]).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</span>}
                    <RowTitle row={row} ctx={ctx} />
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export { ROW_DRAG };
