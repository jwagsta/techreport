/* Mirror Bacteria report — drawer + sidenote interactions.
   No build step, no framework. */

(function () {
  'use strict';

  const scrim = document.getElementById('scrim');
  const drawer = document.getElementById('drawer');
  const dBody = document.getElementById('d-body');
  const dSource = document.getElementById('d-source');
  const dJump = document.getElementById('d-jump');

  let pendingHref = null;

  function openDrawer(opts) {
    pendingHref = opts.href || null;
    if (dSource) dSource.textContent = opts.label || '—';
    if (dBody) dBody.innerHTML = opts.html || '';
    if (drawer) {
      drawer.classList.add('open');
      drawer.classList.toggle('wide', !!opts.wide);
      drawer.setAttribute('aria-hidden', 'false');
    }
    if (scrim) scrim.classList.add('open');
  }

  window.closeDrawer = function () {
    if (drawer) drawer.classList.remove('open');
    if (scrim) scrim.classList.remove('open');
    if (drawer) drawer.setAttribute('aria-hidden', 'true');
    pendingHref = null;
  };

  window.jumpThere = function () {
    if (pendingHref) {
      const href = pendingHref;
      window.closeDrawer();
      // small delay so the drawer animation feels complete before jump
      setTimeout(function () { window.location.href = href; }, 200);
    } else {
      window.closeDrawer();
    }
  };

  // ---------- internal-link previews ----------

  function findOnPage(targetId) {
    if (!targetId) return null;
    const el = document.getElementById(targetId);
    return el || null;
  }

  function shouldBeWide(el) {
    // Figures and tables look much better in a wider drawer.
    if (!el) return false;
    if (el.tagName === 'FIGURE' || el.tagName === 'TABLE') return true;
    if (el.querySelector && (el.querySelector('figure') || el.querySelector('table'))) return true;
    return false;
  }

  function buildLocalPreview(targetId) {
    const el = findOnPage(targetId);
    if (!el) return null;

    const clone = el.cloneNode(true);
    clone.querySelectorAll('[id]').forEach(function (n) { n.removeAttribute('id'); });
    clone.removeAttribute('id');

    let label = 'On this page';

    if (el.tagName === 'SECTION') {
      const h = el.querySelector('h2, h3, h4');
      label = h ? h.textContent.trim() : 'Section';
    } else if (el.tagName === 'FIGURE') {
      const fc = el.querySelector('figcaption b');
      label = fc ? fc.textContent.trim() : 'Figure';
    } else if (el.tagName === 'ASIDE' && el.classList.contains('boxrow')) {
      const lab = el.querySelector('.box-label');
      const t = el.querySelector('.box-title');
      label = (lab ? lab.textContent.trim() + ' · ' : '') + (t ? t.textContent.trim() : 'Box');
    } else if (el.tagName === 'TABLE' || (el.classList && el.classList.contains('tablerow'))) {
      label = 'Table';
    }

    return {
      label: label,
      html: '<div class="deyebrow">' + escapeHtml(label) + '</div>' + clone.outerHTML,
      href: '#' + targetId,
      wide: shouldBeWide(el),
    };
  }

  // Lightweight cross-page fetch + section extraction.
  async function fetchSectionFromOtherChapter(chapSlug, targetId) {
    const url = '../' + chapSlug + '/';
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const text = await res.text();
      const doc = new DOMParser().parseFromString(text, 'text/html');
      // Pull base info: chapter title (the first h1) and target element
      const chapTitle = doc.querySelector('.chap-title')?.textContent?.trim() || chapSlug;
      let target = chapSlug === targetId ? null : doc.getElementById(targetId);
      if (!target) {
        // Whole-chapter preview: header + first paragraph or two of body
        const headerHtml = doc.querySelector('.chap-header')?.outerHTML || '';
        const firstParas = Array.from(doc.querySelectorAll('.body .row .prose')).slice(0, 3)
          .map(function (p) { return p.outerHTML; }).join('');
        return {
          label: 'Chapter · ' + chapTitle,
          html:
            '<div class="deyebrow">' + escapeHtml('Chapter · ' + chapTitle) + '</div>' +
            headerHtml + firstParas,
          href: url,
          wide: false,
        };
      }
      // Targeted preview
      const clone = target.cloneNode(true);
      clone.querySelectorAll('[id]').forEach(function (n) { n.removeAttribute('id'); });
      clone.removeAttribute('id');
      let label = 'In: ' + chapTitle;
      if (target.tagName === 'SECTION') {
        const h = target.querySelector('h2, h3, h4');
        if (h) label = h.textContent.trim() + ' · ' + chapTitle;
      } else if (target.tagName === 'FIGURE') {
        const b = target.querySelector('figcaption b');
        if (b) label = b.textContent.trim();
      } else if (target.tagName === 'ASIDE' && target.classList.contains('boxrow')) {
        const t = target.querySelector('.box-title');
        if (t) label = t.textContent.trim();
      }
      // Rewrite relative image src so they still load from inside the drawer
      clone.querySelectorAll('img[src]').forEach(function (img) {
        const src = img.getAttribute('src');
        if (src && src.indexOf('://') === -1 && !src.startsWith('/')) {
          // src in target page was like ../assets/foo.png; in our drawer, point to that page's assets
          if (src.startsWith('../')) {
            img.setAttribute('src', '../' + chapSlug + '/' + src);
          }
        }
      });
      return {
        label: label,
        html: '<div class="deyebrow">' + escapeHtml(label) + '</div>' + clone.outerHTML,
        href: url + '#' + targetId,
        wide: shouldBeWide(target),
      };
    } catch (e) {
      return null;
    }
  }

  function buildCrossPagePreview(target) {
    const targets = window.__TARGETS__ || {};
    const chapSlug = targets[target];
    if (!chapSlug) {
      // Best-effort fallback: parse "chapter-N-..." prefix
      const m = target.match(/^(chapter-\d+(?:-[a-z0-9-]+)?)/);
      const guess = m ? m[1] : null;
      return {
        label: 'External target',
        html:
          '<div class="deyebrow">Link</div>' +
          (guess
            ? '<h2>Open ' + guess.replace(/-/g, ' ') + '</h2><p>Click <em>Jump there</em> above to follow this link.</p>'
            : '<p>Could not locate target on this page.</p>'),
        href: guess ? '../' + guess + '/' : '#' + target,
      };
    }
    const isChapterRoot = chapSlug === target;
    const href = '../' + chapSlug + '/' + (isChapterRoot ? '' : '#' + target);
    const niceName = chapSlug.replace(/-/g, ' ').replace(/^chapter (\d+)/, 'Chapter $1');
    return {
      label: niceName,
      html:
        '<div class="deyebrow">' + escapeHtml(niceName) + '</div>' +
        '<h2>' + (isChapterRoot ? 'Open ' + escapeHtml(niceName) : 'Open section') + '</h2>' +
        '<p>This link points to another part of the report. Click <em>Jump there ↗</em> above to open it, or close this preview to keep reading.</p>',
      href: href,
    };
  }

  function buildCitePreview(citeKey) {
    const idx = (citeKey.split(':')[1] || '').trim();
    const refLi = document.getElementById('ref-' + idx);
    if (!refLi) return null;
    const refHtml = refLi.innerHTML;
    const url = refLi.dataset.url || '';
    const doi = refLi.dataset.doi || '';
    let actions = '';
    if (url) {
      actions += '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">Open paper ↗</a>';
    }
    if (doi) {
      actions += '<a href="https://doi.org/' + escapeHtml(doi) + '" target="_blank" rel="noopener noreferrer">DOI: ' + escapeHtml(doi) + '</a>';
    }
    return {
      label: 'Reference',
      html:
        '<div class="deyebrow">Reference</div>' +
        '<div class="ref-card">' + refHtml + '</div>' +
        (actions ? '<div class="ref-actions">' + actions + '</div>' : ''),
      href: '#ref-' + idx,
    };
  }

  // Intercept clicks on internal links anywhere in the document — including
  // inside the drawer, where the drawer should swap its own content
  // rather than open a nested preview.
  document.addEventListener('click', function (e) {
    const a = e.target.closest('a.ilink, a.refn, a.cite');
    if (!a) return;

    // If link is inside the drawer, follow it inside the drawer (no nesting)
    const insideDrawer = !!a.closest('.drawer');

    if (a.classList.contains('cite')) {
      e.preventDefault();
      const preview = buildCitePreview(a.dataset.cite || '');
      if (preview) openDrawer(preview);
      return;
    }

    if (a.classList.contains('refn')) {
      const fn = a.dataset.fn;
      const fnEl = document.getElementById('fn-' + fn);
      if (fnEl) {
        e.preventDefault();
        const text = fnEl.querySelector('.text');
        const html =
          '<div class="deyebrow">Footnote ' + escapeHtml(fn) + '</div>' +
          '<p>' + (text ? text.innerHTML : fnEl.innerHTML) + '</p>';
        openDrawer({
          label: 'Note ' + fn,
          html: html,
          href: '#fn-' + fn,
        });
      }
      return;
    }

    // ilink — intercept always; open in drawer (or replace drawer content)
    e.preventDefault();
    const target = a.dataset.target || (a.getAttribute('href') || '').replace(/^#/, '');
    const local = findOnPage(target);
    if (local) {
      openDrawer(buildLocalPreview(target));
      return;
    }
    // Cross-page: try to fetch the actual chapter content for a real preview.
    const targets = window.__TARGETS__ || {};
    const chapSlug = targets[target] || (target.match(/^(chapter-\d+(?:-[a-z0-9-]+)?)/) || [])[1];
    if (!chapSlug) {
      openDrawer(buildCrossPagePreview(target));
      return;
    }
    // Show a quick "loading" state, then swap.
    openDrawer({
      label: 'Loading…',
      html: '<div class="deyebrow">Loading</div><p style="color:var(--muted)">Fetching preview…</p>',
      href: '../' + chapSlug + '/' + (chapSlug === target ? '' : '#' + target),
    });
    fetchSectionFromOtherChapter(chapSlug, target).then(function (p) {
      if (p) openDrawer(p);
      else openDrawer(buildCrossPagePreview(target));
    });
  });

  // ESC closes drawer
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') window.closeDrawer();
  });

  // ---------- footnote hover peek ----------
  // On wide viewports we show a quick popover on hover over a footnote anchor.
  let peekEl = null;
  let peekTimer = null;

  function ensurePeek() {
    if (peekEl) return peekEl;
    peekEl = document.createElement('div');
    peekEl.className = 'fnpeek';
    document.body.appendChild(peekEl);
    return peekEl;
  }

  function positionPeek(anchor, peek) {
    const r = anchor.getBoundingClientRect();
    const peekRect = peek.getBoundingClientRect();
    let left = r.left + window.scrollX + r.width / 2 - peekRect.width / 2;
    let top = r.bottom + window.scrollY + 6;
    // keep on screen
    const max = window.scrollX + window.innerWidth - peekRect.width - 12;
    if (left > max) left = max;
    if (left < 12 + window.scrollX) left = 12 + window.scrollX;
    peek.style.left = left + 'px';
    peek.style.top = top + 'px';
  }

  document.addEventListener('mouseover', function (e) {
    if (window.matchMedia('(max-width: 800px)').matches) return;
    const fnA = e.target.closest('a.refn');
    const citeA = e.target.closest('a.cite');
    if (!fnA && !citeA) return;
    const peek = ensurePeek();
    if (fnA) {
      const fn = fnA.dataset.fn;
      const fnEl = document.getElementById('fn-' + fn);
      if (!fnEl) return;
      const text = fnEl.querySelector('.text');
      peek.innerHTML =
        '<strong style="color:var(--accent); margin-right:6px;">' + escapeHtml(fn) + '</strong>' +
        (text ? text.innerHTML : fnEl.innerHTML);
      peek.classList.add('show');
      positionPeek(fnA, peek);
    } else if (citeA) {
      const idx = (citeA.dataset.cite || '').split(':')[1] || '';
      const li = document.getElementById('ref-' + idx);
      if (!li) return;
      peek.innerHTML = li.innerHTML;
      peek.classList.add('show');
      positionPeek(citeA, peek);
    }
    clearTimeout(peekTimer);
  });

  document.addEventListener('mouseout', function (e) {
    const a = e.target.closest('a.refn, a.cite');
    if (!a) return;
    if (!peekEl) return;
    peekTimer = setTimeout(function () { peekEl.classList.remove('show'); }, 100);
  });

  // ---------- TOC current-section highlight on scroll ----------

  const tocLinks = document.querySelectorAll('.toc a');
  if (tocLinks.length && 'IntersectionObserver' in window) {
    const linkByHash = new Map();
    tocLinks.forEach(function (link) {
      const href = link.getAttribute('href') || '';
      if (href.startsWith('#')) linkByHash.set(href.slice(1), link);
    });

    const observed = [];
    linkByHash.forEach(function (_link, id) {
      const el = document.getElementById(id);
      if (el) observed.push(el);
    });

    if (observed.length) {
      const io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            tocLinks.forEach(function (l) { l.classList.remove('current'); });
            const id = entry.target.id;
            const link = linkByHash.get(id);
            if (link) link.classList.add('current');
          }
        });
      }, { rootMargin: '-30% 0px -60% 0px', threshold: 0 });

      observed.forEach(function (el) { io.observe(el); });
    }
  }

  // ---------- helper ----------

  // ---------- mobile: brand link toggles the chapter menu ----------
  (function () {
    const wrap = document.querySelector('.brand-wrap');
    if (!wrap) return;
    const brand = wrap.querySelector('.brand');
    if (!brand) return;

    function isNarrow() { return window.matchMedia('(max-width: 900px)').matches; }

    brand.addEventListener('click', function (e) {
      if (!isNarrow()) return;
      e.preventDefault();
      wrap.classList.toggle('menu-open');
    });
    document.addEventListener('click', function (e) {
      if (!wrap.contains(e.target)) wrap.classList.remove('menu-open');
    });
  })();

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
})();
