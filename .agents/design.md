# Design

## Overview

The repository has two designed surfaces.

- The local web app is a `product-ui` surface.
- The terminal CLI is a `developer-ui` surface.

The web source is `src/web-app-html-parts.ts`.
The CLI sources are `src/cli.ts`, `src/cli-helpers.ts`, and the command modules.

Both surfaces prioritize clear state, trust signals, and compact actions.
Do not apply web-only visual tokens to terminal output.

## Colors

The web app uses CSS properties in `src/web-app-html-parts.ts`.

| Role | Token | Value |
|---|---|---|
| Canvas | `--bg` | `#0f1419` |
| Card start | `--bg-card` | `#1a2330` |
| Card end | `--bg-card-2` | `#1f2938` |
| Primary text | `--fg` | `#e8eef6` |
| Secondary text | `--muted` | `#9aadc2` |
| Primary action | `--accent` | `#5ec8ff` |
| Verified or success | `--mint` | `#7fe3c0` |
| Warning | `--amber` | `#ffb15e` |
| Error or unread | `--coral` | `#ff7a68` |
| Destructive action | `--danger` | `#ff6b6f` |

Use semantic properties instead of repeating raw values.
Keep text contrast readable against every dark surface.

The CLI inherits terminal colors. It adds no ANSI palette.
Status meaning comes from labels and marks, not color alone.

## Typography

The web app uses the system sans-serif stack for interface text.
It uses `ui-monospace`, `SFMono-Regular`, `Menlo`, and `Consolas` for identifiers.

The wordmark is `1.2rem`, weight `800`, with `-0.02em` tracking.
The hero uses `clamp(1.5rem, 3vw, 2.2rem)` and weight `800`.
Body and post text use a `1.5` line height.

The CLI inherits the terminal font.
Indent command output by two spaces and separate metadata with ` · `.

## Layout

The web shell has a `1280px` maximum width and `22px` side padding.
The main stage uses three columns with a `20px` gap.
At `1020px`, the stage becomes one column with a `640px` maximum width.
At `480px`, side padding becomes `16px` and the top bar wraps.

Keep the profile and follows left, the feed center, and peers and DMs right.
The CLI uses sequential blocks with blank lines between separate results.

## Elevation & Depth

Web cards use `--shadow-2`, a one-pixel border, and a dark vertical gradient.
The sticky top bar uses blur, saturation, and `z-index: 40`.
Active tabs use `--shadow-1`.

Terminal depth is not applicable.
Use blank lines and indentation for terminal hierarchy.

## Shapes

The web radius token is `16px` for cards.
Buttons use `11px`; fields and tab groups use `10px`.
Small buttons and tabs use `8px`.
Chips, badges, and counts use `999px` pill radii.
Avatars and presence dots are circular.

Terminal output uses `✓`, `~`, `🔑`, `•`, and `·` as status marks.
Always pair a mark with explanatory text or a visible legend.

## Components

The local web app contains these recurring components:

- `.card` groups a single task or data region.
- `.btn-primary`, `.btn-ghost`, and `.btn-danger` express action priority.
- `.field` supplies a shared input treatment and focus border.
- `.chip` shows profile and verification metadata.
- `.post` shows authorship, age, and signed post text.
- `.dm-msg` distinguishes incoming, outgoing, and system messages.

Use the global `:focus-visible` outline for keyboard focus.
Keep native labels and status roles in `src/web-app-html-parts.ts`.
Honor `prefers-reduced-motion` for all transitions and animations.
Render peer-controlled content as text, never HTML.

CLI command blocks must preserve the established status legend.
Errors go to standard error. Results and progress go to standard output.

## Do's and Don'ts

- Do reuse semantic CSS properties. Do not create a second palette.
- Do preserve keyboard focus. Do not remove the mint focus outline.
- Do keep status text beside marks. Do not depend on color or icons alone.
- Do sanitize peer text. Do not render peer content as markup.
- Do preserve responsive breakpoints. Do not force three columns on narrow screens.
- Do respect reduced motion. Do not add unguarded entrance animation.
- Do keep CLI output plain. Do not add ANSI colors without a new design decision.
- Do explain unverified data. Do not present self-reported data as verified.
