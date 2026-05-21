package config

import (
	"fmt"
	"os"
	"strings"

	"github.com/tidwall/gjson"
	"github.com/tidwall/sjson"
)

// ConfigMutation describes one planned OpenCode config path mutation.
type ConfigMutation struct {
	Action string
	Path   string
	Before string
	After  string
}

// ApplyPlan is the pure, previewable result of applying preferences to raw
// OpenCode config bytes. Building a plan never writes files or creates backups.
type ApplyPlan struct {
	ConfigPath string
	Mutations  []ConfigMutation
	Updated    []byte
}

// Preview renders a compact, human-readable summary of planned config writes.
func (p ApplyPlan) Preview() string {
	var b strings.Builder
	fmt.Fprintf(&b, "Config: %s\n", p.ConfigPath)
	if len(p.Mutations) == 0 {
		b.WriteString("No config changes.\n")
		return b.String()
	}
	for _, m := range p.Mutations {
		fmt.Fprintf(&b, "%s %s\n", m.Action, m.Path)
		fmt.Fprintf(&b, "- %s\n", m.Before)
		fmt.Fprintf(&b, "+ %s\n", m.After)
	}
	return b.String()
}

// BuildPreferencesApplyPlan reads the configured OpenCode config path and
// builds a pure ApplyPlan. It performs no writes and creates no backups.
func BuildPreferencesApplyPlan(pc PreferencesConfig, targets []Target) (ApplyPlan, error) {
	configPath := ConfigPath()
	raw, err := readConfigForApply(configPath)
	if err != nil {
		return ApplyPlan{}, err
	}
	return BuildApplyPlan(raw, configPath, pc, targets)
}

func readConfigForApply(configPath string) ([]byte, error) {
	raw, err := os.ReadFile(configPath)
	if err != nil {
		return nil, fmt.Errorf("reading config: %w", err)
	}
	return raw, nil
}

// BuildApplyPlan computes the exact updated OpenCode config bytes for the given
// preferences. It mirrors ApplyPreferences mutation semantics but does no I/O.
func BuildApplyPlan(raw []byte, configPath string, pc PreferencesConfig, targets []Target) (ApplyPlan, error) {
	updated := append([]byte(nil), raw...)
	mutations := make([]ConfigMutation, 0)
	var err error

	for _, t := range targets {
		existsInConfig := gjson.GetBytes(raw, "agent."+t.Name).Exists()
		jsonPath := "agent." + t.Name + ".model"

		if !t.IsModelMappable() {
			if !existsInConfig {
				continue
			}
			updated, mutations, err = plannedDelete(updated, mutations, jsonPath)
			if err != nil {
				return ApplyPlan{}, err
			}
			continue
		}

		if pc.ClearedModels[t.Name] {
			if !existsInConfig {
				continue
			}
			updated, mutations, err = plannedDelete(updated, mutations, jsonPath)
			if err != nil {
				return ApplyPlan{}, err
			}
			continue
		}

		model, ok := pc.TargetModels[t.Name]
		if !ok || model == "" {
			continue
		}

		updated, mutations, err = plannedSet(updated, mutations, jsonPath, model)
		if err != nil {
			return ApplyPlan{}, err
		}
	}

	for _, t := range targets {
		if !t.IsModelMappable() {
			continue
		}
		chainPath := "agent." + t.Name + "." + FallbackJSONPath
		chain := pc.TargetFallbacks[t.Name]
		pathExists := gjson.GetBytes(updated, chainPath).Exists()

		if len(chain) == 0 {
			if !pathExists {
				continue
			}
			updated, mutations, err = plannedDelete(updated, mutations, chainPath)
			if err != nil {
				return ApplyPlan{}, err
			}
			continue
		}

		if err := ValidateFallbackChain(chain); err != nil {
			return ApplyPlan{}, fmt.Errorf("invalid fallback chain for %s: %w", t.Name, err)
		}
		updated, mutations, err = plannedSet(updated, mutations, chainPath, chain)
		if err != nil {
			return ApplyPlan{}, err
		}
	}

	for name, cfg := range pc.AdvProviders {
		if !validAdvProviders[name] {
			continue
		}
		disablePath := "agent." + name + ".disable"
		updated, mutations, err = plannedSet(updated, mutations, disablePath, !cfg.Enabled)
		if err != nil {
			return ApplyPlan{}, err
		}
		if cfg.Model != "" {
			modelPath := "agent." + name + ".model"
			updated, mutations, err = plannedSet(updated, mutations, modelPath, cfg.Model)
			if err != nil {
				return ApplyPlan{}, err
			}
		}
	}

	return ApplyPlan{ConfigPath: configPath, Mutations: mutations, Updated: updated}, nil
}

func plannedSet(updated []byte, mutations []ConfigMutation, path string, value any) ([]byte, []ConfigMutation, error) {
	before := pathValue(updated, path)
	next, err := sjson.SetBytes(updated, path, value)
	if err != nil {
		return updated, mutations, fmt.Errorf("setting %s: %w", path, err)
	}
	after := pathValue(next, path)
	if string(next) != string(updated) || before != after {
		mutations = append(mutations, ConfigMutation{Action: "SET", Path: path, Before: before, After: after})
	}
	return next, mutations, nil
}

func plannedDelete(updated []byte, mutations []ConfigMutation, path string) ([]byte, []ConfigMutation, error) {
	before := pathValue(updated, path)
	next, err := sjson.DeleteBytes(updated, path)
	if err != nil {
		return updated, mutations, fmt.Errorf("deleting %s: %w", path, err)
	}
	after := pathValue(next, path)
	if string(next) != string(updated) || before != after {
		mutations = append(mutations, ConfigMutation{Action: "DELETE", Path: path, Before: before, After: after})
	}
	return next, mutations, nil
}

func pathValue(raw []byte, path string) string {
	res := gjson.GetBytes(raw, path)
	if !res.Exists() {
		return "(missing)"
	}
	if res.Raw != "" {
		return res.Raw
	}
	return res.String()
}
