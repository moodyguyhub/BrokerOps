/**
 * BrokerOps Global UI Context Bus
 * Cross-iframe context management + Shell header controls
 * 
 * Features:
 * - Server selector state propagation
 * - Time window selection (relative/absolute)
 * - Keyboard shortcuts (/, Esc, Cmd/Ctrl+K, g→o/l/a)
 * - Copy helpers for IDs and values
 * - Event bus for cross-component communication
 * 
 * Version: 1.0.0
 */

(function(global) {
  'use strict';

  // ============================================================================
  // Constants & Configuration
  // ============================================================================
  
  const DEFAULT_TIME_WINDOWS = [
    { key: '15m', label: '15 min', minutes: 15 },
    { key: '1h', label: '1 hour', minutes: 60 },
    { key: '6h', label: '6 hours', minutes: 360 },
    { key: '24h', label: '24 hours', minutes: 1440 },
    { key: '7d', label: '7 days', minutes: 10080 },
    { key: '30d', label: '30 days', minutes: 43200 }
  ];

  const KEYBOARD_SHORTCUTS = {
    SEARCH: '/',
    CLOSE: 'Escape',
    COMMAND_PALETTE: 'k', // with Cmd/Ctrl
    NAV_ORDERS: 'o',      // with g prefix
    NAV_LPS: 'l',         // with g prefix
    NAV_ALERTS: 'a',      // with g prefix
    NAV_DASHBOARD: 'd'    // with g prefix
  };

  // ============================================================================
  // Event Bus Implementation
  // ============================================================================
  
  class EventBus {
    constructor() {
      this.listeners = new Map();
    }

    on(event, callback) {
      if (!this.listeners.has(event)) {
        this.listeners.set(event, new Set());
      }
      this.listeners.get(event).add(callback);
      return () => this.off(event, callback);
    }

    off(event, callback) {
      const eventListeners = this.listeners.get(event);
      if (eventListeners) {
        eventListeners.delete(callback);
      }
    }

    emit(event, data) {
      const eventListeners = this.listeners.get(event);
      if (eventListeners) {
        eventListeners.forEach(callback => {
          try {
            callback(data);
          } catch (err) {
            console.error(`[BO_CTX] Error in event handler for ${event}:`, err);
          }
        });
      }
      // Also dispatch to window for cross-iframe communication
      window.dispatchEvent(new CustomEvent(`bo:${event}`, { detail: data }));
    }
  }

  // ============================================================================
  // State Management
  // ============================================================================
  
  const state = {
    server: null,           // Current server ID
    servers: [],            // Available servers
    timeWindow: '24h',      // Current time window key
    timeWindowMinutes: 1440,
    alertCount: 0,          // Unacknowledged alert count
    systemStatus: 'ok',     // ok | degraded | error
    searchOpen: false,
    initialized: false
  };

  const eventBus = new EventBus();

  // ============================================================================
  // Relative Time Formatter
  // ============================================================================
  
  function relativeTime(date) {
    if (!date) return '';
    const now = Date.now();
    const ts = date instanceof Date ? date.getTime() : new Date(date).getTime();
    const diffMs = now - ts;
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);

    if (diffSec < 5) return 'just now';
    if (diffSec < 60) return `${diffSec}s ago`;
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffHour < 24) return `${diffHour}h ago`;
    if (diffDay < 7) return `${diffDay}d ago`;
    return new Date(ts).toLocaleDateString();
  }

  function formatTimeWindow(minutes) {
    if (minutes < 60) return `${minutes}m`;
    if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
    return `${Math.floor(minutes / 1440)}d`;
  }

  // ============================================================================
  // Copy Helpers
  // ============================================================================
  
  async function copyToClipboard(text, label = 'Value') {
    try {
      await navigator.clipboard.writeText(text);
      showToast(`${label} copied to clipboard`, 'success');
      return true;
    } catch (err) {
      console.error('[BO_CTX] Copy failed:', err);
      showToast('Failed to copy', 'error');
      return false;
    }
  }

  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `bo-toast bo-toast-${type}`;
    toast.textContent = message;
    toast.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      padding: 10px 16px;
      background: ${type === 'success' ? '#10b981' : type === 'error' ? '#f43f5e' : '#06b6d4'};
      color: white;
      border-radius: 8px;
      font-size: 0.875rem;
      font-weight: 500;
      z-index: 10000;
      animation: boToastIn 0.2s ease-out;
    `;
    
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.animation = 'boToastOut 0.2s ease-in forwards';
      setTimeout(() => toast.remove(), 200);
    }, 2000);
  }

  // ============================================================================
  // Keyboard Navigation
  // ============================================================================
  
  let gPrefixActive = false;
  let gPrefixTimeout = null;

  function initKeyboardShortcuts(config = {}) {
    document.addEventListener('keydown', (e) => {
      // Ignore if typing in an input
      if (e.target.matches('input, textarea, select, [contenteditable]')) {
        if (e.key === 'Escape') {
          e.target.blur();
          eventBus.emit('CLOSE_PANELS');
        }
        return;
      }

      // Escape - close panels
      if (e.key === 'Escape') {
        e.preventDefault();
        eventBus.emit('CLOSE_PANELS');
        state.searchOpen = false;
        return;
      }

      // / - focus search
      if (e.key === '/' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        eventBus.emit('FOCUS_SEARCH');
        const searchEl = document.getElementById('global-search-trigger');
        if (searchEl) searchEl.click();
        return;
      }

      // Cmd/Ctrl+K - command palette / global search
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        eventBus.emit('TOGGLE_COMMAND_PALETTE');
        return;
      }

      // g prefix navigation (vim-style)
      if (e.key === 'g' && !gPrefixActive) {
        gPrefixActive = true;
        clearTimeout(gPrefixTimeout);
        gPrefixTimeout = setTimeout(() => {
          gPrefixActive = false;
        }, 500);
        return;
      }

      if (gPrefixActive) {
        gPrefixActive = false;
        clearTimeout(gPrefixTimeout);

        const navMap = {
          'o': 'orders',
          'l': 'lps',
          'a': 'alerts',
          'd': 'dashboard'
        };

        if (navMap[e.key]) {
          e.preventDefault();
          eventBus.emit('NAV', { tab: navMap[e.key] });
          if (config.onNavigate) {
            config.onNavigate(navMap[e.key]);
          }
        }
      }
    });
  }

  // ============================================================================
  // Shell Header Controls
  // ============================================================================
  
  function initShell(config = {}) {
    if (state.initialized) {
      console.warn('[BO_CTX] Already initialized');
      return;
    }

    const {
      serverSelectId = 'global-server-select',
      timeWindowId = 'global-time-window',
      alertsBadgeId = 'global-alerts-badge',
      searchTriggerId = 'global-search-trigger',
      systemStatusId = 'global-system-status',
      servers = [],
      defaultServer = null,
      defaultTimeWindow = '24h',
      onNavigate = null,
      onServerChange = null,
      onTimeWindowChange = null
    } = config;

    state.servers = servers;
    state.server = defaultServer || (servers[0]?.id ?? null);
    state.timeWindow = defaultTimeWindow;
    
    const twConfig = DEFAULT_TIME_WINDOWS.find(t => t.key === defaultTimeWindow);
    state.timeWindowMinutes = twConfig?.minutes ?? 1440;

    // Server selector
    const serverSelect = document.getElementById(serverSelectId);
    if (serverSelect) {
      // Populate options
      serverSelect.innerHTML = servers.map(s => 
        `<option value="${s.id}" ${s.id === state.server ? 'selected' : ''}>${s.name || s.id}</option>`
      ).join('');

      serverSelect.addEventListener('change', (e) => {
        state.server = e.target.value;
        eventBus.emit('SERVER_CHANGE', { server: state.server });
        if (onServerChange) onServerChange(state.server);
      });
    }

    // Time window selector
    const timeWindowSelect = document.getElementById(timeWindowId);
    if (timeWindowSelect) {
      timeWindowSelect.innerHTML = DEFAULT_TIME_WINDOWS.map(tw =>
        `<option value="${tw.key}" ${tw.key === state.timeWindow ? 'selected' : ''}>${tw.label}</option>`
      ).join('');

      timeWindowSelect.addEventListener('change', (e) => {
        state.timeWindow = e.target.value;
        const twConfig = DEFAULT_TIME_WINDOWS.find(t => t.key === state.timeWindow);
        state.timeWindowMinutes = twConfig?.minutes ?? 1440;
        eventBus.emit('TIME_WINDOW_CHANGE', { 
          window: state.timeWindow, 
          minutes: state.timeWindowMinutes 
        });
        if (onTimeWindowChange) onTimeWindowChange(state.timeWindow, state.timeWindowMinutes);
      });
    }

    // Search trigger
    const searchTrigger = document.getElementById(searchTriggerId);
    if (searchTrigger) {
      searchTrigger.addEventListener('click', () => {
        state.searchOpen = !state.searchOpen;
        eventBus.emit('TOGGLE_SEARCH', { open: state.searchOpen });
      });
    }

    // Initialize keyboard shortcuts
    initKeyboardShortcuts({ onNavigate });

    state.initialized = true;
    eventBus.emit('INIT_COMPLETE', { state: { ...state } });

    console.log('[BO_CTX] Shell initialized', { server: state.server, timeWindow: state.timeWindow });
  }

  // ============================================================================
  // Alert Badge Management
  // ============================================================================
  
  function updateAlertBadge(count) {
    state.alertCount = count;
    const badge = document.getElementById('global-alerts-badge');
    if (badge) {
      badge.textContent = count > 99 ? '99+' : String(count);
      badge.style.display = count > 0 ? 'inline-flex' : 'none';
    }
    // Also update sidebar badge if present
    const sidebarBadge = document.getElementById('alerts-badge');
    if (sidebarBadge) {
      sidebarBadge.textContent = count > 99 ? '99+' : String(count);
      sidebarBadge.style.display = count > 0 ? 'inline-flex' : 'none';
    }
    eventBus.emit('ALERT_COUNT_CHANGE', { count });
  }

  // ============================================================================
  // System Status Management
  // ============================================================================
  
  function updateSystemStatus(status, message = '') {
    state.systemStatus = status;
    const statusEl = document.getElementById('global-system-status');
    if (statusEl) {
      statusEl.className = `system-status system-status-${status}`;
      statusEl.title = message || status;
    }
    eventBus.emit('SYSTEM_STATUS_CHANGE', { status, message });
  }

  // ============================================================================
  // Cross-iframe Communication
  // ============================================================================
  
  // Listen for messages from embedded iframes
  window.addEventListener('message', (e) => {
    if (!e.data || !e.data.type) return;
    
    // Validate origin if needed
    if (e.data.type.startsWith('BO_')) {
      const eventType = e.data.type.replace('BO_', '');
      eventBus.emit(eventType, e.data.payload);
    }
  });

  // Send message to parent (for embedded pages)
  function postToParent(type, payload) {
    if (window.parent !== window) {
      window.parent.postMessage({ type: `BO_${type}`, payload }, '*');
    }
  }

  // Broadcast to all iframes
  function broadcastToIframes(type, payload) {
    const iframes = document.querySelectorAll('iframe');
    iframes.forEach(iframe => {
      try {
        iframe.contentWindow.postMessage({ type: `BO_${type}`, payload }, '*');
      } catch (err) {
        // Cross-origin iframe, skip
      }
    });
  }

  // ============================================================================
  // Inject Toast CSS
  // ============================================================================
  
  const toastStyles = document.createElement('style');
  toastStyles.textContent = `
    @keyframes boToastIn {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes boToastOut {
      from { opacity: 1; transform: translateY(0); }
      to { opacity: 0; transform: translateY(-10px); }
    }
  `;
  document.head.appendChild(toastStyles);

  // ============================================================================
  // Public API
  // ============================================================================
  
  global.BO_CTX = {
    // Initialization
    initShell,

    // State getters
    getState: () => ({ ...state }),
    getServer: () => state.server,
    getTimeWindow: () => state.timeWindow,
    getTimeWindowMinutes: () => state.timeWindowMinutes,
    getAlertCount: () => state.alertCount,
    getSystemStatus: () => state.systemStatus,

    // State setters
    setServer: (serverId) => {
      state.server = serverId;
      const select = document.getElementById('global-server-select');
      if (select) select.value = serverId;
      eventBus.emit('SERVER_CHANGE', { server: serverId });
      broadcastToIframes('SERVER_CHANGE', { server: serverId });
    },
    setTimeWindow: (windowKey) => {
      state.timeWindow = windowKey;
      const twConfig = DEFAULT_TIME_WINDOWS.find(t => t.key === windowKey);
      state.timeWindowMinutes = twConfig?.minutes ?? 1440;
      const select = document.getElementById('global-time-window');
      if (select) select.value = windowKey;
      eventBus.emit('TIME_WINDOW_CHANGE', { window: windowKey, minutes: state.timeWindowMinutes });
      broadcastToIframes('TIME_WINDOW_CHANGE', { window: windowKey, minutes: state.timeWindowMinutes });
    },
    updateAlertBadge,
    updateSystemStatus,

    // Event bus
    on: (event, callback) => eventBus.on(event, callback),
    off: (event, callback) => eventBus.off(event, callback),
    emit: (event, data) => eventBus.emit(event, data),

    // Utilities
    relativeTime,
    formatTimeWindow,
    copyToClipboard,
    showToast,

    // Cross-iframe communication
    postToParent,
    broadcastToIframes,

    // Constants
    TIME_WINDOWS: DEFAULT_TIME_WINDOWS,
    SHORTCUTS: KEYBOARD_SHORTCUTS
  };

})(typeof window !== 'undefined' ? window : this);
