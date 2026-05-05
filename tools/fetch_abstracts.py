#!/usr/bin/env python3
"""Fetch abstracts for bibliography entries.

Pipeline:
  1. For each unique reference (deduped across chapters by normalized text):
     a. If the ref already has an inline DOI, use it as the lookup key.
     b. Otherwise, query Crossref's bibliographic search to resolve a DOI.
     c. Validate the match by checking first-author last name + year.
  2. With a DOI in hand:
     a. Take the abstract from the Crossref record if present.
     b. Otherwise, fall back to OpenAlex (which reconstructs from inverted index).
  3. Cache everything to data/abstracts.json keyed by SHA-1 of the
     normalized reference text. Re-running skips entries already resolved.

Usage:
  python3 tools/fetch_abstracts.py            # process everything not in cache
  python3 tools/fetch_abstracts.py --limit 50 # cap requests in this run
  python3 tools/fetch_abstracts.py --retry-misses  # re-try entries that failed
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REFERENCES_FILE = ROOT / "data" / "references.json"
ABSTRACTS_FILE = ROOT / "data" / "abstracts.json"

CONTACT_EMAIL = "james.wagstaff@coefficientgiving.org"
USER_AGENT = f"tr-website/1.0 (mailto:{CONTACT_EMAIL})"

# Reuse the citation-key regexes from build.py so resolution behaviour stays
# consistent. Duplicated here so this script has no dependency on build.py.
TAG_RE = re.compile(r"<[^>]+>")
WS_RE = re.compile(r"\s+")
DOI_RE = re.compile(r"\b(10\.\d{4,9}/[^\s<>\")]+)", re.I)
LEAD_AUTHOR_RE = re.compile(r"^\s*([A-ZÀ-Ÿ][\wÀ-ÿ'\-]+)(?:[,\s]|<)")
YEAR_RE = re.compile(r"\((\d{4})[a-z]?\)")


def strip_tags(s: str) -> str:
    return TAG_RE.sub("", s).replace("\xa0", " ")


def norm_text(s: str) -> str:
    return WS_RE.sub(" ", strip_tags(s)).strip()


def ref_key(ref_html: str) -> str:
    return hashlib.sha1(norm_text(ref_html).lower().encode("utf-8")).hexdigest()[:16]


def extract_doi(ref_html: str) -> str | None:
    m = DOI_RE.search(strip_tags(ref_html))
    if m:
        return m.group(1).rstrip(".,;)")
    return None


def extract_first_author(ref_html: str) -> str | None:
    m = LEAD_AUTHOR_RE.match(strip_tags(ref_html))
    return m.group(1) if m else None


def extract_year(ref_html: str) -> str | None:
    m = YEAR_RE.search(strip_tags(ref_html))
    return m.group(1) if m else None


# ---------------------------------------------------------------------------
# JATS / Crossref abstract cleanup
# ---------------------------------------------------------------------------

def clean_abstract(raw: str) -> str:
    """Convert Crossref's JATS-flavoured abstract into something we can
    safely drop into a paragraph block."""
    if not raw:
        return ""
    s = raw
    # Strip namespace prefixes
    s = re.sub(r"<\s*/?\s*jats:", lambda m: m.group(0).replace("jats:", ""), s, flags=re.I)
    # Drop any title/section header tags but keep their text
    s = re.sub(r"<\s*/?(title|abstract|sec|label)\b[^>]*>", "", s, flags=re.I)
    # Normalize <p> → block paragraphs
    s = re.sub(r"<\s*p\b[^>]*>", "<p>", s, flags=re.I)
    s = re.sub(r"<\s*/\s*p\s*>", "</p>", s, flags=re.I)
    # Italic / bold passthroughs
    s = re.sub(r"<\s*italic\b[^>]*>", "<em>", s, flags=re.I)
    s = re.sub(r"<\s*/\s*italic\s*>", "</em>", s, flags=re.I)
    s = re.sub(r"<\s*bold\b[^>]*>", "<strong>", s, flags=re.I)
    s = re.sub(r"<\s*/\s*bold\s*>", "</strong>", s, flags=re.I)
    # Strip every other tag (sup, sub, xref, list, etc.) while keeping text
    s = re.sub(r"<(?!/?(p|em|strong)\b)[^>]+>", "", s, flags=re.I)
    s = WS_RE.sub(" ", s).strip()
    # If no <p> wrapper, wrap whole thing
    if "<p>" not in s.lower():
        s = f"<p>{s}</p>"
    return s


def reconstruct_openalex_abstract(inv: dict | None) -> str:
    if not inv:
        return ""
    pos = {}
    for word, places in inv.items():
        for p in places:
            pos[p] = word
    text = " ".join(pos[i] for i in sorted(pos))
    return f"<p>{text}</p>" if text else ""


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

class HttpError(Exception):
    pass


def http_get_json(url: str, timeout: int = 30) -> dict:
    req = urllib.request.Request(url, headers={
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        raise HttpError(f"{e.code} {e.reason}: {url}") from e
    except urllib.error.URLError as e:
        raise HttpError(f"url error: {e.reason}: {url}") from e


# ---------------------------------------------------------------------------
# Resolution
# ---------------------------------------------------------------------------

def crossref_search(ref_text: str) -> dict | None:
    url = "https://api.crossref.org/works?" + urllib.parse.urlencode({
        "query.bibliographic": ref_text,
        "rows": 1,
        "mailto": CONTACT_EMAIL,
    })
    data = http_get_json(url)
    items = (data.get("message") or {}).get("items") or []
    return items[0] if items else None


def crossref_by_doi(doi: str) -> dict | None:
    url = f"https://api.crossref.org/works/{urllib.parse.quote(doi, safe='/')}?mailto={CONTACT_EMAIL}"
    try:
        data = http_get_json(url)
    except HttpError:
        return None
    return data.get("message")


def openalex_by_doi(doi: str) -> dict | None:
    url = f"https://api.openalex.org/works/doi:{urllib.parse.quote(doi, safe='/')}?mailto={CONTACT_EMAIL}"
    try:
        return http_get_json(url)
    except HttpError:
        return None


def semanticscholar_abstract_by_doi(doi: str) -> str | None:
    """Semantic Scholar Graph API. No key required for low-volume use; we
    pass the User-Agent so they can rate-limit politely. Returns plain text
    wrapped in a single <p>; no markup."""
    url = (
        f"https://api.semanticscholar.org/graph/v1/paper/DOI:"
        f"{urllib.parse.quote(doi, safe='/')}?fields=abstract"
    )
    try:
        data = http_get_json(url)
    except HttpError:
        return None
    txt = (data.get("abstract") or "").strip()
    return f"<p>{txt}</p>" if txt else None


def europepmc_abstract_by_doi(doi: str) -> str | None:
    """Europe PMC search by DOI. abstractText is plain text; wrap in <p>."""
    url = (
        "https://www.ebi.ac.uk/europepmc/webservices/rest/search?"
        f"query=DOI:{urllib.parse.quote(doi)}&format=json&resultType=core"
    )
    try:
        data = http_get_json(url)
    except HttpError:
        return None
    res = (data.get("resultList") or {}).get("result") or []
    if not res:
        return None
    txt = (res[0].get("abstractText") or "").strip()
    return f"<p>{txt}</p>" if txt else None


def pubmed_abstract_by_doi(doi: str) -> str | None:
    """NCBI E-utilities: resolve DOI → PMID → AbstractText.

    PubMed often has abstracts for older bench-biology papers that Crossref
    doesn't carry (especially pre-2000 ASM Press, JBC, etc). The trade-off is
    a slightly chattier API: two HTTP calls per lookup, separated by ~340ms
    to honor NCBI's no-key 3-req/sec cap.
    """
    eutils = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
    # Step 1: esearch by DOI
    esearch = (
        f"{eutils}/esearch.fcgi?db=pubmed&term={urllib.parse.quote(doi)}[AID]"
        f"&retmode=json&email={urllib.parse.quote(CONTACT_EMAIL)}"
    )
    try:
        data = http_get_json(esearch)
    except HttpError:
        return None
    ids = (data.get("esearchresult") or {}).get("idlist") or []
    if not ids:
        return None
    pmid = ids[0]
    time.sleep(0.34)
    # Step 2: efetch the abstract as XML
    efetch = (
        f"{eutils}/efetch.fcgi?db=pubmed&id={pmid}&rettype=abstract&retmode=xml"
        f"&email={urllib.parse.quote(CONTACT_EMAIL)}"
    )
    try:
        req = urllib.request.Request(efetch, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=30) as resp:
            xml_text = resp.read().decode("utf-8", errors="replace")
    except urllib.error.URLError:
        return None
    # PubMed wraps the abstract in <Abstract><AbstractText Label="...">...
    # body may have multiple labelled sections (Background, Methods, …).
    blocks = re.findall(
        r"<AbstractText\b([^>]*)>(.*?)</AbstractText>",
        xml_text,
        flags=re.S,
    )
    if not blocks:
        return None
    paras = []
    for attrs, body in blocks:
        label_m = re.search(r'Label="([^"]+)"', attrs)
        text = re.sub(r"<[^>]+>", "", body).strip()
        if not text:
            continue
        if label_m:
            paras.append(f"<p><strong>{label_m.group(1)}.</strong> {text}</p>")
        else:
            paras.append(f"<p>{text}</p>")
    return "".join(paras) or None


import unicodedata

# Common unicode hyphen variants that show up in Crossref titles/names but
# rarely in source bibliographies (en-dash, em-dash, hyphen, minus, etc.).
_UNI_HYPHENS = "‐‑‒–—−­"


def _norm_name(s: str) -> tuple[str, str]:
    """Return (nfc_lower, letters_only_ascii) for a name.

    The second form is the most permissive comparison key: ASCII-folded,
    lowercased, with all non-letter characters (spaces, hyphens, periods)
    stripped. It exists to handle Crossref's quirks like:
      - "Riera Romo"        vs ref "Riera-Romo"     (space vs hyphen)
      - "Dı́az" (dotless i+◌́) vs ref "Díaz"          (Spanish in Crossref)
      - "Pósfai" decomposed vs ref "Pósfai" composed (NFC drift)
    """
    if not s:
        return "", ""
    s_nfc = unicodedata.normalize("NFC", s)
    for h in _UNI_HYPHENS:
        s_nfc = s_nfc.replace(h, "-")
    s_nfc = s_nfc.lower().strip()
    # Crossref returns Spanish/Catalan authors like "García" using the
    # Turkish-style dotless-i + combining-diacritic, which NFKD doesn't
    # collapse to ASCII "i" the way the dotted form does. Patch first.
    folded = unicodedata.normalize("NFKD", s_nfc).replace("ı", "i")
    s_ascii = re.sub(r"[^a-z]", "", folded.encode("ascii", "ignore").decode())
    return s_nfc, s_ascii


_TITLE_TOKEN_RE = re.compile(r"[a-z0-9]{3,}")
_STOP_WORDS = {
    "the", "and", "for", "with", "from", "into", "but", "are", "was", "were",
    "this", "that", "these", "those", "their", "its", "his", "her",
    "via", "between", "among", "during", "after", "before", "above", "below",
    "however",
}


def _title_tokens(title: str) -> set[str]:
    """Distinctive tokens for title-similarity comparison: ASCII-folded,
    lowercase, length≥3, stripped of stop words. Italics and other markup
    are dropped before tokenizing."""
    if not title:
        return set()
    t = unicodedata.normalize("NFKD", title).encode("ascii", "ignore").decode().lower()
    t = re.sub(r"<[^>]+>", " ", t)
    return {tok for tok in _TITLE_TOKEN_RE.findall(t) if tok not in _STOP_WORDS}


def _title_overlap(ref_text: str, item_title: str) -> float:
    """Jaccard overlap of distinctive tokens. Used as a safety brake on
    matches that pass author+year but might still be the wrong paper —
    Crossref's bibliographic search occasionally returns a same-author
    same-year paper by coincidence."""
    a, b = _title_tokens(ref_text), _title_tokens(item_title)
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def _item_year(item: dict) -> str:
    """Pull a 4-digit year out of a Crossref work, defensively. Crossref
    occasionally returns date-parts=[[None]] or empty arrays — neither should
    crash the validator."""
    issued = (item.get("issued") or {}).get("date-parts") or [[]]
    try:
        y = issued[0][0]
    except (IndexError, TypeError):
        y = None
    if isinstance(y, int):
        return str(y)
    if isinstance(y, str) and y.isdigit():
        return y
    return ""


def match_score(
    item: dict,
    want_author: str | None,
    want_year: str | None,
    ref_text: str = "",
) -> bool:
    """Does the Crossref/OpenAlex hit match what we asked for?

    Two-tier author check: strict NFC + lowercase substring first; if that
    fails, retry with full ASCII transliteration (covers Pósfai → Posfai,
    Crespo-Yanez → crespo yanez, etc.). Crossref's bibliographic search
    occasionally returns a same-author same-year paper by coincidence,
    so we additionally require a non-trivial title overlap with the source
    reference (Jaccard ≥ 0.2 of distinctive tokens) before accepting.
    """
    if want_author:
        want_nfc, want_asc = _norm_name(want_author)
        names = [
            _norm_name(a.get("family") or "")
            for a in (item.get("author") or [])
        ]
        names = [(nfc, asc) for nfc, asc in names if nfc]

        def hit(needle, hay):
            return needle == hay or needle in hay or hay in needle

        author_ok = any(hit(want_nfc, n_nfc) for n_nfc, _ in names)
        if not author_ok:
            # Fall through to ASCII-folded comparison (handles diacritic-
            # variant transliterations: Sjölinder vs Sjolinder, López-Millán
            # vs Lopez-Millan, etc.)
            author_ok = any(hit(want_asc, n_asc) for _, n_asc in names)
        if not author_ok:
            return False

    if want_year:
        year = _item_year(item)
        if year:
            try:
                if abs(int(year) - int(want_year)) > 1:
                    return False
            except ValueError:
                pass

    # Title-overlap safety brake: the author+year check alone has caught
    # nearly-identical-byline same-year papers in the past (Crossref ranks
    # imperfectly). Require some actual title token overlap before trusting
    # the hit. Threshold deliberately low — we want to allow short
    # subtitle-only changes and translation rewordings, but reject papers
    # that only happen to share a byline.
    if ref_text:
        item_title = (item.get("title") or [""])[0]
        if item_title and _title_overlap(ref_text, item_title) < 0.2:
            return False

    return True


def resolve_one(ref_html: str) -> dict:
    """Return a record for one reference: {status, abstract_html, doi, ...}."""
    text = norm_text(ref_html)
    if not text:
        return {"status": "empty"}

    inline_doi = extract_doi(ref_html)
    want_author = extract_first_author(ref_html)
    want_year = extract_year(ref_html)

    # Step 1: get a DOI + Crossref record.
    item: dict | None = None
    doi: str | None = None
    source = ""

    if inline_doi:
        item = crossref_by_doi(inline_doi)
        if item:
            doi = inline_doi
            source = "crossref-doi"

    if item is None:
        try:
            item = crossref_search(text)
        except HttpError as e:
            return {"status": "error", "error": str(e)}
        if item is not None:
            if not match_score(item, want_author, want_year, ref_text=text):
                # No confident match — bail out gracefully.
                return {
                    "status": "not_found",
                    "first_author": want_author,
                    "year": want_year,
                    "tried_title": (item.get("title") or [""])[0][:140],
                }
            doi = item.get("DOI")
            source = "crossref-search"

    if item is None or not doi:
        return {
            "status": "not_found",
            "first_author": want_author,
            "year": want_year,
        }

    matched_title = (item.get("title") or [""])[0]
    matched_authors = item.get("author") or []
    matched_year = _item_year(item)

    abstract_html = clean_abstract(item.get("abstract") or "")
    if not abstract_html:
        # Fallback to OpenAlex via the DOI we now have.
        oa = openalex_by_doi(doi)
        if oa:
            abstract_html = reconstruct_openalex_abstract(
                oa.get("abstract_inverted_index")
            )
            if abstract_html:
                source = source + "+openalex"
    if not abstract_html:
        # PubMed: older biomedical journals (JBC, JBact pre-2000) that don't
        # deposit abstracts into Crossref but do appear in MEDLINE.
        pm = pubmed_abstract_by_doi(doi)
        if pm:
            abstract_html = pm
            source = source + "+pubmed"
    if not abstract_html:
        # Europe PMC: separate index from PubMed; especially good for
        # plant-pathology, soil/agriculture, and EU biomed journals.
        ep = europepmc_abstract_by_doi(doi)
        if ep:
            abstract_html = ep
            source = source + "+europepmc"
    if not abstract_html:
        # Semantic Scholar: catches conference proceedings, book chapters,
        # and recent CS-bio crossover papers the others miss.
        s2 = semanticscholar_abstract_by_doi(doi)
        if s2:
            abstract_html = s2
            source = source + "+s2"

    if not abstract_html:
        return {
            "status": "no_abstract",
            "doi": doi,
            "matched_title": matched_title,
            "matched_year": matched_year,
            "source": source,
        }

    return {
        "status": "ok",
        "doi": doi,
        "abstract_html": abstract_html,
        "matched_title": matched_title,
        "matched_year": matched_year,
        "matched_first_author": (matched_authors[0].get("family") if matched_authors else ""),
        "source": source,
    }


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------

def load_cache() -> dict:
    if ABSTRACTS_FILE.exists():
        try:
            return json.loads(ABSTRACTS_FILE.read_text())
        except json.JSONDecodeError:
            return {}
    return {}


def save_cache(cache: dict) -> None:
    ABSTRACTS_FILE.write_text(
        json.dumps(cache, ensure_ascii=False, indent=2, sort_keys=True)
    )


def collect_unique_refs() -> list[tuple[str, str]]:
    """Return [(key, ref_html)] for every unique reference across all chapters."""
    data = json.loads(REFERENCES_FILE.read_text())
    seen: dict[str, str] = {}
    for chap, refs in data.items():
        for r in refs:
            if not isinstance(r, dict):
                continue
            html = r.get("html", "")
            if not html.strip():
                continue
            k = ref_key(html)
            if k not in seen:
                seen[k] = html
    return list(seen.items())


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0,
                    help="Max number of *new* lookups to perform in this run (0 = no cap).")
    ap.add_argument("--retry-misses", action="store_true",
                    help="Also retry entries previously marked not_found / no_abstract / error.")
    ap.add_argument("--sleep", type=float, default=0.12,
                    help="Sleep between API calls (sec) to stay polite.")
    ap.add_argument("--dry-run", action="store_true",
                    help="Print what would be fetched without making API calls.")
    args = ap.parse_args()

    refs = collect_unique_refs()
    cache = load_cache()
    print(f"References (unique): {len(refs)}; cached: {len(cache)}")

    retry_statuses = {"not_found", "no_abstract", "error", "empty"} if args.retry_misses else set()

    # Snapshot existing statuses for the run summary.
    todo: list[tuple[str, str]] = []
    for k, html in refs:
        existing = cache.get(k)
        if not existing or existing.get("status") in retry_statuses:
            todo.append((k, html))
    print(f"Will attempt: {len(todo)}")

    if args.dry_run:
        for k, html in todo[:20]:
            print(" ", k, "→", norm_text(html)[:90])
        print("…")
        return 0

    done = 0
    counts = {"ok": 0, "no_abstract": 0, "not_found": 0, "error": 0, "empty": 0}
    save_every = 25
    try:
        for k, html in todo:
            if args.limit and done >= args.limit:
                break
            try:
                rec = resolve_one(html)
            except Exception as e:
                rec = {"status": "error", "error": f"unhandled: {e!r}"}
            cache[k] = rec
            counts[rec.get("status", "error")] = counts.get(rec.get("status", "error"), 0) + 1
            done += 1
            if done % 10 == 0:
                snippet = norm_text(html)[:60]
                print(f"  [{done}/{len(todo)}] {rec.get('status'):<11} {snippet}")
            if done % save_every == 0:
                save_cache(cache)
            time.sleep(args.sleep)
    except KeyboardInterrupt:
        print("Interrupted — saving partial cache.")
    finally:
        save_cache(cache)

    print()
    print("Run summary:")
    for status, n in counts.items():
        print(f"  {status:<12} {n}")
    print(f"  total processed: {done}")
    total_ok = sum(1 for r in cache.values() if r.get("status") == "ok")
    print(f"Cache now contains: {len(cache)} entries; with abstracts: {total_ok}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
