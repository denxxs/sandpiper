// A database: its views (tabs), toolbar (filter, sort, search, settings, new) and the current view's layout.
// What values mean, how filters and sorts work and how rows group lives in shared/db.ts (the server uses it too);
// the pieces of the screen live in ./db/.
import { useMemo, useState } from "react";
import { ArrowUpDown, ListFilter, Maximize2, Plus, Search, Settings } from "lucide-react";
import { dbCtx, DbView, filterCount, isGroup, VIEW_LABEL, VIEW_TYPES, viewRows } from "../../shared/db";
import { createPage, isTrashed, newView, Page, updatePage, useLocal, usePages, useUsers } from "../store";
import { go, openRow } from "../nav";
import { Dropdown, MenuItem, MenuLabel } from "./ui";
import { pageIcon } from "./Sidebar";
import { FilterMenu, SortMenu, ViewOptionsMenu } from "./db/menus";
import { AddPropertyMenu } from "./db/propMenu";
import { EditableValue, PROP_ICON } from "./db/values";
import { VIEW_ICON } from "./db/icons";
import { BoardView, CalendarView, GalleryView, ListView, TableView, ViewCtx } from "./db/views";
import { TimelineView } from "./db/timeline";
import { ChartView } from "./db/chart";

export { PROP_ICON, PropValue, EditableValue } from "./db/values";

function ViewTabs({ db, view, locked, setActive }: { db: Page; view: DbView; locked: boolean; setActive: (id: string) => void }) {
  const views = db.views ?? [];
  const setViews = (v: DbView[]) => updatePage(db.id, { views: v }, false);
  return (
    <div className="view-tabs" role="tablist" aria-label="Views">
      {views.map((v) => (
        <button
          key={v.id}
          role="tab"
          aria-selected={v.id === view.id}
          className={"view-tab" + (v.id === view.id ? " active" : "")}
          onClick={() => setActive(v.id)}
        >
          {VIEW_ICON[v.type] ?? VIEW_ICON.table} {v.name}
        </button>
      ))}
      {!locked && (
        <Dropdown
          width={200}
          trigger={(open) => (
            <button className="view-tab add" onClick={open} title="Add a view">
              <Plus size={14} />
            </button>
          )}
        >
          {(close) => (
            <div className="menu">
              <MenuLabel>New view</MenuLabel>
              {VIEW_TYPES.map((t) => (
                <MenuItem
                  key={t}
                  icon={VIEW_ICON[t]}
                  label={VIEW_LABEL[t]}
                  onClick={() => {
                    const v = newView(t, db.properties ?? []);
                    setViews([...views, v]);
                    setActive(v.id);
                    close();
                  }}
                />
              ))}
            </div>
          )}
        </Dropdown>
      )}
    </div>
  );
}

export function DatabaseView({ dbId, inline }: { dbId: string; inline?: boolean }) {
  const pages = usePages();
  const users = useUsers();
  const db: Page | undefined = pages[dbId];
  const [activeId, setActiveId] = useLocal<string | null>("view." + dbId, null);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);

  const views = db?.views ?? [];
  const view = views.find((v) => v.id === activeId) ?? views[0];
  const props = db?.properties ?? [];
  // One context per render of the data: computed values (formulas, rollups) are worked out once and reused.
  const c = useMemo(() => dbCtx(pages, users), [pages, users]);

  const rows = useMemo(() => (db && view ? viewRows(db, view, c, query) : []), [db, view, c, query]);

  if (!db || db.kind !== "database" || isTrashed(pages, dbId)) {
    return <div className="db-missing">This database was deleted or is no longer available.</div>;
  }
  if (!view) return null;

  const locked = !!db.locked;
  const ctx: ViewCtx = {
    db,
    view,
    props,
    visible: props.filter((p) => !(view.hidden ?? []).includes(p.id)),
    rows,
    users,
    c,
    locked,
    open: (rowId) => openRow(rowId, view.openIn ?? "side"),
    addRow: (extra, title) => {
      // Pre-fill values so the new row satisfies the view's "is" filters and stays visible.
      const preset: Record<string, any> = {};
      if ((view.filterOp ?? "and") === "and") {
        for (const f of view.filters) {
          if (isGroup(f)) continue;
          const prop = props.find((p) => p.id === f.propId);
          if (!prop || f.value == null || f.value === "") continue;
          if ((prop.type === "select" || prop.type === "status") && f.op === "is" && !String(f.value).startsWith("group:")) preset[prop.id] = f.value;
          if ((prop.type === "multi_select" || prop.type === "person" || prop.type === "relation") && f.op === "contains") preset[prop.id] = [f.value];
          if (prop.type === "checkbox" && f.op === "checked") preset[prop.id] = true;
        }
      }
      const merged = { ...preset, ...extra };
      for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
      return createPage({ parentId: db.id, isRow: true, title: title ?? "", props: merged });
    },
  };
  const nFilters = filterCount(view.filters);
  const bar = { db, view, props, c, users };

  return (
    <div className={"db" + (inline ? " inline" : "")}>
      {inline && (
        <div className="db-inline-title">
          <span className="row-icon">{pageIcon(db)}</span>
          <input
            value={db.title}
            placeholder="Untitled database"
            readOnly={locked}
            onChange={(e) => updatePage(db.id, { title: e.target.value })}
            onKeyDown={(e) => e.stopPropagation()}
          />
          <button className="icon-btn" onClick={() => go(db.id)} title="Open as full page">
            <Maximize2 size={14} />
          </button>
        </div>
      )}
      <div className="db-bar">
        <ViewTabs db={db} view={view} locked={locked} setActive={setActiveId} />
        <span style={{ flex: 1 }} />
        {!locked && (
          <Dropdown align="end" width={520} trigger={(open) => (
            <button className={"btn-ghost small" + (nFilters ? " on" : "")} onClick={open}>
              <ListFilter size={14} /> Filter{nFilters ? ` · ${nFilters}` : ""}
            </button>
          )}>
            {() => <FilterMenu ctx={bar} />}
          </Dropdown>
        )}
        {!locked && view.type !== "chart" && (
          <Dropdown align="end" width={380} trigger={(open) => (
            <button className={"btn-ghost small" + (view.sorts.length ? " on" : "")} onClick={open}>
              <ArrowUpDown size={14} /> Sort{view.sorts.length ? ` · ${view.sorts.length}` : ""}
            </button>
          )}>
            {() => <SortMenu ctx={bar} />}
          </Dropdown>
        )}
        {searching ? (
          <span className="db-search">
            <Search size={14} />
            <input
              autoFocus
              value={query}
              placeholder="Search rows…"
              onChange={(e) => setQuery(e.target.value)}
              onBlur={() => !query && setSearching(false)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Escape") {
                  setQuery("");
                  setSearching(false);
                }
              }}
            />
          </span>
        ) : (
          <button className="icon-btn" onClick={() => setSearching(true)} title="Search rows">
            <Search size={15} />
          </button>
        )}
        {!locked && (
          <Dropdown align="end" width={290} trigger={(open) => (
            <button className="icon-btn" onClick={open} title="View settings">
              <Settings size={15} />
            </button>
          )}>
            {() => <ViewOptionsMenu ctx={bar} setActive={setActiveId} />}
          </Dropdown>
        )}
        {!locked && view.type !== "chart" && (
          <button className="btn small" onClick={() => ctx.open(ctx.addRow())}>
            New
          </button>
        )}
      </div>
      {/* Keyed by view, so switching views fades the new one in. */}
      <div className="db-view" key={view.id}>
        {view.type === "table" && <TableView ctx={ctx} />}
        {view.type === "board" && <BoardView ctx={ctx} />}
        {view.type === "list" && <ListView ctx={ctx} />}
        {view.type === "gallery" && <GalleryView ctx={ctx} />}
        {view.type === "calendar" && <CalendarView ctx={ctx} />}
        {view.type === "timeline" && <TimelineView ctx={ctx} />}
        {view.type === "chart" && <ChartView ctx={ctx} />}
      </div>
      {rows.length === 0 && (view.type === "list" || view.type === "gallery" || view.type === "table") && (
        <div className="muted small pad">{nFilters || query ? "No rows match the current filters." : "No rows yet."}</div>
      )}
    </div>
  );
}

/** The list of property values shown at the top of a database row's page. */
export function RowProperties({ rowId }: { rowId: string }) {
  const pages = usePages();
  const users = useUsers();
  const c = useMemo(() => dbCtx(pages, users), [pages, users]);
  const row = pages[rowId];
  const db = row?.parentId ? pages[row.parentId] : undefined;
  if (!row || !db || db.kind !== "database") return null;
  const locked = !!db.locked || !!row.locked;
  return (
    <div className="row-props">
      {(db.properties ?? []).map((p) => (
        <div key={p.id} className="row-prop">
          <div className="row-prop-name" title={p.description || p.name}>
            {PROP_ICON[p.type]} <span>{p.name}</span>
          </div>
          <EditableValue dbId={db.id} row={row} prop={p} c={c} locked={locked} placeholder="Empty" className="row-prop-value" />
        </div>
      ))}
      {!locked && (
        <Dropdown width={240} trigger={(open) => (
          <button className="btn-ghost small muted" onClick={open}>
            <Plus size={14} /> Add a property
          </button>
        )}>
          {(close) => <AddPropertyMenu ctx={{ db }} close={close} />}
        </Dropdown>
      )}
    </div>
  );
}

