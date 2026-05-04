/* Mirror Bacteria report — drawer + sidenote interactions.
   No build step, no framework. */

(function () {
  'use strict';

  const scrim = document.getElementById('scrim');
  const drawer = document.getElementById('drawer');
  const dBody = document.getElementById('d-body');
  const dSource = document.getElementById('d-source');
  const dJump = document.getElementById('d-jump');

  let currentPreview = null;
  const history = [];

  function applyPreview(opts) {
    currentPreview = opts || null;
    if (dSource) {
      const lbl = (opts && opts.label) || '';
      dSource.textContent = lbl;
      dSource.style.display = lbl ? '' : 'none';
    }
    if (dBody) dBody.innerHTML = (opts && opts.html) || '';
    const prevLabel = document.getElementById('d-preview-label');
    if (prevLabel) prevLabel.textContent = (opts && opts.previewLabel) || 'Preview';
    if (drawer) {
      drawer.classList.add('open');
      drawer.setAttribute('aria-hidden', 'false');
      drawer.classList.toggle('has-history', history.length > 0);
      if (dJump) {
        dJump.style.display = (opts && opts.hideJump) ? 'none' : '';
      }
    }
    if (scrim) scrim.classList.add('open');
  }

  function openDrawer(opts) {
    if (currentPreview && opts) {
      // navigating from one preview to another → push the previous onto stack
      history.push(currentPreview);
    }
    applyPreview(opts);
  }

  window.drawerBack = function () {
    if (!history.length) return;
    const prev = history.pop();
    applyPreview(prev);
  };

  window.closeDrawer = function () {
    if (drawer) drawer.classList.remove('open');
    if (scrim) scrim.classList.remove('open');
    if (drawer) {
      drawer.setAttribute('aria-hidden', 'true');
      drawer.classList.remove('has-history');
    }
    history.length = 0;
    currentPreview = null;
  };

  window.jumpThere = function () {
    const href = currentPreview && currentPreview.href;
    if (href) {
      window.closeDrawer();
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
      html: clone.outerHTML,
      href: '#' + targetId,
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
      // Preserve the chapter number from the slug (e.g. "chapter-4-…" → "4").
      const chapMatch = chapSlug.match(/^chapter-(\d+)/);
      const chapNumLabel = chapMatch ? 'Chapter ' + chapMatch[1] + ' · ' : '';
      let target = chapSlug === targetId ? null : doc.getElementById(targetId);
      if (!target) {
        // Whole-chapter preview: header + first paragraph or two of body
        const headerHtml = doc.querySelector('.chap-header')?.outerHTML || '';
        const firstParas = Array.from(doc.querySelectorAll('.body .row .prose')).slice(0, 3)
          .map(function (p) { return p.outerHTML; }).join('');
        return {
          label: chapNumLabel + chapTitle,
          html: headerHtml + firstParas,
          href: url,
        };
      }
      // Targeted preview
      const clone = target.cloneNode(true);
      clone.querySelectorAll('[id]').forEach(function (n) { n.removeAttribute('id'); });
      clone.removeAttribute('id');
      let label = chapNumLabel + chapTitle;
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
        html: clone.outerHTML,
        href: url + '#' + targetId,
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
          '' +
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
        '' +
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
    // Plain-text query for Google Scholar / Google search.
    const refText = (refLi.textContent || '').replace(/\s+/g, ' ').trim();
    const googleHref = 'https://www.google.com/search?q=' + encodeURIComponent(refText);
    const actions = [];
    actions.push(
      '<a href="' + escapeHtml(googleHref) + '" target="_blank" rel="noopener noreferrer">Google this paper ↗</a>'
    );
    if (url) {
      actions.push(
        '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">Open source ↗</a>'
      );
    }
    if (doi) {
      actions.push(
        '<a href="https://doi.org/' + escapeHtml(doi) + '" target="_blank" rel="noopener noreferrer">DOI: ' + escapeHtml(doi) + '</a>'
      );
    }
    return {
      label: '',                // suppress the redundant src-title
      previewLabel: 'Reference',
      html:
        '<div class="ref-card">' + refHtml + '</div>' +
        '<div class="ref-actions">' + actions.join('') + '</div>',
      href: '',
      hideJump: true,
    };
  }

  // Click handler on author/reviewer cards → open a drawer preview.
  // The body shows just the picture (duotone) + name + affiliation.
  function buildAuthorFaceHtml(name) {
    const head = (window.__HEADSHOTS__ || {})[name];
    if (!head || !head.url) {
      return '';  // initials fallback drawn elsewhere if needed
    }
    const r = (head.height || 1) / (head.width || 1);
    const c = head.crop || { x: 0, y: 0, size: 1 };
    const size = Math.max(0.0001, c.size);
    const bgSize = (1 / size) * 100;
    const bgX = size >= 1 ? 0 : (c.x / (1 - size)) * 100;
    const bgY = Math.abs(r - size) < 1e-9 ? 0 : (c.y * r) / (r - size) * 100;
    const styleVars =
      "--head-img:url('" + head.url + "');" +
      "--head-bg-size:" + bgSize.toFixed(3) + "% auto;" +
      "--head-bg-pos:" + bgX.toFixed(3) + "% " + bgY.toFixed(3) + "%;";
    return (
      '<div class="face drawer-face" data-headshot="1" ' +
      'style="' + styleVars + 'width:120px;height:120px;border-radius:50%"></div>'
    );
  }

  function buildAuthorPreview(name, aff, role) {
    const safe = (s) => escapeHtml(s || '');
    const label = role === 'reviewer' ? 'Reviewer' : 'Author';
    const faceHtml = buildAuthorFaceHtml(name);
    return {
      // No src-title — name is shown next to the face, no need to repeat it.
      label: '',
      previewLabel: label,
      html:
        '<div style="font-family: var(--sans); padding: 8px 0; display: flex; gap: 22px; align-items: center;">' +
          faceHtml +
          '<div style="min-width:0;">' +
            '<h2 style="font-family: var(--serif); font-size: 26px; font-weight: 600; line-height: 1.2; margin: 0 0 6px;">' + safe(name) + '</h2>' +
            (aff
              ? '<p style="color: var(--muted); font-size: 13px; margin: 0;">' + safe(aff) + '</p>'
              : '') +
          '</div>' +
        '</div>',
      href: '',
      hideJump: true,
    };
  }

  function openAuthorFromEl(el) {
    if (!el) return;
    openDrawer(buildAuthorPreview(
      el.dataset.authorName,
      el.dataset.authorAff,
      el.dataset.authorRole || 'author'
    ));
  }

  document.addEventListener('click', function (e) {
    const author = e.target.closest('[data-author-name]');
    if (author) {
      e.preventDefault();
      openAuthorFromEl(author);
      return;
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') {
      const author = document.activeElement?.closest?.('[data-author-name]');
      if (author) {
        e.preventDefault();
        openAuthorFromEl(author);
      }
    }
  });

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
          '' +
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
      html: '<p style="color:var(--muted); font-family: var(--sans); font-size: 13px;">Loading…</p>',
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
