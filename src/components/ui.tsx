import { Component, ReactNode, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Check } from "lucide-react";
import type { User } from "../store";
import { WS_ID } from "../nav";
import { COVERS } from "../content-palette";
export { COVERS };

// ---------------------------------------------------------------- error boundary

/** Keeps a crash in one part of the screen from taking the whole app down with it. */
export class ErrorBoundary extends Component<
  { children: ReactNode; fallback: (error: Error, retry: () => void) => ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error(error);
  }
  render() {
    return this.state.error ? this.props.fallback(this.state.error, () => this.setState({ error: null })) : this.props.children;
  }
}

// ---------------------------------------------------------------- popover

type Anchor = HTMLElement | DOMRect | { x: number; y: number };
const stack: HTMLElement[] = [];

function anchorRect(a: Anchor): DOMRect {
  if (a instanceof HTMLElement) return a.getBoundingClientRect();
  if (a instanceof DOMRect) return a;
  return new DOMRect(a.x, a.y, 0, 0);
}

export function Popover(props: {
  anchor: Anchor;
  onClose: () => void;
  children: ReactNode;
  align?: "start" | "end" | "center";
  side?: "bottom" | "right" | "over";
  width?: number | string;
  className?: string;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const { anchor, onClose, align = "start", side = "bottom" } = props;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const place = () => {
      const a = anchorRect(anchor);
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      let left: number;
      let top: number;
      if (side === "right") {
        left = a.right + 6;
        top = a.top;
        if (left + w > innerWidth - 8) left = a.left - w - 6;
      } else {
        left = align === "end" ? a.right - w : align === "center" ? a.left + a.width / 2 - w / 2 : a.left;
        top = side === "over" ? a.top : a.bottom + 4;
        if (top + h > innerHeight - 8 && side !== "over") {
          const above = a.top - h - 4;
          top = above >= 8 ? above : Math.max(8, innerHeight - h - 8);
        }
      }
      left = Math.max(8, Math.min(left, innerWidth - w - 8));
      top = Math.max(8, Math.min(top, innerHeight - h - 8));
      setPos((p) => (p && p.left === left && p.top === top ? p : { left, top }));
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    window.addEventListener("resize", place);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [anchor, align, side]);

  useEffect(() => {
    const el = ref.current!;
    stack.push(el);
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      const idx = stack.indexOf(el);
      // Clicks inside this popover or any popover opened after it keep it open.
      for (let i = idx; i < stack.length; i++) if (stack[i].contains(t)) return;
      closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && stack[stack.length - 1] === el) {
        e.stopPropagation();
        closeRef.current();
      }
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      const i = stack.indexOf(el);
      if (i >= 0) stack.splice(i, 1);
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, []);

  return createPortal(
    <div
      ref={ref}
      className={"pop " + (props.className ?? "")}
      style={{
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        // Hidden with opacity (not visibility) until placed, so inputs inside can take focus on mount.
        opacity: pos ? 1 : 0,
        width: props.width,
        ...props.style,
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {props.children}
    </div>,
    document.body,
  );
}

/** A trigger element plus a popover that opens from it. */
export function Dropdown(props: {
  trigger: (open: (e?: React.MouseEvent) => void, isOpen: boolean) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "start" | "end" | "center";
  side?: "bottom" | "right" | "over";
  width?: number | string;
  className?: string;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const wrap = useRef<HTMLSpanElement>(null);
  const close = () => setAnchor(null);
  return (
    <>
      <span ref={wrap} className="dd-wrap">
        {props.trigger((e) => {
          e?.stopPropagation();
          e?.preventDefault();
          setAnchor((a) => (a ? null : ((wrap.current?.firstElementChild as HTMLElement) ?? wrap.current)));
        }, !!anchor)}
      </span>
      {anchor && (
        <Popover anchor={anchor} onClose={close} align={props.align} side={props.side} width={props.width} className={props.className}>
          {props.children(close)}
        </Popover>
      )}
    </>
  );
}

// ---------------------------------------------------------------- menu

export function MenuItem(props: {
  icon?: ReactNode;
  label: ReactNode;
  hint?: ReactNode;
  onClick?: (e: React.MouseEvent) => void;
  danger?: boolean;
  checked?: boolean;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={"menu-item" + (props.danger ? " danger" : "") + (props.active ? " active" : "")}
      onClick={props.onClick}
      disabled={props.disabled}
    >
      {props.icon !== undefined && <span className="menu-icon">{props.icon}</span>}
      <span className="menu-label">{props.label}</span>
      {props.hint && <span className="menu-hint">{props.hint}</span>}
      {props.checked && <Check size={14} />}
    </button>
  );
}
export const MenuSep = () => <div className="menu-sep" />;
export const MenuLabel = ({ children }: { children: ReactNode }) => <div className="menu-heading">{children}</div>;

export function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className={"toggle" + (on ? " on" : "")}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!on);
      }}
    >
      <span />
    </button>
  );
}

// ---------------------------------------------------------------- modal

export function Modal(props: { onClose: () => void; children: ReactNode; className?: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });
  return createPortal(
    <div className="modal-backdrop" onMouseDown={props.onClose}>
      <div className={"modal " + (props.className ?? "")} onMouseDown={(e) => e.stopPropagation()}>
        {props.children}
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------- avatar

export function Avatar({ user, size = 24 }: { user: Pick<User, "name" | "color" | "avatar">; size?: number }) {
  const [broken, setBroken] = useState(false);
  if (user.avatar && !broken) {
    return (
      <img
        className="avatar"
        src={user.avatar}
        alt=""
        title={user.name}
        referrerPolicy="no-referrer"
        style={{ width: size, height: size }}
        onError={() => setBroken(true)}
      />
    );
  }
  return (
    <span
      className="avatar"
      title={user.name}
      style={{ width: size, height: size, background: user.color, fontSize: Math.round(size * 0.46) }}
    >
      {(user.name.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}

// ---------------------------------------------------------------- emoji picker

const EMOJI: [string, string][] = [
  ["Smileys", "😀 😃 😄 😁 😆 🥹 😅 😂 🙂 😉 😊 😇 🥰 😍 🤩 😘 😋 😛 😜 🤪 🤗 🤔 🫡 🤫 😐 😑 😶 🙄 😏 😴 🤤 😷 🤒 🤕 🥳 🥸 😎 🤓 🧐 😕 😮 😳 🥺 😢 😭 😱 😤 😡 🤯 👻 💀 👽 🤖 🎃"],
  ["People", "👋 🤚 ✋ 👌 🤌 ✌️ 🤞 🤟 🤘 👈 👉 👆 👇 👍 👎 ✊ 👊 👏 🙌 🤝 🙏 ✍️ 💪 🧠 👀 👁️ 👤 👥 🧑‍💻 🧑‍🎨 🧑‍🔬 🧑‍🏫 🧑‍🍳 🧑‍🚀 🕵️ 🦸 🧙"],
  ["Nature", "🐶 🐱 🐭 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🐔 🐧 🐦 🦉 🦄 🐝 🦋 🐢 🐙 🐬 🐳 🌵 🌲 🌳 🌴 🌱 🌿 🍀 🍁 🍄 🌷 🌹 🌻 🌼 🌙 ⭐ 🌟 ✨ ⚡ 🔥 🌈 ☀️ ☁️ ❄️ 💧 🌊"],
  ["Food", "🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍒 🍑 🥭 🍍 🥥 🥑 🍅 🥕 🌽 🥐 🍞 🧀 🍳 🥞 🍔 🍟 🍕 🌮 🍜 🍣 🍱 🍪 🎂 🍰 🍫 🍿 ☕ 🍵 🧃 🍺 🍷 🥂"],
  ["Activity", "⚽ 🏀 🏈 ⚾ 🎾 🏐 🎱 🏓 🏸 🥊 🏆 🥇 🎯 🎮 🎲 🧩 ♟️ 🎨 🎬 🎤 🎧 🎹 🥁 🎸 🎻 🎭 🏃 🚴 🧘 🏕️ 🎪"],
  ["Travel", "🚗 🚕 🚌 🚎 🚓 🚑 🚒 🚚 🚲 🛴 ✈️ 🚀 🛸 🚁 ⛵ 🚢 🏠 🏡 🏢 🏥 🏦 🏫 🏛️ ⛪ 🗽 🗼 🏰 🌋 🏔️ 🏖️ 🏝️ 🗺️ 🧭 🌍 🌎 🌏"],
  ["Objects", "⌚ 📱 💻 ⌨️ 🖥️ 🖨️ 📷 🎥 📺 💡 🔦 🔋 🔌 💰 💳 💎 🔧 🔨 ⚙️ 🧲 🧪 🔬 🔭 💊 🧹 🔑 🗝️ 📦 ✉️ 📫 📝 📁 📂 📅 📆 📇 📈 📉 📊 📋 📌 📍 📎 📏 ✂️ 🗑️ 🔒 🔓 📚 📖 🔖 🏷️ 🧾 🗒️ 📓 📔 📕 📗 📘 📙 🎁 🎈 🎉"],
  ["Symbols", "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 💔 💯 ✅ ☑️ ✔️ ❌ ⭕ ❗ ❓ ⚠️ 🚫 ♻️ 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ 🟥 🟧 🟨 🟩 🟦 🟪 ▶️ ⏸️ ⏹️ 🔁 🔔 🔕 💬 💭 🗯️ 🏁 🚩 🎌 🏳️ #️⃣ ℹ️ 🆕 🆗 🔝"],
];

export function EmojiPicker({ onPick, onRemove }: { onPick: (emoji: string) => void; onRemove?: () => void }) {
  return (
    <div className="emoji-picker">
      <div className="emoji-head">
        <span>Icon</span>
        <span style={{ flex: 1 }} />
        <button
          className="btn-ghost small"
          onClick={() => {
            const all = EMOJI.flatMap(([, s]) => s.split(" "));
            onPick(all[Math.floor(Math.random() * all.length)]);
          }}
        >
          Random
        </button>
        {onRemove && (
          <button className="btn-ghost small" onClick={onRemove}>
            Remove
          </button>
        )}
      </div>
      <div className="emoji-scroll">
        {EMOJI.map(([name, list]) => (
          <div key={name}>
            <div className="menu-heading">{name}</div>
            <div className="emoji-grid">
              {list.split(" ").map((e) => (
                <button key={e} onClick={() => onPick(e)}>
                  {e}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- media query

export function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return match;
}

// ---------------------------------------------------------------- toasts

interface ToastItem {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
  leaving?: boolean;
}
let toasts: ToastItem[] = [];
let toastSeq = 0;
const toastListeners = new Set<() => void>();
const setToasts = (next: ToastItem[]) => {
  toasts = next;
  toastListeners.forEach((l) => l());
};
/** Toasts fade down and out (faster than they came in), then leave the list. */
const dismissToast = (id: number) => {
  if (!toasts.some((t) => t.id === id && !t.leaving)) return;
  setToasts(toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
  setTimeout(() => setToasts(toasts.filter((t) => t.id !== id)), 150);
};

/** A short confirmation at the bottom of the screen, optionally with one action such as Undo. */
export function toast(text: string, action?: ToastItem["action"]) {
  const id = ++toastSeq;
  setToasts([...toasts.slice(-2), { id, text, action }]);
  setTimeout(() => dismissToast(id), action ? 6000 : 3000);
}

export function Toaster() {
  const list = useSyncExternalStore(
    (l) => (toastListeners.add(l), () => void toastListeners.delete(l)),
    () => toasts,
  );
  return createPortal(
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={"toast" + (t.leaving ? " leaving" : "")}>
          <span>{t.text}</span>
          {t.action && (
            <button
              className="toast-action"
              onClick={() => {
                t.action!.run();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------- tooltips

/**
 * One styled tooltip for every control that has a `title`, instead of the browser's slow grey box. A trailing
 * "(Ctrl+K)" in a title is shown as a shortcut hint. The editor's own toolbar keeps its tooltips.
 */
export function TooltipLayer() {
  const [tip, setTip] = useState<{ text: string; keys: string | null; x: number; y: number; above: boolean } | null>(null);
  useEffect(() => {
    let el: HTMLElement | null = null;
    let timer = 0;
    let shown = false;
    let lastHidden = 0;
    const restore = () => {
      clearTimeout(timer);
      if (el) {
        const saved = el.dataset.tip;
        if (saved !== undefined && !el.hasAttribute("title")) el.setAttribute("title", saved);
        delete el.dataset.tip;
        el = null;
      }
      if (shown) {
        shown = false;
        lastHidden = Date.now();
        setTip(null);
      }
    };
    const show = (target: HTMLElement) => {
      if (!target.isConnected || el !== target) return;
      shown = true;
      const text = target.dataset.tip ?? "";
      const r = target.getBoundingClientRect();
      const m = /^(.*?)\s*\(((?:Ctrl|Cmd|Shift|Alt|Esc)[^)]*)\)$/.exec(text);
      const above = r.bottom + 40 > innerHeight;
      setTip({
        text: m ? m[1] : text,
        keys: m ? m[2] : null,
        x: Math.max(70, Math.min(innerWidth - 70, r.left + r.width / 2)),
        y: above ? r.top - 6 : r.bottom + 6,
        above,
      });
    };
    const over = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const t = (e.target as Element).closest?.("[title], [data-tip]") as HTMLElement | null;
      if (t === el) return;
      restore();
      if (!t || t.closest(".bn-container, .tooltip")) return;
      const title = t.getAttribute("title");
      if (title) {
        t.dataset.tip = title;
        t.removeAttribute("title");
        // The title was the accessible name of icon-only buttons; keep it as one.
        if (!t.hasAttribute("aria-label") && !t.textContent?.trim()) t.setAttribute("aria-label", title);
      }
      if (!t.dataset.tip) return;
      el = t;
      // Moving from one control straight to the next shows the next tooltip at once, as in Notion.
      timer = window.setTimeout(() => show(t), Date.now() - lastHidden < 400 ? 0 : 520);
    };
    const hide = () => restore();
    document.addEventListener("pointerover", over, true);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("keydown", hide, true);
    document.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);
    return () => {
      restore();
      document.removeEventListener("pointerover", over, true);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("keydown", hide, true);
      document.removeEventListener("scroll", hide, true);
      window.removeEventListener("blur", hide);
    };
  }, []);
  if (!tip) return null;
  return createPortal(
    <div
      className="tooltip"
      role="tooltip"
      style={{ left: tip.x, top: tip.y, transform: `translate(-50%, ${tip.above ? "-100%" : "0"})` }}
    >
      <span>{tip.text}</span>
      {tip.keys && <kbd>{tip.keys}</kbd>}
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------- misc

export function relTime(ts?: number): string {
  if (!ts) return "";
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function coverStyle(cover?: string): CSSProperties {
  if (!cover) return {};
  if (COVERS[cover]) return { background: COVERS[cover] };
  return { backgroundImage: `url("${cover.replace(/["\\\n]/g, "")}")`, backgroundSize: "cover", backgroundPosition: "center" };
}

export async function uploadFile(file: File): Promise<string> {
  const res = await fetch(`/api/upload?ws=${WS_ID}&name=${encodeURIComponent(file.name)}`, { method: "POST", body: file });
  if (!res.ok) throw new Error(res.status === 413 ? "File is too large (25 MB max)" : "Upload failed");
  return (await res.json()).url;
}
