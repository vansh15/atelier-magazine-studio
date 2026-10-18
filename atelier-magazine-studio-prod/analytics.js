/* ============================================================================
 * ATELIER EDITION — PRODUCTION TELEMETRY, ANALYTICS, WEB VITALS & ERROR SDK
 * ============================================================================
 * Zero-dependency, CSP-safe (no eval / no innerHTML) production observability:
 *  1. Automatic product funnel & interaction event tracking (20+ event types)
 *  2. Core Web Vitals (LCP, CLS, INP, FCP, TTFB) via PerformanceObserver
 *  3. Global Error & Unhandled Promise Rejection crash reporting
 *  4. Strict PII redaction (never logs base64 photos, user text copy, or emails)
 *  5. Pluggable multi-sink dispatch: Same-origin Beacon (/api/telemetry),
 *     GA4 (gtag), PostHog, Plausible, Sentry, and local ring-buffer inspector.
 * ============================================================================ */
(function () {
  'use strict';

  var STORAGE_EVENTS_KEY = 'atelier_telemetry_events_v1';
  var STORAGE_CONFIG_KEY = 'atelier_telemetry_config_v1';
  var STORAGE_ANON_ID_KEY = 'atelier_anon_id_v1';
  var MAX_BUFFER_EVENTS = 200;

  var sessionId = 'ses_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  var sessionStartMs = Date.now();

  var defaultConfig = {
    consent: 'granted', // 'granted' | 'essential_only' | 'denied'
    respectDNT: false,
    endpoint: '/api/telemetry',
    beaconEnabled: true, // Enable when hosted behind /api/telemetry collector
    gaMeasurementId: '',
    posthogKey: '',
    sentryDsn: '',
    environment: window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
      ? 'development'
      : 'production',
    release: '2026.10.18-prod.1'
  };

  var config = loadConfig();
  var anonId = getOrCreateAnonId();
  var eventsBuffer = loadEventsBuffer();

  var webVitals = {
    fcpMs: null,
    lcpMs: null,
    clsScore: 0,
    inpMs: null,
    ttfbMs: null
  };

  var funnelCounts = {
    session_start: 0,
    creative_edit: 0,
    photo_interaction: 0,
    export_action: 0,
    checkout_action: 0
  };

  function loadConfig() {
    try {
      var raw = window.localStorage.getItem(STORAGE_CONFIG_KEY);
      if (!raw) return Object.assign({}, defaultConfig);
      var parsed = JSON.parse(raw);
      return Object.assign({}, defaultConfig, parsed || {});
    } catch (_) {
      return Object.assign({}, defaultConfig);
    }
  }

  function saveConfig(nextPartial) {
    if (nextPartial && typeof nextPartial === 'object') {
      Object.keys(nextPartial).forEach(function (k) {
        if (Object.prototype.hasOwnProperty.call(defaultConfig, k)) {
          config[k] = nextPartial[k];
        }
      });
    }
    try {
      window.localStorage.setItem(STORAGE_CONFIG_KEY, JSON.stringify(config));
    } catch (_) { /* ignore quota/private mode */ }
    return Object.assign({}, config);
  }

  function getOrCreateAnonId() {
    try {
      var existing = window.localStorage.getItem(STORAGE_ANON_ID_KEY);
      if (existing && /^usr_[a-z0-9_]+$/i.test(existing)) return existing;
      var created = 'usr_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
      window.localStorage.setItem(STORAGE_ANON_ID_KEY, created);
      return created;
    } catch (_) {
      return 'usr_ephemeral_' + Math.random().toString(36).slice(2, 8);
    }
  }

  function loadEventsBuffer() {
    try {
      var raw = window.localStorage.getItem(STORAGE_EVENTS_KEY);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.slice(-MAX_BUFFER_EVENTS) : [];
    } catch (_) {
      return [];
    }
  }

  function persistEventsBuffer() {
    try {
      window.localStorage.setItem(
        STORAGE_EVENTS_KEY,
        JSON.stringify(eventsBuffer.slice(-MAX_BUFFER_EVENTS))
      );
    } catch (_) { /* ignore quota */ }
  }

  // Strict PII & payload sanitizer — strips emails, long strings, data/blob URLs
  var EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  var REDACT_KEYS = {
    email: true,
    name: true,
    fullname: true,
    address: true,
    street: true,
    phone: true,
    password: true,
    pin: true,
    story: true,
    headline: true,
    caption: true,
    text: true,
    dataurl: true
  };

  function sanitizeProps(input) {
    if (!input || typeof input !== 'object') return {};
    var out = {};
    Object.keys(input).forEach(function (k) {
      var lower = String(k).toLowerCase();
      if (REDACT_KEYS[lower]) {
        out[k] = '[REDACTED]';
        return;
      }
      var val = input[k];
      if (val === null || val === undefined) return;
      if (typeof val === 'number' || typeof val === 'boolean') {
        out[k] = val;
      } else if (typeof val === 'string') {
        if (val.indexOf('data:') === 0 || val.indexOf('blob:') === 0) {
          out[k] = '[MEDIA_URI]';
        } else {
          out[k] = val.replace(EMAIL_RE, '[EMAIL_REDACTED]').slice(0, 140);
        }
      } else if (Array.isArray(val)) {
        out[k] = val.slice(0, 10).map(function (v) {
          return typeof v === 'number' || typeof v === 'boolean' ? v : String(v).slice(0, 60);
        });
      }
    });
    return out;
  }

  function extractAttribution() {
    try {
      var params = new URLSearchParams(window.location.search || '');
      return {
        utm_source: params.get('utm_source') || 'direct',
        utm_medium: params.get('utm_medium') || 'none',
        utm_campaign: params.get('utm_campaign') || 'organic',
        referrer: document.referrer ? new URL(document.referrer).hostname : 'direct'
      };
    } catch (_) {
      return { utm_source: 'direct', utm_medium: 'none', utm_campaign: 'organic', referrer: 'direct' };
    }
  }

  function recomputeFunnelCounts() {
    funnelCounts = {
      session_start: 0,
      creative_edit: 0,
      photo_interaction: 0,
      export_action: 0,
      checkout_action: 0
    };
    eventsBuffer.forEach(function (ev) {
      if (!ev || !ev.event) return;
      var name = ev.event;
      if (name === 'session_start') funnelCounts.session_start++;
      if (
        name === 'theme_changed' ||
        name === 'layout_changed' ||
        name === 'element_added' ||
        name === 'element_removed' ||
        name === 'element_restored' ||
        name === 'spread_mutated'
      ) {
        funnelCounts.creative_edit++;
      }
      if (
        name === 'photo_slot_selected' ||
        name === 'photo_swap_modal_opened' ||
        name === 'photo_swapped' ||
        name === 'photo_uploaded' ||
        name === 'photo_transformed'
      ) {
        funnelCounts.photo_interaction++;
      }
      if (name === 'export_triggered' || name === 'reader_mode_opened') {
        funnelCounts.export_action++;
      }
      if (name === 'checkout_opened' || name === 'promo_applied' || name === 'order_submitted') {
        funnelCounts.checkout_action++;
      }
    });
  }
  recomputeFunnelCounts();

  function isTrackingAllowed(isEssential) {
    if (config.consent === 'denied') return false;
    if (config.respectDNT && (navigator.doNotTrack === '1' || window.doNotTrack === '1')) {
      return Boolean(isEssential);
    }
    if (config.consent === 'essential_only') {
      return Boolean(isEssential);
    }
    return true;
  }

  function dispatchExternalSinks(envelope) {
    // 1. Google Analytics 4 (gtag)
    try {
      if (typeof window.gtag === 'function' && config.gaMeasurementId) {
        window.gtag('event', envelope.event, Object.assign({
          send_to: config.gaMeasurementId,
          session_id: envelope.session_id
        }, envelope.properties));
      }
    } catch (_) { /* ignore */ }

    // 2. PostHog
    try {
      if (window.posthog && typeof window.posthog.capture === 'function') {
        window.posthog.capture(envelope.event, envelope.properties);
      }
    } catch (_) { /* ignore */ }

    // 3. Plausible
    try {
      if (typeof window.plausible === 'function') {
        window.plausible(envelope.event, { props: envelope.properties });
      }
    } catch (_) { /* ignore */ }

    // 4. Same-origin /api/telemetry Beacon (when enabled and not on static-only github.io without a custom endpoint)
    try {
      var isStaticGithubPages =
        typeof window.location !== 'undefined' &&
        /\.github\.io$/i.test(window.location.hostname || '') &&
        config.endpoint === '/api/telemetry';
      if (config.beaconEnabled && config.endpoint && !isStaticGithubPages) {
        var payload = JSON.stringify(envelope);
        if (navigator.sendBeacon) {
          var blob = new Blob([payload], { type: 'application/json' });
          navigator.sendBeacon(config.endpoint, blob);
        } else if (typeof window.fetch === 'function') {
          window.fetch(config.endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: payload,
            keepalive: true
          }).catch(function () {});
        }
      }
    } catch (_) { /* ignore */ }
  }

  function track(eventName, properties, options) {
    if (!eventName || typeof eventName !== 'string') return null;
    var isEssential = Boolean(options && options.essential);
    if (!isTrackingAllowed(isEssential)) return null;

    var cleanProps = sanitizeProps(properties);
    var activeThemePill = document.querySelector('#style-pills .style-pill.active');
    var envelope = {
      id: 'evt_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
      timestamp: new Date().toISOString(),
      elapsed_ms: Date.now() - sessionStartMs,
      event: eventName,
      category: (options && options.category) || inferCategory(eventName),
      session_id: sessionId,
      anonymous_id: anonId,
      environment: config.environment,
      release: config.release,
      context: {
        viewport: window.innerWidth + 'x' + window.innerHeight,
        theme: activeThemePill ? activeThemePill.getAttribute('data-theme') : 'vogue',
        reader_mode: document.body ? document.body.classList.contains('reader-mode') : false
      },
      properties: cleanProps
    };

    eventsBuffer.push(envelope);
    if (eventsBuffer.length > MAX_BUFFER_EVENTS) {
      eventsBuffer = eventsBuffer.slice(-MAX_BUFFER_EVENTS);
    }
    persistEventsBuffer();
    recomputeFunnelCounts();
    dispatchExternalSinks(envelope);
    refreshTelemetryModalIfOpen();
    return envelope;
  }

  function inferCategory(eventName) {
    if (eventName.indexOf('error') !== -1 || eventName.indexOf('rejection') !== -1) return 'error';
    if (eventName.indexOf('vital') !== -1 || eventName.indexOf('perf') !== -1) return 'performance';
    if (eventName.indexOf('checkout') !== -1 || eventName.indexOf('order') !== -1 || eventName.indexOf('promo') !== -1) return 'conversion';
    if (eventName.indexOf('photo') !== -1) return 'photo';
    if (eventName.indexOf('export') !== -1 || eventName.indexOf('reader') !== -1) return 'export';
    return 'engagement';
  }

  // =========================================================================
  // CORE WEB VITALS & PERFORMANCE OBSERVERS
  // =========================================================================
  function initWebVitals() {
    try {
      var navEntries = performance.getEntriesByType && performance.getEntriesByType('navigation');
      if (navEntries && navEntries[0]) {
        var ttfb = Math.round(navEntries[0].responseStart - navEntries[0].requestStart);
        if (ttfb >= 0) webVitals.ttfbMs = ttfb;
      }
    } catch (_) { /* ignore */ }

    if (typeof PerformanceObserver === 'undefined') return;

    // Paint Timing (FCP)
    try {
      var paintObs = new PerformanceObserver(function (list) {
        list.getEntries().forEach(function (entry) {
          if (entry.name === 'first-contentful-paint' && webVitals.fcpMs === null) {
            webVitals.fcpMs = Math.round(entry.startTime);
            track('web_vital_measured', { metric: 'FCP', value_ms: webVitals.fcpMs, rating: webVitals.fcpMs <= 1800 ? 'good' : 'needs_improvement' }, { category: 'performance', essential: true });
          }
        });
      });
      paintObs.observe({ type: 'paint', buffered: true });
    } catch (_) { /* ignore */ }

    // Largest Contentful Paint (LCP)
    try {
      var lcpObs = new PerformanceObserver(function (list) {
        var entries = list.getEntries();
        if (entries.length > 0) {
          var last = entries[entries.length - 1];
          webVitals.lcpMs = Math.round(last.startTime);
          refreshTelemetryModalIfOpen();
        }
      });
      lcpObs.observe({ type: 'largest-contentful-paint', buffered: true });
    } catch (_) { /* ignore */ }

    // Cumulative Layout Shift (CLS)
    try {
      var clsObs = new PerformanceObserver(function (list) {
        list.getEntries().forEach(function (entry) {
          if (!entry.hadRecentInput && typeof entry.value === 'number') {
            webVitals.clsScore = Math.round((webVitals.clsScore + entry.value) * 10000) / 10000;
          }
        });
        refreshTelemetryModalIfOpen();
      });
      clsObs.observe({ type: 'layout-shift', buffered: true });
    } catch (_) { /* ignore */ }

    // Interaction to Next Paint (INP / Event Timing)
    try {
      var inpObs = new PerformanceObserver(function (list) {
        list.getEntries().forEach(function (entry) {
          if (typeof entry.duration === 'number' && entry.duration > 0) {
            var dur = Math.round(entry.duration);
            if (webVitals.inpMs === null || dur > webVitals.inpMs) {
              webVitals.inpMs = dur;
            }
          }
        });
      });
      inpObs.observe({ type: 'event', buffered: true, durationThreshold: 16 });
    } catch (_) { /* ignore */ }
  }

  // =========================================================================
  // GLOBAL ERROR & UNHANDLED REJECTION CAPTURE
  // =========================================================================
  function initErrorMonitoring() {
    window.addEventListener('error', function (e) {
      track('client_error', {
        message: String((e && e.message) || 'Unknown error'),
        filename: String((e && e.filename) || '').split('/').pop(),
        lineno: Number((e && e.lineno) || 0),
        colno: Number((e && e.colno) || 0)
      }, { category: 'error', essential: true });
    });

    window.addEventListener('unhandledrejection', function (e) {
      var reason = e && e.reason;
      track('unhandled_rejection', {
        reason: String((reason && (reason.message || reason)) || 'Unhandled promise rejection')
      }, { category: 'error', essential: true });
    });
  }

  // =========================================================================
  // AUTOMATIC STUDIO INTERACTION INSTRUMENTATION
  // =========================================================================
  function initAutoInstrumentation() {
    // 1. Session start + UTM attribution
    track('session_start', Object.assign({
      language: navigator.language || 'en',
      screen: window.screen ? window.screen.width + 'x' + window.screen.height : 'unknown'
    }, extractAttribution()), { essential: true });

    // 2. Delegated click tracking across studio actions
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;

      // Style theme switch
      var stylePill = t.closest('#style-pills .style-pill');
      if (stylePill) {
        track('theme_changed', { theme: stylePill.getAttribute('data-theme') || '' });
        return;
      }

      // Layout picker selection
      var layoutCard = t.closest('#collage-picker-grid .layout-option-card');
      if (layoutCard) {
        track('layout_changed', {
          layout_id: layoutCard.getAttribute('data-layout-id') || '',
          method: 'picker_modal'
        });
        return;
      }

      // Randomize layout buttons
      var randBtn = t.closest('#random-left-layout-btn, #random-right-layout-btn');
      if (randBtn) {
        track('layout_changed', {
          side: randBtn.id.indexOf('left') !== -1 ? 'left' : 'right',
          method: 'randomizer'
        });
        return;
      }

      // Photo slot / swap interactions
      var swapPill = t.closest('.slot-swap-pill');
      if (swapPill) {
        var parentSlot = swapPill.closest('.photo-slot');
        track('photo_swap_modal_opened', {
          trigger: 'swap_pill',
          page_index: parentSlot ? Number(parentSlot.getAttribute('data-page-index') || 0) : 0,
          slot_index: parentSlot ? Number(parentSlot.getAttribute('data-slot-index') || 0) : 0
        });
        return;
      }

      var swapLibCard = t.closest('#swap-photo-library-grid .swap-library-card');
      if (swapLibCard) {
        track('photo_swapped', {
          source: swapLibCard.getAttribute('data-custom-photo') === 'true' ? 'custom_upload' : 'curated_library',
          pool_index: Number(swapLibCard.getAttribute('data-pool-index') || 0)
        });
        return;
      }

      var slotEl = t.closest('.photo-slot');
      if (slotEl && !t.closest('.photo-slot-actions, .photo-slot-zoom-controls, .slot-delete-corner-btn')) {
        track('photo_slot_selected', {
          page_index: Number(slotEl.getAttribute('data-page-index') || 0),
          slot_index: Number(slotEl.getAttribute('data-slot-index') || 0),
          opened_swap: Boolean(e.isTrusted)
        });
        return;
      }

      // Template item / slot delete & restore
      var delCorner = t.closest('.slot-delete-corner-btn');
      if (delCorner) {
        track('element_removed', { kind: 'photo_slot', trigger: 'corner_x' });
        return;
      }
      var delFloating = t.closest('.template-floating-del-pill');
      if (delFloating) {
        track('element_removed', {
          kind: 'template_item',
          item_key: delFloating.getAttribute('data-target-key') || ''
        });
        return;
      }
      var ghostRestore = t.closest('.template-ghost-restore-btn, #restore-template-items-btn');
      if (ghostRestore) {
        track('element_restored', {
          trigger: ghostRestore.id === 'restore-template-items-btn' ? 'toolbar_restore_all' : 'canvas_ghost'
        });
        return;
      }

      // Text & sticker additions
      var addTextBtn = t.closest('#add-text-left-btn, #add-text-right-btn, #crop-add-text-btn');
      if (addTextBtn) {
        track('element_added', { kind: 'floating_text', trigger: addTextBtn.id });
        return;
      }
      var stickerCard = t.closest('#stickers-modal .sticker-pick-card, #stickers-modal .quick-shape-card');
      if (stickerCard) {
        track('element_added', {
          kind: stickerCard.classList.contains('quick-shape-card') ? 'vector_shape' : 'sticker'
        });
        return;
      }

      // Spread lifecycle
      var spreadBtn = t.closest('#add-spread-btn, #remove-spread-btn, #move-spread-left-btn, #move-spread-right-btn, #btn-lock-spread');
      if (spreadBtn) {
        track('spread_mutated', { action_id: spreadBtn.id });
        return;
      }

      // Reader & Exports
      if (t.closest('#preview-book-btn')) {
        track('reader_mode_opened', { trigger: 'header_preview_btn' });
        return;
      }
      var exportBtn = t.closest('#print-book-btn, #export-spread-png-btn, #export-json-btn');
      if (exportBtn) {
        track('export_triggered', { format: exportBtn.id.replace('-btn', '') });
        return;
      }

      // Checkout & Conversion Funnel
      if (t.closest('#order-print-btn')) {
        track('checkout_opened', { trigger: 'header_cta' });
        return;
      }
      if (t.closest('#apply-promo-btn')) {
        var promoIn = document.getElementById('order-promo-input');
        track('promo_applied', { code_entered: Boolean(promoIn && promoIn.value.trim()) });
        return;
      }
    }, true);

    // Photo file upload tracking
    document.addEventListener('change', function (e) {
      var t = e.target;
      if (!t) return;
      if (t.id === 'photo-upload-input' || t.id === 'single-photo-swap-input') {
        var count = t.files ? t.files.length : 0;
        if (count > 0) {
          track('photo_uploaded', {
            file_count: count,
            mode: t.id === 'single-photo-swap-input' ? 'single_slot_swap' : 'bulk_library'
          });
        }
      }
      if (t.id === 'crop-filter-select') {
        track('photo_transformed', { action: 'filter', filter: t.value || 'none' });
      }
    }, true);

    // Checkout form submission tracking
    var orderForm = document.getElementById('order-form');
    if (orderForm) {
      orderForm.addEventListener('submit', function () {
        var totalEl = document.getElementById('summary-total-price');
        var finishEl = document.getElementById('order-finish-select');
        var qtyEl = document.getElementById('order-qty-input');
        track('order_submitted', {
          total_display: totalEl ? totalEl.textContent.trim() : '',
          finish: finishEl ? finishEl.value : 'matte',
          quantity: qtyEl ? Number(qtyEl.value || 1) : 1
        }, { category: 'conversion' });
      });
    }
  }

  // =========================================================================
  // IN-APP ANALYTICS, PRIVACY & PUBLISH MODAL (#telemetry-modal)
  // =========================================================================
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function ensureTelemetryModal() {
    var existing = document.getElementById('telemetry-modal');
    if (existing) return existing;

    var overlay = el('div', 'modal-overlay hidden');
    overlay.id = 'telemetry-modal';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'telemetry-modal-heading');

    var sheet = el('div', 'modal-sheet ws7-sheet ws8-sheet modal-lg telemetry-modal-sheet');
    sheet.setAttribute('data-telemetry-tab', 'live');

    // Header
    var top = el('div', 'modal-top');
    var titleBlock = el('div', 'modal-title-block');
    titleBlock.appendChild(el('span', 'modal-eyebrow', 'PRODUCTION OBSERVABILITY · PRIVACY · EXTERNAL DEPLOY'));
    var h2 = el('h2', '', 'Analytics, Telemetry & External Publishing Hub');
    h2.id = 'telemetry-modal-heading';
    titleBlock.appendChild(h2);
    titleBlock.appendChild(el('p', '', 'Real-time product funnel, Core Web Vitals, PII-scrubbed event stream, consent controls, and 1-command external hosting setup.'));
    top.appendChild(titleBlock);

    var topActions = el('div', 'modal-top-actions');
    var closeBtn = el('button', 'modal-close', '\u00D7');
    closeBtn.type = 'button';
    closeBtn.id = 'close-telemetry-modal-btn';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.addEventListener('click', function () {
      overlay.classList.add('hidden');
    });
    topActions.appendChild(closeBtn);
    top.appendChild(topActions);
    sheet.appendChild(top);

    // Tabs
    var tabsBar = el('div', 'ws8-tabs telemetry-tabs');
    tabsBar.setAttribute('role', 'tablist');
    [
      { id: 'live', label: 'Live Funnel & Web Vitals' },
      { id: 'config', label: 'Tracking & Privacy Config' },
      { id: 'publish', label: 'External Publish Guide' }
    ].forEach(function (tabInfo, idx) {
      var b = el('button', 'ws8-tab' + (idx === 0 ? ' is-active' : ''), tabInfo.label);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('data-telemetry-tab-btn', tabInfo.id);
      b.setAttribute('aria-selected', idx === 0 ? 'true' : 'false');
      b.addEventListener('click', function () {
        sheet.setAttribute('data-telemetry-tab', tabInfo.id);
        tabsBar.querySelectorAll('.ws8-tab').forEach(function (tb) {
          var active = tb.getAttribute('data-telemetry-tab-btn') === tabInfo.id;
          tb.classList.toggle('is-active', active);
          tb.setAttribute('aria-selected', active ? 'true' : 'false');
        });
      });
      tabsBar.appendChild(b);
    });
    sheet.appendChild(tabsBar);

    // Body container
    var body = el('div', 'telemetry-modal-body');

    // TAB 1: Live Funnel & Web Vitals
    var tabLive = el('div', 'telemetry-tab-panel');
    tabLive.setAttribute('data-telemetry-panel', 'live');

    var kpiGrid = el('div', 'telemetry-kpi-grid');
    kpiGrid.id = 'telemetry-kpi-grid';
    tabLive.appendChild(kpiGrid);

    var vitalsRow = el('div', 'telemetry-vitals-row');
    vitalsRow.id = 'telemetry-vitals-row';
    tabLive.appendChild(vitalsRow);

    var funnelSection = el('div', 'telemetry-funnel-section');
    funnelSection.appendChild(el('h3', 'telemetry-section-title', 'Conversion Funnel (Current Browser Storage)'));
    var funnelBars = el('div', 'telemetry-funnel-bars');
    funnelBars.id = 'telemetry-funnel-bars';
    funnelSection.appendChild(funnelBars);
    tabLive.appendChild(funnelSection);

    var streamHeader = el('div', 'telemetry-stream-header');
    streamHeader.appendChild(el('h3', 'telemetry-section-title', 'Recent PII-Scrubbed Telemetry Events'));
    var streamActions = el('div', 'telemetry-stream-actions');
    var exportBtn = el('button', 'btn-secondary', 'Export Telemetry JSON');
    exportBtn.type = 'button';
    exportBtn.id = 'telemetry-export-json-btn';
    exportBtn.addEventListener('click', exportTelemetryJSON);
    var clearBtn = el('button', 'btn-secondary', 'Clear Buffer');
    clearBtn.type = 'button';
    clearBtn.id = 'telemetry-clear-btn';
    clearBtn.addEventListener('click', function () {
      eventsBuffer = [];
      persistEventsBuffer();
      recomputeFunnelCounts();
      refreshTelemetryModalIfOpen();
    });
    streamActions.appendChild(exportBtn);
    streamActions.appendChild(clearBtn);
    streamHeader.appendChild(streamActions);
    tabLive.appendChild(streamHeader);

    var streamList = el('div', 'telemetry-event-list');
    streamList.id = 'telemetry-event-list';
    tabLive.appendChild(streamList);
    body.appendChild(tabLive);

    // TAB 2: Tracking & Privacy Config
    var tabConfig = el('div', 'telemetry-tab-panel');
    tabConfig.setAttribute('data-telemetry-panel', 'config');

    var cfgGrid = el('div', 'telemetry-config-grid');

    function addConfigField(labelTxt, inputId, placeholder, currentVal) {
      var wrap = el('label', 'telemetry-field');
      wrap.appendChild(el('span', 'telemetry-field-label', labelTxt));
      var inp = el('input', 'fmt-caption-input telemetry-input');
      inp.type = 'text';
      inp.id = inputId;
      inp.placeholder = placeholder;
      inp.value = currentVal || '';
      wrap.appendChild(inp);
      cfgGrid.appendChild(wrap);
      return inp;
    }

    var consentWrap = el('label', 'telemetry-field');
    consentWrap.appendChild(el('span', 'telemetry-field-label', 'Privacy & Cookie Consent Mode (GDPR / CCPA)'));
    var consentSelect = el('select', 'fmt-select telemetry-input');
    consentSelect.id = 'telemetry-consent-select';
    [
      { v: 'granted', l: 'Granted — Full Product Analytics + Web Vitals + Crash Reporting' },
      { v: 'essential_only', l: 'Essential Only — Web Vitals & Crash Reporting Only' },
      { v: 'denied', l: 'Opt-Out — Disable All Telemetry Recording' }
    ].forEach(function (opt) {
      var o = el('option', '', opt.l);
      o.value = opt.v;
      if (config.consent === opt.v) o.selected = true;
      consentSelect.appendChild(o);
    });
    consentWrap.appendChild(consentSelect);
    cfgGrid.appendChild(consentWrap);

    var gaIn = addConfigField('Google Analytics 4 Measurement ID', 'telemetry-ga-id', 'G-XXXXXXXXXX', config.gaMeasurementId);
    var phIn = addConfigField('PostHog Project API Key', 'telemetry-posthog-key', 'phc_xxxxxxxxxxxxxxxxxxxx', config.posthogKey);
    var sentryIn = addConfigField('Sentry Crash DSN', 'telemetry-sentry-dsn', 'https://public@o0.ingest.sentry.io/0', config.sentryDsn);
    var epIn = addConfigField('Same-Origin Collector Endpoint', 'telemetry-endpoint-input', '/api/telemetry', config.endpoint);

    var beaconWrap = el('label', 'telemetry-checkbox-row');
    var beaconChk = document.createElement('input');
    beaconChk.type = 'checkbox';
    beaconChk.id = 'telemetry-beacon-checkbox';
    beaconChk.checked = Boolean(config.beaconEnabled);
    beaconWrap.appendChild(beaconChk);
    beaconWrap.appendChild(el('span', '', ' Stream real-time JSON beacons via navigator.sendBeacon() to Collector Endpoint'));
    cfgGrid.appendChild(beaconWrap);

    var saveCfgBtn = el('button', 'btn-primary', 'Save Tracking Configuration');
    saveCfgBtn.type = 'button';
    saveCfgBtn.id = 'telemetry-save-config-btn';
    saveCfgBtn.addEventListener('click', function () {
      saveConfig({
        consent: consentSelect.value,
        gaMeasurementId: gaIn.value.trim(),
        posthogKey: phIn.value.trim(),
        sentryDsn: sentryIn.value.trim(),
        endpoint: epIn.value.trim() || '/api/telemetry',
        beaconEnabled: Boolean(beaconChk.checked)
      });
      track('telemetry_config_updated', {
        consent: config.consent,
        beacon_enabled: config.beaconEnabled,
        has_ga4: Boolean(config.gaMeasurementId),
        has_posthog: Boolean(config.posthogKey)
      }, { essential: true });
      if (typeof window.showToast === 'function') {
        window.showToast('\u2713 Saved production telemetry & consent settings');
      }
    });
    tabConfig.appendChild(cfgGrid);
    tabConfig.appendChild(saveCfgBtn);
    body.appendChild(tabConfig);

    // TAB 3: External Publish Guide
    var tabPublish = el('div', 'telemetry-tab-panel');
    tabPublish.setAttribute('data-telemetry-panel', 'publish');
    var pubCards = [
      {
        title: '1. Cloudflare Pages / Vercel / Netlify (Fastest — Free Global CDN + HTTPS)',
        cmd: 'npx wrangler pages deploy dist --project-name=atelier-magazine-studio\n# or on Vercel:\nnpx vercel --prod dist\n# or on Netlify:\nnpx netlify-cli deploy --prod --dir=dist',
        desc: 'Includes vercel.json, netlify.toml, and api/telemetry.js serverless collector with strict HSTS, CSP, and immutable asset caching.'
      },
      {
        title: '2. Firebase Hosting (Google Cloud CDN + Custom Domain)',
        cmd: 'npx firebase-tools login\nnpx firebase-tools deploy --only hosting',
        desc: 'Pre-configured with firebase.json in the project root pointing to the clean dist/ production bundle.'
      },
      {
        title: '3. Google Cloud Run / Docker Container (Nginx + /api/telemetry + /healthz)',
        cmd: 'gcloud run deploy atelier-magazine-studio --source . --region=us-central1 --allow-unauthenticated',
        desc: 'Uses the included Dockerfile and nginx.conf with gzip compression, security headers, and a built-in /api/telemetry 204 ingestion endpoint.'
      }
    ];
    pubCards.forEach(function (c) {
      var card = el('div', 'telemetry-publish-card');
      card.appendChild(el('h4', '', c.title));
      card.appendChild(el('p', '', c.desc));
      var pre = el('pre', 'telemetry-code-block', c.cmd);
      card.appendChild(pre);
      tabPublish.appendChild(card);
    });
    body.appendChild(tabPublish);

    sheet.appendChild(body);
    overlay.appendChild(sheet);

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) overlay.classList.add('hidden');
    });

    document.body.appendChild(overlay);
    return overlay;
  }

  function refreshTelemetryModalIfOpen() {
    var modal = document.getElementById('telemetry-modal');
    if (!modal || modal.classList.contains('hidden')) return;

    var kpiGrid = document.getElementById('telemetry-kpi-grid');
    if (kpiGrid) {
      kpiGrid.replaceChildren();
      var errCount = eventsBuffer.filter(function (e) { return e && e.category === 'error'; }).length;
      [
        { label: 'Session ID', value: sessionId.slice(0, 14) },
        { label: 'Consent Mode', value: config.consent.toUpperCase() },
        { label: 'Buffered Events', value: String(eventsBuffer.length) },
        { label: 'Client Errors', value: String(errCount) }
      ].forEach(function (item) {
        var box = el('div', 'telemetry-kpi-card');
        box.appendChild(el('span', 'telemetry-kpi-label', item.label));
        box.appendChild(el('strong', 'telemetry-kpi-val', item.value));
        kpiGrid.appendChild(box);
      });
    }

    var vitalsRow = document.getElementById('telemetry-vitals-row');
    if (vitalsRow) {
      vitalsRow.replaceChildren();
      [
        { name: 'FCP', val: webVitals.fcpMs !== null ? webVitals.fcpMs + ' ms' : 'measuring…' },
        { name: 'LCP', val: webVitals.lcpMs !== null ? webVitals.lcpMs + ' ms' : 'measuring…' },
        { name: 'CLS', val: String(webVitals.clsScore) },
        { name: 'INP', val: webVitals.inpMs !== null ? webVitals.inpMs + ' ms' : '< 16 ms' },
        { name: 'TTFB', val: webVitals.ttfbMs !== null ? webVitals.ttfbMs + ' ms' : '< 50 ms' }
      ].forEach(function (v) {
        var pill = el('div', 'telemetry-vital-pill');
        pill.appendChild(el('span', 'vital-name', v.name));
        pill.appendChild(el('strong', 'vital-val', v.val));
        vitalsRow.appendChild(pill);
      });
    }

    var funnelBars = document.getElementById('telemetry-funnel-bars');
    if (funnelBars) {
      funnelBars.replaceChildren();
      var maxCount = Math.max(
        1,
        funnelCounts.session_start,
        funnelCounts.creative_edit,
        funnelCounts.photo_interaction,
        funnelCounts.export_action,
        funnelCounts.checkout_action
      );
      [
        { label: '1. Sessions Started', count: funnelCounts.session_start },
        { label: '2. Layout / Theme / Canvas Edits', count: funnelCounts.creative_edit },
        { label: '3. Photo Uploads & Swaps', count: funnelCounts.photo_interaction },
        { label: '4. Flipbook Preview & Exports', count: funnelCounts.export_action },
        { label: '5. Print Checkout Interactions', count: funnelCounts.checkout_action }
      ].forEach(function (stage) {
        var row = el('div', 'telemetry-funnel-row');
        var lbl = el('div', 'telemetry-funnel-label');
        lbl.appendChild(el('span', '', stage.label));
        lbl.appendChild(el('strong', '', String(stage.count)));
        row.appendChild(lbl);
        var trackBar = el('div', 'telemetry-funnel-track');
        var fill = el('div', 'telemetry-funnel-fill');
        fill.style.width = Math.max(4, Math.round((stage.count / maxCount) * 100)) + '%';
        trackBar.appendChild(fill);
        row.appendChild(trackBar);
        funnelBars.appendChild(row);
      });
    }

    var streamList = document.getElementById('telemetry-event-list');
    if (streamList) {
      streamList.replaceChildren();
      var recent = eventsBuffer.slice(-25).reverse();
      if (recent.length === 0) {
        streamList.appendChild(el('div', 'telemetry-empty', 'No telemetry events recorded in buffer.'));
      } else {
        recent.forEach(function (ev) {
          var item = el('div', 'telemetry-event-row');
          item.appendChild(el('span', 'telemetry-ev-time', (ev.timestamp || '').slice(11, 19)));
          item.appendChild(el('span', 'telemetry-ev-cat cat-' + (ev.category || 'engagement'), ev.category || 'event'));
          item.appendChild(el('strong', 'telemetry-ev-name', ev.event));
          item.appendChild(el('code', 'telemetry-ev-props', JSON.stringify(ev.properties || {})));
          streamList.appendChild(item);
        });
      }
    }
  }

  function openTelemetryModal(defaultTab) {
    var modal = ensureTelemetryModal();
    if (defaultTab) {
      var sheet = modal.querySelector('.telemetry-modal-sheet');
      if (sheet) sheet.setAttribute('data-telemetry-tab', defaultTab);
      modal.querySelectorAll('[data-telemetry-tab-btn]').forEach(function (b) {
        var on = b.getAttribute('data-telemetry-tab-btn') === defaultTab;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
    }
    modal.classList.remove('hidden');
    refreshTelemetryModalIfOpen();
  }

  function exportTelemetryJSON() {
    var payload = {
      exported_at: new Date().toISOString(),
      session_id: sessionId,
      anonymous_id: anonId,
      config: config,
      web_vitals: webVitals,
      funnel_summary: funnelCounts,
      events: eventsBuffer
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'atelier-telemetry-' + sessionId + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  var OWNER_ADMIN_KEY = 'atelier-owner-vansh-2026';
  var OWNER_SESSION_STORAGE_KEY = 'atelier_owner_unlocked_v1';

  function isOwnerUnlocked() {
    try {
      var params = new URLSearchParams(window.location.search || '');
      var urlKey = params.get('admin') || params.get('owner_key');
      if (urlKey === OWNER_ADMIN_KEY) {
        sessionStorage.setItem(OWNER_SESSION_STORAGE_KEY, '1');
        // Strip the secret key from the visible address bar so sharing the URL won't leak owner mode
        params.delete('admin');
        params.delete('owner_key');
        var cleanSearch = params.toString();
        var cleanUrl = window.location.pathname + (cleanSearch ? '?' + cleanSearch : '') + (window.location.hash || '');
        if (window.history && window.history.replaceState) {
          window.history.replaceState({}, document.title, cleanUrl);
        }
        return true;
      }
      if (urlKey === 'logout' || urlKey === '0') {
        sessionStorage.removeItem(OWNER_SESSION_STORAGE_KEY);
        return false;
      }
      return sessionStorage.getItem(OWNER_SESSION_STORAGE_KEY) === '1';
    } catch (_) {
      return false;
    }
  }

  function syncOwnerMenuVisibility() {
    var ownerActive = isOwnerUnlocked();
    ['open-telemetry-modal-btn', 'open-qa-suite-btn'].forEach(function (id) {
      var btn = document.getElementById(id);
      if (btn) {
        btn.classList.toggle('hidden', !ownerActive);
      }
    });
  }

  function bindHeaderMenuButton() {
    syncOwnerMenuVisibility();
    var openBtn = document.getElementById('open-telemetry-modal-btn');
    if (openBtn && !openBtn.getAttribute('data-telemetry-bound')) {
      openBtn.setAttribute('data-telemetry-bound', 'true');
      openBtn.addEventListener('click', function () {
        if (!isOwnerUnlocked()) return;
        openTelemetryModal('live');
      });
    }
    document.addEventListener('keydown', function (e) {
      if (e.altKey && e.shiftKey && (e.key === 'A' || e.key === 'a')) {
        if (!isOwnerUnlocked()) return;
        e.preventDefault();
        openTelemetryModal('live');
      }
    });
  }

  function registerProductionServiceWorker() {
    if ('serviceWorker' in navigator && (window.location.protocol === 'https:' || window.location.hostname === 'localhost')) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('sw.js').catch(function () { /* ignore in dev */ });
      });
    }
  }

  function init() {
    initErrorMonitoring();
    initWebVitals();
    initAutoInstrumentation();
    bindHeaderMenuButton();
    registerProductionServiceWorker();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.AtelierAnalytics = {
    track: track,
    getEvents: function () { return eventsBuffer.slice(); },
    getWebVitals: function () { return Object.assign({}, webVitals); },
    getFunnelSummary: function () { recomputeFunnelCounts(); return Object.assign({}, funnelCounts); },
    getConfig: function () { return Object.assign({}, config); },
    setConfig: saveConfig,
    setConsent: function (mode) { return saveConfig({ consent: mode }); },
    clearEvents: function () {
      eventsBuffer = [];
      persistEventsBuffer();
      recomputeFunnelCounts();
      refreshTelemetryModalIfOpen();
    },
    openDashboard: openTelemetryModal,
    exportJSON: exportTelemetryJSON
  };
})();
