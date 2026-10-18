/* ==== UI REFRESH LAYER (JS) — loaded after app.js; presentation-only helpers ==== */
/* ws2-header: '⋯' overflow menu (Guest / Shortcuts / QA Suite stay in the DOM, just inside the menu). */
(function () {
  'use strict';
  window.__uiErrs = window.__uiErrs || [];
  window.addEventListener('error', function (e) {
    try { window.__uiErrs.push(String(e && e.message || e)); } catch (_) { /* noop */ }
  });

  function initHeaderMore() {
    var btn = document.getElementById('header-more-btn');
    var menu = document.getElementById('header-more-menu');
    if (!btn || !menu) return;

    function setOpen(open) {
      menu.classList.toggle('hidden', !open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.classList.toggle('active', open);
    }
    function isOpen() { return !menu.classList.contains('hidden'); }

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      setOpen(!isOpen());
    });
    // Any menu item closes the menu after its own (app.js) handler runs.
    menu.addEventListener('click', function (e) {
      if (e.target && e.target.closest && e.target.closest('button')) {
        setTimeout(function () { setOpen(false); }, 0);
      }
    });
    document.addEventListener('click', function (e) {
      if (isOpen() && !menu.contains(e.target) && e.target !== btn) setOpen(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && isOpen()) setOpen(false);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initHeaderMore);
  } else {
    initHeaderMore();
  }
})();

/* ==== ws3-toolbar-ia — spread toolbar tab strip (presentation only; all controls stay in the DOM) ==== */
(function () {
  'use strict';
  var DEFAULT_TAB = 'layout';
  function tb() { return document.getElementById('spread-toolbar'); }
  function uiRefreshSetToolbarTab(name) {
    var root = tb();
    if (!root) return null;
    var open = Boolean(name);
    root.classList.toggle('tb-open', open);
    if (open) root.setAttribute('data-tb-tab', name); else root.removeAttribute('data-tb-tab');
    root.querySelectorAll('.tb-tab[data-tb-tab]').forEach(function (t) {
      var on = open && t.getAttribute('data-tb-tab') === name;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    var editorialOpen = false;
    root.querySelectorAll('.tb-group[data-tb-group]').forEach(function (g) {
      var on = open && g.getAttribute('data-tb-group') === name;
      g.classList.toggle('is-open', on);
      if (on && g.closest('#spread-editorial-controls')) editorialOpen = true;
    });
    var ed = document.getElementById('spread-editorial-controls');
    if (ed) ed.classList.toggle('is-open', editorialOpen);
    try { window.sessionStorage.setItem('atelier.ui.tbTab', open ? name : ''); } catch (e) { /* private mode */ }
    return open ? name : null;
  }
  window.uiRefreshSetToolbarTab = uiRefreshSetToolbarTab;
  window.uiRefreshGetToolbarTab = function () {
    var root = tb();
    return root && root.classList.contains('tb-open') ? root.getAttribute('data-tb-tab') : null;
  };
  function init() {
    var root = tb();
    if (!root || root.__uiTbInit) return;
    root.__uiTbInit = true;
    var tabs = root.querySelector('.tb-tabs');
    if (tabs) {
      tabs.addEventListener('click', function (e) {
        var t = e.target.closest('.tb-tab[data-tb-tab]');
        if (!t) return;
        var name = t.getAttribute('data-tb-tab');
        // Clicking the active tab collapses row 2 (toolbar becomes a single row).
        uiRefreshSetToolbarTab(window.uiRefreshGetToolbarTab() === name ? null : name);
      });
      tabs.addEventListener('keydown', function (e) {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        var all = Array.prototype.slice.call(tabs.querySelectorAll('.tb-tab'));
        var i = all.indexOf(document.activeElement);
        if (i < 0) return;
        e.preventDefault();
        var n = all[(i + (e.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length];
        n.focus();
        uiRefreshSetToolbarTab(n.getAttribute('data-tb-tab'));
      });
    }
    var saved = null;
    try { saved = window.sessionStorage.getItem('atelier.ui.tbTab'); } catch (e) { saved = null; }
    if (saved === null) saved = DEFAULT_TAB;
    uiRefreshSetToolbarTab(saved || null);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();


/* ==== ws4-contextual-bars — bars "More ▾" fold, multi-select Group segment, notes panel docking (presentation only) ==== */
(function () {
  'use strict';
  function $(id) { return document.getElementById(id); }

  /* "More ▾" per bar: toggles .ctx-more-open on the bar; all controls stay in the DOM. */
  function initMore(btnId, barId) {
    var btn = $(btnId), bar = $(barId);
    if (!btn || !bar) return;
    function set(open) {
      bar.classList.toggle('ctx-more-open', open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.textContent = open ? 'Less \u25B4' : 'More \u25BE';
    }
    btn.addEventListener('click', function (e) { e.preventDefault(); set(!bar.classList.contains('ctx-more-open')); });
    set(false);
  }

  /* Group/align segment only for multi-selections: mirror the app's own "N Selected" pill. */
  function initMultiSync() {
    var pill = $('multi-select-count-pill'), bar = $('text-format-bar');
    if (!pill || !bar || typeof MutationObserver === 'undefined') return;
    function sync() {
      var n = parseInt(pill.textContent, 10);
      bar.classList.toggle('multi', !pill.classList.contains('hidden') && n >= 2);
    }
    new MutationObserver(sync).observe(pill, { attributes: true, attributeFilter: ['class'], childList: true, characterData: true, subtree: true });
    sync();
  }

  /* Notes panel: closed by default; when opened, dock it just under the toolbar's right edge. */
  function initNotesDock() {
    var panel = $('spread-notes-panel'), btn = $('btn-spread-notes');
    if (!panel) return;
    if (!panel.classList.contains('hidden')) panel.classList.add('hidden');
    if (btn) btn.setAttribute('aria-expanded', 'false');
    function dock() {
      if (panel.classList.contains('hidden')) return;
      var tb = document.querySelector('.spread-toolbar');
      var header = document.querySelector('.simple-header');
      var r = tb ? tb.getBoundingClientRect() : null;
      var top = r && r.height ? r.bottom + 8 : ((header ? header.getBoundingClientRect().bottom : 52) + 12);
      var right = r && r.width ? Math.max(12, window.innerWidth - r.right) : 16;
      panel.style.top = Math.round(top) + 'px';
      panel.style.right = Math.round(right) + 'px';
    }
    if (typeof MutationObserver !== 'undefined') {
      new MutationObserver(dock).observe(panel, { attributes: true, attributeFilter: ['class'] });
    }
    window.addEventListener('resize', dock);
    if (btn) btn.addEventListener('click', function () { setTimeout(dock, 0); });
  }

  function init() {
    initMore('tf-more-btn', 'text-format-bar');
    initMore('pc-more-btn', 'photo-crop-bar');
    initMultiSync();
    initNotesDock();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
/* ==== end ws4-contextual-bars ==== */

/* ==== ws9-motion-a11y-responsive — tooltips for icon-only controls (presentation only; labels untouched) ==== */
(function () {
  'use strict';
  /* Explicit names for glyph-only controls whose meaning is not obvious from the glyph. */
  var NAMES = {
    'fmt-size-down-btn': 'Decrease text size',
    'fmt-size-up-btn': 'Increase text size',
    'close-all-pages-btn': 'Close',
    'header-more-btn': 'More',
    'tf-more-btn': 'More text options',
    'pc-more-btn': 'More photo options'
  };
  var GLYPHS = {
    '\u00D7': 'Close', 'x': 'Close', '\u2715': 'Close', '\u2716': 'Close',
    '\u2039': 'Previous', '\u203A': 'Next', '\u2190': 'Previous', '\u2192': 'Next',
    '\u25C0': 'Previous', '\u25B6': 'Next', '<': 'Previous', '>': 'Next',
    '\u21B6': 'Undo', '\u21B7': 'Redo', '\u21BA': 'Undo', '\u21BB': 'Redo',
    '\u22EF': 'More', '\u2026': 'More', '...': 'More', '\u22EE': 'More',
    '+': 'Add', '\u2212': 'Remove', '-': 'Remove', '\u2212 ': 'Remove',
    'B': 'Bold', 'I': 'Italic', 'U': 'Underline', 'S': 'Strikethrough',
    '\u2713': 'Done', '\u2714': 'Done', '\u2699': 'Settings', '\u2630': 'Menu',
    '\u2191': 'Up', '\u2193': 'Down', '\u21C5': 'Swap', '\u21C6': 'Swap'
  };
  function isIconOnly(btn) {
    var t = (btn.textContent || '').trim();
    return t.length > 0 && t.length <= 3;
  }
  function labelFor(btn) {
    var t = (btn.textContent || '').trim();
    if (btn.id && NAMES[btn.id]) return NAMES[btn.id];
    var aria = btn.getAttribute('aria-label');
    if (aria) return aria;
    if (btn.classList.contains('modal-close')) return 'Close';
    if (GLYPHS[t]) return GLYPHS[t];
    return null;
  }
  function pass(root) {
    var list = (root || document).querySelectorAll('button, [role="button"]');
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      if (b.title || !isIconOnly(b)) continue;
      var name = labelFor(b);
      if (!name) continue;
      b.title = name;
      if (!b.getAttribute('aria-label')) b.setAttribute('aria-label', name);
    }
  }
  function init() {
    pass(document);
    /* Dynamically rendered chrome (pickers, all-pages cards, toasts) gets the same treatment, debounced. */
    if (typeof MutationObserver === 'undefined') return;
    var pending = null;
    new MutationObserver(function () {
      if (pending) return;
      pending = setTimeout(function () { pending = null; try { pass(document); } catch (e) { /* noop */ } }, 120);
    }).observe(document.body, { childList: true, subtree: true });
  }
  window.uiRefreshTooltipPass = pass;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
/* ==== end ws9-motion-a11y-responsive (js) ==== */
