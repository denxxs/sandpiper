// How each kind of property value looks, and the editor that opens when you click one.
import { ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  AtSign,
  Calendar,
  CircleChevronDown,
  CircleDotDashed,
  CircleUser,
  Clock,
  Ellipsis,
  File as FileIcon,
  Hash,
  History,
  IdCard,
  Link,
  MousePointerClick,
  Paperclip,
  Phone,
  Plus,
  ScanSearch,
  Sigma,
  SquareCheck,
  Tags,
  Trash2,
  Type,
  Upload,
  UserPen,
  Users,
  X,
} from "lucide-react";
import {
  asArray,
  dateVal,
  DateVal,
  DbCtx,
  filesVal,
  formatDate,
  formatNumber,
  formulaValue,
  hasTime,
  isDate,
  isPercentAgg,
  kindOf,
  numberFill,
  parseDateText,
  relationIds,
  rollupValue,
  rowsOf,
  showF,
  STATUS_GROUPS,
  storeDate,
  textValue,
  uniqueId,
  ymd,
} from "../../../shared/db";
import { addOption, createPage, DbProperty, OPTION_COLORS, Page, PropType, pressButton, setRowProp, updatePage, updateProperty, User } from "../../store";
import { Avatar, Dropdown, MenuItem, MenuLabel, MenuSep, Popover, Toggle, toast, uploadFile } from "../ui";
import { pageIcon } from "../Sidebar";
import { openRow } from "../../nav";

export const PROP_ICON: Record<PropType, ReactNode> = {
  text: <Type size={14} />,
  number: <Hash size={14} />,
  select: <CircleChevronDown size={14} />,
  multi_select: <Tags size={14} />,
  status: <CircleDotDashed size={14} />,
  date: <Calendar size={14} />,
  person: <Users size={14} />,
  files: <Paperclip size={14} />,
  checkbox: <SquareCheck size={14} />,
  url: <Link size={14} />,
  email: <AtSign size={14} />,
  phone: <Phone size={14} />,
  relation: <ArrowUpRight size={14} />,
  rollup: <ScanSearch size={14} />,
  formula: <Sigma size={14} />,
  button: <MousePointerClick size={14} />,
  unique_id: <IdCard size={14} />,
  created_time: <Clock size={14} />,
  created_by: <CircleUser size={14} />,
  last_edited_time: <History size={14} />,
  last_edited_by: <UserPen size={14} />,
};

/** Read-only properties: Sandpiper fills them in. */
export const READ_ONLY: PropType[] = ["formula", "rollup", "unique_id", "created_time", "created_by", "last_edited_time", "last_edited_by"];

// ---------------------------------------------------------------- pieces

export function Tag({ name, color, onRemove, status }: { name: string; color: string; onRemove?: () => void; status?: boolean }) {
  return (
    <span className={"tag tag-" + color + (status ? " tag-status" : "")}>
      {status && <span className="status-dot" aria-hidden />}
      <span className="tag-text">{name}</span>
      {onRemove && (
        <button
          className="tag-x"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          aria-label={"Remove " + name}
        >
          <X size={11} />
        </button>
      )}
    </span>
  );
}

function Checkbox({ on }: { on: boolean }) {
  // The tick is drawn as a pen stroke, so checking it writes it in and unchecking takes it back out.
  return (
    <span className={"checkbox" + (on ? " on" : "")} role="img" aria-label={on ? "Checked" : "Not checked"}>
      <svg viewBox="0 0 24 24" aria-hidden>
        <path d="M5 12.5l4.5 4.5L19 7.5" pathLength={1} />
      </svg>
    </span>
  );
}

/** A number as its property shows it: plain, as a bar, or as a ring. */
export function NumberShow({ n, prop, percent }: { n: number; prop: DbProperty; percent?: boolean }) {
  const text = percent ? formatNumber(n, { numberFormat: "percent", decimals: prop.decimals }) : formatNumber(n, prop);
  const show = prop.showAs ?? "number";
  if (show === "number") return <span className="num">{text}</span>;
  const fill = percent ? Math.max(0, Math.min(1, n)) : numberFill(n, prop);
  const color = "var(--opt-" + (prop.barColor ?? "green") + ")";
  if (show === "ring") {
    const r = 7;
    const len = 2 * Math.PI * r;
    return (
      <span className="num num-ring">
        <svg viewBox="0 0 20 20" width={18} height={18} aria-hidden>
          <circle cx="10" cy="10" r={r} className="ring-track" />
          <circle cx="10" cy="10" r={r} className="ring-fill" style={{ stroke: color, strokeDasharray: `${fill * len} ${len}` }} transform="rotate(-90 10 10)" />
        </svg>
        {prop.showNumber !== false && <span>{text}</span>}
      </span>
    );
  }
  return (
    <span className="num num-bar">
      {prop.showNumber !== false && <span>{text}</span>}
      <span className="bar-track" aria-hidden>
        <span className="bar-fill" style={{ width: fill * 100 + "%", background: color }} />
      </span>
    </span>
  );
}

function PersonChip({ user }: { user?: User }) {
  if (!user) return null;
  return (
    <span className="person">
      <Avatar user={user} size={18} />
      {user.name}
    </span>
  );
}

function PageChip({ page, onOpen }: { page?: Page; onOpen?: () => void }) {
  if (!page) return null;
  return (
    <span
      className="rel-chip"
      role={onOpen ? "link" : undefined}
      onClick={
        onOpen &&
        ((e) => {
          e.stopPropagation();
          onOpen();
        })
      }
    >
      <span className="rel-icon">{pageIcon(page)}</span>
      <span className="rel-title">{page.title?.trim() || "Untitled"}</span>
    </span>
  );
}

const linkHref = (v: string) => (/^[a-z][a-z0-9+.-]*:/i.test(v) ? v : "https://" + v);
const isImage = (url: string, name: string) => /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(name || url) || /^\/files\//.test(url) && /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(name);

/** A property value, as it reads in a cell, a card or a row's page. */
export function PropValue({ row, prop, c, onPress }: { row: Page; prop: DbProperty; c: DbCtx; onPress?: () => void }) {
  if (prop.id === "title") return <span>{row.title}</span>;
  const v = row.props?.[prop.id];
  switch (prop.type) {
    case "checkbox":
      return <Checkbox on={!!v} />;
    case "select":
    case "status":
    case "multi_select": {
      const opts = asArray(v)
        .map((id) => prop.options?.find((o) => o.id === id))
        .filter(Boolean);
      if (!opts.length) return null;
      return (
        <span className="tags">
          {opts.map((o) => (
            <Tag key={o!.id} name={o!.name} color={o!.color} status={prop.type === "status"} />
          ))}
        </span>
      );
    }
    case "person": {
      const ids = asArray(v).filter((id) => c.users[id]);
      if (!ids.length) return null;
      return (
        <span className="tags">
          {ids.map((id) => (
            <PersonChip key={id} user={c.users[id]} />
          ))}
        </span>
      );
    }
    case "created_by":
      return <PersonChip user={row.createdBy ? c.users[row.createdBy] : undefined} />;
    case "last_edited_by":
      return <PersonChip user={row.updatedBy ? c.users[row.updatedBy] : undefined} />;
    case "date":
    case "created_time":
    case "last_edited_time": {
      const t = textValue(row, prop, c);
      return t ? <span>{t}</span> : null;
    }
    case "url":
      if (!v) return null;
      return (
        <a className="cell-link" href={linkHref(String(v))} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}>
          {String(v)}
        </a>
      );
    case "email":
      return v ? (
        <a className="cell-link" href={"mailto:" + String(v)} onClick={(e) => e.stopPropagation()}>
          {String(v)}
        </a>
      ) : null;
    case "phone":
      return v ? (
        <a className="cell-link" href={"tel:" + String(v).replace(/[^\d+]/g, "")} onClick={(e) => e.stopPropagation()}>
          {String(v)}
        </a>
      ) : null;
    case "number":
      return typeof v === "number" ? <NumberShow n={v} prop={prop} /> : null;
    case "files": {
      const files = filesVal(v);
      if (!files.length) return null;
      return (
        <span className="tags">
          {files.map((f, i) =>
            isImage(f.url, f.name) ? (
              <a key={i} className="file-thumb" href={f.url} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()} title={f.name}>
                <img src={f.url} alt={f.name} loading="lazy" />
              </a>
            ) : (
              <a key={i} className="file-chip" href={f.url} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()} title={f.name}>
                <FileIcon size={12} /> <span>{f.name}</span>
              </a>
            ),
          )}
        </span>
      );
    }
    case "relation": {
      const ids = relationIds(row, prop, c);
      if (!ids.length) return null;
      return (
        <span className="tags">
          {ids.map((id) => (
            <PageChip key={id} page={c.pages[id]} onOpen={() => openRow(id, "side")} />
          ))}
        </span>
      );
    }
    case "unique_id": {
      const n = uniqueId(row, prop, c);
      return <span className="num-id">{prop.prefix ? `${prop.prefix}-${n}` : n}</span>;
    }
    case "rollup": {
      const r = rollupValue(row, prop, c);
      const percent = isPercentAgg(prop.rollup?.fn ?? "");
      if (typeof r === "number") return <NumberShow n={r} prop={prop} percent={percent} />;
      if (r == null || (Array.isArray(r) && !r.length)) return null;
      if (Array.isArray(r) && r.every((x) => x && typeof x === "object" && (x as any).kind === "page")) {
        return (
          <span className="tags">
            {r.map((x: any) => (
              <PageChip key={x.id} page={c.pages[x.id]} />
            ))}
          </span>
        );
      }
      if (Array.isArray(r) && r.every((x) => typeof x === "boolean")) {
        return (
          <span className="tags">
            {r.map((x, i) => (
              <Checkbox key={i} on={!!x} />
            ))}
          </span>
        );
      }
      return <span>{showF(r, prop, c)}</span>;
    }
    case "formula": {
      const r = formulaValue(row, prop, c);
      if (r.error)
        return (
          <span className="formula-error" title={r.error}>
            Error
          </span>
        );
      const val = r.value;
      if (typeof val === "boolean") return <Checkbox on={val} />;
      if (typeof val === "number") return <NumberShow n={val} prop={prop} />;
      if (val == null || val === "") return null;
      if (isDate(val)) return <span>{formatDate(val, prop, c.now)}</span>;
      return <span className="formula-text">{showF(val, prop, c)}</span>;
    }
    case "button":
      return (
        <button
          className="db-button"
          disabled={!onPress}
          onClick={(e) => {
            e.stopPropagation();
            onPress?.();
          }}
        >
          <MousePointerClick size={13} /> {prop.button?.label || prop.name}
        </button>
      );
    default:
      return v == null || v === "" ? null : <span>{String(v)}</span>;
  }
}

// ---------------------------------------------------------------- editors

function TextEditor(props: { initial: string; number?: boolean; multiline?: boolean; onCommit: (v: any) => void; onClose: () => void }) {
  const [val, setVal] = useState(props.initial);
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const commit = () => {
    if (done.current) return;
    done.current = true;
    if (val !== props.initial) {
      if (props.number) {
        const n = parseFloat(val.replace(/[^\d.eE+-]/g, ""));
        props.onCommit(val.trim() === "" || Number.isNaN(n) ? undefined : n);
      } else props.onCommit(val);
    }
    props.onClose();
  };
  // Commit when the popover is closed by clicking elsewhere.
  const commitRef = useRef(commit);
  commitRef.current = commit;
  useEffect(() => () => commitRef.current(), []);
  const common = {
    ref,
    value: val,
    className: "cell-input",
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setVal(e.target.value),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        commit();
      } else if (e.key === "Escape") {
        done.current = true;
        props.onClose();
      }
      e.stopPropagation();
    },
  };
  return props.multiline ? <textarea rows={Math.min(8, Math.max(1, val.split("\n").length))} {...common} /> : <input inputMode={props.number ? "decimal" : undefined} {...common} />;
}

/** Rename, recolour or delete one option (and, for status, move it to another group). */
export function OptionMenu({ dbId, prop, optionId, close }: { dbId: string; prop: DbProperty; optionId: string; close: () => void }) {
  const options = prop.options ?? [];
  const o = options.find((x) => x.id === optionId);
  if (!o) return null;
  const setOptions = (next: typeof options) => updateProperty(dbId, prop.id, { options: next });
  return (
    <div className="menu">
      <input
        className="menu-input"
        defaultValue={o.name}
        autoFocus
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") close();
        }}
        onChange={(e) => setOptions(options.map((x) => (x.id === o.id ? { ...x, name: e.target.value || x.name } : x)))}
      />
      <MenuItem
        icon={<Trash2 size={14} />}
        label="Delete option"
        danger
        onClick={() => {
          setOptions(options.filter((x) => x.id !== o.id));
          close();
        }}
      />
      {prop.type === "status" && (
        <>
          <MenuSep />
          <MenuLabel>Group</MenuLabel>
          {STATUS_GROUPS.map((g) => (
            <MenuItem key={g.id} label={g.label} checked={(o.group ?? "todo") === g.id} onClick={() => setOptions(options.map((x) => (x.id === o.id ? { ...x, group: g.id } : x)))} />
          ))}
        </>
      )}
      <MenuSep />
      <MenuLabel>Color</MenuLabel>
      {OPTION_COLORS.map((col) => (
        <MenuItem
          key={col}
          icon={<span className={"swatch tag-" + col} />}
          label={col[0].toUpperCase() + col.slice(1)}
          checked={o.color === col}
          onClick={() => setOptions(options.map((x) => (x.id === o.id ? { ...x, color: col } : x)))}
        />
      ))}
    </div>
  );
}

function OptionEditor({ dbId, prop, value, multi, onChange }: { dbId: string; prop: DbProperty; value: string[]; multi: boolean; onChange: (v: string[]) => void }) {
  const [q, setQ] = useState("");
  const options = prop.options ?? [];
  const shown = options.filter((o) => o.name.toLowerCase().includes(q.trim().toLowerCase()));
  const exact = options.some((o) => o.name.toLowerCase() === q.trim().toLowerCase());
  const toggle = (id: string) => {
    if (multi) onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
    else onChange(value.includes(id) ? [] : [id]);
    setQ("");
  };
  const row = (o: (typeof options)[number]) => (
    <div key={o.id} className={"opt-row" + (value.includes(o.id) ? " active" : "")} onClick={() => toggle(o.id)}>
      <Tag name={o.name} color={o.color} status={prop.type === "status"} />
      <span style={{ flex: 1 }} />
      <Dropdown
        side="right"
        width={220}
        trigger={(open) => (
          <button className="icon-btn tiny" onClick={open} title="Edit option">
            <Ellipsis size={14} />
          </button>
        )}
      >
        {(close) => <OptionMenu dbId={dbId} prop={prop} optionId={o.id} close={close} />}
      </Dropdown>
    </div>
  );
  return (
    <div className="opt-editor">
      <div className="opt-input">
        {value.map((id) => {
          const o = options.find((x) => x.id === id);
          return o ? <Tag key={id} name={o.name} color={o.color} status={prop.type === "status"} onRemove={() => onChange(value.filter((x) => x !== id))} /> : null;
        })}
        <input
          autoFocus
          value={q}
          placeholder={value.length ? "" : prop.type === "status" ? "Search for an option…" : "Search or create an option…"}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && q.trim()) {
              const match = options.find((o) => o.name.toLowerCase() === q.trim().toLowerCase()) ?? shown[0];
              toggle(match && (exact || prop.type === "status") ? match.id : addOption(dbId, prop.id, q));
            } else if (e.key === "Backspace" && !q && value.length) onChange(value.slice(0, -1));
          }}
        />
      </div>
      <div className="opt-list">
        {prop.type === "status"
          ? STATUS_GROUPS.map((g) => {
              const list = shown.filter((o) => (o.group ?? "todo") === g.id);
              return (
                <div key={g.id}>
                  <MenuLabel>{g.label}</MenuLabel>
                  {list.map(row)}
                </div>
              );
            })
          : (
            <>
              <MenuLabel>{options.length ? "Select an option or create one" : "Type to create an option"}</MenuLabel>
              {shown.map(row)}
            </>
          )}
        {q.trim() && !exact && (
          <div className="opt-row" onClick={() => toggle(addOption(dbId, prop.id, q))}>
            <span className="muted">Create</span>&nbsp;
            <Tag name={q.trim()} color="gray" status={prop.type === "status"} />
          </div>
        )}
      </div>
    </div>
  );
}

function PersonEditor({ value, users, onChange }: { value: string[]; users: Record<string, User>; onChange: (v: string[]) => void }) {
  const list = Object.values(users).sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="menu">
      <MenuLabel>People in this workspace</MenuLabel>
      {list.map((u) => (
        <MenuItem
          key={u.id}
          icon={<Avatar user={u} size={18} />}
          label={u.name}
          checked={value.includes(u.id)}
          onClick={() => onChange(value.includes(u.id) ? value.filter((x) => x !== u.id) : [...value, u.id])}
        />
      ))}
    </div>
  );
}

/** A date or a range, with or without a time. */
function DateEditor({ value, onChange, close }: { value: DateVal | null; onChange: (v: DateVal | null) => void; close: () => void }) {
  const [d, setD] = useState<DateVal | null>(value);
  const withTime = d ? hasTime(d.start) : false;
  const withEnd = !!d?.end;
  const today = ymd(new Date());
  const set = (next: DateVal | null) => {
    setD(next);
    onChange(next);
  };
  const day = (s?: string) => (s ?? "").slice(0, 10);
  const time = (s?: string) => (s && hasTime(s) ? s.slice(11, 16) : "09:00");
  const join = (dayPart: string, timePart: string | null) => (timePart ? `${dayPart}T${timePart}` : dayPart);
  const base = d ?? { start: today };
  return (
    <div className="date-editor" onKeyDown={(e) => e.stopPropagation()}>
      <div className="date-fields">
        <label>
          <span className="muted small">{withEnd ? "Start" : "Date"}</span>
          <span className="row gap">
            <input type="date" autoFocus value={day(d?.start)} onChange={(e) => set(e.target.value ? { ...base, start: join(e.target.value, withTime ? time(d?.start) : null) } : null)} />
            {withTime && <input type="time" value={time(d?.start)} onChange={(e) => set({ ...base, start: join(day(base.start), e.target.value || "00:00") })} />}
          </span>
        </label>
        {withEnd && (
          <label>
            <span className="muted small">End</span>
            <span className="row gap">
              <input type="date" value={day(d?.end)} min={day(d?.start)} onChange={(e) => set({ ...base, end: e.target.value ? join(e.target.value, withTime ? time(d?.end) : null) : undefined })} />
              {withTime && <input type="time" value={time(d?.end)} onChange={(e) => set({ ...base, end: join(day(base.end ?? base.start), e.target.value || "00:00") })} />}
            </span>
          </label>
        )}
      </div>
      <div className="menu-item static">
        <span className="menu-label">End date</span>
        <Toggle on={withEnd} onChange={(on) => set(on ? { ...base, end: base.start } : { start: base.start })} />
      </div>
      <div className="menu-item static">
        <span className="menu-label">Include time</span>
        <Toggle
          on={withTime}
          onChange={(on) =>
            set(
              on
                ? { start: join(day(base.start), "09:00"), end: base.end ? join(day(base.end), "10:00") : undefined }
                : { start: day(base.start), end: base.end ? day(base.end) : undefined },
            )
          }
        />
      </div>
      <div className="row gap">
        <button className="btn-ghost small" onClick={() => (set({ start: withTime ? join(today, time(d?.start)) : today, end: d?.end }), close())}>
          Today
        </button>
        <button className="btn-ghost small" onClick={() => (set(null), close())}>
          Clear
        </button>
      </div>
    </div>
  );
}

function FilesEditor({ value, onChange }: { value: { name: string; url: string }[]; onChange: (v: { name: string; url: string }[]) => void }) {
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    try {
      const added: { name: string; url: string }[] = [];
      for (const f of Array.from(files)) added.push({ name: f.name, url: await uploadFile(f) });
      onChange([...value, ...added]);
    } catch (e: any) {
      toast(e?.message || "That file couldn't be uploaded.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="menu files-editor" onKeyDown={(e) => e.stopPropagation()}>
      {value.map((f, i) => (
        <div key={i} className="menu-item static">
          <span className="menu-icon">
            <FileIcon size={14} />
          </span>
          <a className="menu-label" href={f.url} target="_blank" rel="noreferrer noopener">
            {f.name}
          </a>
          <button className="icon-btn tiny" onClick={() => onChange(value.filter((_, j) => j !== i))} title="Remove">
            <X size={13} />
          </button>
        </div>
      ))}
      {value.length > 0 && <MenuSep />}
      <MenuItem icon={<Upload size={14} />} label={busy ? "Uploading…" : "Upload a file"} disabled={busy} onClick={() => input.current?.click()} />
      <input ref={input} type="file" multiple hidden onChange={(e) => upload(e.target.files)} />
      <div className="row gap pad-x">
        <input
          className="grow"
          placeholder="Or paste a link…"
          value={link}
          onChange={(e) => setLink(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && /^https?:\/\/\S+$/i.test(link.trim())) {
              const url = link.trim();
              onChange([...value, { name: decodeURIComponent(url.split("/").pop()?.split("?")[0] || url), url }]);
              setLink("");
            }
          }}
        />
      </div>
    </div>
  );
}

/** Pick rows of the related database; typing a name that isn't there offers to add it. */
function RelationEditor({ prop, value, c, onChange }: { prop: DbProperty; value: string[]; c: DbCtx; onChange: (v: string[]) => void }) {
  const [q, setQ] = useState("");
  const target = prop.relation ? c.pages[prop.relation.dbId] : undefined;
  const rows = useMemo(() => (target ? rowsOf(c.pages, target.id) : []), [c.pages, target]);
  if (!target || target.trashed) return <div className="menu muted small pad">The related database was deleted.</div>;
  const ql = q.trim().toLowerCase();
  const shown = rows.filter((r) => (r.title?.trim() || "Untitled").toLowerCase().includes(ql)).slice(0, 60);
  const exact = rows.some((r) => r.title.trim().toLowerCase() === ql);
  return (
    <div className="menu rel-editor">
      <input
        className="menu-input"
        autoFocus
        value={q}
        placeholder={`Link to a page in ${target.title?.trim() || "Untitled"}…`}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => e.stopPropagation()}
      />
      {value.length > 0 && <MenuLabel>Linked</MenuLabel>}
      {value.map((id) => (
        <MenuItem key={id} icon={<span className="rel-icon">{pageIcon(c.pages[id])}</span>} label={c.pages[id]?.title?.trim() || "Untitled"} hint={<X size={13} />} onClick={() => onChange(value.filter((x) => x !== id))} />
      ))}
      <MenuLabel>{value.length ? "More pages" : "Pages"}</MenuLabel>
      {shown
        .filter((r) => !value.includes(r.id))
        .map((r) => (
          <MenuItem key={r.id} icon={<span className="rel-icon">{pageIcon(r)}</span>} label={r.title?.trim() || "Untitled"} onClick={() => onChange([...value, r.id])} />
        ))}
      {q.trim() && !exact && (
        <MenuItem
          icon={<Plus size={14} />}
          label={
            <>
              New page <b>{q.trim()}</b>
            </>
          }
          onClick={() => {
            const id = createPage({ parentId: target.id, isRow: true, title: q.trim() });
            onChange([...value, id]);
            setQ("");
          }}
        />
      )}
    </div>
  );
}

/** A property value that opens the right editor when clicked. */
export function EditableValue(props: { dbId: string; row: Page; prop: DbProperty; c: DbCtx; locked?: boolean; placeholder?: string; className?: string }) {
  const { row, prop, dbId, c } = props;
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const v = prop.id === "title" ? row.title : row.props?.[prop.id];
  const readOnly = props.locked || READ_ONLY.includes(prop.type);
  const set = (value: any) => (prop.id === "title" ? updatePage(row.id, { title: String(value ?? "") }) : setRowProp(row.id, prop.id, value));
  const close = () => setAnchor(null);

  let editor: ReactNode = null;
  let over = false;
  let width: number | string | undefined = 280;
  if (anchor) {
    switch (prop.type) {
      case "select":
      case "status":
      case "multi_select":
        editor = (
          <OptionEditor
            dbId={dbId}
            prop={prop}
            value={asArray(v)}
            multi={prop.type === "multi_select"}
            onChange={(ids) => {
              set(prop.type === "multi_select" ? (ids.length ? ids : undefined) : ids[0]);
              if (prop.type !== "multi_select") close();
            }}
          />
        );
        break;
      case "person":
        editor = <PersonEditor value={asArray(v)} users={c.users} onChange={(ids) => set(ids.length ? ids : undefined)} />;
        width = 240;
        break;
      case "date":
        editor = <DateEditor value={dateVal(v)} onChange={(d) => set(storeDate(d))} close={close} />;
        width = 300;
        break;
      case "files":
        editor = <FilesEditor value={filesVal(v)} onChange={(f) => set(f.length ? f : undefined)} />;
        width = 300;
        break;
      case "relation":
        editor = <RelationEditor prop={prop} value={asArray(v)} c={c} onChange={(ids) => set(ids.length ? ids : undefined)} />;
        width = 300;
        break;
      default:
        over = true;
        width = Math.max(220, anchor.offsetWidth);
        editor = (
          <TextEditor
            initial={v == null ? "" : String(v)}
            number={prop.type === "number"}
            multiline={prop.type === "text" || prop.id === "title"}
            onCommit={set}
            onClose={close}
          />
        );
    }
  }
  const empty = prop.id === "title" ? !row.title : prop.type === "checkbox" ? false : READ_ONLY.includes(prop.type) || prop.type === "button" ? false : v == null || v === "" || (Array.isArray(v) && !v.length);

  return (
    <>
      <div
        className={"value " + (props.className ?? "") + (readOnly ? " ro" : "") + (prop.type === "number" || (kindOf(prop, c) === "number" && READ_ONLY.includes(prop.type)) ? " v-num" : "")}
        onClick={(e) => {
          if (readOnly || prop.type === "button") return;
          e.stopPropagation();
          if (prop.type === "checkbox") set(v ? undefined : true);
          else setAnchor(e.currentTarget);
        }}
      >
        <PropValue row={row} prop={prop} c={c} onPress={props.locked ? undefined : () => pressButton(row.id, prop)} />
        {empty && props.placeholder && <span className="placeholder">{props.placeholder}</span>}
      </div>
      {anchor && (
        <Popover anchor={anchor} onClose={close} side={over ? "over" : "bottom"} width={width} className={over ? "pop-cell" : ""}>
          {editor}
        </Popover>
      )}
    </>
  );
}

/** Whether a date property's value includes a time, for the calendar and timeline. */
export function dayOf(v: any): string | null {
  const d = dateVal(v);
  return d ? d.start.slice(0, 10) : null;
}
export { parseDateText };
