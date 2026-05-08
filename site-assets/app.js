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
  const forwardStack = [];

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
      drawer.classList.toggle('has-forward', forwardStack.length > 0);
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
    // Any new navigation invalidates the forward stack.
    forwardStack.length = 0;
    applyPreview(opts);
  }

  window.drawerBack = function () {
    if (!history.length) {
      // No history to go back through → first click closes the drawer.
      window.closeDrawer();
      return;
    }
    if (currentPreview) forwardStack.push(currentPreview);
    const prev = history.pop();
    applyPreview(prev);
  };

  window.drawerForward = function () {
    if (!forwardStack.length) return;
    if (currentPreview) history.push(currentPreview);
    const next = forwardStack.pop();
    applyPreview(next);
  };

  window.closeDrawer = function () {
    if (drawer) drawer.classList.remove('open');
    if (scrim) scrim.classList.remove('open');
    if (drawer) {
      drawer.setAttribute('aria-hidden', 'true');
      drawer.classList.remove('has-history');
      drawer.classList.remove('has-forward');
    }
    history.length = 0;
    forwardStack.length = 0;
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
        // Whole-chapter preview: header + the full summary, which is
        // every direct child of .body up to (but not including) the
        // first <section class="subsection">.
        const headerHtml = doc.querySelector('.chap-header')?.outerHTML || '';
        const body = doc.querySelector('.body');
        let summaryHtml = '';
        if (body) {
          for (const child of Array.from(body.children)) {
            if (child.matches('section.subsection')) break;
            summaryHtml += child.outerHTML;
          }
        }
        return {
          label: chapNumLabel + chapTitle,
          html: headerHtml + summaryHtml,
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
    // The bibliography <li> is now structured as
    //   .ref-cite (the citation)  +  .ref-abstract (hidden until expanded).
    // For the drawer preview we want the citation text only — the abstract
    // gets its own labeled block so the visual hierarchy matches the
    // expanded-in-place view.
    const citeNode = refLi.querySelector('.ref-cite');
    const refHtml = citeNode ? citeNode.innerHTML : refLi.innerHTML;
    const absNode = refLi.querySelector('.ref-abstract-body');
    const absHtml = absNode ? absNode.innerHTML : '';
    const url = refLi.dataset.url || '';
    const doi = refLi.dataset.doi || '';
    // Plain-text query for Google Scholar / Google search.
    const refText = (citeNode ? citeNode.textContent : refLi.textContent || '')
      .replace(/\s+/g, ' ').trim();
    const googleHref = 'https://www.google.com/search?q=' + encodeURIComponent(refText);
    const actions = [];
    const arrow = '<span class="ext-arrow" aria-hidden="true">↗</span>';
    actions.push(
      '<a href="' + escapeHtml(googleHref) + '" target="_blank" rel="noopener noreferrer">Search for this reference' + arrow + '</a>'
    );
    if (url) {
      actions.push(
        '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">Open source' + arrow + '</a>'
      );
    }
    if (doi) {
      actions.push(
        '<a href="https://doi.org/' + escapeHtml(doi) + '" target="_blank" rel="noopener noreferrer">DOI: ' + escapeHtml(doi) + '</a>'
      );
    }
    const abstractBlock = absHtml
      ? (
        '<div class="ref-abstract drawer-abstract">' +
          '<div class="ref-abstract-label">Abstract</div>' +
          '<div class="ref-abstract-body">' + absHtml + '</div>' +
        '</div>'
      )
      : '';
    return {
      label: '',                // suppress the redundant src-title
      previewLabel: 'Reference',
      html:
        '<div class="ref-card">' + refHtml + '</div>' +
        abstractBlock +
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
      'style="' + styleVars + 'width:120px;height:120px;border-radius:50%;flex:0 0 120px"></div>'
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

  // ---------- bibliography: click a reference to toggle its abstract ----------
  // The end-of-chapter <ol class="refs-list"> renders each entry as
  //   <li class="ref-item has-abstract">
  //     <div class="ref-cite">…</div>
  //     <div class="ref-abstract" hidden>…</div>
  //   </li>
  // Clicking anywhere on the cite line (except a real link inside it) flips
  // the hidden state of the sibling abstract block.
  document.addEventListener('click', function (e) {
    const cite = e.target.closest('.refs-list .ref-item.has-abstract > .ref-cite');
    if (!cite) return;
    // Don't hijack clicks on actual links inside the citation (DOI, etc.).
    if (e.target.closest('a')) return;
    const li = cite.parentElement;
    const abs = li.querySelector(':scope > .ref-abstract');
    if (!abs) return;
    const open = li.classList.toggle('expanded');
    if (open) abs.removeAttribute('hidden');
    else abs.setAttribute('hidden', '');
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

  // ---------- Figure-caption collision guard ----------
  // Figcaptions are absolutely positioned so they can extend past the
  // figure's row when the caption is taller than the image — that's the
  // intended Tufte-style overflow into next paragraphs. But a long caption
  // can collide with a sidenote on a paragraph immediately below the figure.
  // When that's about to happen, extend the figrow's min-height so the
  // caption fits inside its row again. Otherwise leave it overflowing.
  (function () {
    function adjustFigrows() {
      const figrows = document.querySelectorAll('.figrow');
      figrows.forEach(function (figrow) {
        const cap = figrow.querySelector('figcaption');
        if (!cap) return;
        figrow.style.minHeight = '';  // reset before measuring
        const capH = cap.offsetHeight;
        const figH = figrow.offsetHeight;
        if (capH <= figH) return;  // image is at least as tall — no overflow.
        const overflow = capH - figH;
        let consumed = 0;
        let collide = false;
        let sib = figrow.nextElementSibling;
        while (sib && consumed < overflow) {
          if (sib.querySelector && sib.querySelector('.row-sidenotes')) {
            collide = true;
            break;
          }
          consumed += sib.offsetHeight || 0;
          sib = sib.nextElementSibling;
        }
        if (collide) {
          figrow.style.minHeight = capH + 'px';
        }
      });
    }
    function schedule() {
      if (window.requestAnimationFrame) requestAnimationFrame(adjustFigrows);
      else adjustFigrows();
    }
    if (document.readyState === 'complete') schedule();
    else window.addEventListener('load', schedule, { once: true });
    let resizeTimer = null;
    window.addEventListener('resize', function () {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(schedule, 120);
    }, { passive: true });
  })();

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

  // ============================================================
  // Mobile author stacks — collapsed view shows max 5 overlapping
  // headshots with a "+N more" badge. Tap anywhere on the row to
  // expand into the full grid view; tapping individual faces while
  // collapsed expands rather than opening the per-author drawer.
  // ============================================================
  (function initAuthorStacks() {
    const NARROW = '(max-width: 900px)';
    const MAX_VISIBLE = 10;

    function setup(strip) {
      if (strip.dataset.stackInit === '1') return;
      strip.dataset.stackInit = '1';
      const authors = strip.querySelectorAll('.author');
      const total = authors.length;
      if (total === 0) return;

      // Inline "+N" badge — only when the strip would have to truncate.
      // (Chapter author lists with 4–7 names just show every circle.)
      if (total > MAX_VISIBLE) {
        strip.classList.add('has-overflow');
        const count = document.createElement('span');
        count.className = 'author-stack-count';
        count.textContent = '+' + (total - MAX_VISIBLE);
        count.setAttribute('aria-hidden', 'true');
        strip.appendChild(count);
      }

      // Always render the +/Show less toggle on mobile so readers can
      // expand into the named-card grid (CSS hides it on wide).
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'author-stack-toggle';
      function refresh() {
        const expanded = strip.classList.contains('expanded');
        toggle.textContent = expanded ? 'Show less' : '+';
        toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        toggle.setAttribute(
          'aria-label',
          expanded ? 'Show less' : 'Show all authors',
        );
      }
      refresh();
      toggle.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        strip.classList.toggle('expanded');
        refresh();
      });
      strip.appendChild(toggle);

      // Tap anywhere on the collapsed row to expand (mobile only).
      // Capture-phase so we beat the document-level [data-author-name] handler.
      strip.addEventListener('click', function (e) {
        if (!window.matchMedia(NARROW).matches) return;
        if (strip.classList.contains('expanded')) return;
        if (e.target === toggle || toggle.contains(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        strip.classList.add('expanded');
        refresh();
      }, true);
    }

    function init() {
      document.querySelectorAll('.author-strip, .reviewer-strip, .faculty .list')
        .forEach(setup);
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else { init(); }

    // Switching back to wide viewport: drop the expanded marker so the
    // grid layout returns naturally.
    window.addEventListener('resize', function () {
      if (window.matchMedia(NARROW).matches) return;
      document.querySelectorAll('.author-strip.expanded, .faculty .list.expanded')
        .forEach(s => s.classList.remove('expanded'));
    });
  })();
})();
