# Changelog

All notable changes to this extension are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
uses [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-11-12

### Added

- Live accessibility diagnostics for HTML, JSX/TSX, Vue, Svelte, Razor and CSS/SCSS/SASS/LESS. They
  refresh as you type or on save, and every rule id links to its WCAG documentation.
- Nine auditors:
  - Color Contrast
  - Screen Reader Labels (accessible-name computation)
  - ARIA Landmarks
  - Heading Structure
  - Alt Text Quality
  - Link Purpose
  - Media & Embeds
  - Page Metadata
  - Keyboard & Focus (including a structural CSS parser for suppressed focus outlines)
- A shared, template-aware markup tokenizer. It handles JSX expressions and spreads, framework
  bindings, comments, unquoted attributes, optional end tags, hidden subtrees and character references.
- Quick fixes:
  - add `alt=""`, `aria-label`, iframe `title` or `<html lang>`
  - change a positive `tabindex` to `0`
  - remove `autofocus`
- Workspace audit with a 0–100 health score, a letter grade and per-category pass rates. The report
  opens in an interactive view where you can click a location to jump to the code.
- Report export as Markdown, JSON, self-contained HTML and SARIF 2.1.0.
- Settings to turn each rule group on or off, hide advisory findings, choose when diagnostics refresh,
  and exclude paths or large files.
- Support for untrusted (Restricted Mode) and virtual workspaces.
