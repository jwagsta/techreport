/* Mirror Bacteria Report — in-browser search.
   Loads search-index.json on first open, builds an inverted index,
   ranks results by token frequency + title boost + match position. */

(function () {
  'use strict';

  let indexPromise = null;
  let inverted = null;       // Map<token, Map<recordId, freq>>
  let records = null;
  let overlay = null;
  let inputEl = null;
  let resultsEl = null;
  let countEl = null;
  let activeIndex = -1;

  // ----- index loading -----

  function basePath() {
    // Determine the URL prefix to reach the site root from the current page.
    // Chapter pages live one level deep (/chapter-1-introduction/), so prefix is "..".
    // The index page is at the root, so prefix is ".".
    const path = window.location.pathname;
    if (/\/chapter-[\w-]+\/?$/.test(path) || path.split('/').filter(Boolean).length >= 1 && path !== '/') {
      // Anything inside a single sub-directory.
      // Resolve relative to current dir: '../search-index.json' or './search-index.json'.
      const segs = path.split('/').filter(Boolean);
      // If page is /<slug>/, depth=1 → use "..";  if root, depth=0 → use ".".
      // Use 'index.html' alone counts as root.
      if (segs.length >= 1 && !segs[segs.length - 1].includes('.')) {
        return '..';
      }
    }
    return '.';
  }

  async function loadIndex() {
    if (records) return records;
    if (!indexPromise) {
      const url = basePath() + '/search-index.json';
      indexPromise = fetch(url).then(function (r) {
        if (!r.ok) throw new Error('search-index.json: HTTP ' + r.status);
        return r.json();
      }).then(function (data) {
        records = data;
        buildInvertedIndex(records);
        return records;
      });
    }
    return indexPromise;
  }

  function tokenize(s) {
    if (!s) return [];
    return String(s)
      .toLowerCase()
      // strip diacritics
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .split(/[^a-z0-9]+/)
      .filter(function (t) { return t && t.length >= 2; });
  }

  // very small stemmer-ish normaliser (handles plurals)
  function stem(w) {
    if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
    if (w.length > 3 && w.endsWith('es')) return w.slice(0, -2);
    if (w.length > 3 && w.endsWith('s'))  return w.slice(0, -1);
    if (w.length > 4 && w.endsWith('ing')) return w.slice(0, -3);
    if (w.length > 4 && w.endsWith('ed'))  return w.slice(0, -2);
    return w;
  }

  function buildInvertedIndex(recs) {
    inverted = new Map();
    recs.forEach(function (r, idx) {
      const text = (r.title || '') + ' ' + (r.text || '') + ' ' + (r.sectionTitle || '') + ' ' + (r.chapTitle || '');
      const toks = tokenize(text).map(stem);
      const counts = new Map();
      toks.forEach(function (t) {
        counts.set(t, (counts.get(t) || 0) + 1);
      });
      counts.forEach(function (freq, tok) {
        let bucket = inverted.get(tok);
        if (!bucket) { bucket = new Map(); inverted.set(tok, bucket); }
        bucket.set(idx, freq);
      });
    });
  }

  // ----- search -----

  function search(query) {
    if (!records) return [];
    const qToks = tokenize(query).map(stem);
    if (!qToks.length) return [];

    // For each token, find candidate docs (exact + prefix)
    const candidateScores = new Map(); // docId -> score

    qToks.forEach(function (q) {
      // exact
      const exact = inverted.get(q);
      if (exact) {
        exact.forEach(function (freq, docId) {
          candidateScores.set(docId, (candidateScores.get(docId) || 0) + freq * 2);
        });
      }
      // prefix (e.g., 'mirror' matches 'mirroring')
      if (q.length >= 3) {
        inverted.forEach(function (bucket, token) {
          if (token === q) return; // already counted
          if (token.startsWith(q)) {
            bucket.forEach(function (freq, docId) {
              candidateScores.set(docId, (candidateScores.get(docId) || 0) + freq);
            });
          }
        });
      }
    });

    // Convert to ranked array, applying boosts
    const scored = [];
    candidateScores.forEach(function (score, docId) {
      const r = records[docId];
      // bonus: matches in title / heading
      const titleText = ((r.title || '') + ' ' + (r.sectionTitle || '')).toLowerCase();
      const queryLower = query.toLowerCase();
      let bonus = 0;
      if (titleText.indexOf(queryLower) !== -1) bonus += 10;
      if (r.kind === 'heading' || r.kind === 'figure' || r.kind === 'box') bonus += 2;
      // require at least one query token to actually appear
      const okMatch = qToks.some(function (q) {
        return titleText.indexOf(q) !== -1 || (r.text || '').toLowerCase().indexOf(q) !== -1;
      });
      if (!okMatch) return;
      scored.push({ rec: r, score: score + bonus, docId: docId });
    });
    scored.sort(function (a, b) { return b.score - a.score; });
    return scored.slice(0, 40);
  }

  // ----- snippet rendering -----

  function makeSnippet(text, query) {
    if (!text) return '';
    const lower = text.toLowerCase();
    const qLower = query.toLowerCase();
    let pos = lower.indexOf(qLower);
    if (pos === -1) {
      // try first query token
      const tok = tokenize(query)[0] || '';
      pos = tok ? lower.indexOf(tok) : 0;
      if (pos === -1) pos = 0;
    }
    const start = Math.max(0, pos - 60);
    const end = Math.min(text.length, pos + 180);
    const slice = (start > 0 ? '… ' : '') + text.slice(start, end) + (end < text.length ? ' …' : '');
    // highlight all query tokens
    const tokens = tokenize(query);
    let html = escapeHtml(slice);
    tokens.forEach(function (t) {
      if (!t) return;
      const re = new RegExp('(' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
      html = html.replace(re, '<mark>$1</mark>');
    });
    return html;
  }

  // ----- DOM / overlay -----

  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.className = 'search-overlay';
    overlay.innerHTML =
      '<div class="search-card" role="dialog" aria-modal="true" aria-label="Search">' +
        '<div class="search-input-row">' +
          '<svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="7" cy="7" r="5"/><path d="M11 11l3 3"/></svg>' +
          '<input type="text" class="search-input" placeholder="Search the report…" autocomplete="off" spellcheck="false">' +
          '<kbd>esc</kbd>' +
        '</div>' +
        '<div class="search-results" role="listbox"></div>' +
        '<div class="search-foot"><span class="search-count">Type to search</span><span class="search-hints">↑↓ to navigate · ↵ to open · ⌘K toggles</span></div>' +
      '</div>';
    document.body.appendChild(overlay);

    inputEl = overlay.querySelector('.search-input');
    resultsEl = overlay.querySelector('.search-results');
    countEl = overlay.querySelector('.search-count');

    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeSearch(); });
    inputEl.addEventListener('input', onInput);
    inputEl.addEventListener('keydown', onKey);

    return overlay;
  }

  function openSearch() {
    ensureOverlay();
    overlay.classList.add('open');
    document.body.classList.add('search-open');
    inputEl.value = '';
    inputEl.focus();
    resultsEl.innerHTML = '';
    countEl.textContent = 'Type to search';
    activeIndex = -1;
    loadIndex().catch(function (e) {
      countEl.textContent = 'Could not load search index';
      console.warn(e);
    });
  }

  function closeSearch() {
    if (!overlay) return;
    overlay.classList.remove('open');
    document.body.classList.remove('search-open');
  }

  function onInput() {
    const q = inputEl.value.trim();
    activeIndex = -1;
    if (!q) {
      resultsEl.innerHTML = '';
      countEl.textContent = 'Type to search';
      return;
    }
    if (!records) {
      countEl.textContent = 'Loading…';
      return;
    }
    const hits = search(q);
    countEl.textContent = hits.length === 0
      ? 'No matches'
      : (hits.length === 1 ? '1 match' : hits.length + ' matches');
    renderResults(hits, q);
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); closeSearch(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const items = resultsEl.querySelectorAll('.search-hit');
      if (!items.length) return;
      activeIndex = Math.max(0, Math.min(items.length - 1,
        activeIndex + (e.key === 'ArrowDown' ? 1 : -1)));
      items.forEach(function (n, i) { n.classList.toggle('active', i === activeIndex); });
      const a = items[activeIndex];
      if (a) a.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const items = resultsEl.querySelectorAll('.search-hit');
      const a = items[Math.max(0, activeIndex)];
      if (a) a.click();
    }
  }

  function chapHref(rec) {
    return basePath() + '/' + rec.chap + '/' + (rec.section && rec.section !== rec.chap ? '#' + rec.section : '');
  }

  function renderResults(hits, query) {
    if (!hits.length) { resultsEl.innerHTML = ''; return; }
    // group by chapter for visual clarity
    const groups = new Map();
    hits.forEach(function (h) {
      const k = h.rec.chap;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(h);
    });

    const html = [];
    groups.forEach(function (list, chapId) {
      const top = list[0].rec;
      html.push('<div class="search-group">');
      html.push('<div class="search-group-label">Ch. ' + escapeHtml(String(top.chapNum || '')) +
                ' · ' + escapeHtml(top.chapTitle || chapId) + '</div>');
      list.forEach(function (h) {
        const r = h.rec;
        const heading = r.kind === 'heading'
          ? r.text
          : (r.title || (r.sectionNum ? r.sectionNum + ' ' : '') + (r.sectionTitle || ''));
        const snippet = r.kind === 'heading' ? '' : makeSnippet(r.text || '', query);
        const kindLabel = ({
          paragraph: 'Paragraph',
          figure:    'Figure',
          box:       'Box',
          heading:   'Section',
          list:      'List',
          table:     'Table',
        })[r.kind] || 'Item';
        html.push(
          '<a class="search-hit" href="' + chapHref(r) + '">' +
            '<div class="search-hit-meta"><span class="search-hit-kind">' + escapeHtml(kindLabel) + '</span>' +
              (heading ? '<span class="search-hit-heading">' + makeSnippet(heading, query) + '</span>' : '') +
            '</div>' +
            (snippet ? '<div class="search-hit-snippet">' + snippet + '</div>' : '') +
          '</a>'
        );
      });
      html.push('</div>');
    });
    resultsEl.innerHTML = html.join('');
  }

  // ----- triggers -----

  document.addEventListener('click', function (e) {
    const t = e.target.closest('[data-search-open]');
    if (t) { e.preventDefault(); openSearch(); }
  });

  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (overlay && overlay.classList.contains('open')) closeSearch();
      else openSearch();
    }
  });

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
})();
