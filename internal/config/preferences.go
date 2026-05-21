// Package config — preferences.go
//
// Direct per-target model preferences. Each agent or sub-agent maps directly to
// a model ID with no intermediate abstraction. Config is stored in
// ~/.config/opencode/omp-preferences.json (separate from opencode.json which
// uses additionalProperties:false).
//
// Fallback chains: the canonical JSON path in opencode.json is
// `agent.<name>.options.fallback_models`. See schema/fallback-schema.json for
// the cross-stack contract — both this Go writer and the TypeScript plugin
// reader reference the field name `fallback_models` verbatim.
package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// PreferencesConfig holds per-target model assignments.
// TargetModels maps each target name (agent or sub-agent) to a model ID.
// ClearedModels tracks targets whose model was explicitly cleared by the user,
// so ApplyPreferences can remove the model key from opencode.json.
// AdvProviders holds provider-specific ADV variant configuration (enable/disable + model).
// TargetFallbacks maps each target to its ordered fallback chain — written
// at opencode.json path agent.<name>.options.fallback_models. See
// schema/fallback-schema.json for the contract; empty/missing means no
// fallback (single-model behavior).
type PreferencesConfig struct {
	TargetModels    map[string]string            `json:"target_models"`
	ClearedModels   map[string]bool              `json:"cleared_models,omitempty"`
	AdvProviders    map[string]AdvProviderConfig `json:"adv_providers,omitempty"`
	TargetFallbacks map[string][]string          `json:"target_fallbacks,omitempty"`
}

// AdvProviderConfig holds enable/disable and optional model for a provider ADV variant.
type AdvProviderConfig struct {
	Enabled bool   `json:"enabled"`
	Model   string `json:"model,omitempty"`
}

// PreferencesPath returns the path to omp-preferences.json, respecting
// OPENCODE_CONFIG_DIR.
func PreferencesPath() string {
	return filepath.Join(ConfigDir(), "omp-preferences.json")
}

// validAdvProviders is the whitelist of allowed provider ADV variant names.
var validAdvProviders = map[string]bool{
	"adv-claude": true,
	"adv-gpt":    true,
	"adv-glm":    true,
	"adv-kimi":   true,
}

// ValidAdvProvider reports whether name is a recognized provider ADV variant.
func ValidAdvProvider(name string) bool {
	return validAdvProviders[name]
}

func sanitizePreferences(pc PreferencesConfig) (PreferencesConfig, bool) {
	changed := false

	if pc.TargetModels == nil {
		pc.TargetModels = make(map[string]string)
		changed = true
	}
	if pc.ClearedModels == nil {
		pc.ClearedModels = make(map[string]bool)
		changed = true
	}
	if pc.AdvProviders == nil {
		pc.AdvProviders = make(map[string]AdvProviderConfig)
		changed = true
	}
	if pc.TargetFallbacks == nil {
		pc.TargetFallbacks = make(map[string][]string)
		changed = true
	}

	for name := range pc.TargetModels {
		if !(Target{Name: name, Kind: KindAgent}).IsModelMappable() {
			delete(pc.TargetModels, name)
			changed = true
		}
	}
	for name := range pc.ClearedModels {
		if !(Target{Name: name, Kind: KindAgent}).IsModelMappable() {
			delete(pc.ClearedModels, name)
			changed = true
		}
	}
	for name := range pc.AdvProviders {
		if !validAdvProviders[name] {
			delete(pc.AdvProviders, name)
			changed = true
		}
	}
	for name, chain := range pc.TargetFallbacks {
		// Drop unmappable targets (main agents like build/plan/adv).
		if !(Target{Name: name, Kind: KindAgent}).IsModelMappable() {
			delete(pc.TargetFallbacks, name)
			changed = true
			continue
		}
		// Drop chains that violate the schema contract (bad pattern,
		// over-length, or duplicate entries). Surfacing-at-apply is
		// preserved by ApplyPreferences itself; sanitize here is
		// belt-and-braces for malformed on-disk preferences.
		if err := ValidateFallbackChain(chain); err != nil {
			delete(pc.TargetFallbacks, name)
			changed = true
		}
	}

	return pc, changed
}

// LoadPreferences reads the preferences config from disk.
// Returns an empty PreferencesConfig (no error) if the file does not exist.
func LoadPreferences() (PreferencesConfig, error) {
	data, err := os.ReadFile(PreferencesPath())
	if os.IsNotExist(err) {
		return PreferencesConfig{
			TargetModels:  make(map[string]string),
			ClearedModels: make(map[string]bool),
		}, nil
	}
	if err != nil {
		return PreferencesConfig{}, err
	}
	var pc PreferencesConfig
	if err := json.Unmarshal(data, &pc); err != nil {
		return PreferencesConfig{}, err
	}
	pc, changed := sanitizePreferences(pc)
	if changed {
		if err := SavePreferences(pc); err != nil {
			return PreferencesConfig{}, err
		}
	}
	return pc, nil
}

// SavePreferences writes the preferences config to disk atomically
// (temp file + rename).
func SavePreferences(pc PreferencesConfig) error {
	// Discard the `changed` flag — SavePreferences always writes, so whether
	// sanitize made any structural changes is irrelevant to this code path.
	pc, _ = sanitizePreferences(pc)
	data, err := json.MarshalIndent(pc, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(PreferencesPath(), data, 0644)
}

// ApplyPreferences writes model preferences to opencode.json for all targets
// that have a model assignment in the preferences config. Targets without an
// assignment are left unchanged unless explicitly cleared. Creates new entries
// in opencode.json when a target has a model to set but no existing entry.
// Also writes AdvProviders configuration (disable + model) for provider ADV variants.
func ApplyPreferences(pc PreferencesConfig, targets []Target) error {
	plan, err := BuildPreferencesApplyPlan(pc, targets)
	if err != nil {
		return err
	}
	return ApplyPreparedPlan(plan)
}

// ApplyPreparedPlan commits an already-previewed apply plan to disk using the
// same backup, atomic-write, owner-only permission, and retention safeguards as
// ApplyPreferences. Keeping this separate from BuildPreferencesApplyPlan lets
// callers show users the exact bytes/mutations that will be written, then
// confirm that prepared plan without recomputing a different one.
func ApplyPreparedPlan(plan ApplyPlan) error {
	if plan.ConfigPath == "" {
		return fmt.Errorf("apply plan missing config path")
	}
	if len(plan.Updated) == 0 {
		return fmt.Errorf("apply plan missing updated config bytes")
	}

	// Pre-mutation backup. Errors propagated — a missing backup is a missing
	// rollback path, not an acceptable failure mode.
	if err := writeBackup(plan.ConfigPath); err != nil {
		return fmt.Errorf("writing backup: %w", err)
	}

	if err := writeFileAtomic(plan.ConfigPath, plan.Updated, 0600); err != nil {
		return err
	}
	if err := pruneBackups(plan.ConfigPath, maxOpencodeBackups); err != nil {
		return fmt.Errorf("pruning backups: %w", err)
	}
	return nil
}
