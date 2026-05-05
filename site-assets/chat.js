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

  // ---------- Sending (stub — implemented in B3) ----------
  async function sendCurrent() {
    const q = input.value.trim();
    if (!q) return;
    console.warn('chat.sendCurrent not yet implemented');
  }

  // ---------- Boot ----------
  function boot() {
    if (!apiUrl()) return;
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
