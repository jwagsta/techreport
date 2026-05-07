/* Mirror Bacteria report — "Ask AI" chat widget.
   No build step, no framework. */

(function () {
  'use strict';

  const STORAGE_KEY = 'mirror-bacteria-chat:v2';

  const SUGGESTIONS = [
    'Summarize the report in 3 bullets.',
    'What are the main biosecurity concerns?',
    'How could mirror bacteria evade the immune system?',
    'Who authored this report?',
  ];

  const BG_OPTIONS = [
    { id: 'non-specialist',  label: 'New to biology',                hint: 'I want plain-English explanations and definitions.' },
    { id: 'some-background', label: 'Some biology background',       hint: "I'm comfortable with general biology terms." },
    { id: 'expert',          label: 'Researcher / specialist',       hint: "I work in biology or a related field." },
  ];

  const BG_LABELS = Object.fromEntries(BG_OPTIONS.map(o => [o.id, o.label]));

  // ---------- API endpoint ----------
  function apiUrl() {
    const m = document.querySelector('meta[name="chat-api"]');
    return (m && m.getAttribute('content')) || '';
  }
  function turnstileSiteKey() {
    const m = document.querySelector('meta[name="turnstile-site-key"]');
    return (m && m.getAttribute('content')) || '';
  }

  // ---------- State ----------
  function defaultState() {
    return {
      open: false,
      messages: [],          // [{ role, content, expanded? }]
      position: null,        // {x, y}
      sessionToken: null,
      userBackground: null,  // 'non-specialist' | 'some-background' | 'expert'
    };
  }
  function loadState() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      return Object.assign(defaultState(), JSON.parse(raw));
    } catch { return defaultState(); }
  }
  function saveState() {
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
  }

  // ---------- Reader location ----------
  function readerLocation() {
    const ch = document.querySelector('meta[name="chapter-id"]');
    const ct = document.querySelector('meta[name="chapter-title"]');
    const chapterId = (ch && ch.getAttribute('content')) || 'index';
    const chapterTitle = (ct && ct.getAttribute('content')) || 'Home';
    let sectionId = null, sectionTitle = null;
    const mid = window.innerHeight / 2;
    const headings = document.querySelectorAll('h3[id], h4[id], section[id] > h2[id]');
    for (let i = headings.length - 1; i >= 0; i--) {
      const r = headings[i].getBoundingClientRect();
      if (r.top <= mid) {
        sectionId = headings[i].id;
        sectionTitle = headings[i].textContent.trim();
        break;
      }
    }
    return { chapterId, chapterTitle, sectionId, sectionTitle };
  }

  // ---------- Tiny DOM helper ----------
  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      const v = attrs[k];
      if (k === 'className') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    if (children) children.forEach(c => c && e.appendChild(c));
    return e;
  }

  // ---------- Markdown ----------
  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escapeAttr(s) {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  }

  // Allow only known-good URL shapes. Anything else → strip the link, keep the text.
  // Valid: same-page anchor (#foo), root (/), root with anchor (/#foo),
  // /chapter-*/, /chapter-*/#anchor, /summary/, /summary/#anchor, http(s)://...
  function safeHref(href) {
    if (!href) return null;
    if (/^https?:\/\//i.test(href)) return href;
    if (href === '/' || href === '#' ) return href;
    if (/^#[\w-]+$/.test(href)) return href;
    if (/^\/(#[\w-]+)?$/.test(href)) return href;
    if (/^\/chapter-[\w-]+\/(#[\w-]+)?$/.test(href)) return href;
    if (/^\/summary\/(#[\w-]+)?$/.test(href)) return href;
    return null;
  }

  // Custom rendering for citations:
  //   [§4.1 Innate immune detection ...](url)  → eyebrow + serif title
  //   [Chapter 4](url)                          → eyebrow only
  //   [anything else](url)                      → plain link
  function renderLink(text, url) {
    const safe = safeHref(url);
    if (!safe) return escapeHtml(text);                         // hallucinated path → plain text

    // Match "§N.M …" or "§N.M.O …" with the rest as title
    const sec = text.match(/^§\s*(\d+(?:\.\d+){0,3})\s+(.+)$/);
    if (sec) {
      return `<a class="cite" href="${escapeAttr(safe)}">` +
               `<span class="cite-num">§${escapeHtml(sec[1])}</span>` +
               `<span class="cite-title">${escapeHtml(sec[2])}</span>` +
             `</a>`;
    }
    // Match "Chapter N" or "Chapter N — Title"
    const ch = text.match(/^Chapter\s+(\d+)(?:\s*[—–-]\s*(.+))?$/);
    if (ch) {
      const num = `<span class="cite-num">Chapter ${escapeHtml(ch[1])}</span>`;
      const title = ch[2] ? `<span class="cite-title">${escapeHtml(ch[2])}</span>` : '';
      return `<a class="cite" href="${escapeAttr(safe)}">${num}${title}</a>`;
    }
    return `<a href="${escapeAttr(safe)}">${escapeHtml(text)}</a>`;
  }

  function renderInline(s) {
    // Operate on the already-escaped text. Replace markdown link syntax with rendered HTML.
    let out = '';
    let i = 0;
    const re = /\[([^\]]+)\]\(([^)\s]+)\)/g;
    let m;
    while ((m = re.exec(s)) !== null) {
      out += s.slice(i, m.index);
      out += renderLink(m[1], m[2]);
      i = m.index + m[0].length;
    }
    out += s.slice(i);
    // Bold + italic on the result. Be careful not to apply inside HTML tags.
    out = out.replace(/\*\*([^*<>]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*])\*([^*<>]+)\*/g, '$1<em>$2</em>');
    return out;
  }

  function renderMarkdown(src) {
    const lines = escapeHtml(src).split('\n');
    const out = [];
    let para = [];
    let listKind = null;       // 'ul' | 'ol' | null
    function flushPara() {
      if (para.length) { out.push('<p>' + renderInline(para.join(' ')) + '</p>'); para = []; }
    }
    function flushList() { if (listKind) { out.push('</' + listKind + '>'); listKind = null; } }

    for (const ln of lines) {
      const t = ln.trim();
      if (!t) { flushPara(); flushList(); continue; }

      // Headings (#, ##, ###, ####)
      const h = t.match(/^(#{1,4})\s+(.+)$/);
      if (h) { flushPara(); flushList(); out.push(`<h${h[1].length}>${renderInline(h[2])}</h${h[1].length}>`); continue; }

      // Unordered list
      if (/^[-*]\s+/.test(t)) {
        flushPara();
        if (listKind !== 'ul') { flushList(); out.push('<ul>'); listKind = 'ul'; }
        out.push('<li>' + renderInline(t.replace(/^[-*]\s+/, '')) + '</li>');
        continue;
      }
      // Ordered list
      if (/^\d+\.\s+/.test(t)) {
        flushPara();
        if (listKind !== 'ol') { flushList(); out.push('<ol>'); listKind = 'ol'; }
        out.push('<li>' + renderInline(t.replace(/^\d+\.\s+/, '')) + '</li>');
        continue;
      }
      flushList();
      para.push(t);
    }
    flushList(); flushPara();
    return out.join('\n');
  }

  // ---------- DOM nodes ----------
  let state = loadState();
  let launcher, win, body, input, sendBtn;

  function buildDom() {
    launcher = el('button', { className: 'chat-launcher', 'aria-label': 'Ask AI' }, [
      el('svg', {
        className: 'chat-launcher-icon',
        viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': 'true',
        // Four-point sparkle — universal "AI / smart" mark
        html: '<path d="M12 2.5l1.7 5.4 5.4 1.7-5.4 1.7L12 16.7l-1.7-5.4L4.9 9.6l5.4-1.7L12 2.5z"/><path d="M19 14.5l.9 2.7 2.6.8-2.6.8L19 21.5l-.9-2.7-2.6-.8 2.6-.8.9-2.7z" opacity=".75"/>',
      }),
      el('span', { className: 'chat-launcher-label', text: 'Ask AI' }),
    ]);
    launcher.addEventListener('click', toggleOpen);
    document.body.appendChild(launcher);

    body = el('div', { className: 'chat-body', 'aria-live': 'polite' });
    input = el('textarea', { className: 'chat-input', rows: '1', placeholder: 'Ask anything about the report…', 'aria-label': 'Ask AI question' });
    input.addEventListener('keydown', onInputKeydown);
    input.addEventListener('input', autoGrow);
    sendBtn = el('button', { className: 'chat-send', text: 'Send' });
    sendBtn.addEventListener('click', () => sendQuestion(input.value.trim()));

    const header = el('div', { className: 'chat-header' }, [
      el('span', { className: 'chat-header-title', text: 'Ask AI' }),
      el('button', { className: 'chat-header-btn', 'aria-label': 'Minimize', title: 'Minimize', text: '–', onclick: minimize }),
      el('button', { className: 'chat-header-btn', 'aria-label': 'Close and clear', title: 'Close and clear', text: '×', onclick: closeAndClear }),
    ]);
    header.addEventListener('mousedown', onHeaderMouseDown);

    win = el('div', { className: 'chat-window', hidden: 'true', role: 'dialog', 'aria-label': 'Ask AI chat' }, [
      header,
      body,
      el('div', { className: 'chat-input-wrap' }, [input, sendBtn]),
      el('div', { className: 'chat-disclaimer', text: 'AI answers may be inaccurate. Citations link to the report for verification.' }),
    ]);
    document.body.appendChild(win);

    applyPosition();
    if (state.open) openWindow();
    renderMessages();
  }

  function applyPosition() {
    if (window.innerWidth < 1024 || !state.position) {
      win.style.left = ''; win.style.top = '';
      win.style.right = '24px'; win.style.bottom = '24px';
    } else {
      win.style.left = state.position.x + 'px';
      win.style.top  = state.position.y + 'px';
      win.style.right = ''; win.style.bottom = '';
    }
  }

  function autoGrow() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  }

  function onInputKeydown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendQuestion(input.value.trim());
    }
  }

  function toggleOpen() { state.open ? minimize() : openWindow(); }

  function openWindow() {
    state.open = true; saveState();
    win.hidden = false;
    requestAnimationFrame(() => win.classList.add('open'));
    setTimeout(() => input && input.focus(), 50);
  }

  function minimize() {
    state.open = false; saveState();
    win.classList.remove('open');
    if (window.innerWidth < 1024) {
      setTimeout(() => { win.hidden = true; }, 220);
    } else {
      win.hidden = true;
    }
  }

  function closeAndClear() {
    if (state.messages.length > 2 && !confirm('Clear this chat?')) return;
    state = defaultState();
    saveState();
    renderMessages();
    minimize();
  }

  // ---------- Rendering ----------
  function renderMessages() {
    body.innerHTML = '';

    if (state.messages.length === 0) {
      const inputDisabled = !state.userBackground;
      input.disabled = inputDisabled;
      sendBtn.disabled = inputDisabled;

      const empty = el('div', { className: 'chat-empty' });
      if (!state.userBackground) {
        empty.appendChild(el('div', { className: 'chat-empty-prompt', text: 'Before we start — what\'s your background?' }));
        empty.appendChild(el('div', { text: "I'll calibrate explanations to fit. Even at expert level I'll keep defining terms — the report spans several specialties." }));
        const opts = el('div', { className: 'chat-bg-options' });
        for (const o of BG_OPTIONS) {
          const btn = el('button', {
            className: 'chat-bg-option',
            onclick: () => { state.userBackground = o.id; saveState(); renderMessages(); input.focus(); },
          }, [
            el('span', { className: 'chat-bg-option-label', text: o.label }),
            el('span', { className: 'chat-bg-option-hint', text: o.hint }),
          ]);
          opts.appendChild(btn);
        }
        empty.appendChild(opts);
      } else {
        const bgRow = el('div', { className: 'chat-bg-active' }, [
          document.createTextNode('Tuned for: ' + (BG_LABELS[state.userBackground] || state.userBackground)),
        ]);
        const change = el('a', { text: 'change', onclick: () => { state.userBackground = null; saveState(); renderMessages(); } });
        bgRow.appendChild(change);
        empty.appendChild(bgRow);

        empty.appendChild(el('div', { text: 'Try asking:' }));
        for (const s of SUGGESTIONS) {
          empty.appendChild(el('button', { className: 'chat-suggestion', text: s, onclick: () => sendQuestion(s) }));
        }
      }
      body.appendChild(empty);
      return;
    }

    // Normal message list
    input.disabled = false;
    sendBtn.disabled = false;

    for (let i = 0; i < state.messages.length; i++) {
      body.appendChild(buildMsgNode(state.messages[i], i));
    }
    // Add an Expand button after the last assistant message if it's complete.
    maybeAddExpandButton();
    body.scrollTop = body.scrollHeight;
  }

  function buildMsgNode(m, i) {
    const cls = 'chat-msg chat-msg-' + m.role;
    const bubble = el('div', { className: 'chat-msg-bubble' });
    bubble.innerHTML = m.role === 'assistant'
      ? renderMarkdown(m.content)
      : escapeHtml(m.content);
    if (m.role === 'assistant') {
      bubble.querySelectorAll('a[href]').forEach(a => a.addEventListener('click', onCitationClick));
    }
    return el('div', { className: cls, 'data-i': i }, [bubble]);
  }

  function maybeAddExpandButton() {
    if (sending) return;
    const last = state.messages[state.messages.length - 1];
    if (!last || last.role !== 'assistant' || !last.content || last.expanded) return;
    const wraps = body.querySelectorAll('.chat-msg-assistant');
    const lastWrap = wraps[wraps.length - 1];
    if (!lastWrap) return;
    const btn = el('button', {
      className: 'chat-expand',
      text: 'Expand',
      title: 'Get a longer, more detailed answer',
      onclick: () => {
        last.expanded = true;
        saveState();
        sendQuestion('Please expand on your previous answer with more detail and additional citations.');
      },
    });
    lastWrap.appendChild(btn);
  }

  function onCitationClick(e) {
    if (window.MirrorBacteria && typeof window.MirrorBacteria.openLinkPreview === 'function') {
      e.preventDefault();
      window.MirrorBacteria.openLinkPreview(e.currentTarget.getAttribute('href'));
    }
  }

  // ---------- Drag (desktop only) ----------
  let drag = null;
  function onHeaderMouseDown(e) {
    if (window.innerWidth < 1024) return;
    if (e.target.closest('.chat-header-btn')) return;
    const r = win.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragEnd);
    e.preventDefault();
  }
  function onDragMove(e) {
    if (!drag) return;
    const x = Math.max(0, Math.min(window.innerWidth - 80, e.clientX - drag.dx));
    const y = Math.max(0, Math.min(window.innerHeight - 80, e.clientY - drag.dy));
    win.style.left = x + 'px'; win.style.top = y + 'px';
    win.style.right = ''; win.style.bottom = '';
  }
  function onDragEnd() {
    if (!drag) return;
    const r = win.getBoundingClientRect();
    state.position = { x: r.left, y: r.top };
    saveState();
    drag = null;
    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup', onDragEnd);
  }

  // ---------- Turnstile ----------
  function loadTurnstileScript() {
    if (document.querySelector('script[data-turnstile]')) return;
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true; s.defer = true;
    s.setAttribute('data-turnstile', '1');
    document.head.appendChild(s);
  }
  function getTurnstileToken() {
    return new Promise((resolve, reject) => {
      const sk = turnstileSiteKey();
      if (!sk) return reject(new Error('no-turnstile-site-key'));
      const tryRender = () => {
        if (!window.turnstile) return setTimeout(tryRender, 100);
        const div = document.createElement('div');
        div.style.cssText = 'position:fixed;bottom:-9999px;left:-9999px';
        document.body.appendChild(div);
        window.turnstile.render(div, {
          sitekey: sk,
          size: 'invisible',
          callback: (tok) => { resolve(tok); div.remove(); },
          'error-callback': () => { reject(new Error('turnstile-error')); div.remove(); },
          'timeout-callback': () => { reject(new Error('turnstile-timeout')); div.remove(); },
        });
        try { window.turnstile.execute(div); } catch (e) { reject(e); div.remove(); }
      };
      tryRender();
    });
  }

  // ---------- Sending ----------
  let abortController = null;
  let sending = false;

  async function sendQuestion(q) {
    if (!q || sending) return;
    if (!state.userBackground) {
      // Shouldn't happen — UI gates input — but guard anyway.
      renderMessages();
      return;
    }
    sending = true;
    input.value = ''; autoGrow();

    state.messages.push({ role: 'user', content: q });
    state.messages.push({ role: 'assistant', content: '' });
    saveState();
    renderMessages();
    sendBtn.disabled = true;

    try {
      let turnstileToken = null;
      if (!state.sessionToken) {
        try { turnstileToken = await getTurnstileToken(); }
        catch { setLastAssistant('Verification failed. Please refresh and try again.'); return; }
      }

      const loc = readerLocation();
      const history = state.messages.slice(0, -2);
      const headers = { 'content-type': 'application/json' };
      if (state.sessionToken) headers['x-session-token'] = state.sessionToken;

      abortController = new AbortController();
      const res = await fetch(apiUrl(), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          chapterId: loc.chapterId,
          chapterTitle: loc.chapterTitle,
          sectionId: loc.sectionId,
          sectionTitle: loc.sectionTitle,
          question: q,
          history,
          turnstileToken,
          userBackground: state.userBackground,
        }),
        signal: abortController.signal,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'unknown' }));
        setLastAssistant(errorMessageFor(err));
        return;
      }
      if (!res.body) { setLastAssistant('No response received.'); return; }

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          handleSseEvent(buf.slice(0, idx));
          buf = buf.slice(idx + 2);
        }
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      console.error('chat error', e);
      setLastAssistant('Something went wrong. Please try again.');
    } finally {
      sending = false;
      sendBtn.disabled = false;
      saveState();
      // Re-render so the Expand button can attach to the now-complete reply.
      renderMessages();
    }
  }

  function handleSseEvent(evt) {
    let event = 'message', data = '';
    for (const ln of evt.split('\n')) {
      if (ln.startsWith('event: ')) event = ln.slice(7).trim();
      else if (ln.startsWith('data: ')) data = ln.slice(6);
    }
    let payload; try { payload = JSON.parse(data); } catch { return; }
    if (event === 'session' && payload.token) state.sessionToken = payload.token;
    else if (event === 'text' && typeof payload.delta === 'string') appendToLastAssistant(payload.delta);
    else if (event === 'error') setLastAssistant(errorMessageFor(payload));
  }

  function appendToLastAssistant(delta) {
    const i = state.messages.length - 1;
    if (i < 0 || state.messages[i].role !== 'assistant') return;
    state.messages[i].content += delta;
    renderLastAssistant();
  }

  function setLastAssistant(text) {
    const i = state.messages.length - 1;
    if (i < 0 || state.messages[i].role !== 'assistant') return;
    state.messages[i].content = text;
    renderLastAssistant();
  }

  function renderLastAssistant() {
    const wraps = body.querySelectorAll('.chat-msg-assistant');
    const last = wraps[wraps.length - 1];
    if (!last) { renderMessages(); return; }
    const bubble = last.querySelector('.chat-msg-bubble');
    bubble.innerHTML = renderMarkdown(state.messages[state.messages.length - 1].content);
    bubble.querySelectorAll('a[href]').forEach(a => a.addEventListener('click', onCitationClick));
    body.scrollTop = body.scrollHeight;
  }

  function errorMessageFor(payload) {
    switch (payload && payload.error) {
      case 'rate_limited': return "You're going a bit fast — please wait a moment and try again.";
      case 'daily_limit':  return 'The assistant is taking a break for today. Please come back tomorrow.';
      case 'turnstile_required':
      case 'turnstile_failed': return 'Verification failed. Please refresh the page and try again.';
      case 'forbidden_origin': return 'This site is not authorized to use the assistant.';
      case 'upstream_rate_limited': return 'The assistant is briefly overloaded. Please wait a minute and try again.';
      case 'upstream_auth':         return 'The assistant is misconfigured (auth). Please contact the site owner.';
      case 'upstream_billing':      return 'The assistant is unavailable (billing). Please contact the site owner.';
      case 'upstream_error':        return 'The assistant is unavailable right now. Please try again.';
      default: return 'Something went wrong. Please try again.';
    }
  }

  // ---------- Boot ----------
  function boot() {
    if (!apiUrl()) return;
    loadTurnstileScript();
    buildDom();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else { boot(); }

  window.addEventListener('resize', applyPosition);

  window.MirrorBactChatTest = {
    open: openWindow, minimize, state: () => state,
    send: (q) => { input.value = q; return sendQuestion(q); },
  };
})();
