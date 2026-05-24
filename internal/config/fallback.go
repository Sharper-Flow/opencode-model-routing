// Package config — fallback.go
//
// Validation and constants for per-agent fallback chains. The canonical
// contract lives in schema/fallback-schema.json; this file mirrors the regex
// and length cap on the Go writer side. Both this file and the TypeScript
// plugin's loader reference the field name `fallback_models` verbatim — drift
// is enforced by schema-contract-check.sh.
//
// New writes target OMR plugin tuple options because OpenCode forwards
// agent.options into provider/model requests. FallbackJSONPath remains only as
// the legacy migration path under agent.<name>.options.fallback_models.
package config

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/tidwall/gjson"
	"github.com/tidwall/sjson"
)

// ModelKeyPattern is the regex that every fallback chain entry must match.
// Mirrors `items.pattern` in schema/fallback-schema.json.
const ModelKeyPattern = `^[a-z0-9][a-z0-9-]*/[A-Za-z0-9_:/-]+(\.[A-Za-z0-9_:/-]+)*$`

// FallbackJSONPath is the legacy JSON path under each agent for the fallback
// chain. OMR now writes plugin tuple options instead; this path is retained for
// migration reads and cleanup.
const FallbackJSONPath = "options.fallback_models"

const RoutingPluginID = "@sharper-flow/opencode-model-routing-plugin"
const RoutingPluginPathFragment = "opencode-model-routing"

func isRoutingPluginSpec(spec string) bool {
	return spec == RoutingPluginID || strings.Contains(spec, RoutingPluginPathFragment)
}

func routingPluginIndex(raw []byte) (int, bool) {
	plugins := gjson.GetBytes(raw, "plugin")
	if !plugins.Exists() || !plugins.IsArray() {
		return -1, false
	}
	for i, item := range plugins.Array() {
		if item.Type == gjson.String && isRoutingPluginSpec(item.String()) {
			return i, true
		}
		if item.IsArray() {
			arr := item.Array()
			if len(arr) > 0 && arr[0].Type == gjson.String && isRoutingPluginSpec(arr[0].String()) {
				return i, true
			}
		}
	}
	return -1, false
}

func ensureRoutingPluginOptions(raw []byte) ([]byte, int, error) {
	idx, ok := routingPluginIndex(raw)
	if !ok {
		updated := raw
		if !gjson.GetBytes(updated, "plugin").IsArray() {
			var err error
			updated, err = sjson.SetBytes(updated, "plugin", []any{})
			if err != nil {
				return nil, -1, err
			}
		}
		updated, err := sjson.SetBytes(updated, "plugin.-1", []any{RoutingPluginID, map[string]any{}})
		if err != nil {
			return nil, -1, err
		}
		idx, _ = routingPluginIndex(updated)
		return updated, idx, nil
	}

	entry := gjson.GetBytes(raw, fmt.Sprintf("plugin.%d", idx))
	if entry.Type == gjson.String {
		updated, err := sjson.SetBytes(raw, fmt.Sprintf("plugin.%d", idx), []any{entry.String(), map[string]any{}})
		if err != nil {
			return nil, -1, err
		}
		return updated, idx, nil
	}
	return raw, idx, nil
}

func pluginFallbackPath(raw []byte, agentName string) (string, bool) {
	idx, ok := routingPluginIndex(raw)
	if !ok {
		return "", false
	}
	return fmt.Sprintf("plugin.%d.1.agents.%s.fallback_models", idx, agentName), true
}

// MaxChainLength caps the number of entries in a single fallback chain.
// Mirrors `maxItems` in schema/fallback-schema.json. The cap is conservative
// — agents needing deeper chains are usually a sign that the primary model
// choice is wrong, not that the chain needs to be longer.
const MaxChainLength = 8

// modelKeyRE is the compiled-once regex used for chain entry validation.
var modelKeyRE = regexp.MustCompile(ModelKeyPattern)

// ValidateFallbackChain enforces the schema contract on a single chain:
//   - length ≤ MaxChainLength
//   - each entry matches ModelKeyPattern
//   - no duplicate entries (uniqueItems constraint)
//
// An empty or nil chain is valid (means "no fallback for this target").
func ValidateFallbackChain(chain []string) error {
	if len(chain) > MaxChainLength {
		return fmt.Errorf("fallback chain length %d exceeds max %d", len(chain), MaxChainLength)
	}
	seen := make(map[string]struct{}, len(chain))
	for i, entry := range chain {
		if !modelKeyRE.MatchString(entry) {
			return fmt.Errorf("fallback chain entry %d (%q) does not match pattern %s",
				i, entry, ModelKeyPattern)
		}
		if strings.Contains(entry, "..") {
			return fmt.Errorf("fallback chain entry %d (%q) must not contain '..'", i, entry)
		}
		if _, dup := seen[entry]; dup {
			return fmt.Errorf("fallback chain has duplicate entry %q at position %d", entry, i)
		}
		seen[entry] = struct{}{}
	}
	return nil
}
