# Unified Chapter TOC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the chapter-page left panel — currently shows only the current chapter's section outline — with a unified "Report contents" widget that lists every chapter and inline-expands the current chapter's sections, per `docs/superpowers/specs/2026-05-04-unified-chapter-toc-design.md`.

**Architecture:** Static-site generator. The build is a single Python script (`build.py`) that produces HTML pages by string-templating data from `data/`. Layout is CSS Grid. Behaviour (scroll-spy, hover popouts, drawer) is plain JS in `site-assets/app.js`. There is no existing test framework — the test rhythm here is **build → grep the rendered HTML → visual check in the running preview server → commit**. This plan reflects that.

**Tech Stack:** Python 3, plain CSS, plain JS, BeautifulSoup (parser only), PIL (image dims), Pandoc (parser only).

**File map:**

| File | Role |
| ---- | ---- |
| `build.py` | Add `render_report_contents()` helper; replace TOC scaffolding inside `CHAPTER_TEMPLATE`; update `render_chapter_page()` to call the new helper. |
| `site-assets/styles.css` | Update `--col-toc` and `--col-marg` values; add `.rc-*` rules for the new widget; remove now-unused chapter-TOC selectors. |
| `site-assets/app.js` | Replace the existing scroll-spy (`.toc a`-based, lines 436–466) with one that targets `.rc-sec` and keeps the last section active past the bottom; add hover popout for truncated `.rc-chap` / `.rc-sec` rows. |

The home-page `INDEX_TEMPLATE` is **not** modified — out of scope per the spec.

The local preview server is assumed running at `http://localhost:8000` (started by the user with `cd site && python3 -m http.server 8000`). If it's not running after a build, restart it.

---

### Task 1: Widen the TOC column via CSS variables

**Files:**
- Modify: `site-assets/styles.css:24-27` (root vars)
- Modify: `site-assets/styles.css:30-32` (1100px breakpoint override)

- [ ] **Step 1: Update :root variables**

In `site-assets/styles.css`, replace lines 24–27:

```css
  --col-toc:      300px;
  --col-marg:     240px;
  --col-gap:      36px;
  --max:          1320px;
```

(Old values were `--col-toc: 220px; --col-marg: 280px;`. `--col-gap` and `--max` unchanged but rewritten for context.)

- [ ] **Step 2: Update the 1100-breakpoint override**

Replace lines 30–32:

```css
@media (max-width: 1100px) {
  :root { --col-toc: 240px; --col-marg: 200px; --col-gap: 28px; }
}
```

(Old values were `--col-toc: 180px; --col-marg: 240px;`.)

- [ ] **Step 3: Build and verify**

Run from the worktree root:

```bash
python3 build.py
grep -E "^\s*--col-(toc|marg):" site/styles.css | head -4
```

Expected output includes:

```
  --col-toc:      300px;
  --col-marg:     240px;
    :root { --col-toc: 240px; --col-marg: 200px; --col-gap: 28px; }
```

(The 1100-breakpoint line is the third match; exact whitespace may differ.)

- [ ] **Step 4: Visual sanity check**

Reload `http://localhost:8000/chapter-1-introduction/`. The left TOC should now visibly be wider than before (the chapter heading "Chapter 1" should sit further from the left edge of the prose column). Confirm no text is overlapping or clipped.

- [ ] **Step 5: Commit**

```bash
git add site-assets/styles.css
git commit -m "Widen TOC column: --col-toc 220→300, --col-marg 280→240"
```

---

### Task 2: Add `render_report_contents()` helper

**Files:**
- Modify: `build.py` — add a new helper function just above `render_chapter_page` (around line 912).

The helper takes the full ordered chapter list, the current chapter's slug, and the current chapter's section outline. It returns the complete `<nav class="toc">…</nav>` HTML for the chapter page.

- [ ] **Step 1: Add the helper function**

Insert immediately above `def render_chapter_page(` (around line 912 in `build.py`):

```python
def render_report_contents(
    chapters: list,
    current_slug: str,
    current_sections: list,  # [{id, num, title}]
    has_refs: bool,
) -> str:
    """Render the unified left-side "Report contents" widget for a chapter page.

    `chapters` is the ordered list of chapter dicts (about, summary, ch1…ch9).
    `current_slug` is the id of the chapter currently being rendered.
    `current_sections` is the list of h2-level entries for the current chapter,
    each {id: anchor, num: "2.3" or "", title: full section title}.
    `has_refs` controls whether to render the trailing References sub-row.
    """
    rows = []
    for c in chapters:
        cid = c.get("id", "")
        n = c.get("number")
        ctitle = clean_ws(c.get("title", "") or "")
        is_current = cid == current_slug
        num_html = (
            f'<span class="rc-num">{html.escape(str(n))}</span>'
            if n else '<span class="rc-num"></span>'
        )
        caret = "▾" if is_current else "▸"
        if is_current:
            href = "#"
        else:
            href = f"../{cid}/"
        cls = "rc-chap"
        if is_current:
            cls += " expanded current"
        rows.append(
            f'<a class="{cls}" href="{html.escape(href)}" '
            f'data-fulltitle="{html.escape(ctitle)}">'
            f'<span class="rc-caret" aria-hidden="true">{caret}</span>'
            f'{num_html}'
            f'<span class="rc-title">{html.escape(ctitle)}</span>'
            f'</a>'
        )
        if is_current:
            for s in current_sections:
                sid = s.get("id", "")
                snum = s.get("num", "") or ""
                stitle = clean_ws(s.get("title", "") or "")
                num_span = (
                    f'<span class="rc-secn">{html.escape(snum)}</span>'
                    if snum else '<span class="rc-secn"></span>'
                )
                full = f"{snum}   {stitle}".strip() if snum else stitle
                rows.append(
                    f'<a class="rc-sec" href="#{html.escape(sid)}" '
                    f'data-fulltitle="{html.escape(full)}">'
                    f'{num_span}'
                    f'<span class="rc-sectitle">{html.escape(stitle)}</span>'
                    f'</a>'
                )
            if has_refs:
                rows.append(
                    '<a class="rc-sec rc-refs" href="#references" '
                    'data-fulltitle="References">'
                    '<span class="rc-secn"></span>'
                    '<span class="rc-sectitle">References</span>'
                    '</a>'
                )
    items = "\n      ".join(rows)
    return (
        '<nav class="toc rc" aria-label="Report contents">\n'
        '    <div class="rc-label">Report contents</div>\n'
        f'    {items}\n'
        '  </nav>'
    )
```

- [ ] **Step 2: Smoke-test the helper standalone**

Run from the worktree root:

```bash
python3 -c "
import sys; sys.path.insert(0, '.')
import build
chapters = [
    {'id': 'about', 'number': None, 'title': 'About this report'},
    {'id': 'summary', 'number': 0, 'title': 'Summary'},
    {'id': 'chapter-1-introduction', 'number': 1, 'title': 'Introduction'},
    {'id': 'chapter-2-pathways', 'number': 2, 'title': 'Pathways to mirror life'},
]
sections = [
    {'id': 'sec-2-1', 'num': '2.1', 'title': 'Advances in chemistry permit synthesis'},
    {'id': 'sec-2-2', 'num': '2.2', 'title': 'Progress in synthetic biology'},
]
out = build.render_report_contents(chapters, 'chapter-2-pathways', sections, has_refs=True)
print(out)
"
```

Expected: HTML containing `<nav class=\"toc rc\"`, four `<a class=\"rc-chap\"` entries (one with `expanded current`), two `<a class=\"rc-sec\"` entries (for 2.1 and 2.2), and a final `<a class=\"rc-sec rc-refs\"` for References.

- [ ] **Step 3: Commit**

```bash
git add build.py
git commit -m "Add render_report_contents() helper for unified chapter TOC"
```

---

### Task 3: Replace chapter-page TOC scaffolding

**Files:**
- Modify: `build.py:645-651` (CHAPTER_TEMPLATE TOC block)
- Modify: `build.py:945-966, 1024-1027, 1029-1037` (toc plumbing in `render_chapter_page`)

- [ ] **Step 1: Update `CHAPTER_TEMPLATE` to use a single placeholder**

Replace the `<nav class="toc">` block (lines 647–651):

```python
CHAPTER_TEMPLATE = """{head}{topstrip}
<main class="page">
  {report_contents}

  <section class="content">
```

(Drop the `<a class="toc-label toc-label-link">…</a>`, `{toc_items_block}`, and `{toc_refs_link}` lines. The `{report_contents}` placeholder will receive the full nav element from the helper.)

- [ ] **Step 2: Build the section list and call the helper in `render_chapter_page`**

Replace lines 945–966 (the block that builds `toc_items`, `toc_items_block`, `toc_label`):

```python
    # Build the section outline for this chapter (h2-level, with section numbers).
    current_sections = []
    for i, ss in enumerate(chapter.get("subsections", []) or [], start=1):
        ss_num = "" if is_summary or n is None else f"{n}.{i}"
        ss_title = strip_leading_number(clean_ws(ss.get("title", "")), ss_num)
        current_sections.append({
            "id": ss.get("id", ""),
            "num": ss_num,
            "title": ss_title,
        })
```

- [ ] **Step 3: Drop the `toc_refs_link` plumbing**

Delete lines 1024–1027 (the old `toc_refs_link = (...)` block).

- [ ] **Step 4: Call the helper and pass it to the template**

In the `return CHAPTER_TEMPLATE.format(...)` block (around line 1029), replace `toc_label=...`, `toc_items_block=...`, `toc_refs_link=...` with a single `report_contents=...`:

```python
    report_contents = render_report_contents(
        chapters=_CTX.get("chapters_for_toc", []),
        current_slug=chapter.get("id", ""),
        current_sections=current_sections,
        has_refs=bool(refs_html),
    )

    return CHAPTER_TEMPLATE.format(
        head=head,
        topstrip=topstrip,
        report_contents=report_contents,
        title=html.escape(title),
        publish_date=html.escape(publish_date),
        n_authors=len(chap_authors),
```

(Keep the rest of the `.format(...)` call as-is.)

- [ ] **Step 5: Stash the chapter list in `_CTX` so the helper can see it**

Find the call site `render_chapter_page(...)` in `main()` (around line 1424). Just above the chapter loop, add:

```python
    _CTX["chapters_for_toc"] = chapters
```

(Verify by running `grep -n "_CTX\[\"chapters_for_toc\"\]" build.py`.)

- [ ] **Step 6: Build and verify HTML structure**

```bash
python3 build.py
grep -c 'class="rc-chap' site/chapter-1-introduction/index.html
grep -c 'class="rc-sec' site/chapter-1-introduction/index.html
grep -c 'class="rc-sec rc-refs"' site/chapter-1-introduction/index.html
grep -o 'class="rc-chap expanded current"' site/chapter-1-introduction/index.html | head -1
```

Expected:

- `class="rc-chap` count: 11 (about + summary + 9 chapters).
- `class="rc-sec` count: 1 + (number of sections in chapter 1).
- `class="rc-sec rc-refs"` count: 1.
- `class="rc-chap expanded current"` matched exactly once.

- [ ] **Step 7: Verify the same on a later chapter**

```bash
grep -o 'class="rc-chap expanded current"' site/chapter-5-detection-of-mirror-bacteria/index.html | head -1
grep -o 'href="../chapter-1-introduction/"' site/chapter-5-detection-of-mirror-bacteria/index.html | head -1
```

Expected: each grep returns one match — the current-chapter row is expanded, and the link to chapter 1 is a relative `../` URL.

- [ ] **Step 8: Commit**

```bash
git add build.py
git commit -m "Wire render_report_contents() into chapter pages"
```

---

### Task 4: Add CSS for the new widget

**Files:**
- Modify: `site-assets/styles.css` — add a new `.rc-*` block; remove or no-op the old `.toc-label-*`, `.toc-refs-link`, and `.home-toc .toc-chapters .toc-num` chapter-page selectors.

The new CSS lives in one block. The existing `.toc` positioning (fixed, top:88px, max-height) is reused — `.rc` is just a content style on top of that.

- [ ] **Step 1: Append the `.rc-*` rules**

Append this block to `site-assets/styles.css` just before the `MOBILE` section header (search for `@media (max-width: 900px)` and insert above it):

```css
/* ============================================================
   REPORT CONTENTS — unified left-panel widget on chapter pages
   ============================================================ */

.toc.rc { padding-left: 24px; padding-right: 12px; }

.rc .rc-label {
  font-size: 11px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--accent);
  font-weight: 600;
  margin-bottom: 14px;
}

/* Each chapter row: caret · number · ellipsis-truncated title.
   The whole row is the link. The number sits in a fixed-width gutter so
   titles align across chapters and across the about/summary rows. */
.rc .rc-chap {
  display: grid;
  grid-template-columns: 12px 20px minmax(0, 1fr);
  align-items: baseline;
  gap: 4px;
  padding: 5px 0;
  text-decoration: none;
  color: var(--ink-3);
  font-family: var(--sans);
  font-size: 12.5px;
  line-height: 1.45;
  border: 0;
}
.rc .rc-chap:hover { color: var(--ink); }
.rc .rc-chap.current,
.rc .rc-chap.expanded { color: var(--ink); font-weight: 600; }

.rc .rc-caret {
  color: var(--muted-2);
  font-size: 9px;
  line-height: 1;
  padding-top: 4px;
}
.rc .rc-num {
  color: var(--accent);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  text-align: right;
  padding-right: 4px;
}
.rc .rc-title {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

/* Section row inside the expanded current chapter.
   Lives in the same grid as chapter rows so the section number sits in the
   chapter-title column (indented past the chapter number gutter). */
.rc .rc-sec {
  display: grid;
  grid-template-columns: 12px 28px minmax(0, 1fr);
  align-items: baseline;
  gap: 4px;
  padding: 3px 0;
  margin-left: 0;
  text-decoration: none;
  color: var(--ink-3);
  font-family: var(--sans);
  font-size: 12px;
  line-height: 1.45;
  position: relative;
}
.rc .rc-sec:hover { color: var(--ink); }
.rc .rc-sec .rc-secn {
  grid-column: 2;
  color: var(--accent);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  font-size: 11.5px;
  text-align: right;
  padding-right: 4px;
}
.rc .rc-sec .rc-sectitle {
  grid-column: 3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

/* Active section: small blue dot in the leftmost gutter column. */
.rc .rc-sec.current { color: var(--ink); font-weight: 600; }
.rc .rc-sec.current::before {
  content: "";
  position: absolute;
  left: 2px;
  top: 50%;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  transform: translateY(-50%);
}

/* "References" appears as a section row, demoted slightly. */
.rc .rc-sec.rc-refs {
  margin-top: 6px;
  color: var(--accent);
  font-weight: 600;
  font-size: 11px;
  letter-spacing: 0.10em;
  text-transform: uppercase;
}
.rc .rc-sec.rc-refs:hover { color: var(--ink); }
.rc .rc-sec.rc-refs .rc-sectitle { font-family: var(--sans); }

/* Floating popout — same family as .fnpeek. */
.rcpeek {
  position: fixed;
  z-index: 80;
  background: #fffaf0;
  border: 1px solid #d8c89a;
  border-radius: 4px;
  padding: 8px 12px;
  max-width: 460px;
  font-family: var(--sans);
  font-size: 12px;
  line-height: 1.45;
  color: var(--ink-2);
  pointer-events: none;
  opacity: 0;
  transform: translateY(2px);
  transition: opacity 0.10s, transform 0.10s;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.10);
}
.rcpeek.show { opacity: 1; transform: translateY(0); }
```

- [ ] **Step 2: Remove now-unused chapter-TOC CSS**

The chapter pages no longer use `.toc-label`, `.toc-label-link`, `.toc-refs-link`, `.toc-label-2`, or the `.toc ol a / .toc-num / .home-toc .toc-chapters` rules. **However**, the home page (`INDEX_TEMPLATE`) still uses them — verify before removing. Run:

```bash
grep -E "toc-label|toc-refs-link|toc-num|toc-onpage|toc-chapters" site/index.html | head -10
```

If matches appear (they will — the home page's "On this page" + "Report contents" widget uses these classes), **leave the existing selectors alone**. Removing them would break the home page.

The `.toc-label` and `.toc-refs-link` selectors stay. Nothing to delete in this task.

- [ ] **Step 3: Build and visually verify**

```bash
python3 build.py
```

Reload `http://localhost:8000/chapter-2-pathways-to-mirror-life/`. Verify:

- The left panel now shows the heading "REPORT CONTENTS" (small caps, accent blue).
- Below it: 11 rows — "About this report", "Summary", and chapters 1–9.
- The chapter-2 row has a `▾` caret, is bold, and is followed by 5 indented section rows with section numbers (2.1–2.5), then a "References" row at the bottom of the expanded block.
- Other chapters have a `▸` caret and a single-line ellipsis-truncated title.
- The chapter-3 title ("Engineering, Biosafety, and Biosecurity of Mirror Bacteria") is truncated with an ellipsis (no overflow into the next column).

Any visible misalignment (numbers not flush, caret floating wrong) is fixed in this same step before committing.

- [ ] **Step 4: Commit**

```bash
git add site-assets/styles.css
git commit -m "Style the unified Report Contents widget"
```

---

### Task 5: Scroll-spy — keep the right section dot lit as the reader scrolls

**Files:**
- Modify: `site-assets/app.js:436-466` — replace the existing `.toc a` scroll-spy block.

The existing scroll-spy already works on any link inside `.toc` whose `href` starts with `#`. With the new widget, `.rc-sec` rows fit that shape and will be picked up automatically — but the active-class name is `current`, and the new CSS keys off `.rc-sec.current` (matches). **However**, the existing implementation has two problems for the new design:

1. When **no** entry is intersecting (reader scrolled past the last section into the references / footnotes), all rows lose `.current`. Spec says: keep the last section active.
2. The selector `.toc a` also matches the chapter rows. The chapter row's href is `#` (back-to-top); that's not a real section anchor, so `linkByHash` filters it out — fine. The `../chapter-N/` rows also fail the `href.startsWith('#')` check — also fine.

So the only real fix is (1).

- [ ] **Step 1: Replace the scroll-spy block**

Replace lines 436–466 in `site-assets/app.js`:

```js
  // ---------- TOC current-section highlight on scroll ----------

  const tocLinks = document.querySelectorAll('.toc a');
  if (tocLinks.length && 'IntersectionObserver' in window) {
    const linkByHash = new Map();
    tocLinks.forEach(function (link) {
      const href = link.getAttribute('href') || '';
      if (href.startsWith('#') && href.length > 1) {
        linkByHash.set(href.slice(1), link);
      }
    });

    const observed = [];
    linkByHash.forEach(function (_link, id) {
      const el = document.getElementById(id);
      if (el) observed.push(el);
    });

    if (observed.length) {
      let lastActiveId = null;

      function setActive(id) {
        if (!id || id === lastActiveId) return;
        tocLinks.forEach(function (l) { l.classList.remove('current'); });
        const link = linkByHash.get(id);
        if (link) {
          link.classList.add('current');
          lastActiveId = id;
        }
      }

      const io = new IntersectionObserver(function (entries) {
        // Pick the topmost intersecting entry on this batch.
        const intersecting = entries.filter(function (e) { return e.isIntersecting; });
        if (intersecting.length) {
          intersecting.sort(function (a, b) {
            return a.boundingClientRect.top - b.boundingClientRect.top;
          });
          setActive(intersecting[0].target.id);
        }
        // If nothing is intersecting, leave lastActiveId in place — this
        // gives us the "stay on last section past the end of body" behaviour.
      }, { rootMargin: '-20% 0px -65% 0px', threshold: 0 });

      observed.forEach(function (el) { io.observe(el); });

      // Initialise on load: pick the first observed element above viewport
      // top, falling back to the first one.
      function initActive() {
        let pick = observed[0];
        for (let i = 0; i < observed.length; i++) {
          const r = observed[i].getBoundingClientRect();
          if (r.top <= 80) pick = observed[i];
          else break;
        }
        if (pick) setActive(pick.id);
      }
      // Defer to after layout settles.
      if (document.readyState === 'complete') initActive();
      else window.addEventListener('load', initActive, { once: true });
    }
  }
```

- [ ] **Step 2: Build and verify in the browser**

```bash
python3 build.py
```

Reload `http://localhost:8000/chapter-2-pathways-to-mirror-life/`. Scroll through the chapter and watch the left panel:

1. Above the first section: no dot anywhere (acceptable — chapter row is bold).
2. Reach section 2.2: a small blue dot appears next to the 2.2 row, and the 2.2 title goes bold and dark.
3. Scroll quickly to section 2.5: dot moves through 2.3, 2.4, then settles on 2.5.
4. Scroll past the last section into the References block: dot **stays on 2.5** (does not blank out).
5. Scroll back up: dot moves backward as expected.

Nothing else in the panel should highlight (chapter rows shouldn't get `.current`; `.rc-refs` shouldn't either, since it has `href="#references"` which isn't an h2 id).

- [ ] **Step 3: Verify the references row doesn't compete for highlight**

The References section uses `<section class="refs" id="references">` — the id `references` exists. Check:

```bash
grep -o 'id="references"' site/chapter-2-pathways-to-mirror-life/index.html | head -1
grep -o 'href="#references"' site/chapter-2-pathways-to-mirror-life/index.html | head -2
```

If both grep hits exist, the `.rc-refs` row will technically pick up the `current` class when the reader scrolls into the references block. That's fine visually — `.rc-sec.current::before` will draw a dot and `.rc-sec.rc-refs` is already bold. No code change needed; just confirm in the browser that the dot lands cleanly on References when the reader is in the references block.

- [ ] **Step 4: Commit**

```bash
git add site-assets/app.js
git commit -m "Scroll-spy: pick topmost intersecting section, keep last active"
```

---

### Task 6: Hover popout for truncated rows

**Files:**
- Modify: `site-assets/app.js` — add a new IIFE that wires `mouseover`/`mouseout` on `.rc-chap[data-fulltitle]` and `.rc-sec[data-fulltitle]`, plus shows a `<div class="rcpeek">` only when the row's title is overflowing.

Insert just before the closing `})();` of the main `(function(){ … })();` wrapper at the bottom of `app.js`, OR above the `// ---------- helper ----------` comment block (around line 468). Prefer the latter so the new code lives next to the related scroll-spy block.

- [ ] **Step 1: Add the hover popout block**

Insert this block in `site-assets/app.js` immediately after the scroll-spy block from Task 5 (i.e., after the closing `}` of the scroll-spy `if (tocLinks.length && 'IntersectionObserver' in window)` block):

```js
  // ---------- Report-contents row hover popout ----------
  // When a chapter or section row is ellipsis-truncated, hovering it shows
  // the full title in a small floating cream tooltip (same family as fnpeek).
  // Disabled on narrow viewports — the TOC is hidden there.
  (function () {
    let rcpeek = null;
    let activeRow = null;

    function ensureRcpeek() {
      if (rcpeek) return rcpeek;
      rcpeek = document.createElement('div');
      rcpeek.className = 'rcpeek';
      document.body.appendChild(rcpeek);
      return rcpeek;
    }

    function isOverflowing(row) {
      const title = row.querySelector('.rc-title, .rc-sectitle');
      if (!title) return false;
      return title.offsetWidth < title.scrollWidth;
    }

    function position(row, peek) {
      const rowRect = row.getBoundingClientRect();
      const peekRect = peek.getBoundingClientRect();
      // Place to the right of the TOC, vertically aligned with the row.
      const tocEl = row.closest('.toc');
      const tocRect = tocEl ? tocEl.getBoundingClientRect() : rowRect;
      let left = tocRect.right + 8;
      let top = rowRect.top + rowRect.height / 2 - peekRect.height / 2;
      // Keep on screen.
      const maxLeft = window.innerWidth - peekRect.width - 12;
      if (left > maxLeft) left = maxLeft;
      if (top < 8) top = 8;
      const maxTop = window.innerHeight - peekRect.height - 8;
      if (top > maxTop) top = maxTop;
      peek.style.left = left + 'px';
      peek.style.top = top + 'px';
    }

    function showFor(row) {
      if (window.matchMedia('(max-width: 900px)').matches) return;
      if (!isOverflowing(row)) return;
      const full = row.getAttribute('data-fulltitle') || '';
      if (!full) return;
      const peek = ensureRcpeek();
      peek.textContent = full;
      // Allow the browser to lay it out before measuring.
      peek.classList.add('show');
      // Use rAF so the just-set textContent is reflected in scrollWidth/height.
      requestAnimationFrame(function () { position(row, peek); });
      activeRow = row;
    }

    function hide() {
      if (!rcpeek) return;
      rcpeek.classList.remove('show');
      activeRow = null;
    }

    document.addEventListener('mouseover', function (e) {
      const row = e.target.closest('.rc-chap[data-fulltitle], .rc-sec[data-fulltitle]');
      if (!row || row === activeRow) return;
      showFor(row);
    });
    document.addEventListener('mouseout', function (e) {
      const row = e.target.closest('.rc-chap[data-fulltitle], .rc-sec[data-fulltitle]');
      if (!row) return;
      // Only hide if leaving the row entirely (not just child→parent).
      if (e.relatedTarget && row.contains(e.relatedTarget)) return;
      hide();
    });
    // Also hide on scroll inside the TOC, since position is fixed-anchored.
    const tocEl = document.querySelector('.toc.rc');
    if (tocEl) tocEl.addEventListener('scroll', hide, { passive: true });
  })();
```

- [ ] **Step 2: Build and verify**

```bash
python3 build.py
```

Reload `http://localhost:8000/chapter-3-engineering-biosafety-and-biosecurity-of-mirror-bacteria/` (the chapter with the longest title — guaranteed to be truncated in 300 px).

- Hover the chapter-3 row in the left panel: a cream tooltip appears to the right of the TOC showing the full title "Engineering, Biosafety, and Biosecurity of Mirror Bacteria".
- Hover any section row whose title is truncated (e.g., a long 3.x title): the tooltip shows the full section number + title.
- Hover a row whose title fits on one line (e.g., a short chapter): no tooltip appears.
- Resize the browser below 900 px: hovering rows produces no tooltip (because the TOC is hidden anyway, but verify the early-return works).

- [ ] **Step 3: Commit**

```bash
git add site-assets/app.js
git commit -m "Add hover popout for truncated chapter/section TOC rows"
```

---

### Task 7: End-to-end verification + small fixes

This task is pure verification of the integrated behaviour — no new code unless something is broken. Each step is a check; if any check fails, fix it inline before moving on.

- [ ] **Step 1: Build cleanly**

```bash
python3 build.py
```

Expected output ends with `Built 9 chapter pages + index → /Users/jwagsta/claude/tr-website/.claude/worktrees/unified-chapter-toc/site (dev)`. No tracebacks, no `KeyError`, no warnings other than the existing ones.

- [ ] **Step 2: Click-through every chapter from one chapter page**

Open `http://localhost:8000/chapter-1-introduction/`. From the left panel, click each chapter row in turn (about, summary, 1, 2, …, 9). Each click navigates to the corresponding page. On every page, the left panel reappears with the just-clicked chapter expanded.

- [ ] **Step 3: Section navigation within a chapter**

On `http://localhost:8000/chapter-2-pathways-to-mirror-life/`, click each of the 5 section rows. Each click smooth-scrolls to the corresponding `<h2>` heading. The blue dot follows in the left panel.

- [ ] **Step 4: Back-to-top via expanded chapter row**

On the same chapter page, click the expanded chapter-2 row itself (not the caret, the title). Page scrolls to the top.

- [ ] **Step 5: References click**

Click the "References" row at the bottom of the expanded block. Page smooth-scrolls to the references section.

- [ ] **Step 6: Narrow viewport (≤ 900 px)**

Resize the browser to 800 px wide. The left TOC disappears entirely (matches existing behaviour). The topstrip stays pinned. The brand "Technical Report on Mirror Bacteria" still opens the dropdown menu on click.

- [ ] **Step 7: Home page is unaffected**

Open `http://localhost:8000/`. The home page's left panel still shows "ON THIS PAGE" + "REPORT CONTENTS" exactly as before — two stacked blocks, hanging-indent chapter numbers, no caret/dot machinery. (This page was not in scope; if any of its styling has been damaged, fix the CSS to leave the home-page selectors intact.)

- [ ] **Step 8: Spot-check chapter-3 title truncation**

`http://localhost:8000/chapter-1-introduction/`. The chapter-3 row in the left panel displays "Engineering, Biosafety, and Biosecurity…" with an ellipsis. Hovering it shows the full title in the cream popout.

- [ ] **Step 9: Spot-check the long section titles in chapter 2**

On chapter 2's page, every section row is truncated single-line with section number visible (2.1, 2.2, …). Hovering any row shows the full long title in the popout.

- [ ] **Step 10: No console errors**

Open DevTools → Console while navigating. No JS errors, no `Uncaught TypeError`, no warnings from app.js or the IntersectionObserver.

- [ ] **Step 11: If any check failed**

Fix and commit the fix as a separate small commit (`Fix: <one-line description>`). Re-run all checks.

- [ ] **Step 12: Sanity check the full diff**

```bash
git diff main...HEAD --stat
```

Expected files in the diff: `build.py`, `site-assets/styles.css`, `site-assets/app.js`, plus the design-doc + favicon + topstrip-padding pre-redesign commit. No accidental edits.

---

### Task 8: Push the branch and open a PR

- [ ] **Step 1: Push the worktree branch**

```bash
git push -u origin worktree-unified-chapter-toc
```

- [ ] **Step 2: Open a PR**

```bash
gh pr create --title "Unified chapter TOC: full report contents + inline current-chapter expand" --body "$(cat <<'EOF'
## Summary
- New left panel on chapter pages: lists every chapter, auto-expands the current one to show its h2-level sections, smooth-scrolls within page, navigates between chapters in one click.
- Section/chapter titles ellipsis-truncated with a cream floating popout (matches existing fnpeek pattern) showing the full title on hover.
- Active section indicated by a 6 px blue dot in the gutter — no vertical rule, no background fill.
- Layout grid: TOC 220→300, main 706→666, sidenote 280→240. Page max-width unchanged.
- Scroll-spy keeps the last section active when the reader scrolls past it into references.
- Narrow ≤ 900 px: TOC stays fully hidden, unchanged.
- Home page out of scope, untouched.

## Pre-redesign commits also included
- Add SVG favicon (IBM-blue circle).
- Topstrip brand padding-left 46→38 to align with the TOC content-area edge.
- Design doc at docs/superpowers/specs/2026-05-04-unified-chapter-toc-design.md.

## Test plan
- [ ] On a chapter page, every chapter row navigates correctly when clicked.
- [ ] On a chapter page, every section row smooth-scrolls to the corresponding h2.
- [ ] Active section dot updates as you scroll, and stays on the last section past the end of body.
- [ ] Hover a truncated row → cream tooltip with full title; hover a row that fits → no tooltip.
- [ ] Resize ≤ 900 px → TOC hidden, topstrip still pinned, no console errors.
- [ ] Home page unchanged structurally and visually.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Report PR URL**

The `gh pr create` command prints the PR URL on success. Report it back to the user.

---

## Self-review notes

**Spec coverage**: All sections of the spec (layout, structure, component anatomy, active indicator, hover popout, click behaviour, scroll-spy, TOC overflow, narrow/mobile, home-page-out-of-scope, build-time changes) map to specific tasks 1–6, with verification in task 7. The "first paint" risk in the spec is addressed by Task 5 Step 1's `initActive()` function which runs on load.

**Placeholder scan**: No "TBD" / "TODO" / "implement appropriate". Every step contains the actual code or command.

**Type/name consistency**: Class names used across tasks: `.rc`, `.rc-label`, `.rc-chap`, `.rc-sec`, `.rc-num`, `.rc-secn`, `.rc-title`, `.rc-sectitle`, `.rc-caret`, `.rc-refs`, `.rcpeek`, `.current`, `.expanded`. Each appears in both the build.py rendering (Task 2) and the CSS (Task 4) and the app.js (Tasks 5–6) consistently. The helper signature `render_report_contents(chapters, current_slug, current_sections, has_refs)` is the same in Task 2 and the call site in Task 3.

**Test framework note**: Verification is `build → grep → eyeball in browser` rather than pytest. Acknowledged in the plan header.
