# Broker Risk Policy v0.2
# Policy ID: broker.risk.order
# Owner: Compliance Team

package broker.risk.order

import rego.v1

default decision := {"allow": false, "reason_code": "POLICY_ERROR", "rule_id": "fallback"}

# Metadata for audit trail
policy_version := "policy.v0.2"

# Rule: Block orders exceeding quantity limit
decision := {"allow": false, "reason_code": "QTY_LIMIT_EXCEEDED", "rule_id": "qty_limit"} if {
input.qty > 1000
}

# Rule: Block restricted symbols with high quantity
decision := {"allow": false, "reason_code": "SYMBOL_RESTRICTION", "rule_id": "symbol_gme"} if {
upper(input.symbol) == "GME"
input.qty > 10
}

# Rule: Block penny stocks over threshold
decision := {"allow": false, "reason_code": "PENNY_STOCK_RESTRICTION", "rule_id": "penny_stock"} if {
input.price != null
input.price < 1.0
input.qty > 100
}

# Rule: Allow if no blocking rules match
decision := {"allow": true, "reason_code": "OK", "rule_id": "allow_default"} if {
input.qty <= 1000
not restricted_symbol
not penny_stock_violation
}

restricted_symbol if {
upper(input.symbol) == "GME"
input.qty > 10
}

penny_stock_violation if {
input.price != null
input.price < 1.0
input.qty > 100
}
