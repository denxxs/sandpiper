// The menu a column header opens (as in Notion): rename, describe, edit the property's settings, change its type,
// filter, sort, group, calculate, freeze, hide, wrap, insert, duplicate, delete. Plus the "add a property" menu.
import { ReactNode, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowDownUp,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUp,
  Calculator,
  ChevronRight,
  Copy,
  EyeOff,
  GripVertical,
  Group,
  Info,
  ListFilter,
  Plus,
  Repeat2,
  Settings2,
  Snowflake,
  Trash2,
  WrapText,
  X,
} from "lucide-react";
import {
  aggregatesFor,
  allProps,
  canGroupBy,
  checkFormula,
  DATE_FORMATS,
  DbCtx,
  formulaValue,
  FUNCTION_NAMES,
  kindOf,
  NUMBER_FORMATS,
  opsFor,
  PROP_TYPES,
  ROLLUP_FNS,
  rowsOf,
  showF,
  STATUS_GROUPS,
  TITLE,
} from "../../../shared/db";
import {
  addOption,
  addProperty,
  DbProperty,
  DbView,
  deleteProperty,
  duplicateProperty,
  nid,
  OPTION_COLORS,
  Page,
  PROP_TYPE_LABEL,
  PropType,
  setRelationTwoWay,
  updateProperty,
  updateView,
  usePages,
} from "../../store";
import { Dropdown, MenuItem, MenuLabel, MenuSep, Toggle } from "../ui";
import { pageIcon } from "../Sidebar";
import { OptionMenu, PROP_ICON, Tag } from "./values";

export interface MenuCtx {
  db: Page;
  view: DbView;
  props: DbProperty[];
  c: DbCtx;
}

const SETTINGS: PropType[] = ["number", "select", "multi_select", "status", "date", "created_time", "last_edited_time", "relation", "rollup", "formula", "unique_id", "button"];

/** A row that opens a submenu to its right. */
function Sub({ icon, label, hint, width = 260, children }: { icon: ReactNode; label: string; hint?: ReactNode; width?: number; children: (close: () => void) => ReactNode }) {
  return (
    <Dropdown side="right" width={width} trigger={(open, isOpen) => <MenuItem icon={icon} label={label} active={isOpen} hint={<>{hint}<ChevronRight size={14} /></>} onClick={open} />}>
      {children}
    </Dropdown>
  );
}

// ---------------------------------------------------------------- the column menu

export function ColumnMenu({ ctx, prop, close, index }: { ctx: MenuCtx; prop: DbProperty; close: () => void; index: number }) {
  const { db, view, c } = ctx;
  const isTitle = prop.id === "title";
  const [describe, setDescribe] = useState(!!prop.description);
  const calc = view.calcs?.[prop.id];
  const grouped = view.groupBy === prop.id;
  const frozen = (view.freeze ?? 0) === index + 1;
  const wrapped = !!view.wrap || (view.wrapCols ?? []).includes(prop.id);
  const setSort = (dir: "asc" | "desc") => {
    updateView(db.id, view.id, { sorts: [{ propId: prop.id, dir }, ...view.sorts.filter((s) => s.propId !== prop.id)] });
    close();
  };
  const ops = opsFor(prop, c, db);
  return (
    <div className="menu col-menu">
      <div className="col-menu-head">
        {isTitle ? (
          <span className="col-menu-type">{PROP_ICON.text}</span>
        ) : (
          <Dropdown side="right" width={240} trigger={(open) => <button className="col-menu-type" onClick={open} title="Change type">{PROP_ICON[prop.type]}</button>}>
            {(closeT) => <TypeList ctx={ctx} prop={prop} close={() => (closeT(), close())} />}
          </Dropdown>
        )}
        <input
          className="menu-input"
          defaultValue={prop.name}
          autoFocus={!isTitle}
          readOnly={isTitle}
          aria-label="Property name"
          onChange={(e) => updateProperty(db.id, prop.id, { name: e.target.value || prop.name })}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") close();
          }}
        />
        {!isTitle && (
          <button className={"icon-btn tiny" + (describe ? " on" : "")} onClick={() => setDescribe((d) => !d)} title="Description">
            <Info size={14} />
          </button>
        )}
      </div>
      {describe && !isTitle && (
        <textarea
          className="col-menu-desc"
          defaultValue={prop.description ?? ""}
          placeholder="Add a description…"
          rows={2}
          autoFocus={!prop.description}
          onChange={(e) => updateProperty(db.id, prop.id, { description: e.target.value || undefined })}
          onKeyDown={(e) => e.stopPropagation()}
        />
      )}
      {!isTitle && SETTINGS.includes(prop.type) && (
        <Sub icon={<Settings2 size={14} />} label="Edit property" width={prop.type === "formula" ? 420 : 300}>
          {() => <PropertySettings ctx={ctx} prop={prop} />}
        </Sub>
      )}
      {!isTitle && (
        <Sub icon={<Repeat2 size={14} />} label="Change type" hint={<span className="muted small">{PROP_TYPE_LABEL[prop.type]}</span>} width={240}>
          {(closeT) => <TypeList ctx={ctx} prop={prop} close={() => (closeT(), close())} />}
        </Sub>
      )}
      <MenuSep />
      {ops.length > 0 && (
        <MenuItem
          icon={<ListFilter size={14} />}
          label="Filter"
          onClick={() => {
            updateView(db.id, view.id, { filters: [...view.filters, { id: nid(6), propId: prop.id, op: ops[0].op }] });
            close();
          }}
        />
      )}
      {prop.type !== "button" && (
        <Sub icon={<ArrowDownUp size={14} />} label="Sort" width={200}>
          {() => (
            <div className="menu">
              <MenuItem icon={<ArrowUp size={14} />} label="Ascending" checked={view.sorts[0]?.propId === prop.id && view.sorts[0].dir === "asc"} onClick={() => setSort("asc")} />
              <MenuItem icon={<ArrowDown size={14} />} label="Descending" checked={view.sorts[0]?.propId === prop.id && view.sorts[0].dir === "desc"} onClick={() => setSort("desc")} />
              {view.sorts.some((s) => s.propId === prop.id) && (
                <MenuItem icon={<X size={14} />} label="Remove sort" onClick={() => (updateView(db.id, view.id, { sorts: view.sorts.filter((s) => s.propId !== prop.id) }), close())} />
              )}
            </div>
          )}
        </Sub>
      )}
      {canGroupBy(prop) && view.type !== "calendar" && view.type !== "timeline" && view.type !== "chart" && (
        <MenuItem
          icon={<Group size={14} />}
          label={grouped ? "Ungroup" : "Group"}
          onClick={() => {
            updateView(db.id, view.id, { groupBy: grouped && view.type !== "board" ? undefined : prop.id, hiddenGroups: undefined, collapsedGroups: undefined });
            close();
          }}
        />
      )}
      {(view.type === "table" || view.type === "board") && prop.type !== "button" && (
        <Sub icon={<Calculator size={14} />} label="Calculate" hint={calc ? <span className="muted small">{aggLabel(calc)}</span> : undefined} width={220}>
          {(closeC) => <CalcList ctx={ctx} prop={prop} close={() => (closeC(), close())} />}
        </Sub>
      )}
      {view.type === "table" && (
        <MenuItem
          icon={<Snowflake size={14} />}
          label={frozen ? "Unfreeze columns" : "Freeze up to this column"}
          onClick={() => {
            updateView(db.id, view.id, { freeze: frozen ? undefined : index + 1 });
            close();
          }}
        />
      )}
      {!isTitle && (
        <MenuItem
          icon={<EyeOff size={14} />}
          label="Hide"
          onClick={() => {
            updateView(db.id, view.id, { hidden: [...(view.hidden ?? []), prop.id] });
            close();
          }}
        />
      )}
      {view.type === "table" && (
        <div className="menu-item static">
          <span className="menu-icon">
            <WrapText size={14} />
          </span>
          <span className="menu-label">Wrap content</span>
          <Toggle
            on={wrapped}
            onChange={(on) => {
              const cols = (view.wrapCols ?? []).filter((x) => x !== prop.id);
              updateView(db.id, view.id, { wrapCols: on ? [...cols, prop.id] : cols, wrap: on ? view.wrap : undefined });
            }}
          />
        </div>
      )}
      <MenuSep />
      {view.type === "table" && !isTitle && (
        <Sub icon={<ArrowLeftToLine size={14} />} label="Insert left" width={240}>
          {(closeA) => <AddPropertyMenu ctx={ctx} at={(db.properties ?? []).findIndex((p) => p.id === prop.id)} close={() => (closeA(), close())} />}
        </Sub>
      )}
      {view.type === "table" && (
        <Sub icon={<ArrowRightToLine size={14} />} label="Insert right" width={240}>
          {(closeA) => <AddPropertyMenu ctx={ctx} at={isTitle ? 0 : (db.properties ?? []).findIndex((p) => p.id === prop.id) + 1} close={() => (closeA(), close())} />}
        </Sub>
      )}
      {!isTitle && (
        <>
          <MenuItem
            icon={<Copy size={14} />}
            label="Duplicate property"
            onClick={() => {
              duplicateProperty(db.id, prop.id);
              close();
            }}
          />
          <MenuItem
            icon={<Trash2 size={14} />}
            label="Delete property"
            danger
            onClick={() => {
              deleteProperty(db.id, prop.id);
              close();
            }}
          />
        </>
      )}
    </div>
  );
}

const aggLabel = (fn: string) => [{ fn: "count", label: "Count" }, ...ROLLUP_FNS].find((a) => a.fn === fn)?.label ?? fn;

export function CalcList({ ctx, prop, close }: { ctx: MenuCtx; prop: DbProperty; close: () => void }) {
  const { db, view, c } = ctx;
  const cur = view.calcs?.[prop.id];
  const set = (fn: string | null) => {
    const calcs = { ...(view.calcs ?? {}) };
    if (fn) calcs[prop.id] = fn;
    else delete calcs[prop.id];
    updateView(db.id, view.id, { calcs });
    close();
  };
  const list = aggregatesFor(prop, c, db);
  const sections: [string, typeof list][] = [
    ["Count", list.filter((a) => a.fn.startsWith("count"))],
    ["Percent", list.filter((a) => a.fn.startsWith("percent"))],
    ["More options", list.filter((a) => !a.fn.startsWith("count") && !a.fn.startsWith("percent"))],
  ];
  return (
    <div className="menu">
      <MenuItem label="None" checked={!cur} onClick={() => set(null)} />
      {sections
        .filter(([, l]) => l.length)
        .map(([title, l]) => (
          <div key={title}>
            <MenuLabel>{title}</MenuLabel>
            {l.map((a) => (
              <MenuItem key={a.fn} label={a.label} checked={cur === a.fn} onClick={() => set(a.fn)} />
            ))}
          </div>
        ))}
    </div>
  );
}

// ---------------------------------------------------------------- types

/** Databases in this workspace, for relations. */
function useDatabases(): Page[] {
  const pages = usePages();
  return useMemo(() => Object.values(pages).filter((p) => p.kind === "database" && !p.trashed).sort((a, b) => (a.title || "").localeCompare(b.title || "")), [pages]);
}

function DatabasePicker({ selfId, onPick, twoWay, setTwoWay }: { selfId: string; onPick: (dbId: string) => void; twoWay: boolean; setTwoWay: (v: boolean) => void }) {
  const dbs = useDatabases();
  const [q, setQ] = useState("");
  const shown = dbs.filter((d) => (d.title?.trim() || "Untitled").toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className="menu">
      <MenuLabel>Related to</MenuLabel>
      <input className="menu-input" autoFocus placeholder="Search databases…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      {shown.map((d) => (
        <MenuItem key={d.id} icon={<span className="rel-icon">{pageIcon(d)}</span>} label={(d.title?.trim() || "Untitled") + (d.id === selfId ? " (this database)" : "")} onClick={() => onPick(d.id)} />
      ))}
      {!shown.length && <div className="muted small pad">No databases match.</div>}
      <MenuSep />
      <div className="menu-item static">
        <span className="menu-label">Show on the related database too</span>
        <Toggle on={twoWay} onChange={setTwoWay} />
      </div>
    </div>
  );
}

function TypeList({ ctx, prop, close }: { ctx: MenuCtx; prop: DbProperty; close: () => void }) {
  const [relation, setRelation] = useState(false);
  const [twoWay, setTwoWay] = useState(true);
  if (relation) {
    return (
      <DatabasePicker
        selfId={ctx.db.id}
        twoWay={twoWay}
        setTwoWay={setTwoWay}
        onPick={(dbId) => {
          updateProperty(ctx.db.id, prop.id, { type: "relation", relation: { dbId }, options: undefined });
          if (twoWay) setRelationTwoWay(ctx.db.id, prop.id, true);
          close();
        }}
      />
    );
  }
  return (
    <div className="menu">
      <MenuLabel>Type</MenuLabel>
      {PROP_TYPES.map((t) => (
        <MenuItem
          key={t}
          icon={PROP_ICON[t]}
          label={PROP_TYPE_LABEL[t]}
          checked={prop.type === t}
          onClick={() => {
            if (t === prop.type) return close();
            if (t === "relation") return setRelation(true);
            const extra: Partial<DbProperty> = { type: t };
            if (t === "rollup") extra.rollup = firstRollup(ctx.db);
            if (t === "formula" && prop.formula == null) extra.formula = "";
            if (t === "button" && !prop.button) extra.button = { label: prop.name, actions: [] };
            updateProperty(ctx.db.id, prop.id, extra);
            close();
          }}
        />
      ))}
    </div>
  );
}

function firstRollup(db: Page): DbProperty["rollup"] {
  const rel = db.properties?.find((p) => p.type === "relation");
  return { relationPropId: rel?.id ?? "", targetPropId: "title", fn: "show_original" };
}

/** The "add a property" menu; `at` places the new property (Insert left / right). */
export function AddPropertyMenu({ ctx, at, close, onAdded }: { ctx: Pick<MenuCtx, "db">; at?: number; close: () => void; onAdded?: (id: string) => void }) {
  const [relation, setRelation] = useState(false);
  const [twoWay, setTwoWay] = useState(true);
  const [q, setQ] = useState("");
  const add = (t: PropType, extra: Partial<DbProperty> = {}) => {
    const id = addProperty(ctx.db.id, t, undefined, extra, at);
    onAdded?.(id);
    close();
  };
  if (relation) {
    return (
      <DatabasePicker
        selfId={ctx.db.id}
        twoWay={twoWay}
        setTwoWay={setTwoWay}
        onPick={(dbId) => add("relation", { relation: { dbId, syncedPropId: twoWay ? "new" : undefined } })}
      />
    );
  }
  const shown = PROP_TYPES.filter((t) => PROP_TYPE_LABEL[t].toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className="menu">
      <input className="menu-input" autoFocus placeholder="Search for a property type…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter" && shown[0]) shown[0] === "relation" ? setRelation(true) : add(shown[0], shown[0] === "rollup" ? { rollup: firstRollup(ctx.db) } : {});
      }} />
      <MenuLabel>Type</MenuLabel>
      {shown.map((t) => (
        <MenuItem key={t} icon={PROP_ICON[t]} label={PROP_TYPE_LABEL[t]} onClick={() => (t === "relation" ? setRelation(true) : add(t, t === "rollup" ? { rollup: firstRollup(ctx.db) } : {}))} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- settings per type

export function PropertySettings({ ctx, prop }: { ctx: MenuCtx; prop: DbProperty }) {
  const { db, c } = ctx;
  const kind = kindOf(prop, c, db);
  switch (prop.type) {
    case "number":
      return <NumberSettings db={db} prop={prop} />;
    case "select":
    case "multi_select":
    case "status":
      return <OptionsSettings db={db} prop={prop} />;
    case "date":
    case "created_time":
    case "last_edited_time":
      return <DateSettings db={db} prop={prop} />;
    case "relation":
      return <RelationSettings db={db} prop={prop} />;
    case "rollup":
      return (
        <>
          <RollupSettings db={db} prop={prop} c={c} />
          {kind === "number" && (
            <>
              <MenuSep />
              <NumberSettings db={db} prop={prop} />
            </>
          )}
          {kind === "date" && (
            <>
              <MenuSep />
              <DateSettings db={db} prop={prop} />
            </>
          )}
        </>
      );
    case "formula":
      return (
        <>
          <FormulaEditor db={db} prop={prop} c={c} />
          {kind === "number" && (
            <>
              <MenuSep />
              <NumberSettings db={db} prop={prop} />
            </>
          )}
          {kind === "date" && (
            <>
              <MenuSep />
              <DateSettings db={db} prop={prop} />
            </>
          )}
        </>
      );
    case "unique_id":
      return (
        <div className="menu">
          <MenuLabel>Prefix</MenuLabel>
          <input
            className="menu-input"
            defaultValue={prop.prefix ?? ""}
            placeholder="e.g. TASK"
            onChange={(e) => updateProperty(db.id, prop.id, { prefix: e.target.value.replace(/[^A-Za-z0-9_]/g, "").slice(0, 12) || undefined })}
            onKeyDown={(e) => e.stopPropagation()}
          />
          <div className="muted small pad">Each new row gets the next number. Numbers never repeat, even after a row is deleted.</div>
        </div>
      );
    case "button":
      return <ButtonSettings db={db} prop={prop} />;
    default:
      return null;
  }
}

function NumberSettings({ db, prop }: { db: Page; prop: DbProperty }) {
  const set = (p: Partial<DbProperty>) => updateProperty(db.id, prop.id, p);
  const fmt = NUMBER_FORMATS.find((f) => f.id === (prop.numberFormat ?? "number"));
  const show = prop.showAs ?? "number";
  return (
    <div className="menu num-settings">
      <Sub icon={undefined} label="Number format" hint={<span className="muted small">{fmt?.label.replace(/ \(.*\)$/, "") ?? "Number"}</span>} width={260}>
        {(close) => <FormatList current={prop.numberFormat ?? "number"} onPick={(id) => (set({ numberFormat: id === "number" ? undefined : id }), close())} />}
      </Sub>
      <Sub icon={undefined} label="Decimal places" hint={<span className="muted small">{prop.decimals ?? "Default"}</span>} width={180}>
        {(close) => (
          <div className="menu">
            <MenuItem label="Default" checked={prop.decimals == null} onClick={() => (set({ decimals: undefined }), close())} />
            {[0, 1, 2, 3, 4, 5, 6].map((n) => (
              <MenuItem key={n} label={String(n)} checked={prop.decimals === n} onClick={() => (set({ decimals: n }), close())} />
            ))}
          </div>
        )}
      </Sub>
      <MenuLabel>Show as</MenuLabel>
      <div className="show-as">
        {(["number", "bar", "ring"] as const).map((s) => (
          <button key={s} className={"show-as-card" + (show === s ? " on" : "")} onClick={() => set({ showAs: s === "number" ? undefined : s })} aria-pressed={show === s}>
            {s === "number" ? (
              <span className="show-as-num">42</span>
            ) : s === "bar" ? (
              <span className="show-as-bar">
                <span />
              </span>
            ) : (
              <svg viewBox="0 0 20 20" width={22} height={22} aria-hidden>
                <circle cx="10" cy="10" r="7" className="ring-track" />
                <circle cx="10" cy="10" r="7" className="ring-fill" strokeDasharray="30 44" transform="rotate(-90 10 10)" />
              </svg>
            )}
            <span>{s[0].toUpperCase() + s.slice(1)}</span>
          </button>
        ))}
      </div>
      {show !== "number" && (
        <>
          <Sub icon={undefined} label="Color" hint={<span className={"swatch tag-" + (prop.barColor ?? "green")} />} width={180}>
            {(close) => (
              <div className="menu">
                {OPTION_COLORS.map((col) => (
                  <MenuItem key={col} icon={<span className={"swatch strong-" + col} />} label={col[0].toUpperCase() + col.slice(1)} checked={(prop.barColor ?? "green") === col} onClick={() => (set({ barColor: col }), close())} />
                ))}
              </div>
            )}
          </Sub>
          <div className="menu-item static">
            <span className="menu-label">Divide by</span>
            <input
              className="mini-input"
              type="number"
              defaultValue={prop.divideBy ?? (prop.numberFormat === "percent" ? 1 : 100)}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n) && n > 0) set({ divideBy: n });
              }}
              onKeyDown={(e) => e.stopPropagation()}
            />
          </div>
          <div className="menu-item static">
            <span className="menu-label">Show number</span>
            <Toggle on={prop.showNumber !== false} onChange={(on) => set({ showNumber: on ? undefined : false })} />
          </div>
        </>
      )}
      <div className="muted small pad">Changes apply to all views showing this property.</div>
    </div>
  );
}

function FormatList({ current, onPick }: { current: string; onPick: (id: string) => void }) {
  const [q, setQ] = useState("");
  const shown = NUMBER_FORMATS.filter((f) => f.label.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className="menu format-list">
      <input className="menu-input" autoFocus placeholder="Filter formats…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter" && shown[0]) onPick(shown[0].id);
      }} />
      <div className="format-scroll">
        {shown.map((f) => (
          <MenuItem key={f.id} label={f.label} checked={f.id === current} onClick={() => onPick(f.id)} />
        ))}
      </div>
    </div>
  );
}

function DateSettings({ db, prop }: { db: Page; prop: DbProperty }) {
  const set = (p: Partial<DbProperty>) => updateProperty(db.id, prop.id, p);
  return (
    <div className="menu">
      <MenuLabel>Date format</MenuLabel>
      {DATE_FORMATS.map((f) => (
        <MenuItem key={f.id} label={f.label} checked={(prop.dateFormat ?? "default") === f.id} onClick={() => set({ dateFormat: f.id === "default" ? undefined : f.id })} />
      ))}
      <MenuSep />
      <MenuLabel>Time format</MenuLabel>
      <MenuItem label="12 hour" checked={(prop.timeFormat ?? "12h") === "12h"} onClick={() => set({ timeFormat: undefined })} />
      <MenuItem label="24 hour" checked={prop.timeFormat === "24h"} onClick={() => set({ timeFormat: "24h" })} />
    </div>
  );
}

function OptionsSettings({ db, prop }: { db: Page; prop: DbProperty }) {
  const [adding, setAdding] = useState<string | null>(null);
  const drag = useRef<string | null>(null);
  const options = prop.options ?? [];
  const move = (id: string, beforeId: string | null, group?: string) => {
    const list = options.filter((o) => o.id !== id);
    const item = options.find((o) => o.id === id);
    if (!item) return;
    const moved = group ? { ...item, group: group as any } : item;
    const at = beforeId ? list.findIndex((o) => o.id === beforeId) : list.length;
    list.splice(at < 0 ? list.length : at, 0, moved);
    updateProperty(db.id, prop.id, { options: list });
  };
  const row = (o: (typeof options)[number]) => (
    <div
      key={o.id}
      className="opt-row"
      draggable
      onDragStart={(e) => {
        drag.current = o.id;
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (drag.current && drag.current !== o.id) move(drag.current, o.id, prop.type === "status" ? o.group : undefined);
        drag.current = null;
      }}
    >
      <GripVertical size={13} className="muted grip" />
      <Tag name={o.name} color={o.color} status={prop.type === "status"} />
      <span style={{ flex: 1 }} />
      <Dropdown side="right" width={220} trigger={(open) => (
        <button className="icon-btn tiny" onClick={open} title="Edit option">
          <Settings2 size={13} />
        </button>
      )}>
        {(close) => <OptionMenu dbId={db.id} prop={prop} optionId={o.id} close={close} />}
      </Dropdown>
    </div>
  );
  const addInput = (group?: string) =>
    adding === (group ?? "") ? (
      <input
        className="menu-input"
        autoFocus
        placeholder="Option name"
        onBlur={() => setAdding(null)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && e.currentTarget.value.trim()) {
            addOption(db.id, prop.id, e.currentTarget.value, group as any);
            e.currentTarget.value = "";
          } else if (e.key === "Escape") setAdding(null);
        }}
      />
    ) : (
      <MenuItem icon={<Plus size={14} />} label="Add an option" onClick={() => setAdding(group ?? "")} />
    );
  return (
    <div className="menu opt-settings">
      {prop.type === "status" ? (
        STATUS_GROUPS.map((g) => (
          <div
            key={g.id}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (drag.current) move(drag.current, null, g.id);
              drag.current = null;
            }}
          >
            <MenuLabel>{g.label}</MenuLabel>
            {options.filter((o) => (o.group ?? "todo") === g.id).map(row)}
            {addInput(g.id)}
          </div>
        ))
      ) : (
        <>
          <MenuLabel>Options</MenuLabel>
          {options.map(row)}
          {addInput()}
          {options.length > 1 && (
            <MenuItem
              icon={<ArrowDownUp size={14} />}
              label="Sort A → Z"
              onClick={() => updateProperty(db.id, prop.id, { options: [...options].sort((a, b) => a.name.localeCompare(b.name)) })}
            />
          )}
        </>
      )}
    </div>
  );
}

function RelationSettings({ db, prop }: { db: Page; prop: DbProperty }) {
  const pages = usePages();
  const target = prop.relation ? pages[prop.relation.dbId] : undefined;
  return (
    <div className="menu">
      <MenuLabel>Related to</MenuLabel>
      <div className="menu-item static">
        <span className="menu-icon">{target ? pageIcon(target) : null}</span>
        <span className="menu-label">{target ? target.title?.trim() || "Untitled" : "A deleted database"}</span>
      </div>
      {target && (
        <div className="menu-item static">
          <span className="menu-label">Show on {target.id === db.id ? "this database" : target.title?.trim() || "Untitled"}</span>
          <Toggle on={!!prop.relation?.syncedPropId} onChange={(on) => setRelationTwoWay(db.id, prop.id, on)} />
        </div>
      )}
      <div className="muted small pad">To relate to a different database, change this property's type to Relation again.</div>
    </div>
  );
}

function RollupSettings({ db, prop, c }: { db: Page; prop: DbProperty; c: DbCtx }) {
  const cfg = prop.rollup ?? { relationPropId: "", targetPropId: "title", fn: "show_original" };
  const relations = (db.properties ?? []).filter((p) => p.type === "relation");
  const relation = relations.find((p) => p.id === cfg.relationPropId);
  const targetDb = relation?.relation ? c.pages[relation.relation.dbId] : undefined;
  const targets = targetDb ? allProps(targetDb).filter((p) => p.type !== "button") : [];
  const target = targets.find((p) => p.id === cfg.targetPropId);
  const set = (p: Partial<NonNullable<DbProperty["rollup"]>>) => updateProperty(db.id, prop.id, { rollup: { ...cfg, ...p } });
  const fns = ROLLUP_FNS.filter((f) => {
    if (f.for === "any") return true;
    const k = target ? kindOf(target, c, targetDb) : "text";
    return (f.for === "number" && k === "number") || (f.for === "date" && k === "date") || (f.for === "checkbox" && k === "checkbox");
  });
  if (!relations.length) return <div className="menu muted small pad">A rollup sums up a property of related pages. Add a Relation property first.</div>;
  return (
    <div className="menu">
      <Sub icon={undefined} label="Relation" hint={<span className="muted small">{relation?.name ?? "Choose"}</span>} width={220}>
        {(close) => (
          <div className="menu">
            {relations.map((r) => (
              <MenuItem key={r.id} icon={PROP_ICON.relation} label={r.name} checked={r.id === cfg.relationPropId} onClick={() => (set({ relationPropId: r.id, targetPropId: "title" }), close())} />
            ))}
          </div>
        )}
      </Sub>
      <Sub icon={undefined} label="Property" hint={<span className="muted small">{target?.name ?? "Choose"}</span>} width={220}>
        {(close) => (
          <div className="menu">
            {targets.map((t) => (
              <MenuItem key={t.id} icon={PROP_ICON[t.type]} label={t.name} checked={t.id === cfg.targetPropId} onClick={() => (set({ targetPropId: t.id }), close())} />
            ))}
          </div>
        )}
      </Sub>
      <Sub icon={undefined} label="Calculate" hint={<span className="muted small">{aggLabel(cfg.fn)}</span>} width={220}>
        {(close) => (
          <div className="menu">
            {fns.map((f) => (
              <MenuItem key={f.fn} label={f.label} checked={f.fn === cfg.fn} onClick={() => (set({ fn: f.fn }), close())} />
            ))}
          </div>
        )}
      </Sub>
    </div>
  );
}

function FormulaEditor({ db, prop, c }: { db: Page; prop: DbProperty; c: DbCtx }) {
  const [src, setSrc] = useState(prop.formula ?? "");
  const ref = useRef<HTMLTextAreaElement>(null);
  const problem = checkFormula(src);
  const sample = rowsOf(c.pages, db.id)[0];
  let preview: string | null = null;
  let runError: string | undefined;
  if (!problem && sample && src.trim()) {
    const r = formulaValue(sample, { ...prop, formula: src }, { ...c, cache: new Map(), busy: new Set() });
    runError = r.error;
    preview = r.error ? null : showF(r.value, prop, c) || "(empty)";
  }
  const insert = (text: string) => {
    const el = ref.current;
    const at = el?.selectionStart ?? src.length;
    const end = el?.selectionEnd ?? at;
    const next = src.slice(0, at) + text + src.slice(end);
    setSrc(next);
    requestAnimationFrame(() => {
      el?.focus();
      const caret = at + text.length - (text.endsWith("()") ? 1 : 0);
      el?.setSelectionRange(caret, caret);
    });
  };
  const save = () => updateProperty(db.id, prop.id, { formula: src });
  return (
    <div className="menu formula-editor">
      <textarea
        ref={ref}
        className="formula-input"
        value={src}
        autoFocus
        spellCheck={false}
        rows={4}
        placeholder={'e.g. prop("Price") * prop("Quantity")'}
        onChange={(e) => setSrc(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) save();
        }}
      />
      <div className={"formula-result" + (problem || runError ? " bad" : "")} role="status">
        {problem || runError ? problem || runError : preview != null ? <>Result for “{sample?.title?.trim() || "Untitled"}”: <b>{preview}</b></> : "Write a formula to see its result."}
      </div>
      <div className="row gap">
        <button className="btn small" onClick={save} disabled={src === (prop.formula ?? "")}>
          Save
        </button>
        <span className="muted small">Ctrl+Enter saves</span>
      </div>
      <MenuLabel>Properties</MenuLabel>
      <div className="formula-chips">
        {allProps(db)
          .filter((p) => p.id !== prop.id)
          .map((p) => (
            <button key={p.id} className="chip" onClick={() => insert(`prop("${p.name}")`)}>
              {PROP_ICON[p.type]} {p.name}
            </button>
          ))}
      </div>
      <MenuLabel>Functions</MenuLabel>
      <div className="formula-chips fns">
        {FUNCTION_NAMES.map((f) => (
          <button key={f} className="chip mono" onClick={() => insert(f + "()")}>
            {f}
          </button>
        ))}
      </div>
    </div>
  );
}

function ButtonSettings({ db, prop }: { db: Page; prop: DbProperty }) {
  const cfg = prop.button ?? { label: prop.name, actions: [] };
  const set = (p: Partial<NonNullable<DbProperty["button"]>>) => updateProperty(db.id, prop.id, { button: { ...cfg, ...p } });
  const targets = allProps(db).filter((p) => ["text", "number", "select", "status", "multi_select", "date", "person", "checkbox", "url", "email", "phone"].includes(p.type) || p.id === "title");
  const setAction = (i: number, a: (typeof cfg.actions)[number] | null) => {
    const actions = [...cfg.actions];
    if (a) actions[i] = a;
    else actions.splice(i, 1);
    set({ actions });
  };
  return (
    <div className="menu button-settings">
      <MenuLabel>Label</MenuLabel>
      <input className="menu-input" defaultValue={cfg.label ?? ""} onChange={(e) => set({ label: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
      <MenuLabel>When pressed, set</MenuLabel>
      {cfg.actions.map((a, i) => {
        const t = targets.find((p) => p.id === a.propId) ?? TITLE;
        return (
          <div key={i} className="filter-row">
            <select value={a.propId} onChange={(e) => setAction(i, { propId: e.target.value, value: undefined })}>
              {targets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <ActionValue prop={t} value={a.value} onChange={(value) => setAction(i, { ...a, value })} />
            <button className="icon-btn tiny" onClick={() => setAction(i, null)} title="Remove">
              <X size={13} />
            </button>
          </div>
        );
      })}
      <MenuItem icon={<Plus size={14} />} label="Add an action" onClick={() => set({ actions: [...cfg.actions, { propId: targets.find((p) => p.type === "checkbox" || p.type === "status")?.id ?? targets[0]?.id ?? "title", value: undefined }] })} />
    </div>
  );
}

function ActionValue({ prop, value, onChange }: { prop: DbProperty; value: any; onChange: (v: any) => void }) {
  const special = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value)[0] : null;
  switch (prop.type) {
    case "checkbox":
      return (
        <select className="grow" value={special === "toggle" ? "toggle" : value === true ? "on" : "off"} onChange={(e) => onChange(e.target.value === "toggle" ? { toggle: true } : e.target.value === "on" ? true : { clear: true })}>
          <option value="on">Checked</option>
          <option value="off">Unchecked</option>
          <option value="toggle">The opposite</option>
        </select>
      );
    case "date":
      return (
        <select className="grow" value={special ?? "now"} onChange={(e) => onChange({ [e.target.value]: true })}>
          <option value="now">Today</option>
          <option value="clear">Empty</option>
        </select>
      );
    case "person":
      return (
        <select className="grow" value={special ?? "me"} onChange={(e) => onChange({ [e.target.value]: true })}>
          <option value="me">Whoever pressed it</option>
          <option value="clear">Empty</option>
        </select>
      );
    case "select":
    case "status":
      return (
        <select className="grow" value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value || { clear: true })}>
          <option value="">Empty</option>
          {(prop.options ?? []).map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      );
    case "multi_select":
      return (
        <select className="grow" value={Array.isArray(value) ? value[0] ?? "" : ""} onChange={(e) => onChange(e.target.value ? [e.target.value] : { clear: true })}>
          <option value="">Empty</option>
          {(prop.options ?? []).map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      );
    case "number":
      return <input className="grow" type="number" defaultValue={typeof value === "number" ? value : ""} onChange={(e) => onChange(e.target.value === "" ? { clear: true } : Number(e.target.value))} onKeyDown={(e) => e.stopPropagation()} />;
    default:
      return <input className="grow" defaultValue={typeof value === "string" ? value : ""} placeholder="Text" onChange={(e) => onChange(e.target.value || { clear: true })} onKeyDown={(e) => e.stopPropagation()} />;
  }
}
