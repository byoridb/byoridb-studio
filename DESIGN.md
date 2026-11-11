---
name: Byori Studio
description: A compact desktop editing workspace with creative memory and CLI agents.
colors:
  bg: "#111214"
  panel: "#1c1e21"
  panel-raised: "#25272b"
  border: "#34373c"
  text: "#f0f2f5"
  muted: "#a7adb7"
  accent: "#37d7cb"
  control-bg: "#292c31"
  control-border: "#41464f"
  control-hover: "#34383f"
  action-fill: "#45cfc1"
  action-ink: "#102f2b"
  action-hover: "#70e1d4"
  secondary-fill: "#303a47"
  secondary-ink: "#d0dceb"
  video-track: "#24505a"
  image-track: "#345764"
  audio-track: "#294736"
  text-track: "#71572f"
typography:
  title:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans KR", sans-serif'
    fontSize: "17px"
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: "-0.3px"
  section:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans KR", sans-serif'
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.5
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans KR", sans-serif'
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  panel:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans KR", sans-serif'
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans KR", sans-serif'
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.5
  supporting:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans KR", sans-serif'
    fontSize: "10px"
    fontWeight: 400
rounded:
  badge: "3px"
  control: "4px"
  inset: "5px"
  panel: "6px"
  dialog: "8px"
spacing:
  tight: "4px"
  control: "6px"
  compact: "8px"
  row: "10px"
  inset: "12px"
  field: "14px"
  group: "16px"
components:
  button-primary:
    backgroundColor: "{colors.action-fill}"
    textColor: "{colors.action-ink}"
    rounded: "{rounded.control}"
    padding: "7px 13px"
  button-primary-hover:
    backgroundColor: "{colors.action-hover}"
  button-secondary:
    backgroundColor: "{colors.secondary-fill}"
    textColor: "{colors.secondary-ink}"
    rounded: "{rounded.control}"
    padding: "7px 13px"
  button-export:
    backgroundColor: "{colors.accent}"
    textColor: "#0c302d"
    rounded: "{rounded.control}"
    height: "30px"
    padding: "0 13px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "#bdc5d0"
    rounded: "{rounded.control}"
    width: "30px"
    height: "30px"
  input:
    backgroundColor: "{colors.control-bg}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "7px 9px"
  navigation:
    textColor: "{colors.muted}"
    typography: "{typography.supporting}"
    padding: "4px 5px"
  navigation-active:
    textColor: "{colors.accent}"
  context-chip:
    backgroundColor: "#344b4b"
    textColor: "#b9d9d6"
    rounded: "{rounded.badge}"
    padding: "3px 6px"
  media-card:
    backgroundColor: "#2b2e34"
    rounded: "{rounded.control}"
  dialog:
    backgroundColor: "#222831"
    rounded: "{rounded.dialog}"
  timeline-clip:
    backgroundColor: "{colors.video-track}"
    textColor: "#dceff2"
    rounded: "{rounded.control}"
    height: "58px"
---

# Design System: Byori Studio

## Overview

**Creative North Star: "The CapCut Desktop Editing Workspace"**

Byori Studio follows the user's pinned CapCut Desktop reference: charcoal working surfaces, restrained cyan emphasis, photographic footage and compact editing controls. The interface is a Korean desktop workspace whose visual hierarchy follows the editing task. Media and the composition carry the imagery; the surrounding chrome stays quiet.

The assistant, concept notes and memory occupy the same restrained working environment. Their slightly cooler surfaces distinguish an auxiliary workspace without introducing a separate brand. Preserve the Byori Studio name and familiar Korean editing terminology. This document records the implemented React interface in the macOS Tauri app; it does not assert complete CapCut feature parity or a mobile design.

**Key Characteristics:**

- Dark tonal panels separated by narrow gutters and fine dividers.
- Cyan emphasis for actions, active tools, navigation and keyboard focus.
- Compact Korean controls with stable numeric readouts.
- Photographic media tiles, timeline filmstrips and an actual composite preview.
- A resizable timeline and an auxiliary agent, concept and memory drawer.

Evidence: `src/styles/index.css`, `src/styles/studio.css`, `src/studio/panels.css`, `src/studio/timeline.css`, `src/studio/selection-overlay.css`, and their components. The rendered checks are `.impeccable/review/desktop.png`, `desktop-wide.png` and `export.png`. Direction comes from the contract in `index.html` (seed `byori-capcut-user-pinned`) and the confirmed commitments in `PRODUCT.md`.

## Colors

The palette combines near-black chrome, charcoal panels and cool neutral text with cyan interaction states; track colors classify content.

### Primary

- **Editing Cyan** (`accent`): export, active tabs and tools, focus rings, slider accents and active resize affordances.
- **Action Teal** (`action-fill`, `action-hover`, `action-ink`): primary actions inside dialogs and memory workflows, with a dark label and lighter hover fill.

### Secondary

- **Track Classification** (`video-track`, `image-track`, `audio-track`, `text-track`): blue-teal video, cooler image clips, muted green audio and ochre text. These identify media types; they are not competing action colors.

### Neutral

- **Workspace Charcoal** (`bg`, `panel`, `panel-raised`): shell, principal work panels and inset controls.
- **Control Graphite** (`control-bg`, `control-border`, `control-hover`): editable fields, their boundaries and button hover states.
- **Cool Ink** (`text`, `muted`): primary UI text and supporting labels.
- **Slate Secondary** (`secondary-fill`, `secondary-ink`): subordinate dialog actions.
- **Panel Divider** (`border`): navigation boundaries and inset separators.

### Named Rules

**The Action and Media Rule.** Cyan identifies interaction; muted track colors identify media types. Preserve that distinction when adding tools or tracks.

## Typography

**Body and UI Font:** the platform sans-serif stack in the frontmatter, with Noto Sans KR and generic sans-serif fallbacks. There is no reusable display-font role.

**Label/Mono Font:** UI labels keep the same sans-serif family. Timecodes and numerical metadata use tabular numerals; installation logs use `ui-monospace, "SFMono-Regular", monospace` locally.

The type ramp is deliberately shallow. Modal titles are the strongest reusable text, followed by section headings and panel controls. Body text in the assistant and settings uses more generous line spacing for Korean sentences.

### Hierarchy

- **Title:** dialog titles; the shared title token appears in settings, export and recent-project dialogs.
- **Section:** settings, concept and memory headings.
- **Body:** root interface baseline.
- **Panel:** library and inspector controls and navigation.
- **Label:** panel headers, field labels, actions and ordinary explanatory copy; longer explanations use line heights around 1.7–1.85 as implemented.
- **Supporting:** filenames, help and secondary details. It is not the default for reading paragraphs.

### Named Rules

**The Stable Readout Rule.** Timecodes and numeric metadata use tabular numerals so changing values do not disturb alignment.

## Layout

The application fills its window. The desktop shell has a minimum width of 920px and minimum height of 580px; its top bar is 54px and status bar is 23px. The workspace uses 6px gutters. Its upper region contains the library, flexible player and inspector; the default columns are `minmax(282px, 28%) minmax(250px, 1fr) 278px`.

The timeline spans the editing surface below the upper panels. It begins at 300px high and has an 8px resize separator. Pointer dragging and keyboard arrows adjust it, with a 200px minimum and space reserved for a 240px upper workspace. The desktop reference shows video, audio and text tracks together. Track labels remain sticky while the content scrolls; the ruler stays visible while moving vertically.

The assistant is 320px wide. Above 1500px window width it occupies a neighboring column; at or below that breakpoint it overlays the right side of the editing workspace. At 1200px and below, the inspector narrows to 252px, the library uses a 29% column and the player controls wrap with the timecode above transport buttons. The 700px height breakpoint compresses selected controls. No mobile layout is implemented.

Spacing is a compact working rhythm, not a strict mathematical scale. Small gaps group icons and labels; larger insets separate sections. The media library uses a two-column grid and an independent scroll area. Library tabs keep their size and scroll horizontally with visible overflow arrow controls when needed.

## Elevation & Depth

Work panels use tonal layering and fine borders. Floating menus, notifications and dialogs add soft black shadows to communicate their position above the workspace. The narrower-window assistant receives a side shadow when it overlays editing content. The composition has a small ambient shadow; media thumbnails and ordinary controls are otherwise flat.

### Shadow Vocabulary

- **Menu:** `0 9px 28px #0007` for the application menu.
- **Notification:** `0 8px 24px #0005` for transient notices.
- **Dialog:** `0 20px 65px #0008` for settings, export and recent projects.
- **Assistant overlay:** `-10px 0 30px #0006` in the overlay breakpoint.
- **Composition:** `0 4px 16px #0003` around the preview canvas.

### Named Rules

**The Working Plane Rule.** Working panels separate through tone and dividers; floating layers use soft shadows to make their position legible.

## Shapes

Controls and media thumbnails have modest corners; badges are tighter, and dialogs are slightly rounder than the work panels. The frontmatter records the recurring radii. One-pixel borders articulate panels, fields, clips and previews. Tabs remain squared at their underline edge. Status indicators are small circles, while transform handles remain precise squares.

Photographic thumbnails crop within their library tile. The composition and export preview contain the actual frame at the project's aspect ratio. Filmstrips repeat images horizontally at the strip height instead of stretching them vertically.

## Components

### Buttons

Compact, direct controls keep the work in view. Primary and secondary dialog actions share padding, a 32px minimum height and 11px labels; primary actions use weight 600. The top-right export action has its own compact height and the root cyan accent. Icon buttons use SVG symbols with tooltips or accessible labels.

Hover changes fill, text or border over 120ms. Generic buttons use `control-hover`; primary actions lighten their teal. Disabled controls reduce opacity and use a not-allowed cursor. Keyboard focus uses a 2px cyan outline, normally offset by 3px; library and inspector controls use a 2px offset.

### Chips

Context chips identify the selected clip in the assistant composer with a subdued teal surface, small status dot and single-line content. State badges in settings distinguish available and connected services with neutral or muted green fills. These are informational attachments to a workflow, not large navigation pills.

### Cards / Containers

Media tiles present an image or audio illustration, a type icon, duration when relevant, a lower-right add action and a filename below. Thumbnails use an aspect ratio of 1.55 and a cyan border on hover. The grid remains content-first; it does not wrap every tile in an additional elevated card.

Settings, export and recent-project dialogs share a bordered charcoal container, rounded corners, separated header/footer regions and a constrained scrolling body. Export pairs a real rendered composite with its output settings. Its preview respects the project aspect ratio and shows a loading or failure message when the frame is unavailable.

### Inputs / Fields

Graphite fields use a one-pixel border and the common control radius. Focus changes the border to `#47b6ae` and keyboard focus adds the shared cyan outline. Numeric controls align values and units consistently. The assistant composer groups context, input and provider/send controls within a single bordered surface, with a border change on focus within.

### Navigation

Library categories pair SVG icons with short Korean labels. Active tabs use cyan text; inspector and assistant tabs also use a thin bottom indicator. Library overflow remains reachable using arrow buttons. Selected sidebar categories use accent text. There is no mobile navigation variant.

### Timeline and Selection

Track lanes use consistent label and content heights: 72px video/image, 62px audio and 54px text. Clips keep their media-type fill, compact label band and contextual trim handles. Video/image clips use 58px height with a 19px label band and 37px filmstrip. A pale outline makes primary selection distinct; multiple selections retain their own quieter outline. A fine vertical playhead crosses the ruler and lanes.

A compact second toolbar row exposes labeled Split, Trim Start and Trim End actions with shortcuts and contextual selection guidance. Selected clips show accent-colored handles at both ends; dragging shows the retained time range and duration. Handles support one-frame arrow-key edits and visible keyboard focus while global editor shortcuts continue to work.

The player selection overlay sits above the rendered composite, with a fine pale-cyan boundary, a movable interior and four square corner handles. Both pointer and keyboard operations are supported. The visible bounds, inspector values and selected timeline clip refer to the same selection.

### Agent and Memory Workspace

The assistant uses tabs for editing, concept and memory. Suggestions are restrained bordered rows, logs and results remain within the scrollable feed, and the composer stays below them. Context follows the selected clip. Its controls inherit the same focus, color and spacing language as the editor.

Motion is functional: short state transitions, smooth tab scrolling and one-second linear activity spinners. The reduced-motion media query disables smooth scrolling and reduces transitions/animations to near-instant changes.

### Added Assets and Responsive Preview

Filters and effects place a compact “내 필터/내 효과” section before the built-in preset grids, with import, save-name input and reusable preset rows so adding assets is immediately discoverable. Text exposes “내 글꼴” and a font picker action in the inspector. The controls use the established 10–13px type steps, graphite inputs and cyan interaction language. Editable font samples, video text preset colors, HSL/RGB swatches and chroma-key colors represent media content; scoped detector exceptions keep those values separate from the Studio interface palette. Fixture-only values are likewise excluded narrowly.

The player mode control distinguishes immediate “빠른 재생” from exact “정밀 재생”. Approximate local feedback is labeled; exact frames replace it after rendering settles. Slider drafts, typed text and filter hover update the canvas without accumulating undo entries. Imported partial presets deep-merge consistently with committed edits.

Higgsfield connection controls live within the existing settings dialog. Added, disabled, checking, connected and failed states are visible. The UI states the current read-only tool boundary and keeps OAuth login separate from generation claims.

## Do's and Don'ts

### Do:

- **Do** preserve the Byori Studio name and Korean editing terminology.
- **Do** use cyan for interaction and muted track colors for media classification.
- **Do** retain visible selection and keyboard focus above rendered media.
- **Do** keep overflow navigation reachable and timeline height adjustable.
- **Do** use real project imagery and composite frames in editing and export previews.
- **Do** keep new controls within the compact desktop panel, field and button language.

### Don't:

- **Don't** replace working-panel hierarchy with promotional display typography.
- **Don't** add decorative shadows to ordinary media tiles or editing controls.
- **Don't** let the rendered preview cover selection affordances.
- **Don't** treat the demonstrated desktop layout as an implemented mobile system or full CapCut feature parity.

**Not canonized:** the text-glyph `b` brand placeholder, system-font promotional intro/connection headings, and 8–9px microcopy remain implementation limitations. They are excluded from reusable identity, display and reading-size rules; preserving them as tokens would spread unresolved craft and legibility issues. Project footage, text preset styling and individual media colors are content, not interface tokens.
