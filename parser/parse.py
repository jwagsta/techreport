"""Parse `Final Tech Report.docx` into a structured JSON shape suitable for
flexible website rendering.

Pipeline:
  1. (already done) `pandoc --track-changes=accept -t html` produces report.html
     with `--extract-media=./media`.
  2. This script reads report.html, walks the DOM, and emits:
       - report.json      : full structured document
       - chapters/*.json  : one file per top-level section (lazy-load friendly)
       - assets/          : images copied from media/media/

Schema is documented in README.md.
"""
from __future__ import annotations

import json
import re
import shutil
from pathlib import Path
from typing import Any

from bs4 import BeautifulSoup, NavigableString, Tag

ROOT = Path(__file__).parent
HTML_PATH = ROOT / "intermediates" / "report.html"
SRC_MEDIA = ROOT / "intermediates" / "media" / "media"
OUT_DIR = ROOT.parent / "data"
OUT_ASSETS = OUT_DIR / "assets"
OUT_CHAPTERS = OUT_DIR / "chapters"


# ---------------------------------------------------------------------------
# helpers


def slugify(text: str) -> str:
    text = text.strip().lower()
    text = re.sub(r"[^\w\s-]", "", text)
    text = re.sub(r"[\s_-]+", "-", text)
    return text.strip("-")


def inner_html(tag: Tag) -> str:
    """Serialize children of `tag` as HTML, stripped & whitespace-collapsed."""
    return "".join(str(c) for c in tag.children).strip()


_WS_RE = re.compile(r"\s+")


def text_of(tag: Tag) -> str:
    return _WS_RE.sub(" ", tag.get_text(" ", strip=True)).strip()


def normalize_ws(s: str) -> str:
    return _WS_RE.sub(" ", s).strip()


def annotate_inline(html: str) -> str:
    """Add data-* attributes to inline citation/footnote links so frontends can
    style them without re-parsing. Operates on a fragment."""
    if not html:
        return html
    frag = BeautifulSoup(html, "lxml")
    # lxml wraps fragments in <html><body>...</body></html>; strip back to body
    body = frag.body
    if body is None:
        return html
    for a in body.find_all("a"):
        href = a.get("href", "")
        if "paperpile.com/" in href:
            a["data-citation"] = "paperpile"
        elif a.get("class") and "footnote-ref" in a.get("class"):
            a["data-footnote-ref"] = a.get("href", "").lstrip("#")
        elif a.get("class") and "footnote-back" in a.get("class"):
            a["data-footnote-back"] = "1"
    return "".join(str(c) for c in body.children).strip()


# ---------------------------------------------------------------------------
# block emission


def emit_paragraph(p: Tag) -> dict[str, Any]:
    return {"type": "paragraph", "html": annotate_inline(inner_html(p))}


def emit_heading(h: Tag) -> dict[str, Any]:
    level = int(h.name[1])
    return {
        "type": "heading",
        "level": level,
        "id": h.get("id"),
        "text": text_of(h),
        "html": annotate_inline(inner_html(h)),
    }


def emit_list(ul: Tag) -> dict[str, Any]:
    ordered = ul.name == "ol"
    items = []
    for li in ul.find_all("li", recursive=False):
        # Each li can have its own paragraphs / nested lists.
        items.append({"html": annotate_inline(inner_html(li))})
    return {
        "type": "list",
        "ordered": ordered,
        "start": int(ul.get("start") or 1) if ordered else None,
        "items": items,
    }


def emit_blockquote(bq: Tag) -> dict[str, Any]:
    return {
        "type": "blockquote",
        "blocks": walk_blocks(bq),
    }


def is_figure_table(table: Tag) -> bool:
    """Detect the figure-with-caption pattern pandoc emits for image+caption
    layout tables: single column, first row is an image, second row is an h5
    (the caption)."""
    cols = table.find("colgroup")
    col_count = len(cols.find_all("col")) if cols else None
    if col_count and col_count != 1:
        return False
    rows = table.find_all("tr")
    if len(rows) < 1:
        return False
    first_cell = rows[0].find(["td", "th"])
    if not first_cell or not first_cell.find("img"):
        return False
    return True


def emit_figure(table: Tag, fig_counter: dict[str, int]) -> dict[str, Any]:
    rows = table.find_all("tr")
    img = rows[0].find("img")
    src = img.get("src", "")
    style = img.get("style", "") or ""
    width = re.search(r"width:\s*([\d.]+in)", style)
    height = re.search(r"height:\s*([\d.]+in)", style)

    # Caption is in row 2 if present (h5 + p's).
    caption = None
    caption_cell = rows[1].find(["td", "th"]) if len(rows) > 1 else None
    if caption_cell:
        h5 = caption_cell.find("h5")
        # everything except the h5 becomes the body
        body_parts = []
        for child in caption_cell.children:
            if isinstance(child, Tag) and child.name == "h5":
                continue
            if isinstance(child, NavigableString) and not str(child).strip():
                continue
            body_parts.append(str(child))
        caption = {
            "id": h5.get("id") if h5 else None,
            "title": text_of(h5) if h5 else None,
            "title_html": annotate_inline(inner_html(h5)) if h5 else None,
            "body_html": annotate_inline("".join(body_parts).strip()),
        }

    fig_counter["n"] += 1
    return {
        "type": "figure",
        "id": (caption or {}).get("id") or f"figure-{fig_counter['n']}",
        "src": src,  # rewritten to assets/ path later
        "alt": img.get("alt") or "",
        "width": width.group(1) if width else None,
        "height": height.group(1) if height else None,
        "caption": caption,
    }


def is_box_table(table: Tag) -> bool:
    """A 'Box N.N' callout: single-column table whose first cell contains an
    <h4 id="box-…">. The docx puts these in layout tables; the schema lifts
    them out as a first-class `box` block."""
    cols = table.find("colgroup")
    if cols and len(cols.find_all("col")) > 1:
        return False
    first_cell = (table.find("tr") or table).find(["td", "th"])
    if not first_cell:
        return False
    h4 = first_cell.find("h4", id=True)
    return bool(h4 and h4.get("id", "").startswith("box-"))


_BOX_TITLE_RE = re.compile(r"^(Box\s+[\d.]+)\s*[:.]\s*(.*)$", re.I | re.S)


def emit_box(table: Tag) -> dict[str, Any]:
    """Lift a box-table into a typed `box` block with its own children."""
    cell = (table.find("tr") or table).find(["td", "th"])
    h4 = cell.find("h4", id=True)
    box_id = h4.get("id", "")
    heading = normalize_ws(text_of(h4))
    m = _BOX_TITLE_RE.match(heading)
    if m:
        label, title = m.group(1).strip(), m.group(2).strip()
    else:
        label, title = "Box", heading

    # Children = everything in the cell except the heading itself.
    container = BeautifulSoup("<div></div>", "lxml").div
    for child in cell.children:
        if isinstance(child, Tag) and child is h4:
            continue
        if isinstance(child, NavigableString) and not str(child).strip():
            continue
        if isinstance(child, Tag):
            container.append(child.__copy__())
        else:
            container.append(NavigableString(str(child)))
    blocks = walk_blocks(container)
    return {
        "type": "box",
        "id": box_id,
        "label": label,
        "title": title,
        "blocks": blocks,
    }


def is_affiliations_table(table: Tag) -> bool:
    """The 1-column 'Authors are listed in alphabetical order …' footer at the
    top of Chapter 1. Detected so it can be marked & skipped by renderers."""
    txt = text_of(table)[:200].lower()
    return "authors are listed in alphabetical order" in txt and "affiliations" in txt


def emit_table(table: Tag) -> dict[str, Any]:
    out: dict[str, Any] = {"type": "table", "html": str(table)}
    if is_affiliations_table(table):
        out["kind"] = "affiliations"
    return out


def walk_blocks(container: Tag) -> list[dict[str, Any]]:
    """Walk direct children of `container` and emit typed blocks. Headings are
    NOT collected here — they're consumed by `partition_sections`."""
    blocks: list[dict[str, Any]] = []
    fig_counter = {"n": 0}
    for child in container.children:
        if isinstance(child, NavigableString):
            if str(child).strip():
                blocks.append({"type": "text", "text": str(child).strip()})
            continue
        if not isinstance(child, Tag):
            continue
        name = child.name
        if name == "p":
            blocks.append(emit_paragraph(child))
        elif name in ("ul", "ol"):
            blocks.append(emit_list(child))
        elif name == "blockquote":
            blocks.append(emit_blockquote(child))
        elif name == "table":
            if is_figure_table(child):
                blocks.append(emit_figure(child, fig_counter))
            elif is_box_table(child):
                blocks.append(emit_box(child))
            else:
                blocks.append(emit_table(child))
        elif name in ("h2", "h3", "h4", "h5", "h6"):
            # Most h2/h3s are consumed by the section partitioner; any that
            # leak through become inline heading blocks so we never drop them.
            blocks.append(emit_heading(child))
        elif name == "section":
            # `<section class="footnotes">` is handled separately at the top.
            blocks.extend(walk_blocks(child))
        elif name == "hr":
            blocks.append({"type": "hr"})
        elif name in ("div", "figure"):
            blocks.extend(walk_blocks(child))
        elif name == "img":
            blocks.append({"type": "image", "src": child.get("src", "")})
        else:
            # Fallback: keep raw html so nothing is silently dropped.
            blocks.append({"type": "raw", "html": str(child)})
    return blocks


# ---------------------------------------------------------------------------
# document partitioning


def split_by_heading(nodes: list[Tag], level: int) -> list[tuple[Tag | None, list[Tag]]]:
    """Split a flat list of tags into groups keyed by Hn headings of the given
    level. Returns [(heading_tag_or_None, [tags before next heading]), ...].
    The first group's heading may be None (preamble before any heading)."""
    groups: list[tuple[Tag | None, list[Tag]]] = []
    current_heading: Tag | None = None
    current: list[Tag] = []
    target = f"h{level}"
    for n in nodes:
        if isinstance(n, Tag) and n.name == target:
            if current_heading is not None or current:
                groups.append((current_heading, current))
            current_heading = n
            current = []
        else:
            current.append(n)
    if current_heading is not None or current:
        groups.append((current_heading, current))
    return groups


def parse_subsection(heading: Tag, body: list[Tag], level: int) -> dict[str, Any]:
    """Parse a heading at `level` and its body. Recurses one level deeper.

    If the body contains no headings at sub_level but does contain headings at
    sub_level+1, fall back to that deeper level so flat chapters (e.g. H1 -> H3)
    still get a subsection-based TOC."""
    sub_level = level + 1
    has_sub = any(isinstance(n, Tag) and n.name == f"h{sub_level}" for n in body)
    if not has_sub and level < 3:
        deeper = sub_level + 1
        if any(isinstance(n, Tag) and n.name == f"h{deeper}" for n in body):
            sub_level = deeper
    sub_groups = split_by_heading(body, sub_level)
    # First group (no heading) = blocks directly under this heading.
    intro_blocks: list[dict[str, Any]] = []
    subsections: list[dict[str, Any]] = []

    for h, b in sub_groups:
        if h is None:
            # Wrap into a synthetic container so walk_blocks can iterate.
            tmp = BeautifulSoup("<div></div>", "lxml").div
            for n in b:
                tmp.append(n.__copy__() if isinstance(n, Tag) else NavigableString(str(n)))
            intro_blocks = walk_blocks(tmp)
        else:
            if sub_level <= 3:
                subsections.append(parse_subsection(h, b, sub_level))
            else:
                # h4+ is inlined as a heading block.
                tmp = BeautifulSoup("<div></div>", "lxml").div
                tmp.append(h.__copy__())
                for n in b:
                    tmp.append(n.__copy__() if isinstance(n, Tag) else NavigableString(str(n)))
                intro_blocks.extend(walk_blocks(tmp))

    return {
        "id": heading.get("id") or slugify(text_of(heading)),
        "level": level,
        "title": text_of(heading),
        "title_html": annotate_inline(inner_html(heading)),
        "blocks": intro_blocks,
        "subsections": subsections,
    }


# ---------------------------------------------------------------------------
# specialized extractors


CHAPTER_RE = re.compile(r"^Chapter\s+(\d+):\s*(.+)$", re.IGNORECASE)


def classify_section(title: str) -> tuple[str, int | None, str]:
    """Return (kind, chapter_number, clean_title)."""
    m = CHAPTER_RE.match(title.strip())
    if m:
        return ("chapter", int(m.group(1)), m.group(2).strip())
    backmatter = {
        "references",
        "contributions and acknowledgments",
        "boxes, figures, and tables",
        "table of contents",
    }
    frontmatter = {"abstract", "report authors", "review", "about this report", "summary"}
    key = title.strip().lower()
    if key in backmatter:
        return ("backmatter", None, title.strip())
    if key in frontmatter:
        return ("frontmatter", None, title.strip())
    return ("section", None, title.strip())


def extract_authors(blocks: list[dict[str, Any]]) -> list[dict[str, str]]:
    """Each author paragraph in the source is `Name, Affiliation`."""
    authors = []
    for b in blocks:
        if b.get("type") != "paragraph":
            continue
        text = BeautifulSoup(b["html"], "lxml").get_text(" ", strip=True)
        if not text or text.lower().startswith("in alphabetical"):
            continue
        if text.lower() == "contact":
            break
        if "," in text:
            name, _, affil = text.partition(",")
            authors.append({"name": normalize_ws(name), "affiliation": normalize_ws(affil)})
    return authors


def extract_reviewers(blocks: list[dict[str, Any]]) -> list[dict[str, str]]:
    """Reviewers live in a single blockquote at the end of the Review section."""
    for b in blocks:
        if b.get("type") != "blockquote":
            continue
        out = []
        for inner in b.get("blocks", []):
            if inner.get("type") != "paragraph":
                continue
            text = BeautifulSoup(inner["html"], "lxml").get_text(" ", strip=True)
            if "," in text:
                name, _, affil = text.partition(",")
                out.append({"name": normalize_ws(name), "affiliation": normalize_ws(affil)})
        if out:
            return out
    return []


def extract_footnotes(soup: BeautifulSoup) -> list[dict[str, Any]]:
    section = soup.find("section", class_="footnotes")
    if not section:
        return []
    out = []
    for li in section.find_all("li"):
        fid = li.get("id", "").replace("fn", "")
        # Strip the "back-link" arrow ↩︎ from the displayed html.
        for back in li.find_all("a", class_="footnote-back"):
            back.decompose()
        out.append({"id": fid, "html": annotate_inline(inner_html(li)).strip()})
    section.decompose()  # remove from main flow
    return out


def extract_references(refs_section: dict[str, Any]) -> dict[str, list[dict[str, str]]]:
    """The References H1 contains H2 headings 'Chapter N' followed by a single
    blockquote of <p> entries."""
    by_chapter: dict[str, list[dict[str, str]]] = {}
    for sub in refs_section.get("subsections", []):
        title = sub["title"]
        m = re.match(r"Chapter\s+(\d+)", title, re.I)
        chapter_key = m.group(1) if m else slugify(title)
        entries = []
        for b in sub["blocks"]:
            if b.get("type") == "blockquote":
                for inner in b.get("blocks", []):
                    if inner.get("type") == "paragraph":
                        entries.append({"html": inner["html"]})
            elif b.get("type") == "paragraph":
                entries.append({"html": b["html"]})
        by_chapter[chapter_key] = entries
    return by_chapter


# ---------------------------------------------------------------------------
# image handling


IMG_SRC_RE = re.compile(r'src="media/([^"]+)"')


def rewrite_image_paths(text: str) -> str:
    """Rewrite `media/foo.png` -> `assets/foo.png` in serialized HTML."""
    return IMG_SRC_RE.sub(r'src="assets/\1"', text)


def rewrite_blocks(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {k: rewrite_blocks(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [rewrite_blocks(x) for x in obj]
    if isinstance(obj, str):
        # rewrite both inline html and bare src="..."
        s = rewrite_image_paths(obj)
        if s.startswith("media/"):
            s = "assets/" + s[len("media/"):]
        return s
    return obj


def copy_assets() -> list[str]:
    OUT_ASSETS.mkdir(parents=True, exist_ok=True)
    names = []
    for src in sorted(SRC_MEDIA.iterdir()):
        if src.is_file():
            shutil.copy2(src, OUT_ASSETS / src.name)
            names.append(src.name)
    return names


# ---------------------------------------------------------------------------
# main


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    OUT_CHAPTERS.mkdir(parents=True, exist_ok=True)

    soup = BeautifulSoup(HTML_PATH.read_text(encoding="utf-8"), "lxml")
    body = soup.body or soup

    # 1) Extract footnotes section (so it doesn't pollute the main flow).
    footnotes = extract_footnotes(soup)

    # 2) Group top-level nodes by H1.
    flat = [n for n in body.children if isinstance(n, Tag) or (isinstance(n, NavigableString) and str(n).strip())]
    h1_groups = split_by_heading(flat, 1)

    # 3) Parse each H1 group.
    sections: list[dict[str, Any]] = []
    refs_section: dict[str, Any] | None = None
    for h, body_nodes in h1_groups:
        if h is None:
            # preamble (title page)
            continue
        title = text_of(h)
        kind, chap_num, clean_title = classify_section(title)

        # Build a synthetic container holding body_nodes.
        tmp = BeautifulSoup("<div></div>", "lxml").div
        for n in body_nodes:
            if isinstance(n, Tag):
                tmp.append(n.__copy__())
            else:
                tmp.append(NavigableString(str(n)))

        section_obj = parse_subsection(h, body_nodes, level=1)
        section_obj["kind"] = kind
        section_obj["number"] = chap_num
        section_obj["title"] = clean_title

        if title.strip().lower() == "references":
            refs_section = section_obj
            continue
        sections.append(section_obj)

    # 3.5) Patch in Figure 1.1.
    #
    # The source docx is missing the body of Figure 1.1 — only its caption
    # appears in the table-of-contents links, never as an actual figure block.
    # Pandoc still extracts its image (image21.png) but leaves it disconnected.
    # Until the docx is fixed, we inject the figure into Chapter 1 after the
    # first paragraph that references it.
    _patch_figure_1_1(sections)

    # 4) Pull out structured author/reviewer lists from front matter.
    authors: list[dict[str, str]] = []
    reviewers: list[dict[str, str]] = []
    for s in sections:
        if s["title"].lower() == "report authors":
            authors = extract_authors(s["blocks"])
        elif s["title"].lower() == "review":
            reviewers = extract_reviewers(s["blocks"])

    # 5) References.
    references = extract_references(refs_section) if refs_section else {}

    # 6) Copy assets and rewrite paths.
    asset_names = copy_assets()
    sections = rewrite_blocks(sections)
    footnotes = rewrite_blocks(footnotes)
    references = rewrite_blocks(references)

    # 7) Build the document object.
    doc = {
        "schemaVersion": "1.0",
        "meta": {
            "title": "Technical Report on Mirror Bacteria: Feasibility and Risks",
            "publishDate": "December, 2024",
            "license": "CC BY-NC-SA 4.0",
            "doi": "10.1126/science.ads9158",
            "contact": "technical-report@mbdialogues.org",
        },
        "authors": authors,
        "reviewers": reviewers,
        "sections": sections,
        "footnotes": footnotes,
        "references": references,
        "assets": asset_names,
    }

    # 8) Write the full doc.
    full_path = OUT_DIR / "report.json"
    full_path.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")

    # 9) Write a slim index plus per-section files for lazy loading.
    index = {
        "schemaVersion": doc["schemaVersion"],
        "meta": doc["meta"],
        "authors": doc["authors"],
        "reviewers": doc["reviewers"],
        "toc": [
            {
                "id": s["id"],
                "kind": s["kind"],
                "number": s["number"],
                "title": s["title"],
                "subsections": [
                    {"id": ss["id"], "title": ss["title"], "level": ss["level"]}
                    for ss in s.get("subsections", [])
                ],
            }
            for s in sections
        ],
        "assets": asset_names,
    }
    (OUT_DIR / "index.json").write_text(
        json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    for s in sections:
        (OUT_CHAPTERS / f"{s['id']}.json").write_text(
            json.dumps(s, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    (OUT_DIR / "footnotes.json").write_text(
        json.dumps(footnotes, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (OUT_DIR / "references.json").write_text(
        json.dumps(references, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    # Console summary.
    n_blocks = sum(_count_blocks(s) for s in sections)
    print(f"Wrote {full_path}  ({full_path.stat().st_size:,} bytes)")
    print(f"  sections   : {len(sections)}")
    print(f"  authors    : {len(authors)}")
    print(f"  reviewers  : {len(reviewers)}")
    print(f"  footnotes  : {len(footnotes)}")
    print(f"  reference chapters : {len(references)}  (entries: {sum(len(v) for v in references.values())})")
    print(f"  total blocks       : {n_blocks}")
    print(f"  assets copied      : {len(asset_names)} -> {OUT_ASSETS}")


_FIGURE_1_1: dict[str, Any] = {
    "type": "figure",
    "id": "figure-1.1-chiral-molecules-have-non-superimposable-mirror-images",
    "src": "media/image21.png",  # rewritten to assets/ later in main()
    "alt": "",
    "width": None,
    "height": None,
    "caption": {
        "id": "figure-1.1-chiral-molecules-have-non-superimposable-mirror-images",
        "title": "Figure 1.1: Chiral molecules have non-superimposable mirror images",
        "title_html": "Figure 1.1: Chiral molecules have non-superimposable mirror images",
        "body_html": (
            "<p><strong>A.</strong> The amino acid glycine is an achiral molecule, "
            "as it can be superimposed on its mirror image. "
            "<strong>B.</strong> All other canonical amino acids are chiral "
            "molecules, with two non-superimposable mirror images. Alanine is "
            "illustrated as an example. Even if ᴅ-alanine is rotated 180° "
            "so its amino and carboxyl groups are in the same orientation as "
            "ʟ-alanine, as shown in the figure, the two cannot be "
            "superimposed because the methyl group in ʟ-alanine is "
            "projecting into the page but the methyl group in ᴅ-alanine is "
            "projecting out of the page.</p>"
        ),
    },
}


def _patch_figure_1_1(sections: list[dict[str, Any]]) -> None:
    """Inject Figure 1.1 into Chapter 1.

    Per the desired placement, the figure follows the paragraph that ends
    "forms an opposite-handed double helix" (paragraph about mirror DNA).
    """
    for sec in sections:
        if sec.get("id") != "chapter-1-introduction":
            continue
        blocks = sec.get("blocks", [])
        # Already present? (e.g. docx was fixed.)
        for b in blocks:
            if isinstance(b, dict) and b.get("id", "").startswith("figure-1.1"):
                return
        insert_at = None
        for i, b in enumerate(blocks):
            html_text = b.get("html", "") if isinstance(b, dict) else ""
            normalized = re.sub(r"\s+", " ", html_text)
            if "opposite-handed double helix" in normalized:
                insert_at = i + 1
                break
        if insert_at is None:
            # Fall back: after the first block referencing "Figure 1.1".
            for i, b in enumerate(blocks):
                html_text = b.get("html", "") if isinstance(b, dict) else ""
                if "figure-1.1" in html_text or "Figure 1.1" in html_text:
                    insert_at = i + 1
                    break
        if insert_at is None:
            # Last-resort: after the byline paragraphs.
            insert_at = 0
            for i, b in enumerate(blocks):
                h = b.get("html", "") if isinstance(b, dict) else ""
                if h.startswith("<em>"):
                    insert_at = i + 1
                else:
                    break
        blocks.insert(insert_at, dict(_FIGURE_1_1))
        return


def _count_blocks(s: dict[str, Any]) -> int:
    n = len(s.get("blocks", []))
    for sub in s.get("subsections", []):
        n += _count_blocks(sub)
    return n


if __name__ == "__main__":
    main()
