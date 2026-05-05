# Unified Chapter TOC — Design

Date: 2026-05-04
Status: Approved (pending implementation plan)
Scope: Chapter pages only. Home page unchanged structurally.

## Goal

Replace the current chapter-page left panel (which shows only the current chapter's section outline) with a unified "Report contents" widget that:

- Always lists every chapter in the report.
- Auto-expands the current chapter inline to show its h2-level sections.
- Provides scroll-spy so the active section is highlighted as the reader scrolls.
- Lets the reader navigate to any other chapter in one click.

Other chapters stay collapsed so the panel doesn't get unwieldy.

## Layout

Widescreen page grid changes from `TOC 220 ▎ 36 ▎ main 706 ▎ 36 ▎ sidenote 280` to `TOC 300 ▎ 36 ▎ main 666 ▎ 36 ▎ sidenote 240`. Page max-width stays at 1320 px. The TOC gains 80 px; main and sidenote each lose 40 px.

CSS variables to update:

| variable      | before | after |
| ------------- | ------ | ----- |
| `--col-toc`   | 220    | 300   |
| `--col-marg`  | 280    | 240   |
| `--col-gap`   | 36     | 36    |

The 1100-breakpoint override scales proportionally:

| variable      | before | after |
| ------------- | ------ | ----- |
| `--col-toc`   | 180    | 240   |
| `--col-marg`  | 240    | 200   |
| `--col-gap`   | 28     | 28    |

`.toc` keeps its current `padding-left: 24px`. The topstrip alignment (38 px = page padding-left 14 + toc padding-left 24) is unaffected.

## Structure

A single labelled block at the top of the panel:

```
REPORT CONTENTS
  ▸  About this report
  ▸  Summary
  ▸  1   Introduction
  ▾  2   Pathways to mirror life
       2.1   Advances in chemistry permit the synthesis…
     • 2.2   Progress in synthetic biology could allow…   ← active
       2.3   A natural-chirality bacterium might be…
       2.4   Other approaches to creating mirror bact…
       2.5   The feasibility of mirror life will incre…
       References
  ▸  3   Engineering, biosafety, and biosecurity of…
  ▸  4   Risks of mirror bacteria
  …
```

The chapter list mirrors what's on the home page (same chapter ordering, same hanging-indent for the chapter number). The two front-matter pages "About this report" and "Summary" appear above the numbered chapters with no number gutter.

## Component anatomy

### Chapter row (collapsed)

```html
<a class="rc-chap" href="../chapter-N-slug/">
  <span class="rc-caret">▸</span>
  <span class="rc-num">N</span>
  <span class="rc-title">Chapter title…</span>
</a>
```

- Caret is decorative; the whole row is clickable.
- `.rc-title` is `white-space: nowrap; overflow: hidden; text-overflow: ellipsis`.
- Hover popout (see below) shows the full title.

### Chapter row (expanded — only the current chapter)

Same markup, with `.rc-chap.expanded` and the caret rendered as `▾`. Followed by a list of section rows and the references link.

### Section row

```html
<a class="rc-sec" href="#section-anchor">
  <span class="rc-secn">2.2</span>
  <span class="rc-sectitle">Progress in synthetic biology…</span>
</a>
```

- `.rc-secn` is the dotted section number, blue, tabular-nums, fixed-width gutter.
- `.rc-sectitle` is `white-space: nowrap; overflow: hidden; text-overflow: ellipsis`.
- Hover popout shows the full section title.
- Smooth-scroll on click.

### "About this report" / "Summary" rows

Same shape as a chapter row, but with no number — the gutter that holds the chapter number is reserved (`width: 20px`) so titles align flush left across all rows.

### References row (under the expanded current chapter)

A trailing section row with `.rc-refs` modifier. Style is the existing accent-blue small-caps "References" treatment, demoted in size to match the other section rows.

## Active-section indicator

Active section row gets:

- A 6 px solid-blue dot in the left gutter (positioned via `::before`, sitting in the gap between the section-number column and the title column).
- The section title goes from `color: var(--ink-3)` to `color: var(--ink)` and `font-weight: 600`.

No vertical rule, no background fill — keeps the panel quiet.

The active chapter (whichever the reader is on) gets `font-weight: 600` and `color: var(--ink)` regardless of scroll position. Other chapters render in `color: var(--ink-3)`.

## Hover popout

Reuse the existing `.fnpeek` mechanism from `app.js` (footnote/citation hover-peek):

- A floating `<div class="rcpeek">` appended to `<body>`.
- Cream background `#fffaf0`, 1 px border `#d8c89a`, soft drop shadow.
- Position: aligned to the right edge of the TOC, vertically aligned with the hovered row.
- Content: the section number + full title (or chapter number + full chapter title for chapter rows).
- Show on `mouseover`, hide on `mouseout`. Do not show on touch devices.
- Disabled at narrow widths (the TOC is hidden there anyway).

Only triggers on rows whose `.rc-title` or `.rc-sectitle` is actually overflowing — measured at hover time via `el.offsetWidth < el.scrollWidth`. Rows that fit don't get a redundant popout.

## Click behaviour

| Element                                | Action                                                |
| -------------------------------------- | ----------------------------------------------------- |
| Collapsed chapter row                  | Navigate to `chapter-N-slug/` (full page nav).        |
| Expanded current-chapter row           | Smooth-scroll to top of page (`href="#"`).            |
| Section row                            | Smooth-scroll to the section anchor.                  |
| "References" row                       | Smooth-scroll to `#references`.                       |
| About / Summary rows                   | Navigate to those pages.                              |
| Caret span                             | Inert — the parent row's click action runs.           |

There is no manual expand/collapse on collapsed chapters. They open by navigating.

## Scroll-spy

Use `IntersectionObserver` (added if not already in the codebase). Observe each section anchor (`<h2 id="…">`) inside `.body`. The section nearest the top of the viewport is "active"; its corresponding `.rc-sec` gets `.active` (which renders the dot).

When the reader is in the chapter header above the first section, no `.rc-sec` is active and no section dot shows. The chapter row's already-rendered "current chapter" styling (bold + dark) is sufficient — no extra state needed.

Once the reader passes the last section heading and continues into references / footnotes, the last section's row stays active rather than blanking.

## TOC overflow

Panel keeps its current behaviour:

```css
.toc {
  position: fixed;
  top: 88px;
  max-height: calc(100vh - 108px);
  overflow-y: auto;
}
```

With ~14 rows when the current chapter is expanded, the panel is well under 360 px tall and fits any laptop viewport. On shorter viewports (or with future longer chapter lists) the panel scrolls internally.

## Narrow / mobile (≤ 900 px)

No change. `.toc { display: none }` stays. Readers use the existing topstrip "About this report / Summary / Chapter N" hover menu.

## Home page

Out of scope for this redesign. The home-page left panel keeps its current two-block layout ("On this page" + "Report contents") with the existing styling. Reusing the new widget on the home page is a worthwhile follow-up but is deferred to keep this change focused on chapter pages.

## Build-time changes

`build.py`:

- Add a new helper `render_report_contents(chapters, current_slug, current_sections)` that emits the unified widget HTML for chapter pages.
  - `chapters` is the full ordered list (about, summary, ch1…ch9).
  - `current_slug` identifies which chapter row gets `.expanded`.
  - `current_sections` is the list of h2 entries (id, number, title) for that chapter, fed in from the existing per-chapter section data already collected for the old TOC.
  - Other chapters render number + title only.
- Drop the chapter-page TOC template scaffolding (`toc-label`, `toc-items-block`, `toc-refs-link`). The new widget replaces all of it inside `<nav class="toc">`.
- The home-page index template is untouched.

`app.js`:

- New module `setupReportContents()`:
  - Wires hover popout (`rcpeek`) on `.rc-chap` and `.rc-sec` rows.
  - Wires scroll-spy on `<h2>` elements within `.body`.
  - Both run only when `matchMedia('(min-width: 901px)').matches`.
- Existing chapter-TOC scroll-spy code (if any) is removed.

`styles.css`:

- New `.rc-*` rules for the widget (chapter rows, section rows, dot indicator, peek).
- Update `--col-toc` and `--col-marg` values.
- Remove now-unused chapter-TOC selectors.

## Out of scope

- Search input inside the TOC. Search is already in the topstrip.
- Mini-map / scrollbar gutter showing chapter density. Tempting but adds complexity without clear payoff.
- Persisting collapsed state across navigation. Every page render shows the current chapter expanded; that's the only state.
- Drag-to-resize TOC width. Width is fixed.

## Risks / things to watch

- **Long chapter titles in 300 px**: Chapter 3 ("Engineering, Biosafety, and Biosecurity of Mirror Bacteria") was already truncating at 220 px with the hanging-indent gutter. With 300 px and the same gutter the truncation point moves out comfortably; verify in the browser.
- **Scroll-spy edge cases**: At the very bottom of the chapter (after the last section), keep the last section active rather than blanking.
- **First paint**: Render the active state server-side for the chapter row, and let JS take over for section-level highlighting. Avoids a flash where nothing is highlighted on load.
