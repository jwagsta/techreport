/* Mirror Bacteria report — "Ask AI" chat widget.
   No build step, no framework. */

(function () {
  'use strict';

  const STORAGE_KEY = 'mirror-bacteria-chat:v1';
  const SUGGESTIONS = [
    'Summarize the report in 3 bullets.',
    'What are the main biosecurity concerns?',
    'How could mirror bacteria evade the immune system?',
    'Who authored this report?',
  ];

  // ---------- API endpoint resolution ----------
  function apiUrl() {
    const meta = document.querySelector('meta[name="chat-api"]');
    return (meta && meta.getAttribute('content')) || '';
  }
  function turnstileSiteKey() {
    const meta = document.querySelector('meta[name="turnstile-site-key"]');
    return (meta && meta.getAttribute('content')) || '';
  }

  // ---------- State ----------
  function loadState() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      const s = JSON.parse(raw);
      return Object.assign(defaultState(), s);
    } catch (_) { return defaultState(); }
  }
  function defaultState() {
    return {
      open: false,
      messages: [],
      position: null,            // {x, y} for desktop draggable; null = anchored bottom-right
      sessionToken: null,        // server-issued JWT after first Turnstile pass
    };
  }
  function saveState(s) {
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch (_) {}
  }

  // ---------- Reader location (chapter/section) ----------
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

  // ---------- DOM ----------
  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'className') e.className = attrs[k];
      else if (k === 'text') e.textContent = attrs[k];
      else if (k === 'html') e.innerHTML = attrs[k];
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), attrs[k]);
      else e.setAttribute(k, attrs[k]);
    }
    if (children) children.forEach(c => c && e.appendChild(c));
    return e;
  }

  // ---------- Markdown (minimal — links, bold, italic, lists, paragraphs) ----------
  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function renderMarkdown(src) {
    let s = escapeHtml(src);
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (_, t, u) {
      return '<a href="' + u.replace(/"/g, '&quot;') + '">' + t + '</a>';
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
    const lines = s.split('\n');
    let out = [], inUl = false, para = [];
    function flushPara() {
      if (para.length) { out.push('<p>' + para.join(' ') + '</p>'); para = []; }
    }
    for (const ln of lines) {
      const t = ln.trim();
      if (!t) { if (inUl) { out.push('</ul>'); inUl = false; } flushPara(); continue; }
      if (/^[-*]\s+/.test(t)) {
        flushPara();
        if (!inUl) { out.push('<ul>'); inUl = true; }
        out.push('<li>' + t.replace(/^[-*]\s+/, '') + '</li>');
      } else {
        if (inUl) { out.push('</ul>'); inUl = false; }
        para.push(t);
      }
    }
    if (inUl) out.push('</ul>');
    flushPara();
    return out.join('\n');
  }

  // ---------- Render ----------
  let state = loadState();
  let launcher, win, body, input, sendBtn;

  function buildDom() {
    launcher = el('button', { className: 'chat-launcher', 'aria-label': 'Ask AI' }, [
      el('svg', { className: 'chat-launcher-icon', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', html: '<path d="M21 12a9 9 0 1 1-3.5-7.1L21 3v6h-6"/><circle cx="12" cy="12" r="1.6"/><circle cx="8" cy="12" r="1.6"/><circle cx="16" cy="12" r="1.6"/>' }),
      el('span', { className: 'chat-launcher-label', text: 'Ask AI' }),
    ]);
    launcher.addEventListener('click', toggleOpen);
    document.body.appendChild(launcher);

    body = el('div', { className: 'chat-body', 'aria-live': 'polite' });
    input = el('textarea', { className: 'chat-input', rows: '1', placeholder: 'Ask anything about the report…', 'aria-label': 'Ask AI question' });
    input.addEventListener('keydown', onInputKeydown);
    input.addEventListener('input', autoGrow);
    sendBtn = el('button', { className: 'chat-send', text: 'Send' });
    sendBtn.addEventListener('click', sendCurrent);

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
      win.style.top = state.position.y + 'px';
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
      sendCurrent();
    }
  }

  function toggleOpen() { state.open ? minimize() : openWindow(); }

  function openWindow() {
    state.open = true; saveState(state);
    win.hidden = false;
    requestAnimationFrame(() => win.classList.add('open'));
    setTimeout(() => input && input.focus(), 50);
  }

  function minimize() {
    state.open = false; saveState(state);
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
    saveState(state);
    renderMessages();
    minimize();
  }

  function renderMessages() {
    body.innerHTML = '';
    if (state.messages.length === 0) {
      const empty = el('div', { className: 'chat-empty' }, [
        el('div', { text: 'Try asking:' }),
        ...SUGGESTIONS.map(s => el('button', { className: 'chat-suggestion', text: s, onclick: () => { input.value = s; sendCurrent(); } })),
      ]);
      body.appendChild(empty);
      return;
    }
    for (const m of state.messages) {
      const cls = 'chat-msg chat-msg-' + m.role;
      const bubble = el('div', { className: 'chat-msg-bubble' });
      bubble.innerHTML = m.role === 'assistant' ? renderMarkdown(m.content) : escapeHtml(m.content);
      if (m.role === 'assistant') {
        bubble.querySelectorAll('a[href]').forEach(a => a.addEventListener('click', onCitationClick));
      }
      body.appendChild(el('div', { className: cls }, [bubble]));
    }
    body.scrollTop = body.scrollHeight;
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
    saveState(state);
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

  async function sendCurrent() {
    const q = input.value.trim();
    if (!q || sendBtn.disabled) return;
    input.value = ''; autoGrow();

    state.messages.push({ role: 'user', content: q });
    state.messages.push({ role: 'assistant', content: '' });
    saveState(state);
    renderMessages();
    sendBtn.disabled = true;

    try {
      let turnstileToken = null;
      if (!state.sessionToken) {
        try { turnstileToken = await getTurnstileToken(); }
        catch (_) { setLastAssistant('Verification failed. Please refresh and try again.'); return; }
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
          const event = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          handleSseEvent(event);
        }
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      console.error('chat error', e);
      setLastAssistant('Something went wrong. Please try again.');
    } finally {
      sendBtn.disabled = false;
      saveState(state);
    }
  }

  function handleSseEvent(evt) {
    const lines = evt.split('\n');
    let event = 'message', data = '';
    for (const ln of lines) {
      if (ln.startsWith('event: ')) event = ln.slice(7).trim();
      else if (ln.startsWith('data: ')) data = ln.slice(6);
    }
    let payload; try { payload = JSON.parse(data); } catch { return; }
    if (event === 'session' && payload.token) { state.sessionToken = payload.token; }
    else if (event === 'text' && typeof payload.delta === 'string') { appendToLastAssistant(payload.delta); }
    else if (event === 'error') { setLastAssistant(errorMessageFor(payload)); }
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
      case 'upstream_error':  return 'The assistant is unavailable right now. Please try again.';
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
    open: openWindow, minimize, state: () => state, send: (q) => { input.value = q; return sendCurrent(); },
  };
})();
