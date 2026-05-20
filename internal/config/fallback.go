// Package config — fallback.go
//
// Validation and constants for per-agent fallback chains. The canonical
// contract lives in schema/fallback-schema.json; this file mirrors the regex
// and length cap on the Go writer side. Both this file and the TypeScript
// plugin's loader reference the field name `fallback_models` verbatim — drift
// is enforced by schema-contract-check.sh.
//
// Why `agent.<name>.options.fallback_models` instead of a top-level sibling
// key: OpenCode's `AgentConfig.normalize()` in
// packages/opencode/src/config/agent.ts relocates any non-allow-listed
// sibling into `options` at config load time. Writing directly to the
// `options` extension slot matches the documented contract rather than
// relying on the transform side-effect. See design.md § D1 for the citation.
package config

import (
	"fmt"
	"regexp"
)

// ModelKeyPattern is the regex that every fallback chain entry must match.
// Mirrors `items.pattern` in schema/fallback-schema.json.
const ModelKeyPattern = `^[a-z0-9][a-z0-9-]*/[A-Za-z0-9._:/-]+$`

// FallbackJSONPath is the canonical JSON path under each agent for the
// fallback chain. Used by ApplyPreferences (sjson SetBytes target) and by
// discoverTargets (gjson read source).
const FallbackJSONPath = "options.fallback_models"

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
		if _, dup := seen[entry]; dup {
			return fmt.Errorf("fallback chain has duplicate entry %q at position %d", entry, i)
		}
		seen[entry] = struct{}{}
	}
	return nil
}
