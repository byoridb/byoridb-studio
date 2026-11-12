# Byori Studio

<!-- impeccable:product-schema 1 -->

## Platform

web

React/TypeScript UI hosted by a Tauri 2 desktop application. macOS is the current
development and verification environment. Browser development uses the same local service.

## Product Purpose

A video editor named Byori Studio, as confirmed by the user on 2026-11-01. CapCut Desktop is the user's
explicit reference for the interface, editing workflow, and broad feature coverage.
The product scope and acceptance criteria remain canonical in [ROADMAP.md](ROADMAP.md).

## Positioning

ByoriDB connects creative concepts, appeal points, editing decisions and feedback
across versions and projects. Claude Code, Codex and Gemini CLI operate the same
editing tools as the human interface.

## Operating Context

Import footage, edit a timeline, preview and export; ask a selected CLI agent to
make edits, review and undo them; retain the intent and feedback for subsequent work.
Studio includes ByoriDB version discovery and installation/update management.
Users can install fonts, save/import filter and effect presets, and configure a
Higgsfield MCP connection. Editing should respond immediately: transient drafts
and fast playback provide feedback while exact frames render separately. Current
Higgsfield integration exposes read-only discovery; paid generation remains future work.

## Users

Video creators. The initial specialty (personal, brand or channel work) remains open.

## Brand Commitments

Use the product name Byori Studio, per the latest user naming decision on 2026-11-01.
ByoriDB remains the database engine name. Follow CapCut Desktop's layout and interaction conventions.
Use Korean interface copy with familiar editing terminology.

## Evidence on Hand

User decisions and official CapCut reference links are in ROADMAP.md. Demonstration
projects are labeled as examples. The active application is the new video editor;
legacy DB browser components remain as historical source.

## Product Principles

- UI and agents share validated editing commands and project state.
- Saved projects, exact previews and rendered output must agree; label approximate fast previews clearly.
- Record actual intent and feedback with provenance; distinguish assumptions.
- Implement and verify the broad feature target incrementally without presenting
  unavailable operations as working features.
