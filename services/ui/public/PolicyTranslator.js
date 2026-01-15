window.PolicyTranslator = {
  thresholds: {
    qty_limit: { field: 'qty', limit: 1000, label: 'Quantity Limit' },
    symbol_gme: { field: 'qty', limit: 10, symbol: 'GME', label: 'GME Restriction' },
    penny_stock: { field: 'qty', limit: 100, priceThreshold: 1.0, label: 'Penny Stock Limit' }
  },

  explanations: {
    'QTY_LIMIT_EXCEEDED': 'Order quantity exceeds the maximum allowed per transaction',
    'SYMBOL_RESTRICTION': 'This symbol has trading restrictions in place',
    'PENNY_STOCK_RESTRICTION': 'Penny stock orders are limited to protect against volatility',
    'OK': 'Order meets all guardrail requirements',
    'APPROVED': 'Order meets all guardrail requirements'
  },

  translate(summary) {
    const { reasonCode, ruleId, order } = summary;
    const threshold = this.thresholds[ruleId];

    if (reasonCode === 'OK' || reasonCode === 'APPROVED') {
      return {
        primary: '✓ All guardrails passed — order auto-approved',
        secondary: `Guardrail Set: ${summary.policyVersion || 'default'}`
      };
    }

    if (threshold && order) {
      const attempted = order[threshold.field];
      const limit = threshold.limit;
      const excess = attempted - limit;
      const pct = ((excess / limit) * 100).toFixed(0);

      return {
        primary: `⚠ Guardrail triggered: ${threshold.label} exceeded by ${excess.toLocaleString()} units (+${pct}%)`,
        secondary: `Limit: ${limit.toLocaleString()} | Attempted: ${attempted.toLocaleString()} | Rule: ${ruleId}`
      };
    }

    return {
      primary: `⚠ Guardrail triggered: ${this.humanizeReason(reasonCode)}`,
      secondary: `Rule: ${ruleId || 'unknown'} | Guardrail Set: ${summary.policyVersion || 'default'}`
    };
  },

  humanizeReason(code) {
    const map = {
      'QTY_LIMIT_EXCEEDED': 'Quantity Limit Exceeded',
      'SYMBOL_RESTRICTION': 'Symbol Restricted',
      'PENNY_STOCK_RESTRICTION': 'Penny Stock Rule',
      'OK': 'Passed',
      'APPROVED': 'Passed',
      'UNKNOWN': 'Unknown'
    };
    return map[code] || code;
  },

  humanizeEventType(type) {
    const map = {
      'order.requested': 'Order Submitted',
      'risk.decision': 'Guardrail Evaluated',
      'order.accepted': 'Auto-Approved',
      'order.blocked': 'Policy-Blocked',
      'override.requested': 'Override Requested',
      'override.approved': 'Override Approved',
      'operator.override': 'Manual Override'
    };
    return map[type] || type;
  },

  calculateBreach(summary) {
    if (!summary.order || !summary.ruleId) return null;

    const threshold = this.thresholds[summary.ruleId];
    if (!threshold) return null;

    const attempted = summary.order[threshold.field];
    const limit = threshold.limit;
    if (attempted <= limit) return null;

    const breachPercent = ((attempted - limit) / limit * 100).toFixed(1);

    return {
      limit,
      attempted,
      breachPercent,
      label: threshold.label
    };
  }
};
