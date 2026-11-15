---
name: Sandpiper
description: A shared notebook — warm paper, dark ink, and one brick pen.
colors:
  brick-ink: "#c2441d"
  brick-ink-night: "#f0825c"
  brick-wash: "rgba(194, 68, 29, 0.13)"
  page-white: "#ffffff"
  notebook-paper: "#f6f5f2"
  notebook-paper-soft: "#f4f3f0"
  ink: "#24221e"
  pencil: "#625e57"
  faded-pencil: "#757067"
  rule-line: "#e7e4de"
  rule-line-strong: "#d6d2ca"
  hover-wash: "rgba(40, 36, 28, 0.06)"
  pressed-wash: "rgba(40, 36, 28, 0.1)"
  danger-red: "#a61e3a"
  danger-red-night: "#ff8fa3"
  note-yellow: "#fff4d6"
  note-yellow-ink: "#8a5a00"
  night-page: "#1b1b1d"
  night-sidebar: "#222225"
  night-raised: "#2a2a2e"
  night-ink: "#e9e7e3"
  night-pencil: "#b3b0a9"
  night-faded-pencil: "#96938c"
  tooltip-ink: "#2b2925"
  night-tooltip: "#3b3b40"
  night-rule-line: "#323236"
typography:
  display:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "40px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "24px"
    fontWeight: 700
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 700
  display-compact:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "30px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  body-large:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 500
  body:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.45
  body-small:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
  emoji-small:
    fontSize: "20px"
    lineHeight: 1.3
  emoji-medium:
    fontSize: "38px"
  emoji-large:
    fontSize: "68px"
    lineHeight: 1.1
  label:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "11.5px"
    fontWeight: 600
  caption:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 400
rounded:
  xs: "5px"
  sm: "6px"
  control: "8px"
  surface: "12px"
  sheet: "16px"
  pill: "20px"
spacing:
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "12px"
  xl: "16px"
  page-gutter: "64px"
components:
  button-primary:
    backgroundColor: "{colors.brick-ink}"
    textColor: "{colors.page-white}"
    rounded: "{rounded.control}"
    padding: "6px 12px"
  button-ghost:
    textColor: "{colors.pencil}"
    rounded: "{rounded.control}"
    padding: "5px 8px"
  button-ghost-hover:
    backgroundColor: "{colors.hover-wash}"
    textColor: "{colors.ink}"
  button-sign-in-google:
    backgroundColor: "{colors.page-white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    height: "44px"
  button-sign-in-passkey:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.page-white}"
    rounded: "{rounded.control}"
    height: "44px"
  icon-button:
    textColor: "{colors.pencil}"
    rounded: "{rounded.control}"
    size: "28px"
  input:
    backgroundColor: "{colors.page-white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "5px 8px"
  menu-item:
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "5px 8px"
  sidebar-row:
    textColor: "{colors.pencil}"
    rounded: "{rounded.sm}"
    height: "30px"
  sidebar-row-active:
    backgroundColor: "{colors.pressed-wash}"
    textColor: "{colors.ink}"
  popover:
    backgroundColor: "{colors.page-white}"
    rounded: "{rounded.surface}"
  board-card:
    backgroundColor: "{colors.page-white}"
    rounded: "{rounded.control}"
    padding: "8px 10px"
  tag:
    rounded: "{rounded.xs}"
    padding: "1px 7px"
  badge:
    backgroundColor: "{colors.hover-wash}"
    textColor: "{colors.pencil}"
    rounded: "{rounded.pill}"
    padding: "1px 7px"
---

# Design System: Sandpiper

## Overview

**Creative North Star: "The Shared Notebook"**

Sandpiper is a notebook that a few people pass back and forth: one person, a household, a small team. The pages are warm, slightly creamy paper; the writing is dark brown-black ink; and there is exactly one coloured pen, a brick orange, that everyone reaches for when something needs marking. Everything that isn't writing recedes: chrome is drawn in pencil greys, rules are faint, and nothing shouts. The feel is calm and personal: a place you own, not an office.

Density follows a notebook too: compact and calm. Text sits at 14px, rows are 30px tall, and controls appear on hover rather than crowding the page. Pages get a generous reading column; databases are allowed to run full width because they are tables, not prose. Colour inside the content (select-option tags, covers, emoji icons) belongs to what people wrote. The interface itself stays in paper, ink and brick.

There is a full night version of the notebook: the paper becomes a soft charcoal, the ink becomes warm off-white, and the brick pen lightens so it still reads clearly. People pick System, Light or Dark in Settings; System is the default.

**Key Characteristics:**
- Warm paper neutrals with a faint yellow-brown cast, never cold blue-greys.
- One accent, Brick Ink, used sparingly for the primary action, focus, selection and "now".
- Flat pages; only things that float (menus, dialogs, the sign-in card) cast a shadow.
- Gently rounded, nested corners: containers rounder than the controls inside them.
- A single typeface, Inter, with weight doing the work of hierarchy.

## Colors

Paper, ink and one brick pen, with a true red kept strictly for destruction.

### Primary
- **Brick Ink** (#c2441d): the one pen. Primary buttons, focus rings, toggles that are on, the "today" circle in calendars, the active formatting button, a favourited page's star, checked checkboxes, the text caret, and drop targets while dragging. White text on it is 5.1:1. It is the brand's Brick (#e4572e) deepened so small text on it passes contrast.
- **Brick Ink, night** (#f0825c): the same pen lightened for the dark theme; text on it is dark ink (#1f0d06).
- **Brick Wash** (13% Brick Ink): text selection, focus-ring halos, and the "drop here" highlight in the page tree.

### Neutral
- **Page White** (#ffffff): the page itself, popovers, cards and inputs in the light theme.
- **Notebook Paper** (#f6f5f2): the sidebar, the sign-in backdrop, and anywhere the frame sits behind the page.
- **Notebook Paper, soft** (#f4f3f0): callouts, board columns, hovered table rows: a fill one shade warmer than the page.
- **Ink** (#24221e): all primary text and headings.
- **Pencil** (#625e57): secondary text, idle icons, sidebar rows, ghost buttons. 6.2:1 on the page.
- **Faded Pencil** (#757067): placeholders, empty states, section labels, kbd hints and the drawn glyph of a page with no emoji. It holds 4.5:1 on both the page and the sidebar; it was lifted from a 2.5:1 grey so no text in the notebook is hard to read.
- **Rule Line** (#e7e4de) and **Rule Line, strong** (#d6d2ca): dividers, table grid and card outlines; the strong rule is for input borders and checkboxes.
- **Hover Wash** (6% ink) and **Pressed Wash** (10% ink): every hover and selected state on neutral controls. They are translucent so they work on paper, page and soft fills alike.
- **Night Page** (#1b1b1d), **Night Sidebar** (#222225), **Night Raised** (#2a2a2e), **Night Ink** (#e9e7e3), **Night Pencil** (#b3b0a9), **Night Faded Pencil** (#96938c), **Night Rule Line** (#323236): the dark theme's equivalents, in the same roles.

### Semantic
- **Danger Red** (#a61e3a; night #ff8fa3): a crimson, kept well clear of Brick Ink. Delete actions on hover, error messages and the "this page is in Trash" banner. Text on the banner uses a dedicated danger-text colour, white by day and near-black by night, so it always passes contrast.
- **Note Yellow** (#fff4d6 with #8a5a00 text): the offline chip and other gentle warnings.

### Content colours
- **Tag Inks**: nine paired fills for database select options (gray, brown, orange, yellow, green, blue, purple, pink, red), each with its own dark-theme pair. They label content and are chosen by the people writing; chrome never uses them.
- **Cover swatches**: nine soft gradients and six flat tints people can pick as page covers (defined in `src/content-palette.ts`), alongside uploaded or linked images.
- **People Colours**: ten saturated colours (#3b5bdb, #0c8599, #7048e8, #c2255c, #e8590c, #5f3dc4, #1971c2, #a61e4d, #d9480f, #087f5b) for avatars and live cursors. Each account picks its own in Settings. They identify a person and are never used as interface accents.

### Named Rules
**The One Pen Rule.** Brick Ink is the only chromatic colour in the interface. On any screen it marks one primary action, the focus, the selection and "now", and nothing else. If two things on a screen are brick, one of them is wrong.

**The Red Means Gone Rule.** Danger Red appears only where something is deleted, fails, or is in the Trash. Brick is never used for destruction, and red is never used for emphasis.

**The Content Keeps Its Colours Rule.** Tag Inks and People Colours belong to what people wrote and who wrote it. Interface chrome stays paper, ink and brick.

## Typography

**Display Font:** Inter (with ui-sans-serif, system-ui, Segoe UI, Roboto fallbacks)
**Body Font:** Inter
**Label/Mono Font:** the system monospace stack (SF Mono, Cascadia Code, Consolas), for code only

**Character:** One humanist sans throughout, set tight and confident for titles and plain for reading. Hierarchy comes from weight (400 / 500 / 600 / 700) and size, not from extra faces. Each page can switch its own reading font to a book serif (Iowan Old Style, Palatino) or mono; that is the person's choice per page, not a system style.

### Hierarchy
- **Display** (700, 40px, line-height 1.2, -0.02em): page titles. **Display, compact** (30px) replaces it on phones.
- **Headline** (700, 24px, -0.02em): the sign-in card title, the font-picker specimens, and other single headline moments.
- **Title** (700, 18px): inline database titles and panel-level headings; the search field also writes at 18px (400).
- **Body, large** (500, 15px): full-width buttons (sign-in, big primary) and the sidebar's emoji icons.
- **Body** (400, 14px, line-height 1.45): all interface text and page writing. Editor headings follow the editor's own scale above this.
- **Body, small** (400, 13px): small buttons, inline error messages and starter chips.
- **Emoji** (20px / 38px / 68px): page icons are emoji, sized as type: 20px inline (callouts, the emoji picker), 38px on gallery covers, 68px as the page icon above a title.
- **Label** (600, 11.5px): sidebar section names and menu group headings, in Faded Pencil. Settings section headings use 12px, 600, uppercase with 0.04em tracking.
- **Caption** (400, 12–12.5px): metadata such as "Added Nov 13 · last used 2h ago", counts, and table footers, in Pencil.

### Named Rules
**The One Family Rule.** Everything is Inter. Mono is for code; serif is only a per-page reading choice. Never introduce a display face for flavour.

**The Weight, Not Size Rule.** Interface emphasis steps up in weight first (400 → 500 → 600) and only uses size for page and panel titles.

## Layout

A fixed sidebar on the left (264px by default, drag-resizable from 200 to 480px, collapsible with Ctrl/Cmd+\), a 46px top bar with breadcrumbs, and a scrolling page. Pages read in a centred column of 820px with 64px side gutters; full-width pages and databases widen to the window with 72px gutters. Covers run edge to edge at 200px tall. A side peek for database rows slides in on the right at up to 680px.

The spacing rhythm is small and steady: 4, 6 and 8px inside controls and lists, 10–12px between related groups, 16px and up between sections. Rows are 28–30px tall. Hover reveals per-row actions instead of showing them all the time.

Below 760px the sidebar floats over the page, gutters shrink to 20px, the page title drops to 30px, and the side peek becomes full screen. Below 900px the "Edited …" timestamp in the top bar hides.

## Elevation & Depth

The notebook is flat. Pages, sidebar, table cells and board columns sit on the same plane, separated by fills (Page White against Notebook Paper) and hairline rules. Depth appears only for things that genuinely float above the page: menus, popovers, dialogs, the side peek and the sign-in card. Board and gallery cards use a 1px outline ring plus a barely-there 1–2px drop, so they read as paper slips rather than raised tiles.

### Shadow Vocabulary
- **Float** (`box-shadow: 0 0 0 1px rgba(20,18,14,0.06), 0 6px 22px rgba(20,18,14,0.12), 0 2px 6px rgba(20,18,14,0.06)`): every floating layer. At night: `0 0 0 1px rgba(255,255,255,0.08), 0 8px 28px rgba(0,0,0,0.5)`.
- **Paper slip** (`box-shadow: 0 0 0 1px <rule line>, 0 1px 2px rgba(0,0,0,0.05)`): board cards, gallery cards and calendar items.
- **Slip of ink** (`0 4px 14px rgba(0,0,0,0.18)` for tooltips, `0 8px 24px rgba(0,0,0,0.22)` for toasts): the small dark feedback slips.

### Named Rules
**The Paper Stays Flat Rule.** Nothing that lives on the page casts a shadow. If it floats, it gets Float; if it is a slip of content, it gets a ring; otherwise it is flat.

## Shapes

Gently curved, nested corners. Corners are always softer on the outside than on the inside, so a menu (12px) holds items (6px), a board column (12px) holds cards (8px), and a dialog (12px) holds inputs (8px). Full circles are reserved for avatars, the "today" marker and colour swatches; pills (20px) for badges, chips and toggles.

### Named Rules
**The Nested Corners Rule.** Use the scale: xs 5px (tags, mentions, tiny icon buttons) → sm 6px (rows, menu items) → control 8px (buttons, inputs, tabs, cards) → surface 12px (menus, panels, dialogs, containers) → sheet 16px (the sign-in card). An inner element never has a larger radius than its container.

## Components

### Buttons
Quiet until needed; one brick button per view at most.
- **Shape:** gently rounded (8px).
- **Primary:** Brick Ink with white text, 500 weight, 6px × 12px padding (3px × 8px for the small size). Hover brightens slightly.
- **Ghost:** no fill, Pencil text, 5px × 8px; hover fills with Hover Wash and darkens to Ink. An "on" ghost (an active filter or sort) turns its text Brick Ink.
- **Icon button:** 28px square (22px for row-level actions), Pencil icon, Hover Wash on hover.
- **Focus:** a 2px Brick Ink outline with 1px offset on every button.
- **Sign-in buttons:** 44px tall, full width. Google is outlined on Page White with the Google mark; passkey is solid Ink with Page White text.

### Chips, tags and badges
- **Tags:** select options in their Tag Ink pair, 12.5px text, 5px corners, 1px × 7px padding; a small × appears when removable.
- **Badges:** "Owner", "This device": 11px, 600 weight, Pencil on Hover Wash, pill-shaped.
- **Chips:** status chips in the top bar ("Locked", "Offline"), pill-shaped; Offline uses Note Yellow.

### Cards / Containers
- **Board cards:** Page White (Night Raised at night), 8px corners, paper-slip ring, 8px × 10px padding, title in 500 weight with properties in Pencil captions below.
- **Board columns, callouts:** Notebook Paper soft fill, 12px corners, no border.
- **Inline databases:** a 1px Rule Line outline with 12px corners, holding the database as if pasted into the page.

### Inputs / Fields
- **Style:** Page White fill, 1px Rule Line strong border, 8px corners, 5px × 8px padding.
- **Focus:** the border turns Brick Ink with a 3px Brick Wash halo.
- **Inline editors:** table cells and titles edit in place; a cell editor floats over its cell with a 2px Brick Ink ring.

### Navigation
- **Sidebar:** Notebook Paper. Rows are 30px tall, 6px corners, Pencil text at 500 weight. Hover shows Hover Wash; the current page uses Pressed Wash with Ink text. A chevron, emoji icon and title lead each row; "…" and "+" appear on hover. A coloured dot shows who else is on a page. A page with no emoji gets a drawn page glyph (a table glyph for databases) in Faded Pencil, never a stand-in emoji. On phones the sidebar starts closed, floats over a soft backdrop, and closes once a page is picked or the backdrop is tapped.
- **Top bar:** breadcrumbs with icons, then presence avatars, Share, comments, favourite and the page menu at the right. The breadcrumbs fold to the room the bar has: wide keeps the first page and the last two, medium the first page and the current one, a phone only the current one. The rest go into a "…" menu that shows them as a stepped path. When space runs short, the pages above give up their room before the current page's title does.
- **Nesting depth:** pages nest up to 8 levels. Asking for a page inside one at the limit never dead-ends: it goes next to that page, with a toast saying why, and the slash menu says so before you pick it. "Move to" keeps destinations that would go too deep in the list, greyed, with "Too deep". Database rows don't count, so a database can always take more rows. Pages already deeper than the limit stay put and readable; sidebar indentation eases off after six levels so their titles keep their room. Going to a page opens the path to it in the sidebar.
- **Database view tabs:** ghost-style tabs; the active tab gets Pressed Wash and Ink text.
- **Settings:** a two-pane dialog. The left column groups pages under Your account (Profile, Sign-in & devices, AI & apps, Appearance), Workspace (with the workspace's icon and name) and App (owner only); each page has its title and one plain sentence beneath it, never a label above it.

### Feedback
- **Tooltips:** every control with a title gets one styled tooltip (Tooltip Ink by day, Night Tooltip by night, 12px 500 text, 6px corners) after about half a second, and instantly when moving from one control to the next. A shortcut in the title ("Close sidebar (Ctrl+\)") is shown as a quieter hint. The editor's own toolbar keeps its tooltips.
- **Toasts:** a short dark slip at the bottom centre confirms actions that leave no other trace (link copied, duplicated) and offers Undo for anything moved to the Trash. Undo is written in a light brick so it reads on the dark slip; toasts with an action stay 6 seconds, others 3.
- **Comments panel:** Open and Resolved tabs, as in Notion. When a tab has nothing in it, the panel says so and tells you how to start a thread.
- **Search:** where the query appears in a title or snippet it is set in 650 weight with a Brick Ink underline.

### Motion
Motion only explains a change, and it stays small: short distances, no bounce, every entrance on an exponential ease-out (`cubic-bezier(0.16, 1, 0.3, 1)`), and every exit faster than its entrance. Nothing makes you wait, and nothing animates just because it is on screen.
- **Hover washes** come on in 40ms and fade off over 160ms, so pointing feels instant and moving on feels soft. Inputs ease their Brick Ink border and halo in over 140ms.
- **Floating layers** settle: menus and popovers ease in 3px over 160ms, dialogs rise 8px and fade over 220ms, the backdrop fades over 160ms, toasts rise 10px over 260ms and fade down 6px over 150ms when they go.
- **Panels come in from their own side:** the side peek over 260ms and the comments panel over 220ms from the right (16px); the sidebar from the left (8px) when it is reopened, never on first load. On a phone the sidebar slides in from the screen edge like a drawer.
- **Things that change in place fade in** over 180ms: a page when you open it, a database view when you switch to it, a Settings page when you pick it. The editor, a newly added cover, status chips and banners fade over 220ms.
- **New things ink in:** a page or row made a moment ago, by you or anyone else, fades down 3px into place over 220ms in the tree, tables, boards, lists, galleries and calendars. A section opened in the tree drops in the same way.
- **Someone arriving** on a page: their avatar in the top bar and their dot in the tree settle in from 60% over 360ms.
- **Checkboxes** draw their tick as a pen stroke (260ms) and take it back out faster (110ms).
- **The sign-in moment** is the one authored sequence: the page settles and its beak pokes out of the folded corner as the card appears. The card and buttons are there from the first frame.

With reduced motion on, nothing travels or grows: every movement above becomes a short fade alone, toggles and chevrons switch without sliding, and the loading spinner slows down.

### Logo (signature)
The Sandpiper mark is a page whose folded corner is a sandpiper's beak, with an eye and two lines of text cut out of the page. The page is Ink (#16161a) by day and Warm White (#f4f2ee) at night; the beak is Brick (#e4572e), always. It stands bare above the "Sandpiper" wordmark on the sign-in card and in the sidebar, and on an Ink tile as the app icon. Below 32px it uses the small cut (bigger eye, one line of text). It never sits on an orange fill. Files, clear space and colour rules live in `brand/`; the app's `Logo.tsx` draws the same mark.

### Sign-in card (signature)
A single 380px card on Notebook Paper: the mark, the "Sandpiper" wordmark, one line of welcome, the two sign-in buttons, and a short note in Faded Pencil. Errors appear inside the card as a Danger Red line on a 9% red wash.

### Connecting an AI app
- **Approval page** (`/connect`): the sign-in card's layout and backdrop, 420px wide: the mark, "Connect Claude?", one plain sentence on what the app will be able to do as you (it changes with the choice below), two segmented choices (What it can do: Read and edit / Read only; Workspaces: All of mine / Only some, which opens a list of workspaces with toggles), then Cancel (ghost) and Allow (the one Brick Ink button). A Faded Pencil note says where you'll be sent back and that you can disconnect in Settings. If you aren't signed in, the sign-in card comes first and returns here.
- **Settings → AI & apps**: the server address in a read-only field with a copy button, three short steps (Claude, Claude Code, other apps), then Connected (each app or token as a row: robot or key icon, its name, a "Token" badge for tokens, and a caption like "Read and edit · all workspaces · connected Nov 14 · used 2m ago", with a Disconnect ghost button) and Access tokens. A new token is shown once, in mono, on a soft fill, with its copy button.

### Passkey list (signature)
Each passkey is a row with a key icon, its name, and a caption ("Added … · last used … · synced across your devices"), plus pencil (rename) and bin (remove) buttons. Adding a passkey immediately opens the name field with the device name selected, so typing replaces it.

## Do's and Don'ts

### Do:
- **Do** keep chrome in paper, ink and pencil, and spend Brick Ink (#c2441d) only on the primary action, focus, selection and "now".
- **Do** use Hover Wash (6% ink) and Pressed Wash (10% ink) for every neutral hover and selected state, so states work on any fill.
- **Do** nest corners from the scale (12px container → 8px control → 6px row → 5px tag).
- **Do** give a state change visible text as well as colour: "This device", "Owner", "Hasn't signed in yet".
- **Do** theme native browser surfaces from the palette: selection is Brick Wash, and checkboxes and the caret are Brick Ink.
- **Do** check both themes: every token has a night pair and must hold 4.5:1 for text.

### Don't:
- **Don't** use brick for anything destructive, or red for emphasis (The Red Means Gone Rule).
- **Don't** put a second accent colour in the interface; Tag Inks and People Colours are content, not chrome.
- **Don't** cast shadows from things that sit on the page; only floating layers get the Float shadow.
- **Don't** introduce another typeface for headings or labels.
- **Don't** use cold blue-grey neutrals; the paper is warm.
