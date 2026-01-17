/**
 * BrokerOps Provenance Footer Component
 * Single source of truth for build/version provenance display
 * 
 * Renders a minimal footer showing:
 * - Kernel version (tag or sha)
 * - UI version
 * - Build timestamp
 * 
 * Fetches from /api/provenance endpoint once per page load
 * Does NOT duplicate across iframes - shell footer covers embedded content
 * 
 * Version: 1.0.0
 */

(function(global) {
  'use strict';

  // ============================================================================
  // Configuration
  // ============================================================================
  
  const PROVENANCE_ENDPOINT = '/api/provenance';
  const REFRESH_INTERVAL_MS = 0; // 0 = no refresh (fetch once)
  
  // ============================================================================
  // Provenance Footer Class
  // ============================================================================
  
  class ProvenanceFooter {
    constructor() {
      this.data = null;
      this.footerEl = null;
      this.isEmbedded = this._detectEmbed();
    }

    /**
     * Detect if we're running inside an iframe (embedded mode)
     */
    _detectEmbed() {
      try {
        return window.self !== window.top;
      } catch (e) {
        return true; // Cross-origin iframe
      }
    }

    /**
     * Fetch provenance data from API
     */
    async fetchProvenance() {
      try {
        const resp = await fetch(PROVENANCE_ENDPOINT);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        this.data = await resp.json();
        return this.data;
      } catch (err) {
        console.warn('[Provenance] Failed to fetch:', err);
        // Return fallback data
        this.data = {
          kernel: 'brokerops@dev',
          ui: 'ui@dev',
          buildTs: '--'
        };
        return this.data;
      }
    }

    /**
     * Format timestamp for display
     */
    _formatTimestamp(ts) {
      if (!ts || ts === '--') return '--';
      try {
        const date = new Date(ts);
        return date.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
      } catch {
        return ts;
      }
    }

    /**
     * Create footer DOM element
     */
    _createFooterElement() {
      const footer = document.createElement('footer');
      footer.id = 'provenance-footer';
      footer.className = 'provenance-footer';
      footer.innerHTML = `
        <div class="provenance-content">
          <span class="provenance-item" id="prov-kernel" title="Kernel Version">
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
            </svg>
            <code class="prov-value">--</code>
          </span>
          <span class="provenance-separator">•</span>
          <span class="provenance-item" id="prov-ui" title="UI Version">
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
              <line x1="3" y1="9" x2="21" y2="9"/>
              <line x1="9" y1="21" x2="9" y2="9"/>
            </svg>
            <code class="prov-value">--</code>
          </span>
          <span class="provenance-separator">•</span>
          <span class="provenance-item" id="prov-ts" title="Build Timestamp">
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <polyline points="12,6 12,12 16,14"/>
            </svg>
            <code class="prov-value">--</code>
          </span>
        </div>
      `;
      return footer;
    }

    /**
     * Inject CSS styles for footer
     */
    _injectStyles() {
      if (document.getElementById('provenance-footer-styles')) return;
      
      const style = document.createElement('style');
      style.id = 'provenance-footer-styles';
      style.textContent = `
        .provenance-footer {
          position: fixed;
          bottom: 0;
          left: 0;
          right: 0;
          height: 24px;
          background: var(--slate-950, #020617);
          border-top: 1px solid var(--slate-800, #1e293b);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1000;
          font-family: 'JetBrains Mono', 'Consolas', monospace;
          font-size: 0.6875rem;
          color: var(--slate-500, #64748b);
        }

        .provenance-content {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .provenance-item {
          display: flex;
          align-items: center;
          gap: 4px;
        }

        .provenance-item svg {
          opacity: 0.6;
        }

        .provenance-item .prov-value {
          font-family: inherit;
          font-size: inherit;
          background: none;
          padding: 0;
          color: var(--slate-400, #94a3b8);
        }

        .provenance-separator {
          color: var(--slate-700, #334155);
        }

        /* Adjust main content to account for footer */
        body.has-provenance-footer {
          padding-bottom: 24px;
        }

        /* Shell layout adjustment */
        body.has-provenance-footer .shell-layout {
          height: calc(100vh - 64px - 24px); /* topbar + footer */
        }

        /* Hide in embed mode - shell footer is visible to user */
        body.embed-mode .provenance-footer {
          display: none;
        }

        /* Print styles - always show */
        @media print {
          .provenance-footer {
            position: relative;
            background: white;
            border-top: 1px solid #ccc;
            color: #333;
          }
          .provenance-item .prov-value {
            color: #000;
          }
        }
      `;
      document.head.appendChild(style);
    }

    /**
     * Update footer with provenance data
     */
    _updateFooter() {
      if (!this.data || !this.footerEl) return;

      const kernelEl = this.footerEl.querySelector('#prov-kernel .prov-value');
      const uiEl = this.footerEl.querySelector('#prov-ui .prov-value');
      const tsEl = this.footerEl.querySelector('#prov-ts .prov-value');

      if (kernelEl) kernelEl.textContent = this.data.kernel || '--';
      if (uiEl) uiEl.textContent = this.data.ui || '--';
      if (tsEl) tsEl.textContent = this._formatTimestamp(this.data.buildTs);
    }

    /**
     * Initialize and render footer
     * Skip rendering if in embed mode (iframes)
     */
    async init() {
      // Skip footer in embedded pages - shell provides it
      if (this.isEmbedded) {
        console.log('[Provenance] Skipping footer in embed mode');
        return;
      }

      // Inject styles
      this._injectStyles();

      // Fetch data
      await this.fetchProvenance();

      // Create and append footer
      this.footerEl = this._createFooterElement();
      document.body.appendChild(this.footerEl);
      document.body.classList.add('has-provenance-footer');

      // Update with data
      this._updateFooter();

      console.log('[Provenance] Footer initialized:', this.data);
    }

    /**
     * Get current provenance data
     */
    getData() {
      return this.data;
    }
  }

  // ============================================================================
  // Singleton Export
  // ============================================================================
  
  const provenanceFooter = new ProvenanceFooter();

  // Auto-initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => provenanceFooter.init());
  } else {
    provenanceFooter.init();
  }

  // Export for external access
  global.BO_PROVENANCE = provenanceFooter;

})(typeof window !== 'undefined' ? window : this);
