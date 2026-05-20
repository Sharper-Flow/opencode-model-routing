// Package config reads and writes OpenCode's global configuration.
//
// It discovers agents (built-in + markdown) and available
// models from the provider registry. Config writes use tidwall/sjson
// for surgical JSON path updates that preserve formatting.
package config

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/tidwall/gjson"
	"github.com/tidwall/sjson"
)

// TargetKind classifies supported targets.
type TargetKind string

const (
	KindAgent TargetKind = "agent"
)

// Target represents an agent that can have a model preference.
type Target struct {
	Name           string
	Kind           TargetKind
	Mode           string // "primary", "subagent", "system" (agents only)
	Model          string // current model preference, empty = none
	Description    string // one-line purpose description, shown in TUI
	BuiltIn        bool
	Locked         bool     // true for built-in primary agents whose cycle order is fixed by OpenCode
	Hidden         bool     // true when frontmatter sets hidden: true
	FallbackModels []string // ordered fallback chain from agent.<name>.options.fallback_models
}

var unmappedMainAgents = map[string]bool{
	"adv":   true,
	"build": true,
	"plan":  true,
}

// IsSubagent reports whether the target should be treated as a sub-agent in the
// TUI and recovery workflows.
func (t Target) IsSubagent() bool {
	return t.Kind == KindAgent && (t.Mode == "subagent" || t.Hidden)
}

// IsModelMappable reports whether omp should manage a direct model override for
// this target. Main agents/overlays like build, adv, and plan should follow the
// current session model instead of being pinned here.
// Provider ADV variants (adv-claude, adv-gpt, adv-glm, adv-kimi) are explicitly
// whitelisted as mappable so users can assign per-provider models.
func (t Target) IsModelMappable() bool {
	if t.Kind != KindAgent {
		return false
	}
	if validAdvProviders[t.Name] {
		return true
	}
	return !unmappedMainAgents[t.Name]
}

// Model represents an available model from a provider.
type Model struct {
	Provider string
	ID       string // full ID: provider/model-id
	Name     string // display name
}

// State holds the full resolved state for the TUI.
type State struct {
	Targets []Target
	Models  []Model
}

// Built-in agents from OpenCode core.
var builtinAgents = []Target{
	{Name: "build", Kind: KindAgent, Mode: "primary", BuiltIn: true, Locked: true},
	{Name: "plan", Kind: KindAgent, Mode: "primary", BuiltIn: true, Locked: true},
	{Name: "general", Kind: KindAgent, Mode: "subagent", BuiltIn: true},
	{Name: "explore", Kind: KindAgent, Mode: "subagent", BuiltIn: true},
}

// System agents that should not be shown.
var systemAgents = map[string]bool{
	"compaction": true,
	"title":      true,
	"summary":    true,
}

// ConfigDir returns the OpenCode global config directory.
func ConfigDir() string {
	if dir := os.Getenv("OPENCODE_CONFIG_DIR"); dir != "" {
		return dir
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".config", "opencode")
}

// ConfigPath returns the path to opencode.json.
func ConfigPath() string {
	return filepath.Join(ConfigDir(), "opencode.json")
}

// Load reads the global config and resolves all targets and models.
//
// Model discovery uses a CLI-first strategy:
//  1. Call FetchModels() to get the live model list from `opencode models`
//  2. If the CLI call succeeds and returns at least one model, use that list
//  3. Otherwise fall back to parsing provider.*.models from opencode.json
//
// This ensures the picker always reflects OpenCode's runtime model registry,
// not just what happens to be listed in the config file.
func Load() (*State, error) {
	configDir := ConfigDir()
	if configDir == "" {
		return nil, fmt.Errorf("could not determine config directory")
	}

	raw, err := os.ReadFile(ConfigPath())
	if err != nil {
		return nil, fmt.Errorf("reading opencode.json: %w", err)
	}

	state := &State{}

	// 1. Discover models: CLI-first with config fallback
	state.Models = discoverModelsWithFallback(raw)

	// 2. Discover agents: built-in + config + markdown
	state.Targets = discoverTargets(configDir, raw)

	return state, nil
}

// discoverModelsWithFallback attempts CLI-first model discovery and falls back
// to config-based parsing when the CLI is unavailable or returns no models.
func discoverModelsWithFallback(raw []byte) []Model {
	models, err := FetchModels()
	if err == nil && len(models) > 0 {
		return models
	}
	// CLI unavailable or returned no parseable models — fall back to config.
	if err != nil {
		log.Printf("omp: CLI model discovery failed, falling back to config: %v", err)
	} else {
		log.Printf("omp: CLI returned no models, falling back to config parsing")
	}
	return discoverModels(raw)
}

// discoverModels extracts all models from provider.*.models in the config.
func discoverModels(raw []byte) []Model {
	var models []Model

	providers := gjson.GetBytes(raw, "provider")
	if !providers.Exists() {
		return models
	}

	providers.ForEach(func(providerID, providerVal gjson.Result) bool {
		providerVal.Get("models").ForEach(func(modelID, modelVal gjson.Result) bool {
			name := modelVal.Get("name").String()
			if name == "" {
				name = modelID.String()
			}
			models = append(models, Model{
				Provider: providerID.String(),
				ID:       providerID.String() + "/" + modelID.String(),
				Name:     name,
			})
			return true
		})
		return true
	})

	sort.Slice(models, func(i, j int) bool {
		return models[i].ID < models[j].ID
	})

	return models
}

// discoverTargets finds all agents from config + markdown files.
func discoverTargets(configDir string, raw []byte) []Target {
	seen := make(map[string]bool)
	var targets []Target
	projectDir := discoverProjectOpencodeDir()

	// Built-in agents
	for _, a := range builtinAgents {
		a.Model = gjson.GetBytes(raw, "agent."+a.Name+".model").String()
		a.FallbackModels = readFallbackChain(raw, a.Name)
		targets = append(targets, a)
		seen[a.Name] = true
	}

	// Markdown agents: global + project (before JSON so markdown mode wins)
	globalAgentsDir := filepath.Join(configDir, "agents")
	targets = append(targets, discoverMarkdownAgents(globalAgentsDir, raw, seen, true)...)
	if projectDir != "" {
		targets = append(targets, discoverMarkdownAgents(filepath.Join(projectDir, "agents"), raw, seen, false)...)
	}

	// JSON-configured agents (after markdown; mode here only applies to JSON-only agents)
	gjson.GetBytes(raw, "agent").ForEach(func(name, val gjson.Result) bool {
		n := name.String()
		if seen[n] || systemAgents[n] {
			return true
		}
		mode := val.Get("mode").String()
		if mode == "" {
			mode = "all"
		}
		hidden := val.Get("hidden").Bool()
		targets = append(targets, Target{
			Name:           n,
			Kind:           KindAgent,
			Mode:           mode,
			Model:          val.Get("model").String(),
			Description:    val.Get("description").String(),
			Hidden:         hidden,
			FallbackModels: readFallbackChain(raw, n),
		})
		seen[n] = true
		return true
	})

	return targets
}

// readFallbackChain extracts agent.<name>.options.fallback_models from the
// raw config as a []string. Returns nil when the path is absent or the value
// is not an array. The path constant lives in fallback.go.
func readFallbackChain(raw []byte, agentName string) []string {
	res := gjson.GetBytes(raw, "agent."+agentName+"."+FallbackJSONPath)
	if !res.Exists() || !res.IsArray() {
		return nil
	}
	arr := res.Array()
	if len(arr) == 0 {
		return nil
	}
	out := make([]string, 0, len(arr))
	for _, r := range arr {
		out = append(out, r.String())
	}
	return out
}

func discoverProjectOpencodeDir() string {
	if project := os.Getenv("OPENCODE_PROJECT_DIR"); project != "" {
		return filepath.Join(project, ".opencode")
	}

	wd, err := os.Getwd()
	if err != nil {
		return ""
	}

	current := wd
	for {
		candidate := filepath.Join(current, ".opencode")
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			return candidate
		}

		parent := filepath.Dir(current)
		if parent == current {
			return ""
		}
		current = parent
	}
}

// discoverMarkdownAgents scans a directory for *.md agent definitions.
func discoverMarkdownAgents(dir string, raw []byte, seen map[string]bool, allowProviderVariants bool) []Target {
	var targets []Target

	entries, err := os.ReadDir(dir)
	if err != nil {
		return targets
	}

	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		name := strings.TrimSuffix(e.Name(), ".md")
		if seen[name] || systemAgents[name] {
			continue
		}
		if !allowProviderVariants && validAdvProviders[name] {
			continue
		}

		agentPath := filepath.Join(dir, e.Name())
		mode := parseFrontmatterField(agentPath, "mode")
		if mode == "" {
			mode = "all"
		}

		hidden := parseFrontmatterField(agentPath, "hidden") == "true"

		// Check if there's a model override in the JSON config
		model := gjson.GetBytes(raw, "agent."+name+".model").String()

		// Also check frontmatter for model
		if model == "" {
			model = parseFrontmatterField(agentPath, "model")
		}

		description := parseFrontmatterField(agentPath, "description")

		// Fallback chain: JSON wins over frontmatter (matches existing
		// model-override precedence on the line above).
		fallback := readFallbackChain(raw, name)
		if len(fallback) == 0 {
			fallback = parseFrontmatterList(agentPath, "fallback_models")
		}

		targets = append(targets, Target{
			Name:           name,
			Kind:           KindAgent,
			Mode:           mode,
			Model:          model,
			Description:    description,
			Hidden:         hidden,
			FallbackModels: fallback,
		})
		seen[name] = true
	}

	return targets
}

// parseFrontmatterList parses a single inline-array YAML frontmatter field of
// the form `field: ["a", "b", "c"]`. Multi-line list form (`- a\n- b`) is not
// supported in v1 — the existing frontmatter parser is intentionally minimal
// and inline-array covers the only case we currently write/read. Returns
// nil when the field is missing or malformed.
func parseFrontmatterList(path, field string) []string {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	content := string(data)
	if !strings.HasPrefix(content, "---") {
		return nil
	}
	end := strings.Index(content[3:], "---")
	if end < 0 {
		return nil
	}
	frontmatter := content[3 : 3+end]
	for _, line := range strings.Split(frontmatter, "\n") {
		line = strings.TrimSpace(line)
		prefix := field + ":"
		if !strings.HasPrefix(line, prefix) {
			continue
		}
		val := strings.TrimSpace(strings.TrimPrefix(line, prefix))
		// Expect bracketed inline array.
		if !strings.HasPrefix(val, "[") || !strings.HasSuffix(val, "]") {
			return nil
		}
		inner := strings.TrimSuffix(strings.TrimPrefix(val, "["), "]")
		var out []string
		for _, raw := range strings.Split(inner, ",") {
			s := strings.TrimSpace(raw)
			// Strip surrounding quotes (single or double).
			s = strings.Trim(s, `"'`)
			if s != "" {
				out = append(out, s)
			}
		}
		return out
	}
	return nil
}

// parseFrontmatterField does a minimal parse of YAML frontmatter for a single field.
func parseFrontmatterField(path, field string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}

	content := string(data)
	if !strings.HasPrefix(content, "---") {
		return ""
	}

	end := strings.Index(content[3:], "---")
	if end < 0 {
		return ""
	}

	frontmatter := content[3 : 3+end]
	for _, line := range strings.Split(frontmatter, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, field+":") {
			val := strings.TrimPrefix(line, field+":")
			return strings.TrimSpace(val)
		}
	}
	return ""
}

// SetAgentOrder rewrites the agent section of opencode.json so that keys appear
// in the given order. This controls the Tab-cycle order for custom primary agents
// in OpenCode, since it uses JS object insertion order.
//
// Built-in agents (build, plan) are always first in OpenCode's cycle regardless
// of JSON order, so only custom/non-locked agents benefit from reordering.
//
// names must contain all agent names currently in the config agent section.
// Any names not present in the current config are ignored.
func SetAgentOrder(names []string) error {
	configPath := ConfigPath()

	raw, err := os.ReadFile(configPath)
	if err != nil {
		return fmt.Errorf("reading config: %w", err)
	}

	// Collect existing agent entries in a map: name -> raw JSON value
	agentEntries := make(map[string]string)
	gjson.GetBytes(raw, "agent").ForEach(func(key, val gjson.Result) bool {
		agentEntries[key.String()] = val.Raw
		return true
	})

	if len(agentEntries) == 0 {
		// Nothing to reorder
		return nil
	}

	// Delete the entire agent section, then rebuild in order
	updated, err := sjson.DeleteBytes(raw, "agent")
	if err != nil {
		return fmt.Errorf("deleting agent section: %w", err)
	}

	// Re-insert entries in the requested order (skip any names not in config)
	for _, name := range names {
		raw, ok := agentEntries[name]
		if !ok {
			continue
		}
		var val interface{}
		if err := json.Unmarshal([]byte(raw), &val); err != nil {
			return fmt.Errorf("parsing agent %q: %w", name, err)
		}
		updated, err = sjson.SetBytes(updated, "agent."+name, val)
		if err != nil {
			return fmt.Errorf("writing agent %q: %w", name, err)
		}
		delete(agentEntries, name)
	}

	// Append any remaining agents not in the names list (preserve them at end)
	for name, raw := range agentEntries {
		var val interface{}
		if err := json.Unmarshal([]byte(raw), &val); err != nil {
			return fmt.Errorf("parsing agent %q: %w", name, err)
		}
		updated, err = sjson.SetBytes(updated, "agent."+name, val)
		if err != nil {
			return fmt.Errorf("writing remaining agent %q: %w", name, err)
		}
	}

	if !json.Valid(updated) {
		return fmt.Errorf("resulting config is invalid JSON")
	}

	return os.WriteFile(configPath, updated, 0644)
}
