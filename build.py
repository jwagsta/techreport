#!/usr/bin/env python3
"""Build the static report site from data/ (parser output) into site/.

Schema (parser v1.0 — see parser/README.md for the canonical reference):

  data/index.json                  {schemaVersion, meta, authors, reviewers, toc, assets}
  data/chapters/<id>.json          {id, kind, number, level, title, title_html,
                                    blocks, subsections}
  data/footnotes.json              [{id, html}, ...]
  data/references.json             {"1": [{html}, ...], "2": [...]}
  data/assets/                     figure images (referenced as `assets/<name>.png`)

Block types emitted by the parser:
  paragraph    {type, html}                       inline HTML
  heading      {type, level (4–6), id, text, html}
  figure       {type, id, src, alt, width, height,
                caption: {id, title, title_html, body_html}}
  table        {type, html [, kind: "affiliations"]}
  box          {type, id, label, title, blocks}   parser lifts box-callouts here
  list         {type, ordered, start, items: [{html}]}
  blockquote   {type, blocks: [...]}              recursive
  image        {type, src}                        bare image
  hr           {type}
  raw          {type, html}                       parser fallback

Inline annotations the parser adds to <a> elements:
  data-citation="paperpile"        → external citation link (Paperpile DOI)
  data-footnote-ref="fnN"          → click target for footnote N
  data-footnote-back="1"           → back-link inside a footnote
"""

from __future__ import annotations

import html
import json
import os
import re
import shutil
from pathlib import Path

# ---------------------------------------------------------------------------
# Environment toggles
#   BUILD_PROD=1 — production build (skip /admin/* tools and admin-only JSON)
#   BASE_PATH=/foo — prefix for absolute URLs when the site is served from
#                    a sub-directory (GitHub Pages project sites: /<repo>)
# ---------------------------------------------------------------------------
IS_PROD = os.environ.get("BUILD_PROD") == "1"
BASE_PATH = os.environ.get("BASE_PATH", "").rstrip("/")

ROOT = Path(__file__).parent.resolve()
DATA = ROOT / "data"
INDEX_FILE = DATA / "index.json"
CHAPTERS_DIR = DATA / "chapters"
FOOTNOTES_FILE = DATA / "footnotes.json"
REFERENCES_FILE = DATA / "references.json"
ABSTRACTS_FILE = DATA / "abstracts.json"
ASSETS_SRC = DATA / "assets"

SITE = ROOT / "site"
SITE_ASSETS = ROOT / "site-assets"

CHAT_API_URL = os.environ.get("CHAT_API_URL", "")
TURNSTILE_SITE_KEY = os.environ.get("TURNSTILE_SITE_KEY", "")

# Headshot pipeline
HEADSHOT_SELECTIONS = DATA / "headshot-selections.json"
HEADSHOT_CACHE_DIR = ROOT / "data" / "headshots"
HEADSHOT_CACHE_INDEX = ROOT / "data" / "headshot-cache.json"

# Per-page render context (footnote lookup, citation map). Set by render_chapter_page.
_CTX: dict = {
    "footnotes_lookup": {},
    "fn_seen": set(),
    "cite_map": {},
    "chapter_num": 0,
    "media_prefix": "../",  # "../" for chapter pages, "" for the index page
}


# ============================================================
# Citations — author-year patterns in body text linked to bibliography
# ============================================================

# A reference's leading "Lastname, F. M.," or "Lastname, F. M., & Other" → first author last name.
_REF_LEAD_RE = re.compile(r"^\s*([A-ZÀ-Ÿ][\wÀ-ÿ'\-]+)(?:[,\s]|<)")

# Year inside reference: first 4-digit number after the leading author.
_REF_YEAR_RE = re.compile(r"\((\d{4})[a-z]?\)")

# Pull DOIs out of reference HTML.
_DOI_RE = re.compile(r"\b(10\.\d{4,9}/[^\s<>\"\)]+)", re.I)

# Pull explicit hrefs out of reference HTML.
_HREF_RE = re.compile(r'href="(https?://[^"]+)"', re.I)

# Match plain-text URLs in reference HTML so we can wrap them in <a> tags.
# Negative lookbehind avoids re-wrapping URLs already inside an href= attribute.
_PLAIN_URL_RE = re.compile(r'(?<!href=")(?<!href=\')\bhttps?://[^\s<"\']+', re.I)


def _linkify_urls(s: str) -> str:
    """Wrap bare https?:// URLs in <a> tags. Trailing punctuation (.,;) is
    preserved outside the link so e.g. "see https://x.org/foo." doesn't
    swallow the period."""
    def repl(m: re.Match[str]) -> str:
        url = m.group(0)
        trail = ""
        while url and url[-1] in ".,;:)]":
            trail = url[-1] + trail
            url = url[:-1]
        if not url:
            return m.group(0)
        return (
            f'<a href="{html.escape(url, quote=True)}" target="_blank" '
            f'rel="noopener noreferrer">{html.escape(url)}</a>{trail}'
        )
    return _PLAIN_URL_RE.sub(repl, s)


def _ref_text(ref_html: str) -> str:
    return re.sub(r"<[^>]+>", "", ref_html).replace("\xa0", " ")


# Some abstract HTML records start with a redundant "Abstract" header.
# We see four flavours, all stripped so the bibliography and drawer
# don't render "ABSTRACT" twice:
#   (a) standalone:  <p>Abstract</p><p>real abstract …</p>
#   (b) bare-text:   Abstract <p>real abstract …</p>
#   (c) inline:      <p>Abstract: real abstract …</p>  / <p>Abstract Foo …</p>
#   (d) noisy lead:  <p>▪ Abstract Foo …</p>  /  <p>Abstract\n Foo …</p>
#                    (literal backslash-n; bullet characters before)
# The boundary after "abstract" accepts colon, period, whitespace, a
# literal backslash-n sequence, or zero-width before `<` / capital letter.
_ABS_HEADER_BOUNDARY = (
    r'(?:\s*[:.]\s*|(?:\s|\\n)+(?=[<A-Z])|(?=[<A-Z]))'
)
_LEAD_NOISE = r'[^A-Za-z<]*'  # bullets / spaces / punctuation before the word
_ABS_HEADER_STANDALONE_RE = re.compile(
    r'^\s*<p[^>]*>' + _LEAD_NOISE
    + r'(?:<(?:strong|b|em)[^>]*>\s*)?'
    + r'abstract\s*[:.]?\s*'
    + r'(?:</(?:strong|b|em)>\s*)?'
    + r'</p>\s*',
    re.IGNORECASE,
)
_ABS_HEADER_BARE_RE = re.compile(
    r'^' + _LEAD_NOISE
    + r'(?:<(?:strong|b|em)[^>]*>\s*)?'
    + r'abstract'
    + _ABS_HEADER_BOUNDARY
    + r'(?:</(?:strong|b|em)>\s*)?',
    re.IGNORECASE,
)
_ABS_HEADER_INLINE_RE = re.compile(
    r'^(\s*<p[^>]*>)' + _LEAD_NOISE
    + r'(?:<(?:strong|b|em)[^>]*>\s*)?'
    + r'abstract'
    + _ABS_HEADER_BOUNDARY
    + r'(?:</(?:strong|b|em)>\s*)?',
    re.IGNORECASE,
)


def _strip_abstract_header(s: str) -> str:
    if not s:
        return s
    s = _ABS_HEADER_STANDALONE_RE.sub("", s, count=1)
    s = _ABS_HEADER_BARE_RE.sub("", s, count=1)
    s = _ABS_HEADER_INLINE_RE.sub(r"\1", s, count=1)
    return s


# Same key the abstracts pipeline (tools/fetch_abstracts.py) hashes — kept in
# lockstep so build-time lookups hit. If you change one, change the other.
def _abstract_key(ref_html: str) -> str:
    import hashlib
    norm = re.sub(r"\s+", " ", _ref_text(ref_html)).strip().lower()
    return hashlib.sha1(norm.encode("utf-8")).hexdigest()[:16]


def _extract_doi(ref_html: str) -> str | None:
    m = _DOI_RE.search(_ref_text(ref_html))
    if m:
        return m.group(1).rstrip(".,;")
    return None


def _extract_url(ref_html: str) -> str | None:
    m = _HREF_RE.search(ref_html)
    if m:
        return m.group(1)
    doi = _extract_doi(ref_html)
    if doi:
        return f"https://doi.org/{doi}"
    return None


def build_citation_map(references_by_chapter: dict) -> dict:
    """Map (chapter_num, last_name_lower, year) → {idx, html, doi, url}."""
    out: dict[tuple[int, str, str], dict] = {}
    for chap_str, entries in references_by_chapter.items():
        try:
            chap_num = int(chap_str)
        except (TypeError, ValueError):
            continue
        for idx, entry in enumerate(entries):
            ref_html = entry.get("html", "") if isinstance(entry, dict) else str(entry)
            text = _ref_text(ref_html)
            lead = _REF_LEAD_RE.match(text)
            year = _REF_YEAR_RE.search(text)
            if not (lead and year):
                continue
            last = lead.group(1).lower()
            yr = year.group(1)
            key = (chap_num, last, yr)
            if key in out:
                continue  # first match wins
            out[key] = {
                "idx": idx,
                "html": ref_html,
                "doi": _extract_doi(ref_html),
                "url": _extract_url(ref_html),
            }
    return out


# Match patterns like:
#   Joyce, 1984
#   Joyce 1984
#   Joyce et al., 1984
#   Joyce & Cleaves 2010
#   Joyce and Cleaves, 2010
# Year may be 1900–2099, optionally followed by a letter (1984a).
_CITE_RE = re.compile(
    r"""
    (?<![\w])
    (?P<initials>(?:[A-Z]\.\s*){0,3})         # optional leading initials, e.g. "Y. " or "B. E. "
    (?P<author>
        [A-Z][\w'\-]+
        (?:
            \s+(?:&amp;|&)\s+(?:[A-Z]\.\s*)*[A-Z][\w'\-]+
          | \s+and\s+(?:[A-Z]\.\s*)*[A-Z][\w'\-]+
          | \s*<em>[^<]*?et\s+al[^<]*?</em>\.?
          | \s+et\s+al\.?
          | (?:\s+[A-Z][\w'\-]+){1,4}      # multi-word org names ("United Nations …")
        )?
    )
    [\s,]*
    \(?(?P<year>(?:19|20)\d{2})(?P<suffix>[a-z])?\)?
    """,
    re.VERBOSE,
)


def link_citations(s: str) -> str:
    chap_num = _CTX.get("chapter_num") or 0
    cite_map = _CTX.get("cite_map") or {}
    if not chap_num or not cite_map:
        return s

    # Skip text inside existing <a>…</a> or <sup>…</sup> tags so we don't
    # double-link footnote refs / existing anchors.
    def walk(text):
        out = []
        i = 0
        skip_re = re.compile(r"<(a|sup)\b[^>]*>.*?</\1>", re.I | re.S)
        for m in skip_re.finditer(text):
            out.append(_link_citations_run(text[i:m.start()]))
            out.append(text[m.start():m.end()])
            i = m.end()
        out.append(_link_citations_run(text[i:]))
        return "".join(out)

    return walk(s)


def _link_citations_run(text: str) -> str:
    """Apply citation linking to a span of text outside of <a>/<sup> tags."""
    chap_num = _CTX["chapter_num"]
    cite_map = _CTX["cite_map"]

    def repl(m):
        author = m.group("author")
        year = m.group("year")
        # First author's last name = first word of the author group
        last = re.match(r"[A-Z][\w'\-]+", author).group(0).lower()
        ref = cite_map.get((chap_num, last, year))
        if not ref:
            return m.group(0)
        return (
            f'<a class="cite" data-cite="{chap_num}:{ref["idx"]}" '
            f'href="#references" tabindex="0">{m.group(0)}</a>'
        )
    return _CITE_RE.sub(repl, text)


# ============================================================
# Inline transforms (HTML rewrites)
# ============================================================

# Annotate parser-emitted footnote-ref anchors so the drawer JS can intercept them.
FN_REF_RE = re.compile(
    r'<a([^>]*?)data-footnote-ref="fn(\d+)"([^>]*)>(.*?)</a>',
    re.I | re.S,
)

# Tag in-page anchor links so the drawer JS can intercept them.
INTERNAL_LINK_RE = re.compile(r'<a\s+href="#([^"]+)"([^>]*)>')

# Image paths in inline HTML need to walk up one level (chapter pages live one dir down).
ASSET_SRC_RE = re.compile(r'src="(assets/[^"]+)"')

# Paperpile anchors wrap multi-citation parentheses in body text. We unwrap
# them so each individual "Author, year" citation inside can be linked to
# the bibliography. The paperpile URL itself is not in our public data, so
# stripping it is no real loss.
PAPERPILE_RE = re.compile(
    r'<a\s+data-citation="paperpile"[^>]*>(.*?)</a>',
    re.I | re.S,
)


def unwrap_paperpile(s: str) -> str:
    return PAPERPILE_RE.sub(lambda m: m.group(1), s)


def transform_footnote_refs(s: str, used_fns: set[str]) -> str:
    def repl(m):
        before, num, after, body = m.group(1), m.group(2), m.group(3), m.group(4)
        used_fns.add(num)
        # Strip the original href so our handler is the source of truth, but
        # keep the anchor for accessibility / no-JS fallback.
        return (
            f'<a class="refn" data-fn="{num}" '
            f'href="#fn-{num}">{num}</a>'
        )
    return FN_REF_RE.sub(repl, s)


def transform_internal_links(s: str) -> str:
    def repl(m):
        target = m.group(1)
        rest = m.group(2)
        return f'<a class="ilink" data-target="{target}" href="#{target}"{rest}>'
    return INTERNAL_LINK_RE.sub(repl, s)


def rewrite_assets(s: str) -> str:
    prefix = _CTX.get("media_prefix", "")
    return ASSET_SRC_RE.sub(lambda m: f'src="{prefix}{m.group(1)}"', s)


def process_inline(s: str, used_fns: set[str]) -> str:
    return rewrite_assets(
        transform_internal_links(
            link_citations(
                unwrap_paperpile(
                    transform_footnote_refs(s, used_fns)
                )
            )
        )
    )


def clean_ws(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


# ============================================================
# Block renderers — one per documented type
# ============================================================

def render_paragraph(b: dict, used_fns: set[str]) -> str:
    raw = b.get("html", "")
    # Footnotes referenced in this paragraph are emitted as Tufte-style sidenotes
    # in the same grid row (so they sit next to their anchor in the right margin).
    fn_nums = []
    seen_in_para: set[str] = set()
    for m in re.finditer(r'data-footnote-ref="fn(\d+)"', raw):
        n = m.group(1)
        if n not in seen_in_para:
            seen_in_para.add(n)
            fn_nums.append(n)
    inner = process_inline(raw, used_fns)
    sidenote_html = ""
    if fn_nums:
        notes = []
        for n in fn_nums:
            body_html = _CTX["footnotes_lookup"].get(n)
            if not body_html:
                continue
            # Run footnote bodies through citation linking + internal-link transform
            # so cites like "(Martel, 2006)" inside notes are wired up too.
            # Skip the footnote-ref transform (don't recursively anchor footnote
            # markers within footnotes themselves).
            processed_body = rewrite_assets(
                transform_internal_links(
                    link_citations(unwrap_paperpile(body_html))
                )
            )
            # Anchor target id="fn-N" only on first occurrence in document.
            id_attr = ""
            if n not in _CTX["fn_seen"]:
                _CTX["fn_seen"].add(n)
                id_attr = f' id="fn-{n}"'
            notes.append(
                f'<aside class="sidenote"{id_attr} data-fn="{n}">'
                f'<span class="num">{n}</span>'
                f'<span class="text">{processed_body}</span>'
                '</aside>'
            )
        if notes:
            sidenote_html = f'<div class="row-sidenotes">{"".join(notes)}</div>'
    return f'<div class="row"><p class="prose">{inner}</p>{sidenote_html}</div>'


def render_heading(b: dict, used_fns: set[str]) -> str:
    level = max(3, min(int(b.get("level", 4) or 4), 6))
    bid = b.get("id") or ""
    inner = process_inline(b.get("html", ""), used_fns)
    id_attr = f' id="{html.escape(bid)}"' if bid else ""
    return f'<div class="row"><h{level} class="inline-heading"{id_attr}>{inner}</h{level}></div>'


def render_figure(b: dict, used_fns: set[str]) -> str:
    src = b.get("src", "")
    if src.startswith("assets/"):
        src = "../" + src
    alt = b.get("alt", "") or ""
    fid = b.get("id", "") or ""
    caption = b.get("caption") or {}
    title = clean_ws(caption.get("title") or "")
    body = process_inline(caption.get("body_html", "") or "", used_fns)
    m = re.match(r"^(Figure\s+[\d.]+)\s*[:.]\s*(.*)$", title)
    if m:
        label, sub = m.group(1), m.group(2)
    else:
        label, sub = title, ""
    title_span = (
        f'<span class="figtitle">{html.escape(sub)}</span>' if sub else ""
    )
    return (
        f'<figure class="row figrow" id="{html.escape(fid)}">'
        f'<img src="{html.escape(src)}" alt="{html.escape(alt)}" loading="lazy">'
        f'<figcaption>'
        f'<b>{html.escape(label)}</b>'
        f'{title_span}'
        f'{body}'
        f'</figcaption>'
        f'</figure>'
    )


_TABLE_CAP_RE = re.compile(
    r'<tr>\s*<th\s+colspan="\d+"[^>]*>\s*'
    r'<h5\s+id="(table-[^"]+)"[^>]*>(.+?)</h5>\s*'
    r'(.*?)</th>\s*</tr>',
    re.DOTALL,
)
_TABLE_LABEL_RE = re.compile(r'^(Table\s+[\d.]+)\s*:?\s*(.*)$', re.DOTALL)


def render_table(b: dict, used_fns: set[str]) -> str:
    if b.get("kind") == "affiliations":
        return ""  # parser-marked: skip in main flow
    raw = b.get("html", "")
    cap_html = ""
    m = _TABLE_CAP_RE.search(raw)
    if m:
        table_id = m.group(1)
        title_inner = clean_ws(m.group(2))
        rest_inner = m.group(3).strip()
        nm = _TABLE_LABEL_RE.match(title_inner)
        if nm:
            label_num = nm.group(1).strip()
            label_text = clean_ws(nm.group(2)).strip()
        else:
            label_num, label_text = title_inner, ""
        body_html = process_inline(rest_inner, used_fns) if rest_inner else ""
        # label_text and label_num both come straight out of the parser's HTML
        # so they may already contain inline tags like <em>...</em>. Do NOT
        # re-escape; emit as-is. Run process_inline so any embedded citations
        # / footnote refs / internal links get linked the same as body text.
        title_span = (
            f'<span class="figtitle">{process_inline(label_text, used_fns)}</span>'
            if label_text else ""
        )
        cap_html = (
            f'<figcaption class="tablecap" id="{html.escape(table_id)}">'
            f'<b>{label_num}</b>'
            f'{title_span}'
            f'{body_html}'
            f'</figcaption>'
        )
        # Strip the matched label row from the table HTML so it isn't double-rendered.
        raw = raw[:m.start()] + raw[m.end():]
        # If the thead is now empty, remove it.
        raw = re.sub(r'<thead>\s*</thead>', '', raw, count=1)
    inner = process_inline(raw, used_fns)
    return f'<div class="row tablerow">{inner}{cap_html}</div>'


def render_box(b: dict, used_fns: set[str]) -> str:
    bid = html.escape(b.get("id", "") or "")
    label = html.escape(b.get("label", "Box"))
    title = html.escape(clean_ws(b.get("title", "")))
    body = "".join(render_block(child, used_fns) for child in b.get("blocks", []))
    # Strip the surrounding .row wrappers from child paragraphs since we're already inside a box card.
    body = re.sub(r'<div class="row">(<p[^>]*>.*?</p>)</div>', r'\1', body, flags=re.S)
    return (
        f'<aside class="row boxrow callout" id="{bid}">'
        f'<div class="box-label">{label}</div>'
        f'<h4 class="box-title">{title}</h4>'
        f'<div class="box-body">{body}</div>'
        f'</aside>'
    )


def render_list(b: dict, used_fns: set[str]) -> str:
    tag = "ol" if b.get("ordered") else "ul"
    start_attr = ""
    if b.get("ordered") and b.get("start") and int(b["start"]) != 1:
        start_attr = f' start="{int(b["start"])}"'
    items = []
    for item in b.get("items", []):
        h_ = item.get("html", "") if isinstance(item, dict) else str(item)
        items.append(f'<li>{process_inline(h_, used_fns)}</li>')
    return (
        f'<div class="row listrow">'
        f'<{tag} class="prose-list"{start_attr}>{"".join(items)}</{tag}>'
        f'</div>'
    )


def render_blockquote(b: dict, used_fns: set[str]) -> str:
    inner = "".join(render_block(child, used_fns) for child in b.get("blocks", []))
    inner = re.sub(r'<div class="row">(.*?)</div>', r'\1', inner, flags=re.S)
    return f'<blockquote class="row prose-quote">{inner}</blockquote>'


def render_image(b: dict, used_fns: set[str]) -> str:
    src = b.get("src", "")
    if src.startswith("assets/"):
        src = "../" + src
    return f'<div class="row imgrow"><img src="{html.escape(src)}" alt="" loading="lazy"></div>'


def render_hr(b: dict, used_fns: set[str]) -> str:
    return '<hr class="row prose-hr">'


def render_raw(b: dict, used_fns: set[str]) -> str:
    inner = process_inline(b.get("html", "") or "", used_fns)
    return f'<div class="row rawrow">{inner}</div>'


_BLOCK_RENDERERS = {
    "paragraph":  render_paragraph,
    "heading":    render_heading,
    "figure":     render_figure,
    "table":      render_table,
    "box":        render_box,
    "list":       render_list,
    "blockquote": render_blockquote,
    "image":      render_image,
    "hr":         render_hr,
    "raw":        render_raw,
}


def render_block(b, used_fns: set[str]) -> str:
    if not isinstance(b, dict):
        return ""
    fn = _BLOCK_RENDERERS.get(b.get("type", ""))
    return fn(b, used_fns) if fn else ""


# ============================================================
# Chapter authors — parsed from leading byline paragraphs
# ============================================================

NAME_RE = re.compile(r"([A-Z][\w'\-]+(?:\s+[A-Z]\.)*\s+[A-Z][\w'\-]+)\s*<sup>")


def is_byline_paragraph(b: dict) -> bool:
    if b.get("type") != "paragraph":
        return False
    h = (b.get("html") or "").strip()
    return h.startswith("<em>") and "<sup>" in h


def parse_chapter_authors(blocks: list, all_authors: dict) -> tuple[list[dict], int]:
    consumed = 0
    raw = ""
    for b in blocks:
        if is_byline_paragraph(b):
            raw += " " + (b.get("html") or "")
            consumed += 1
        else:
            break
    if not raw:
        return [], 0
    seen = set()
    matches: list[dict] = []
    for name in NAME_RE.findall(raw):
        if name in seen:
            continue
        seen.add(name)
        if name in all_authors:
            matches.append(all_authors[name])
        else:
            parts = name.split()
            last = parts[-1]
            for full, info in all_authors.items():
                if full.endswith(last) and full.split()[0][0] == parts[0][0]:
                    matches.append(info)
                    break
    return matches, consumed


def initials_of(name: str) -> str:
    parts = [p for p in (name or "").split() if p]
    if not parts:
        return "·"
    first = parts[0][0]
    last = parts[-1][0] if len(parts) > 1 else ""
    return (first + last).upper()


def _face_style(name: str) -> tuple[str, bool]:
    """Return (inline-style-string, has_image) for the .face element."""
    info = _CTX.get("headshots", {}).get(name)
    if not info:
        return "", False
    file_url = info["url"]
    crop = info["crop"]
    w, h = info["width"], info["height"]
    if w <= 0 or h <= 0:
        return "", False
    size = max(0.0001, float(crop.get("size", 1.0)))
    x = float(crop.get("x", 0.0))
    y = float(crop.get("y", 0.0))
    r = h / w  # image aspect ratio (height / width)
    # bg-size width as percent of face width: (1/size)*100
    bg_size_pct = (1.0 / size) * 100.0
    # bg-position-x % (works for any image, since x is fraction of width and crop side scales width):
    if size >= 1:
        bg_x = 0.0
    else:
        bg_x = (x / (1.0 - size)) * 100.0
    # bg-position-y % depends on image aspect ratio:
    #   bgPosY% = (c.y * r) / (r - size) * 100
    if abs(r - size) < 1e-9:
        bg_y = 0.0
    else:
        bg_y = (y * r) / (r - size) * 100.0
    return (
        f'style="--head-img:url(\'{file_url}\');'
        f'--head-bg-size:{bg_size_pct:.3f}% auto;'
        f'--head-bg-pos:{bg_x:.3f}% {bg_y:.3f}%"'
    ), True


def author_card(a: dict, role: str = "author") -> str:
    name = a.get("name", "")
    aff = a.get("affiliation", "")
    style, has_img = _face_style(name)
    face_attrs = ' data-headshot="1"' if has_img else ""
    face_inner = "" if has_img else html.escape(initials_of(name))
    safe_name = html.escape(name)
    safe_aff = html.escape(aff)
    safe_role = html.escape(role)
    return (
        '<div class="author" tabindex="0" role="button" '
        f'data-author-name="{safe_name}" data-author-aff="{safe_aff}" '
        f'data-author-role="{safe_role}">'
        f'<div class="face"{face_attrs} {style} aria-hidden="true">{face_inner}</div>'
        f'<div class="who"><b>{safe_name}</b><span>{safe_aff}</span></div>'
        '</div>'
    )


# ============================================================
# Footnote rendering
# ============================================================

def render_footnote(num: str, body_html: str) -> str:
    return (
        f'<aside class="sidenote" id="fn-{num}" data-fn="{num}">'
        f'<span class="num">{num}</span>'
        f'<span class="text">{body_html}</span>'
        '</aside>'
    )


# ============================================================
# Recursive subsection rendering
# ============================================================

def strip_leading_number(title: str, number: str) -> str:
    """Strip a leading "<number><sep>" prefix from a title (e.g. "2.2 Foo" → "Foo")."""
    if not number or not title:
        return title
    pat = re.compile(r"^\s*" + re.escape(number) + r"[.\s)\-:]*", re.I)
    return pat.sub("", title).strip()


def render_subsection(ss: dict, depth: int, used_fns: set[str], number: str = "") -> str:
    sid = html.escape(ss.get("id", ""))
    raw_title = strip_leading_number(clean_ws(ss.get("title", "")), number)
    title_h = html.escape(raw_title)
    h_tag = f"h{min(depth + 1, 6)}"
    num_html = (
        f'<span class="subsection-num">{html.escape(number)}</span> '
        if number else ""
    )
    level_cls = f"level-{depth}"
    parts = [
        f'<section class="subsection {level_cls}" id="{sid}">',
        '<div class="row">',
        f'<{h_tag} class="subsection-title">{num_html}{title_h}</{h_tag}>',
        '</div>',
    ]
    for b in ss.get("blocks", []):
        parts.append(render_block(b, used_fns))
    for i, child in enumerate(ss.get("subsections", []) or [], start=1):
        child_num = f"{number}.{i}" if number else ""
        parts.append(render_subsection(child, depth + 1, used_fns, child_num))
    parts.append('</section>')
    return "".join(parts)


# ============================================================
# Page templates
# ============================================================

PAGE_HEAD = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} — Technical Report on Mirror Bacteria</title>
<link rel="icon" type="image/svg+xml" href="{css_path}favicon.svg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;0,8..60,700;1,8..60,400&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="{css_path}styles.css">
<link rel="stylesheet" href="{css_path}chat.css">
<meta name="chat-api" content="{chat_api}">
<meta name="turnstile-site-key" content="{turnstile_site_key}">
<meta name="chapter-id" content="{chapter_id}">
<meta name="chapter-title" content="{chapter_title}">
</head>
<body>
"""

TOPSTRIP = """<header class="topstrip">
  <div class="inner">
    <div class="crumbs">
      <span class="brand-wrap">
        <a class="brand" href="{home}"><span class="brand-line1">Technical Report</span> <span class="brand-line2">on Mirror Bacteria</span></a>
        <nav class="chap-menu" aria-label="Chapters">
          <a class="chap-menu-home" href="{home}">About</a>
          <div class="chap-menu-sep"></div>
          {summary_menu_link}
          {chap_menu}
        </nav>
      </span>{narrow_crumb}
    </div>
    <button type="button" class="search-trigger" aria-label="Search the report" data-search-open>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
        <circle cx="7" cy="7" r="5"/>
        <path d="M11 11l3 3"/>
      </svg>
      <span>Search</span>
      <kbd>⌘K</kbd>
    </button>
  </div>
</header>"""

CHAPTER_TEMPLATE = """{head}{topstrip}
<main class="page {page_kind_class}">
  {report_contents}

  <section class="content">
    <header class="chap-header">
      {chapter_eyebrow}
      <h1 class="chap-title">{title}</h1>
      <div class="chap-meta">
        <span>Technical Report on Mirror Bacteria: Feasibility and Risks &middot; {publish_date}</span>
        <span class="chap-doi">DOI: <a href="https://doi.org/10.25740/cv716pj4036" rel="noopener" target="_blank">10.25740/cv716pj4036</a></span>
      </div>
    </header>

    {faculty_strip}

    <article class="body" id="body">
      {body_html}
    </article>

    {footnotes_html}

    {refs_html}
  </section>
</main>

<div class="drawer-scrim" id="scrim" onclick="closeDrawer()"></div>
<aside class="drawer" id="drawer" aria-label="Internal link preview" aria-hidden="true">
  <div class="dhead">
    <div class="src">
      <button class="back" id="d-back" onclick="drawerBack()" aria-label="Back">←</button>
      <button class="fwd" id="d-fwd" onclick="drawerForward()" aria-label="Forward">→</button>
      <span class="preview-label" id="d-preview-label">Preview</span>
      <span class="src-title" id="d-source">—</span>
    </div>
    <div class="dactions">
      <button id="d-jump" onclick="jumpThere()">Jump <span class="jump-arr">↗</span></button>
      <button class="x" onclick="closeDrawer()" aria-label="Close">×</button>
    </div>
  </div>
  <div class="dbody" id="d-body"></div>
</aside>

<script>{boot_script}</script>
<script src="{css_path}app.js"></script>
<script src="{css_path}search.js"></script>
<script src="{css_path}chat.js" defer></script>
</body>
</html>
"""

INDEX_TEMPLATE = """{head}{topstrip}
<main class="page index-page">
  <nav class="toc home-toc" aria-label="About">
    <div class="toc-label">About</div>
    <ol class="toc-onpage">
      {toc_items}
    </ol>
    <div class="toc-label toc-label-2">Report contents</div>
    <ol class="toc-chapters">
      {chap_toc_items}
    </ol>
  </nav>

  <section class="content">
    <header class="chap-header">
      <div class="eyebrow">{publish_date}</div>
      <h1 class="chap-title">{title}</h1>
      <div class="chap-doi">
        DOI:
        <a href="https://doi.org/10.25740/cv716pj4036" rel="noopener" target="_blank">10.25740/cv716pj4036</a>
      </div>
    </header>

    {site_context_html}

    {authors_strip_html}

    {abstract_html}

    {contents_html}

    {review_html}

    {about_html}

    {rationale_html}

    {ack_html}
  </section>
</main>

<div class="drawer-scrim" id="scrim" onclick="closeDrawer()"></div>
<aside class="drawer" id="drawer" aria-label="Preview" aria-hidden="true">
  <div class="dhead">
    <div class="src">
      <button class="back" id="d-back" onclick="drawerBack()" aria-label="Back">←</button>
      <button class="fwd" id="d-fwd" onclick="drawerForward()" aria-label="Forward">→</button>
      <span class="preview-label" id="d-preview-label">Preview</span>
      <span class="src-title" id="d-source">—</span>
    </div>
    <div class="dactions">
      <button id="d-jump" onclick="jumpThere()">Jump <span class="jump-arr">↗</span></button>
      <button class="x" onclick="closeDrawer()" aria-label="Close">×</button>
    </div>
  </div>
  <div class="dbody" id="d-body"></div>
</aside>

<script>{boot_script}</script>
<script src="app.js"></script>
<script src="search.js"></script>
<script src="chat.js" defer></script>
</body>
</html>
"""


def estimate_read_minutes(body_html: str) -> int:
    text = re.sub(r"<[^>]+>", " ", body_html)
    return max(1, round(len(text.split()) / 230))


# ============================================================
# Cross-page target map (id → chapter slug)
# ============================================================

def _build_chap_menu(chapters: list, home_prefix: str = "../") -> str:
    """Markup for the chapter dropdown — only numbered chapters (Summary is
    rendered above the separator alongside the About link)."""
    items = []
    for c in chapters:
        n = c.get("number")
        if not n:
            continue
        cid = c.get("id", "")
        t = clean_ws(c.get("title", ""))
        items.append(
            '<a class="chap-menu-item" href="{home}{cid}/">'
            '<span class="chap-menu-num">{n}</span>'
            '<span class="chap-menu-title">{t}</span>'
            '</a>'.format(home=home_prefix, cid=html.escape(cid), n=n, t=html.escape(t))
        )
    return "\n          ".join(items)


def _build_summary_menu_link(chapters: list, home_prefix: str = "../") -> str:
    """Render the Summary entry as a regular chapter row (empty num gutter,
    sentence-case title) so it visually aligns with the numbered chapters
    that follow it in the dropdown."""
    for c in chapters:
        if c.get("number") == 0:
            cid = c.get("id", "")
            return (
                '<a class="chap-menu-item" href="{home}{cid}/">'
                '<span class="chap-menu-num"></span>'
                '<span class="chap-menu-title">Summary</span>'
                '</a>'.format(home=home_prefix, cid=html.escape(cid))
            )
    return ""


def build_search_index(chapters: list) -> list[dict]:
    """One record per searchable block — used by the in-browser search."""
    records: list[dict] = []

    def text_of_html(s: str) -> str:
        s = re.sub(r"<[^>]+>", " ", s or "")
        return re.sub(r"\s+", " ", s).strip()

    def push(rec: dict) -> None:
        if rec.get("text"):
            records.append(rec)

    def walk_blocks(blocks, ctx):
        for b in blocks:
            if not isinstance(b, dict):
                continue
            t = b.get("type")
            if t == "paragraph":
                push({**ctx, "kind": "paragraph", "text": text_of_html(b.get("html", ""))})
            elif t == "figure":
                cap = b.get("caption") or {}
                push({
                    **ctx,
                    "kind": "figure",
                    "id": b.get("id", ""),
                    "title": clean_ws(cap.get("title", "")),
                    "text": text_of_html(cap.get("body_html", "")) or clean_ws(cap.get("title", "")),
                })
            elif t == "box":
                push({
                    **ctx,
                    "kind": "box",
                    "id": b.get("id", ""),
                    "title": f"{b.get('label','Box')}: {b.get('title','')}",
                    "text": " ".join(text_of_html(c.get("html", "") if isinstance(c, dict) else "")
                                       for c in b.get("blocks", [])),
                })
            elif t == "list":
                items = b.get("items", []) or []
                push({
                    **ctx,
                    "kind": "list",
                    "text": " ".join(text_of_html(it.get("html", "") if isinstance(it, dict) else "") for it in items),
                })
            elif t == "table":
                if b.get("kind") == "affiliations":
                    continue
                push({**ctx, "kind": "table", "text": text_of_html(b.get("html", ""))})

    for c in chapters:
        chap_ctx = {
            "chap": c.get("id", ""),
            "chapNum": c.get("number"),
            "chapTitle": clean_ws(c.get("title", "")),
            "section": c.get("id", ""),
            "sectionTitle": clean_ws(c.get("title", "")),
        }
        walk_blocks(c.get("blocks", []) or [], chap_ctx)

        def walk_subsections(subs, parent_ctx, num_prefix=""):
            for i, ss in enumerate(subs, start=1):
                ss_num = f"{num_prefix}.{i}" if num_prefix else f"{parent_ctx['chapNum']}.{i}" if parent_ctx.get("chapNum") else ""
                ss_ctx = {
                    **parent_ctx,
                    "section": ss.get("id", ""),
                    "sectionTitle": clean_ws(ss.get("title", "")),
                    "sectionNum": ss_num,
                }
                # The subsection title itself is a useful hit
                push({
                    **ss_ctx,
                    "kind": "heading",
                    "text": clean_ws(ss.get("title", "")),
                })
                walk_blocks(ss.get("blocks", []) or [], ss_ctx)
                walk_subsections(ss.get("subsections", []) or [], ss_ctx, ss_num)

        walk_subsections(c.get("subsections", []) or [], chap_ctx)

    return records


def collect_target_map(chapters: list) -> dict[str, str]:
    target_map: dict[str, str] = {}

    def walk(node, slug):
        if isinstance(node, dict):
            nid = node.get("id")
            if nid:
                target_map.setdefault(nid, slug)
            for k in ("blocks", "subsections", "items"):
                v = node.get(k)
                if isinstance(v, list):
                    for child in v:
                        walk(child, slug)
            cap = node.get("caption")
            if isinstance(cap, dict):
                walk(cap, slug)

    for c in chapters:
        slug = c.get("id", "")
        target_map[slug] = slug
        for b in c.get("blocks", []):
            walk(b, slug)
        for ss in c.get("subsections", []) or []:
            walk(ss, slug)
    return target_map


# ============================================================
# Page assembly
# ============================================================

def render_report_contents(
    chapters: list,
    current_slug: str,
    current_sections: list,  # [{id, num, title}]
    has_refs: bool,
    has_summary: bool = False,
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
            f'{num_html}'
            f'<span class="rc-title">{html.escape(ctitle)}</span>'
            f'</a>'
        )
        if is_current:
            if has_summary:
                rows.append(
                    '<a class="rc-sec rc-summary" href="#summary" '
                    'data-fulltitle="Summary">'
                    '<span class="rc-secn"></span>'
                    '<span class="rc-sectitle">Summary</span>'
                    '</a>'
                )
            for s in current_sections:
                sid = s.get("id", "")
                snum = s.get("num", "") or ""
                stitle = clean_ws(s.get("title", "") or "")
                num_span = (
                    f'<span class="rc-secn">{html.escape(snum)}</span>'
                    if snum else '<span class="rc-secn"></span>'
                )
                full = f"{snum}   {stitle}".strip() if snum else stitle
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


def render_chapter_page(
    chapter: dict,
    publish_date: str,
    all_authors: dict,
    references: list,
    footnotes_lookup: dict,
    target_map: dict,
    css_path: str,
    home: str,
) -> str:
    n = chapter.get("number")
    title = (chapter.get("title") or "").strip()
    used_fns: set[str] = set()

    # Reset per-page context.
    _CTX["footnotes_lookup"] = footnotes_lookup
    _CTX["fn_seen"] = set()
    _CTX["cite_map"] = _CTX.get("cite_map", {})  # set by main()
    _CTX["chapter_num"] = n or 0
    _CTX["media_prefix"] = "../"

    blocks = chapter.get("blocks", []) or []
    chap_authors, byline_consumed = parse_chapter_authors(blocks, all_authors)
    body_blocks = blocks[byline_consumed:]

    is_summary = n == 0
    # Numbered chapters open with intro paragraphs that summarise the
    # sections to follow. Mark them with a small "SUMMARY" eyebrow so
    # readers can anchor to it from the TOC.
    is_chapter = (chapter.get("kind") or "chapter") == "chapter" and not is_summary
    has_summary = is_chapter and any(
        b for b in body_blocks if isinstance(b, dict) and b.get("type") not in ("hr",)
    )
    body_parts = []
    if has_summary:
        body_parts.append(
            '<div class="row">'
            '<h2 class="chap-summary-label" id="summary">Summary</h2>'
            '</div>'
        )
    body_parts.extend(render_block(b, used_fns) for b in body_blocks)
    for i, ss in enumerate(chapter.get("subsections", []) or [], start=1):
        ss_num = "" if is_summary or n is None else f"{n}.{i}"
        body_parts.append(render_subsection(ss, depth=2, used_fns=used_fns, number=ss_num))
    body_html = "\n".join(p for p in body_parts if p)

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

    cards = [author_card(a) for a in chap_authors]
    faculty_strip = (
        '<section class="faculty" aria-label="Chapter authors">'
        '<div class="label">Chapter <br>authors</div>'
        f'<div class="list">{"".join(cards)}</div>'
        '</section>'
    ) if cards else ""

    # Footnotes appear inline as Tufte sidenotes — no bottom Notes section.
    footnotes_html = ""

    refs_html = ""
    if references:
        import urllib.parse as _urlparse
        abstracts = _CTX.get("abstracts", {})
        ref_lis = []
        for idx, ref in enumerate(references):
            if not isinstance(ref, dict):
                continue
            ref_html = ref.get("html", "")
            # The source docx occasionally carries stray highlighted text
            # (e.g. tracked-change leftovers) that pandoc emits as <mark>.
            # Strip those so references don't render with a yellow box.
            ref_html = re.sub(r"</?mark[^>]*>", "", ref_html)
            abs_rec = abstracts.get(_abstract_key(ref_html)) or {}
            abs_html = _strip_abstract_header(abs_rec.get("abstract_html") or "")
            # If Crossref/OpenAlex pinned a canonical DOI, prefer it over the
            # one we may have inline-extracted (the inline match is rare anyway).
            doi = abs_rec.get("doi") or _extract_doi(ref_html) or ""
            url = (
                f"https://doi.org/{doi}" if doi
                else _extract_url(ref_html) or ""
            )
            # Every reference is expandable — even those without an abstract
            # show the action links (Search / Open source / DOI) under the
            # cite. The class name is preserved for the existing JS hook.
            classes = ["ref-item", "has-abstract"]
            attrs = (
                f'id="ref-{idx}" class="{" ".join(classes)}"'
            )
            if doi:
                attrs += f' data-doi="{html.escape(doi)}"'
            if url:
                attrs += f' data-url="{html.escape(url)}"'
            # Linkify any plain-text URLs in the citation itself.
            cite_html = f'<div class="ref-cite">{_linkify_urls(ref_html)}</div>'
            # Action links — same set the drawer offers — appear inside the
            # expanded block alongside the abstract so the bibliography view
            # has parity with the inline-citation drawer view.
            ref_text = _ref_text(ref_html).replace("\xa0", " ").strip()
            google_href = (
                "https://www.google.com/search?q="
                + _urlparse.quote_plus(ref_text)
            )
            arrow = '<span class="ext-arrow" aria-hidden="true">↗</span>'
            actions = [
                f'<a href="{html.escape(google_href)}" target="_blank" '
                f'rel="noopener noreferrer">Search for this reference{arrow}</a>'
            ]
            if url:
                actions.append(
                    f'<a href="{html.escape(url)}" target="_blank" '
                    f'rel="noopener noreferrer">Open source{arrow}</a>'
                )
            if doi:
                actions.append(
                    f'<a href="https://doi.org/{html.escape(doi)}" target="_blank" '
                    f'rel="noopener noreferrer">DOI: {html.escape(doi)}</a>'
                )
            actions_html = (
                f'<div class="ref-actions">{"".join(actions)}</div>'
            )
            abstract_html_block = (
                f'<div class="ref-abstract-label">Abstract</div>'
                f'<div class="ref-abstract-body">{abs_html}</div>'
            ) if abs_html else ""
            abs_block = (
                f'<div class="ref-abstract" hidden>'
                f'{abstract_html_block}'
                f'{actions_html}'
                f'</div>'
            )
            ref_lis.append(f'<li {attrs}>{cite_html}{abs_block}</li>')
        if ref_lis:
            refs_html = (
                '<section class="refs" id="references" aria-label="References">'
                '<h3 class="refs-title">References</h3>'
                f'<ol class="refs-list">{"".join(ref_lis)}</ol>'
                '</section>'
            )

    head = PAGE_HEAD.format(
        title=html.escape(title),
        css_path=css_path,
        chat_api=html.escape(CHAT_API_URL),
        turnstile_site_key=html.escape(TURNSTILE_SITE_KEY),
        chapter_id=html.escape(chapter.get("id", "")),
        chapter_title=html.escape(title),
    )
    if is_summary:
        crumb = "Summary"
    elif n:
        crumb = f"Chapter {n}"
    else:
        crumb = title or ""
    narrow_crumb = (
        f'<span class="narrow-crumb">{html.escape(crumb)}</span>'
        if crumb else ""
    )
    topstrip = TOPSTRIP.format(
        home=home,
        chap_menu=_CTX.get("chap_menu", ""),
        summary_menu_link=_CTX.get("summary_menu_link", ""),
        narrow_crumb=narrow_crumb,
    )
    boot = (
        "window.__TARGETS__=" + json.dumps(target_map, separators=(",", ":")) + ";"
        "window.__HEADSHOTS__=" + json.dumps(_CTX.get("headshots", {}), separators=(",", ":")) + ";"
    )

    report_contents = render_report_contents(
        chapters=_CTX.get("chapters_for_toc", []),
        current_slug=chapter.get("id", ""),
        current_sections=current_sections,
        has_refs=bool(refs_html),
        has_summary=has_summary,
    )

    # Eyebrow above chapter title — "CHAPTER N" in small-caps blue, matching
    # the report's section-heading typography. Summary (number 0) and the
    # un-numbered front/back-matter pages get a kind-appropriate eyebrow.
    chap_kind = (chapter.get("kind") or "").lower()
    if n and n > 0:
        eyebrow_text = f"Chapter {n}"
    elif chapter.get("id") == "summary":
        eyebrow_text = "Summary"
    elif chap_kind == "frontmatter":
        eyebrow_text = "Front matter"
    elif chap_kind == "backmatter":
        eyebrow_text = "Back matter"
    else:
        eyebrow_text = ""
    chapter_eyebrow = (
        f'<div class="eyebrow">{html.escape(eyebrow_text)}</div>'
        if eyebrow_text else ''
    )

    # Mark front-/back-matter pages so chapter-only treatments (e.g. the
    # large drop-cap on the first paragraph) don't apply.
    page_kind_class = (
        f"kind-{chap_kind}" if chap_kind in ("frontmatter", "backmatter") else "kind-chapter"
    )

    return CHAPTER_TEMPLATE.format(
        head=head,
        topstrip=topstrip,
        report_contents=report_contents,
        title=html.escape(title),
        publish_date=html.escape(publish_date),
        n_authors=len(chap_authors),
        faculty_strip=faculty_strip,
        body_html=body_html,
        footnotes_html=footnotes_html,
        refs_html=refs_html,
        css_path=css_path,
        boot_script=boot,
        chapter_eyebrow=chapter_eyebrow,
        page_kind_class=page_kind_class,
    )


def render_index(
    meta: dict,
    chapters: list,
    authors: list,
    reviewers: list,
    abstract_section: dict | None,
    about_section: dict | None,
    ack_section: dict | None,
    review_section: dict | None,
) -> str:
    # Index page renders frontmatter prose; turn off citation/footnote linking
    # for these sections (they're not chapter-scoped) and set media prefix to "".
    _CTX["chapter_num"] = 0
    _CTX["media_prefix"] = ""
    _CTX["fn_seen"] = set()

    head = PAGE_HEAD.format(
        title=html.escape(meta.get("title", "")),
        css_path="",
        chat_api=html.escape(CHAT_API_URL),
        turnstile_site_key=html.escape(TURNSTILE_SITE_KEY),
        chapter_id="index",
        chapter_title="Home",
    )
    topstrip = TOPSTRIP.format(
        home="./",
        chap_menu=_build_chap_menu(chapters, home_prefix="./"),
        summary_menu_link=_build_summary_menu_link(chapters, home_prefix="./"),
        narrow_crumb="",
    )

    chap_links = []
    # The chapter-list grid lives directly under the home-page Contents
    # heading. We exclude back-matter pages (acknowledgments, etc.) so they
    # don't appear in the main chapter grid; back-matter is reachable via
    # the dedicated link footer at the bottom of the home page.
    for c in chapters:
        if (c.get("kind") or "chapter") == "backmatter":
            continue
        n = c.get("number")
        cid = c.get("id", "")
        t = clean_ws(c.get("title", ""))
        label = "Summary" if n == 0 else f"Chapter {n}"
        chap_links.append(
            '<a class="chap-link" href="{cid}/">'
            '<span class="chap-link-num">{label}</span>'
            '<span class="chap-link-title">{t}</span>'
            '</a>'.format(cid=html.escape(cid), label=html.escape(label), t=html.escape(t))
        )
    authors_html = "".join(author_card(a) for a in authors)

    def render_prose_section(section: dict | None, css_id: str, label: str) -> str:
        if not section:
            return ""
        used: set[str] = set()
        body_blocks = []
        for b in section.get("blocks", []) or []:
            body_blocks.append(render_block(b, used))
        for ss in section.get("subsections", []) or []:
            body_blocks.append(render_subsection(ss, depth=2, used_fns=used))
        # id lives on the heading (the section uses display:contents on the
        # index page so its bounding box is unreliable for scroll targeting).
        return (
            f'<section class="prose-section">'
            f'<h2 class="section-title" id="{css_id}">{html.escape(label)}</h2>'
            f'<article class="body">{"".join(body_blocks)}</article>'
            f'</section>'
        )

    abstract_html = render_prose_section(abstract_section, "abstract", "Abstract")

    # Pull "Rationale for Public Release" out of about-this-report and render
    # it as its own top-level section on the home page. Move the
    # "Content decisions" subsection under the new Rationale section.
    rationale_section = None
    about_section_trimmed = about_section
    if about_section:
        all_subs = list(about_section.get("subsections", []) or [])
        rationale_subs = []
        kept_in_about = []
        for ss in all_subs:
            sid = ss.get("id", "")
            if sid == "rationale-for-public-release":
                rationale_section = dict(ss)
            elif sid == "content-decisions":
                rationale_subs.append(ss)
            else:
                kept_in_about.append(ss)
        if rationale_section:
            existing = list(rationale_section.get("subsections", []) or [])
            rationale_section["subsections"] = existing + rationale_subs
            rationale_section["title"] = "Rationale for public release"
        about_section_trimmed = dict(about_section)
        about_section_trimmed["subsections"] = kept_in_about

    about_html = render_prose_section(about_section_trimmed, "about", "About this report")
    rationale_html = render_prose_section(rationale_section, "rationale", "Rationale for public release") if rationale_section else ""
    # Convert "<p class=\"prose\"><strong>N) Title<br/></strong>body</p>" into a
    # subsection heading followed by a clean paragraph, so the numbered
    # list items adopt the same blue small-caps section-num typography
    # used in chapter subsection headings.
    if rationale_html:
        # Hoist the numbered "<strong>N) Title<br/></strong>" prefix out of
        # the paragraph and into an h3 with the same blue-small-caps numbering
        # used by chapter subsection headings.
        #
        # Important: we also move the heading OUT of the surrounding
        # `<div class="row">`, so the row's adjacent `<div class="row-sidenotes">`
        # (which holds the footnote aside referenced from the body) anchors
        # against the body paragraph, not the heading. Otherwise clicking
        # footnote 1 scrolled to above the heading instead of to its citation.
        rationale_html = re.sub(
            r'<div class="row"><p class="prose"><strong>(\d+)\)\s+([^<]+?)<br/?>\s*</strong>',
            (
                r'<h3 class="subsection-title">'
                r'<span class="subsection-num">\1</span> \2'
                r'</h3>'
                r'<div class="row"><p class="prose">'
            ),
            rationale_html,
            flags=re.DOTALL,
        )
    # Acknowledgments now live on their own page; on the home page render
    # only a small "Read full acknowledgments" footer link.
    if ack_section:
        ack_html = (
            '<section class="ack-link-row" id="acknowledgments">'
            '<a class="ack-link" href="contributions-and-acknowledgments/">'
            '<span class="ack-link-eyebrow">Contributions &amp; acknowledgments</span>'
            '<span class="ack-link-cta">Read the full list of contributors and acknowledgments &rarr;</span>'
            '</a>'
            '</section>'
        )
    else:
        ack_html = ""

    # Review section: render the prose intro, then a compact reviewer-card grid.
    review_body = ""
    if review_section:
        used: set[str] = set()
        for b in review_section.get("blocks", []) or []:
            # Skip the blockquote that already lists reviewers — we render
            # the structured reviewer list below instead.
            if isinstance(b, dict) and b.get("type") == "blockquote":
                continue
            review_body += render_block(b, used)
    reviewer_cards = "".join(author_card(r, role="reviewer") for r in reviewers)
    reviewer_strip_html = (
        '<section class="reviewer-strip-section">'
        '<div class="strip-label">Report reviewers</div>'
        f'<div class="reviewer-strip">{reviewer_cards}</div>'
        '</section>'
    ) if reviewers else ''
    review_html = ""
    if review_body or reviewers:
        review_html = (
            '<section class="prose-section">'
            '<h2 class="section-title" id="review">Review</h2>'
            f'<article class="body">{review_body}</article>'
            + reviewer_strip_html
            + '</section>'
        )

    contents_html = (
        '<section class="chap-list">'
        '<h2 class="section-title" id="contents">Contents</h2>'
        f'{"".join(chap_links)}'
        '</section>'
    )

    # Author cards inline directly under the chap-header (no section wrapper).
    authors_strip_html = (
        '<section class="author-strip-section">'
        '<div class="strip-label">Report authors</div>'
        f'<div class="author-strip">{authors_html}</div>'
        '</section>'
    ) if authors_html else ''

    tagline = (
        '<p class="chap-summary">'
        'An interactive companion to the technical report. Navigate by chapter, '
        'hover citations to see the full reference, and click any in-text link '
        'to preview a section in the side panel without losing your place.'
        '</p>'
    )

    # Header context box — visually distinct callout explaining the site,
    # the AI assistant, and where to find the official archived copy.
    site_context_html = (
        '<aside class="site-context" aria-label="About this site">'
        '<h2 class="site-context-title">About this site</h2>'
        '<div class="site-context-body">'
        '<p>This site is an interactive companion to the December 2024 '
        '<em>Technical Report on Mirror Bacteria</em>, released alongside '
        'the Science Policy Forum article '
        '<a href="https://www.science.org/stoken/author-tokens/ST-2327/full" '
        'rel="noopener" target="_blank">'
        '"Confronting risks of mirror life"</a>. '
        'The official archived copy of the full report is available at the '
        '<a href="https://purl.stanford.edu/cv716pj4036" rel="noopener" target="_blank">'
        'Stanford Digital Repository</a>.</p>'
        '<p>Use the <strong>Ask AI</strong> button in the bottom-right corner '
        'to put questions to a Claude-powered assistant grounded in the '
        "report's text. Every substantive claim is cited with a link back to "
        'the relevant section.</p>'
        '<p>The authors welcome feedback and corrections — please email '
        '<a href="mailto:technical-report@mbdialogues.org">'
        'technical-report@mbdialogues.org</a> '
        'with any errors, missing context, or comments.</p>'
        '</div>'
        '</aside>'
    )

    toc_entries = []
    if abstract_section:
        toc_entries.append(("abstract", "Abstract"))
    toc_entries.append(("contents", "Contents"))
    if review_section or reviewers:
        toc_entries.append(("review", "Review"))
    if about_section:
        toc_entries.append(("about", "About"))
    if rationale_section:
        toc_entries.append(("rationale", "Rationale for release"))
    # Acknowledgments now live on a dedicated page — the entry at the
    # bottom of the on-page TOC links straight there rather than to a
    # local anchor.
    toc_items = "\n      ".join(
        f'<li><a href="#{tid}">{html.escape(label)}</a></li>'
        for tid, label in toc_entries
    )

    # Second left-column TOC: every numbered chapter + Summary + the
    # Contributions & acknowledgments backmatter page. Numberless rows
    # render with an empty num gutter so they align with the chapters.
    chap_toc_items_list = []
    for c in chapters:
        n = c.get("number")
        cid = c.get("id", "")
        t = clean_ws(c.get("title", ""))
        num_text = "" if n == 0 else (str(n) if n else "")
        chap_toc_items_list.append(
            '<li><a href="{cid}/" title="{title_attr}">'
            '<span class="toc-num">{num}</span>'
            '<span class="toc-title">{t}</span>'
            '</a></li>'.format(
                cid=html.escape(cid),
                num=html.escape(num_text),
                t=html.escape(t),
                title_attr=html.escape(t),
            )
        )
    chap_toc_items = "\n      ".join(chap_toc_items_list)

    boot = (
        "window.__HEADSHOTS__="
        + json.dumps(_CTX.get("headshots", {}), separators=(",", ":")) + ";"
    )

    return INDEX_TEMPLATE.format(
        head=head,
        topstrip=topstrip,
        title=html.escape(meta.get("title", "")),
        publish_date=html.escape(meta.get("publishDate", "")),
        toc_items=toc_items,
        chap_toc_items=chap_toc_items,
        site_context_html=site_context_html,
        authors_strip_html=authors_strip_html,
        abstract_html=abstract_html,
        contents_html=contents_html,
        about_html=about_html,
        rationale_html=rationale_html,
        review_html=review_html,
        ack_html=ack_html,
        boot_script=boot,
    )


# ============================================================
# Headshot fetcher
# ============================================================

def _fetch_headshot(name: str, src_url: str) -> tuple[str, int, int] | None:
    """Download src_url into HEADSHOT_CACHE_DIR. Returns (filename, w, h) or None."""
    import hashlib
    import urllib.request
    from io import BytesIO
    try:
        from PIL import Image
    except ImportError:
        print("  PIL not installed — skipping headshot fetch.")
        return None

    HEADSHOT_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha1((name + "|" + src_url).encode("utf-8")).hexdigest()[:12]

    cache: dict = {}
    if HEADSHOT_CACHE_INDEX.exists():
        try:
            cache = json.loads(HEADSHOT_CACHE_INDEX.read_text())
        except Exception:
            cache = {}
    cached = cache.get(name)
    if cached and cached.get("src") == src_url:
        local = HEADSHOT_CACHE_DIR / cached["file"]
        if local.exists() and cached.get("width", 0) > 0:
            return cached["file"], cached["width"], cached["height"]

    try:
        req = urllib.request.Request(
            src_url,
            headers={
                "User-Agent": (
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 12_0) "
                    "AppleWebKit/605.1.15 (KHTML, like Gecko) "
                    "Version/17.0 Safari/605.1.15"
                ),
                "Accept": "image/avif,image/webp,image/png,image/jpeg,*/*",
                "Referer": cached.get("source") if cached else "",
            },
        )
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = resp.read()
    except Exception as e:
        print(f"  fetch failed for {name}: {e}")
        return None

    try:
        img = Image.open(BytesIO(data))
        img.load()
    except Exception as e:
        print(f"  decode failed for {name}: {e}")
        return None

    fmt = (img.format or "JPEG").lower()
    ext = {"jpeg": "jpg", "png": "png", "webp": "webp", "gif": "gif"}.get(fmt, "bin")
    file_name = f"{key}.{ext}"
    (HEADSHOT_CACHE_DIR / file_name).write_bytes(data)
    width, height = img.size

    cache[name] = {"src": src_url, "file": file_name, "width": width, "height": height}
    HEADSHOT_CACHE_INDEX.write_text(json.dumps(cache, indent=2, ensure_ascii=False))
    return file_name, width, height


def fetch_all_headshots() -> dict:
    """Fetch all selected headshots; return name → {url, width, height, crop}."""
    if not HEADSHOT_SELECTIONS.exists():
        return {}
    sel_data = json.loads(HEADSHOT_SELECTIONS.read_text())
    selections = sel_data.get("selections", {}) or {}
    out = {}
    fetched, failed = 0, 0
    for name, sel in selections.items():
        if sel.get("status") != "picked":
            continue
        src = sel.get("src")
        if not src:
            continue
        result = _fetch_headshot(name, src)
        if result is None:
            failed += 1
            continue
        file_name, w, h = result
        out[name] = {
            "file": file_name,
            "url": BASE_PATH + "/headshots/" + file_name,
            "width": w,
            "height": h,
            "crop": sel.get("crop", {"x": 0, "y": 0, "size": 1}),
        }
        fetched += 1
    print(f"  headshots: {fetched} fetched/cached, {failed} failed")
    return out


# ============================================================
# Build orchestration
# ============================================================

def _reorder_chapter_blocks(chapters: list) -> None:
    """Apply manual block reorderings for specific chapters in-place.

    The parser places figures where pandoc emits them, which is sometimes
    several paragraphs after the first inline reference. When two figures
    end up directly adjacent, the absolutely-positioned figcaptions can
    visually collide. Here we move specific figures next to their first
    in-text reference. Figures keep their numerical order — only figures
    move, never paragraphs.
    """
    for ch in chapters:
        if ch.get("id") != "chapter-1-introduction":
            continue
        blocks = ch.get("blocks") or []

        def find_fig(prefix: str) -> int:
            for i, b in enumerate(blocks):
                if (b.get("type") == "figure"
                        and (b.get("id") or "").startswith(prefix)):
                    return i
            return -1

        def find_para(needle: str) -> int:
            for i, b in enumerate(blocks):
                if (b.get("type") == "paragraph"
                        and needle in (b.get("html") or "")):
                    return i
            return -1

        # Pair A: move Fig 1.2 to just before the "protein binding is
        # stereospecific" paragraph (sandwiches it between the
        # mirror-organism-construction para and the protein-binding para).
        i_fig = find_fig("figure-1.2")
        i_dst = find_para("protein binding is stereospecific")
        if i_fig != -1 and i_dst != -1 and i_fig > i_dst:
            fig = blocks.pop(i_fig)
            blocks.insert(i_dst, fig)

        # Pair B: move Fig 1.5 to just after the "Once created, mirror
        # cells could be further engineered" paragraph (figs 1.4 and 1.5
        # were back-to-back; this drops para 19 between them).
        i_fig = find_fig("figure-1.5")
        i_dst = find_para("Once created, mirror cells could be further engineered")
        if i_fig != -1 and i_dst != -1 and i_fig < i_dst:
            fig = blocks.pop(i_fig)
            # i_dst shifted down by 1 after the pop; original index is
            # the post-shift slot immediately AFTER the dst paragraph.
            blocks.insert(i_dst, fig)

        ch["blocks"] = blocks


def main() -> None:
    if not INDEX_FILE.exists():
        raise SystemExit(
            f"Missing {INDEX_FILE}; run the parser first (cd parser && make json)."
        )

    index_data = json.loads(INDEX_FILE.read_text())
    meta = index_data.get("meta", {})
    authors_list = index_data.get("authors", [])
    authors_lookup = {a["name"]: a for a in authors_list}

    fn_list = json.loads(FOOTNOTES_FILE.read_text()) if FOOTNOTES_FILE.exists() else []
    footnotes_lookup = {f.get("id", ""): f.get("html", "") for f in fn_list}

    refs_data = json.loads(REFERENCES_FILE.read_text()) if REFERENCES_FILE.exists() else {}
    _CTX["cite_map"] = build_citation_map(refs_data)
    _CTX["footnotes_lookup"] = footnotes_lookup
    abstracts_data = (
        json.loads(ABSTRACTS_FILE.read_text()) if ABSTRACTS_FILE.exists() else {}
    )
    # Pass the full cache through — even no_abstract records are valuable
    # because the pipeline resolved a DOI for them (drives the "Open source"
    # / DOI link in the bibliography). The render path checks abstract_html
    # separately and only renders the abstract block if it's present.
    _CTX["abstracts"] = {
        k: v for k, v in abstracts_data.items() if isinstance(v, dict)
    }

    chapters = []
    abstract_section = None
    about_section = None
    ack_section = None
    review_section = None
    summary_section = None
    for path in sorted(CHAPTERS_DIR.glob("*.json")):
        ch = json.loads(path.read_text())
        kind = ch.get("kind")
        cid = ch.get("id", "")
        if kind == "chapter":
            chapters.append(ch)
        elif cid == "abstract":
            abstract_section = ch
        elif cid == "about-this-report":
            about_section = ch
        elif cid == "contributions-and-acknowledgments":
            ack_section = ch
        elif cid == "review":
            review_section = ch
        elif cid == "summary":
            summary_section = ch
    chapters.sort(key=lambda c: c.get("number") or 0)

    # Editorial reorderings: break up adjacent figure pairs by sliding
    # figures next to their first in-text reference. Figures stay in
    # numerical order; only figures (not paragraphs) move.
    _reorder_chapter_blocks(chapters)

    # Treat Summary as a "chapter 0" — render it as its own page and slot it
    # at the front of the chapter list so the menu / contents include it.
    if summary_section is not None:
        summary_section = dict(summary_section)
        summary_section["kind"] = "chapter"
        summary_section["number"] = 0
        chapters = [summary_section] + chapters

    # Render acknowledgments as its own backmatter page. We keep the
    # ack_section reference so the home-page link can use the title.
    if ack_section is not None:
        ack_page_section = dict(ack_section)
        ack_page_section["kind"] = "backmatter"
        ack_page_section["number"] = None
        chapters.append(ack_page_section)

    reviewers = index_data.get("reviewers", [])

    if SITE.exists():
        shutil.rmtree(SITE)
    SITE.mkdir(parents=True)

    if ASSETS_SRC.exists():
        shutil.copytree(ASSETS_SRC, SITE / "assets")

    target_map = collect_target_map(chapters)
    _CTX["chap_menu"] = _build_chap_menu(chapters, home_prefix="../")
    _CTX["summary_menu_link"] = _build_summary_menu_link(chapters, home_prefix="../")
    _CTX["headshots"] = fetch_all_headshots()

    # Emit search index (consumed by site-assets/search.js)
    (SITE / "search-index.json").write_text(
        json.dumps(build_search_index(chapters), ensure_ascii=False)
    )

    (SITE / "index.html").write_text(
        render_index(
            meta, chapters, authors_list, reviewers,
            abstract_section, about_section, ack_section, review_section,
        )
    )

    _CTX["chapters_for_toc"] = chapters

    for c in chapters:
        cid = (c.get("id") or "").strip()
        if not cid:
            continue
        chap_dir = SITE / cid
        chap_dir.mkdir(parents=True, exist_ok=True)
        n = c.get("number")
        refs = refs_data.get(str(n), []) if n is not None else []
        page = render_chapter_page(
            chapter=c,
            publish_date=meta.get("publishDate", ""),
            all_authors=authors_lookup,
            references=refs,
            footnotes_lookup=footnotes_lookup,
            target_map=target_map,
            css_path="../",
            home="../",
        )
        (chap_dir / "index.html").write_text(page)

    for name in ("styles.css", "app.js", "search.js", "favicon.svg", "chat.js", "chat.css"):
        src = SITE_ASSETS / name
        if src.exists():
            shutil.copy(src, SITE / name)

    # Always: copy fetched headshot images so the live site can show faces.
    if HEADSHOT_CACHE_DIR.exists():
        site_headshots = SITE / "headshots"
        site_headshots.mkdir(parents=True, exist_ok=True)
        for f in HEADSHOT_CACHE_DIR.iterdir():
            if f.is_file():
                shutil.copy(f, site_headshots / f.name)

    # Admin-only assets — picker, duotone tuner, candidate JSONs. These
    # are dev tools and shouldn't ship in production.
    if not IS_PROD:
        admin_src = SITE_ASSETS / "admin-headshots.html"
        if admin_src.exists():
            admin_dir = SITE / "admin" / "headshots"
            admin_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy(admin_src, admin_dir / "index.html")
        tuner_src = SITE_ASSETS / "admin-duotone.html"
        if tuner_src.exists():
            tuner_dir = SITE / "admin" / "duotone"
            tuner_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy(tuner_src, tuner_dir / "index.html")
        for fname in ("headshot-candidates.json",
                      "reviewer-headshot-candidates.json",
                      "index.json"):
            src = DATA / fname
            if src.exists():
                shutil.copy(src, SITE / fname)
        headshot_applied = _CTX.get("headshots", {})
        if headshot_applied:
            (SITE / "headshots-applied.json").write_text(
                json.dumps(headshot_applied, ensure_ascii=False, indent=2)
            )

    print(f"Built {len(chapters)} chapter pages + index → {SITE}"
          + (" (production)" if IS_PROD else " (dev)"))


if __name__ == "__main__":
    main()
