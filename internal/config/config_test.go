package config

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/tidwall/gjson"
)

func mustWriteFile(t *testing.T, path string, data []byte, perm os.FileMode) {
	t.Helper()
	if err := os.WriteFile(path, data, perm); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func mustMkdirAll(t *testing.T, path string, perm os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(path, perm); err != nil {
		t.Fatalf("mkdir %s: %v", path, err)
	}
}

func mustChdir(t *testing.T, dir string) {
	t.Helper()
	if err := os.Chdir(dir); err != nil {
		t.Fatalf("chdir %s: %v", dir, err)
	}
}

func TestConfigPath_PrefersOpencodeJSONWhenPresent(t *testing.T) {
	dir := t.TempDir()
	mustWriteFile(t, filepath.Join(dir, "opencode.json"), []byte(`{}`), 0644)
	mustWriteFile(t, filepath.Join(dir, "opencode.jsonc"), []byte(`{}`), 0644)
	t.Setenv("OPENCODE_CONFIG_DIR", dir)

	if got, want := ConfigPath(), filepath.Join(dir, "opencode.json"); got != want {
		t.Fatalf("ConfigPath() = %q, want %q", got, want)
	}
}

func TestConfigPath_UsesOpencodeJSONCWhenJSONMissing(t *testing.T) {
	dir := t.TempDir()
	mustWriteFile(t, filepath.Join(dir, "opencode.jsonc"), []byte(`{}`), 0644)
	t.Setenv("OPENCODE_CONFIG_DIR", dir)

	if got, want := ConfigPath(), filepath.Join(dir, "opencode.jsonc"); got != want {
		t.Fatalf("ConfigPath() = %q, want %q", got, want)
	}
}

func TestConfigPath_DefaultsToJSONForFirstWrite(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENCODE_CONFIG_DIR", dir)

	if got, want := ConfigPath(), filepath.Join(dir, "opencode.json"); got != want {
		t.Fatalf("ConfigPath() = %q, want %q", got, want)
	}
}

// -- CLI-first model source tests --------------------------------------------
// These tests verify that Load uses CLI-discovered models as primary source
// and falls back to provider.*.models config parsing when CLI fails.

func TestLoad_UsesCLIModelsAsPrimarySource(t *testing.T) {
	dir := t.TempDir()
	// Config has one model in provider.*.models
	configJSON := `{
		"provider": {
			"anthropic": {
				"models": {
					"claude-config-only": {"name": "Config Only Model"}
				}
			}
		}
	}`
	mustWriteFile(t, filepath.Join(dir, "opencode.json"), []byte(configJSON), 0644)
	t.Setenv("OPENCODE_CONFIG_DIR", dir)

	// CLI returns a different (larger) set of models
	withCommandRunner(t, func(ctx context.Context, name string, args ...string) ([]byte, error) {
		if name == "opencode" && len(args) == 1 && args[0] == "models" {
			return []byte("anthropic/claude-cli-model-1\nanthropic/claude-cli-model-2\ngoogle/gemini-cli\n"), nil
		}
		return nil, nil // refresh call succeeds silently
	})

	state, err := Load()
	if err != nil {
		t.Fatalf("Load() error: %v", err)
	}

	// Should have CLI models, not config-only model
	ids := make(map[string]bool)
	for _, m := range state.Models {
		ids[m.ID] = true
	}

	if ids["anthropic/claude-config-only"] {
		t.Error("config-only model should not appear when CLI returns models")
	}
	if !ids["anthropic/claude-cli-model-1"] {
		t.Error("CLI model anthropic/claude-cli-model-1 should be present")
	}
	if !ids["anthropic/claude-cli-model-2"] {
		t.Error("CLI model anthropic/claude-cli-model-2 should be present")
	}
	if !ids["google/gemini-cli"] {
		t.Error("CLI model google/gemini-cli should be present")
	}
}

func TestLoad_FallsBackToConfigWhenCLIFails(t *testing.T) {
	dir := t.TempDir()
	configJSON := `{
		"provider": {
			"anthropic": {
				"models": {
					"claude-config-fallback": {"name": "Config Fallback Model"}
				}
			}
		}
	}`
	mustWriteFile(t, filepath.Join(dir, "opencode.json"), []byte(configJSON), 0644)
	t.Setenv("OPENCODE_CONFIG_DIR", dir)

	// CLI fetch fails (non-zero exit)
	withCommandRunner(t, func(ctx context.Context, name string, args ...string) ([]byte, error) {
		if name == "opencode" && len(args) == 1 && args[0] == "models" {
			return []byte("error: provider unavailable"), &execExitError{}
		}
		return nil, nil // refresh call succeeds
	})

	state, err := Load()
	if err != nil {
		t.Fatalf("Load() should not error on CLI fetch failure (fallback), got: %v", err)
	}

	ids := make(map[string]bool)
	for _, m := range state.Models {
		ids[m.ID] = true
	}

	if !ids["anthropic/claude-config-fallback"] {
		t.Error("config fallback model should be present when CLI fails")
	}
}

func TestLoad_ReadsOpencodeJSONCWhenJSONMissing(t *testing.T) {
	dir := t.TempDir()
	configJSONC := `{
		"provider": {
			"anthropic": {
				"models": {
					"claude-jsonc-fallback": {"name": "Config JSONC Model"}
				}
			}
		}
	}`
	mustWriteFile(t, filepath.Join(dir, "opencode.jsonc"), []byte(configJSONC), 0644)
	t.Setenv("OPENCODE_CONFIG_DIR", dir)

	withCommandRunner(t, func(ctx context.Context, name string, args ...string) ([]byte, error) {
		if name == "opencode" && len(args) == 1 && args[0] == "models" {
			return []byte("error: provider unavailable"), &execExitError{}
		}
		return nil, nil
	})

	state, err := Load()
	if err != nil {
		t.Fatalf("Load() should read opencode.jsonc when opencode.json is absent, got: %v", err)
	}

	ids := make(map[string]bool)
	for _, m := range state.Models {
		ids[m.ID] = true
	}
	if !ids["anthropic/claude-jsonc-fallback"] {
		t.Error("jsonc config fallback model should be present when CLI fails")
	}
}

func TestLoad_FallsBackToConfigWhenCLIReturnsEmpty(t *testing.T) {
	dir := t.TempDir()
	configJSON := `{
		"provider": {
			"anthropic": {
				"models": {
					"claude-config-only": {"name": "Config Only"}
				}
			}
		}
	}`
	mustWriteFile(t, filepath.Join(dir, "opencode.json"), []byte(configJSON), 0644)
	t.Setenv("OPENCODE_CONFIG_DIR", dir)

	// CLI returns empty output (no parseable models)
	withCommandRunner(t, func(ctx context.Context, name string, args ...string) ([]byte, error) {
		if name == "opencode" && len(args) == 1 && args[0] == "models" {
			return []byte(""), nil
		}
		return nil, nil
	})

	state, err := Load()
	if err != nil {
		t.Fatalf("Load() should not error on empty CLI output (fallback), got: %v", err)
	}

	ids := make(map[string]bool)
	for _, m := range state.Models {
		ids[m.ID] = true
	}

	if !ids["anthropic/claude-config-only"] {
		t.Error("config model should be present when CLI returns empty output")
	}
}

func TestLoad_CLIModelsAreSortedDeterministically(t *testing.T) {
	dir := t.TempDir()
	mustWriteFile(t, filepath.Join(dir, "opencode.json"), []byte(`{}`), 0644)
	t.Setenv("OPENCODE_CONFIG_DIR", dir)

	withCommandRunner(t, func(ctx context.Context, name string, args ...string) ([]byte, error) {
		if name == "opencode" && len(args) == 1 && args[0] == "models" {
			// Return in reverse order
			return []byte("openai/gpt-5\ngoogle/gemini-2.5-pro\nanthropic/claude-sonnet-4-6\n"), nil
		}
		return nil, nil
	})

	state, err := Load()
	if err != nil {
		t.Fatalf("Load() error: %v", err)
	}

	if len(state.Models) != 3 {
		t.Fatalf("expected 3 models, got %d", len(state.Models))
	}
	if state.Models[0].ID != "anthropic/claude-sonnet-4-6" {
		t.Errorf("models[0].ID = %q, want anthropic/claude-sonnet-4-6 (sorted)", state.Models[0].ID)
	}
}

// execExitError is a minimal os/exec.ExitError stand-in for tests.
type execExitError struct{}

func (e *execExitError) Error() string { return "exit status 1" }

func TestDiscoverModels(t *testing.T) {
	raw := []byte(`{
		"provider": {
			"anthropic": {
				"models": {
					"claude-sonnet-4-20250514": {
						"name": "Claude Sonnet 4"
					}
				}
			},
			"google": {
				"models": {
					"gemini-2.5-flash": {
						"name": "Gemini 2.5 Flash"
					},
					"gemini-2.5-pro": {}
				}
			}
		}
	}`)

	models := discoverModels(raw)
	if len(models) != 3 {
		t.Fatalf("expected 3 models, got %d", len(models))
	}

	// Should be sorted by ID
	if models[0].ID != "anthropic/claude-sonnet-4-20250514" {
		t.Errorf("unexpected first model: %s", models[0].ID)
	}
	if models[0].Name != "Claude Sonnet 4" {
		t.Errorf("unexpected name: %s", models[0].Name)
	}

	// Model without name should fall back to ID
	found := false
	for _, m := range models {
		if m.ID == "google/gemini-2.5-pro" && m.Name == "gemini-2.5-pro" {
			found = true
		}
	}
	if !found {
		t.Error("expected gemini-2.5-pro to have name fallback")
	}
}

func TestDiscoverTargets_BuiltIn(t *testing.T) {
	raw := []byte(`{}`)
	targets := discoverTargets("/nonexistent", raw)

	// Should have 4 built-in agents
	if len(targets) != 4 {
		t.Fatalf("expected 4 built-in targets, got %d", len(targets))
	}

	names := make(map[string]bool)
	for _, tgt := range targets {
		names[tgt.Name] = true
	}

	for _, expected := range []string{"build", "plan", "general", "explore"} {
		if !names[expected] {
			t.Errorf("missing built-in agent: %s", expected)
		}
	}
}

func TestDiscoverTargets_WithConfiguredAgent(t *testing.T) {
	raw := []byte(`{
		"agent": {
			"build": {
				"model": "anthropic/claude-sonnet-4-20250514"
			},
			"reviewer": {
				"mode": "subagent",
				"model": "google/gemini-2.5-flash"
			}
		}
	}`)

	targets := discoverTargets("/nonexistent", raw)

	// Should have 4 built-in + 1 custom = 5
	if len(targets) != 5 {
		t.Fatalf("expected 5 targets, got %d", len(targets))
	}

	// Check build has model set
	for _, tgt := range targets {
		if tgt.Name == "build" {
			if tgt.Model != "anthropic/claude-sonnet-4-20250514" {
				t.Errorf("build model = %q, want anthropic/claude-sonnet-4-20250514", tgt.Model)
			}
		}
		if tgt.Name == "reviewer" {
			if tgt.Mode != "subagent" {
				t.Errorf("reviewer mode = %q, want subagent", tgt.Mode)
			}
		}
	}
}

func TestTargetIsSubagent(t *testing.T) {
	tests := []struct {
		name   string
		target Target
		want   bool
	}{
		{name: "primary agent", target: Target{Kind: KindAgent, Mode: "primary"}, want: false},
		{name: "mode subagent", target: Target{Kind: KindAgent, Mode: "subagent"}, want: true},
		{name: "hidden subagent", target: Target{Kind: KindAgent, Hidden: true}, want: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.target.IsSubagent(); got != tt.want {
				t.Fatalf("IsSubagent() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestTargetIsModelMappable(t *testing.T) {
	tests := []struct {
		name   string
		target Target
		want   bool
	}{
		{name: "build unmapped", target: Target{Name: "build", Kind: KindAgent, Mode: "primary"}, want: false},
		{name: "plan unmapped", target: Target{Name: "plan", Kind: KindAgent, Mode: "primary"}, want: false},
		{name: "adv unmapped", target: Target{Name: "adv", Kind: KindAgent, Mode: "primary"}, want: false},
		{name: "custom primary mapped", target: Target{Name: "scout", Kind: KindAgent, Mode: "primary"}, want: true},
		{name: "subagent mapped", target: Target{Name: "general", Kind: KindAgent, Mode: "subagent"}, want: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.target.IsModelMappable(); got != tt.want {
				t.Fatalf("IsModelMappable() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestDiscoverTargets_SystemAgentsExcluded(t *testing.T) {
	raw := []byte(`{
		"agent": {
			"compaction": { "model": "something" },
			"title": { "model": "something" },
			"summary": { "model": "something" }
		}
	}`)

	targets := discoverTargets("/nonexistent", raw)

	for _, tgt := range targets {
		if systemAgents[tgt.Name] {
			t.Errorf("system agent %q should be excluded", tgt.Name)
		}
	}
}

func TestDiscoverTargets_IgnoresConfiguredCommands(t *testing.T) {
	raw := []byte(`{
		"command": {
			"deploy": {"model": "anthropic/claude-opus-4"}
		}
	}`)

	targets := discoverTargets("/nonexistent", raw)

	for _, tgt := range targets {
		if tgt.Name == "deploy" {
			t.Fatal("deploy command should not be discovered as a target")
		}
	}
}

func TestDiscoverMarkdownAgents(t *testing.T) {
	dir := t.TempDir()
	agentDir := filepath.Join(dir, "agents")
	mustMkdirAll(t, agentDir, 0755)

	content := `---
description: Security auditor
mode: subagent
model: anthropic/claude-sonnet-4-20250514
---

You are a security auditor.
`
	mustWriteFile(t, filepath.Join(agentDir, "security.md"), []byte(content), 0644)

	raw := []byte(`{}`)
	seen := make(map[string]bool)
	targets := discoverMarkdownAgents(agentDir, raw, seen, true)

	if len(targets) != 1 {
		t.Fatalf("expected 1 agent, got %d", len(targets))
	}
	if targets[0].Name != "security" {
		t.Errorf("name = %q, want security", targets[0].Name)
	}
	if targets[0].Mode != "subagent" {
		t.Errorf("mode = %q, want subagent", targets[0].Mode)
	}
	if targets[0].Model != "anthropic/claude-sonnet-4-20250514" {
		t.Errorf("model = %q, want anthropic/claude-sonnet-4-20250514", targets[0].Model)
	}
}

func TestDiscoverTargets_FindsProjectMarkdownAgentsFromNestedDir(t *testing.T) {
	root := t.TempDir()
	agentDir := filepath.Join(root, ".opencode", "agents")
	if err := os.MkdirAll(agentDir, 0755); err != nil {
		t.Fatalf("mkdir agent dir: %v", err)
	}

	content := `---
description: Docs researcher
mode: subagent
---

You research docs.
`
	if err := os.WriteFile(filepath.Join(agentDir, "librarian.md"), []byte(content), 0644); err != nil {
		t.Fatalf("write librarian.md: %v", err)
	}

	nested := filepath.Join(root, "nested", "workspace")
	if err := os.MkdirAll(nested, 0755); err != nil {
		t.Fatalf("mkdir nested dir: %v", err)
	}

	oldWD, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	defer func() {
		if err := os.Chdir(oldWD); err != nil {
			t.Fatalf("chdir back: %v", err)
		}
	}()
	if err := os.Chdir(nested); err != nil {
		t.Fatalf("chdir nested: %v", err)
	}

	targets := discoverTargets("/nonexistent", []byte(`{}`))

	var librarian *Target
	for i := range targets {
		if targets[i].Name == "librarian" {
			librarian = &targets[i]
			break
		}
	}
	if librarian == nil {
		t.Fatal("librarian not found; expected project .opencode agent to be discovered")
	}
	if librarian.Mode != "subagent" {
		t.Errorf("mode = %q, want subagent", librarian.Mode)
	}
}

func TestDiscoverTargets_UsesOPENCODEPROJECTDIRForMarkdownAgents(t *testing.T) {
	root := t.TempDir()
	agentDir := filepath.Join(root, ".opencode", "agents")
	if err := os.MkdirAll(agentDir, 0755); err != nil {
		t.Fatalf("mkdir agent dir: %v", err)
	}

	content := "---\nmode: subagent\n---\n"
	if err := os.WriteFile(filepath.Join(agentDir, "reviewer.md"), []byte(content), 0644); err != nil {
		t.Fatalf("write reviewer.md: %v", err)
	}

	t.Setenv("OPENCODE_PROJECT_DIR", root)
	targets := discoverTargets("/nonexistent", []byte(`{}`))

	found := false
	for _, t := range targets {
		if t.Name == "reviewer" && t.Mode == "subagent" {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("expected reviewer subagent from OPENCODE_PROJECT_DIR/.opencode/agents")
	}
}

// TestMarkdownModeWinsOverJSONDefault verifies that when an agent has a markdown
// definition with an explicit mode and a JSON entry with no mode, the markdown
// mode is used (not the JSON default of "all"). This is the librarian scenario.
func TestMarkdownModeWinsOverJSONDefault(t *testing.T) {
	dir := t.TempDir()
	agentDir := filepath.Join(dir, "agents")
	mustMkdirAll(t, agentDir, 0755)

	// markdown defines mode: subagent
	content := "---\ndescription: Docs researcher\nmode: subagent\n---\nYou research docs.\n"
	mustWriteFile(t, filepath.Join(agentDir, "librarian.md"), []byte(content), 0644)

	// JSON entry has a model override but no mode (would default to "all")
	raw := []byte(`{
		"agent": {
			"librarian": {"model": "openrouter/anthropic/claude-haiku-4.5:nitro"}
		}
	}`)

	targets := discoverTargets(dir, raw)

	var librarian *Target
	for i := range targets {
		if targets[i].Name == "librarian" {
			librarian = &targets[i]
			break
		}
	}
	if librarian == nil {
		t.Fatal("librarian not found in targets")
	}
	if librarian.Mode != "subagent" {
		t.Errorf("mode = %q, want subagent (markdown should win over JSON default)", librarian.Mode)
	}
	if librarian.Model != "openrouter/anthropic/claude-haiku-4.5:nitro" {
		t.Errorf("model = %q, want JSON model override to be preserved", librarian.Model)
	}
}

// TestJSONOnlyAgentDefaultsToAll verifies that a JSON-only agent with no mode
// still defaults to "all" (no regression).
func TestJSONOnlyAgentDefaultsToAll(t *testing.T) {
	raw := []byte(`{
		"agent": {
			"scout": {"model": "openai/gpt-5"}
		}
	}`)

	targets := discoverTargets("/nonexistent", raw)

	var scout *Target
	for i := range targets {
		if targets[i].Name == "scout" {
			scout = &targets[i]
			break
		}
	}
	if scout == nil {
		t.Fatal("scout not found in targets")
	}
	if scout.Mode != "all" {
		t.Errorf("mode = %q, want all for JSON-only agent with no mode", scout.Mode)
	}
}

func TestParseFrontmatterField(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.md")

	content := `---
description: My agent
mode: primary
model: google/gemini-2.5-flash
---

Content here
`
	mustWriteFile(t, path, []byte(content), 0644)

	if got := parseFrontmatterField(path, "mode"); got != "primary" {
		t.Errorf("mode = %q, want primary", got)
	}
	if got := parseFrontmatterField(path, "model"); got != "google/gemini-2.5-flash" {
		t.Errorf("model = %q, want google/gemini-2.5-flash", got)
	}
	if got := parseFrontmatterField(path, "nonexistent"); got != "" {
		t.Errorf("nonexistent = %q, want empty", got)
	}
}

func TestSetAgentOrder_ReordersKeys(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "opencode.json")
	initial := `{
  "agent": {
    "build": {"model": "anthropic/claude-sonnet-4"},
    "plan": {},
    "scout": {"mode": "primary"},
    "refine": {"mode": "primary"}
  }
}`
	mustWriteFile(t, configPath, []byte(initial), 0644)
	t.Setenv("OPENCODE_CONFIG_DIR", dir)

	// Reorder: refine before scout
	err := SetAgentOrder([]string{"refine", "scout"})
	if err != nil {
		t.Fatalf("SetAgentOrder: %v", err)
	}

	data, _ := os.ReadFile(configPath)
	raw := string(data)

	// Verify both agents still present and in correct order
	refineIdx := strings.Index(raw, `"refine"`)
	scoutIdx := strings.Index(raw, `"scout"`)
	if refineIdx < 0 || scoutIdx < 0 {
		t.Fatalf("expected both agents in config, got: %s", raw)
	}
	if refineIdx > scoutIdx {
		t.Errorf("expected refine before scout, got order: refine=%d scout=%d\nconfig: %s", refineIdx, scoutIdx, raw)
	}
}

func TestSetAgentOrder_PreservesValues(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "opencode.json")
	initial := `{
  "agent": {
    "scout": {"model": "openai/gpt-5", "mode": "primary"},
    "refine": {"model": "anthropic/claude-opus-4"}
  }
}`
	mustWriteFile(t, configPath, []byte(initial), 0644)
	t.Setenv("OPENCODE_CONFIG_DIR", dir)

	err := SetAgentOrder([]string{"refine", "scout"})
	if err != nil {
		t.Fatalf("SetAgentOrder: %v", err)
	}

	data, _ := os.ReadFile(configPath)
	raw := string(data)

	if !strings.Contains(raw, `"openai/gpt-5"`) {
		t.Errorf("scout model value should be preserved, got: %s", raw)
	}
	if !strings.Contains(raw, `"anthropic/claude-opus-4"`) {
		t.Errorf("refine model value should be preserved, got: %s", raw)
	}
}

func TestSetAgentOrder_WritesConfigOwnerOnly(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "opencode.json")
	initial := `{
  "agent": {
    "scout": {"model": "openai/gpt-5", "mode": "primary"},
    "refine": {"model": "anthropic/claude-opus-4"}
  }
}`
	mustWriteFile(t, configPath, []byte(initial), 0644)
	t.Setenv("OPENCODE_CONFIG_DIR", dir)

	if err := SetAgentOrder([]string{"refine", "scout"}); err != nil {
		t.Fatalf("SetAgentOrder: %v", err)
	}

	info, err := os.Stat(configPath)
	if err != nil {
		t.Fatalf("stat opencode.json: %v", err)
	}
	if got := info.Mode().Perm(); got != 0600 {
		t.Fatalf("mode = %o, want 0600", got)
	}
}

func TestSetAgentOrder_SkipsUnknownNames(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "opencode.json")
	initial := `{
  "agent": {
    "scout": {},
    "refine": {}
  }
}`
	mustWriteFile(t, configPath, []byte(initial), 0644)
	t.Setenv("OPENCODE_CONFIG_DIR", dir)

	// includes a nonexistent name — should not error and should preserve both real agents
	err := SetAgentOrder([]string{"refine", "nonexistent", "scout"})
	if err != nil {
		t.Fatalf("SetAgentOrder with unknown name: %v", err)
	}

	data, _ := os.ReadFile(configPath)
	raw := string(data)

	if !strings.Contains(raw, `"scout"`) || !strings.Contains(raw, `"refine"`) {
		t.Errorf("both real agents should be present, got: %s", raw)
	}
	if strings.Contains(raw, `"nonexistent"`) {
		t.Errorf("nonexistent agent should not be added, got: %s", raw)
	}
}

func TestSetAgentOrder_NoOpWithEmptyAgentSection(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "opencode.json")
	initial := `{"theme": "dark"}`
	mustWriteFile(t, configPath, []byte(initial), 0644)
	t.Setenv("OPENCODE_CONFIG_DIR", dir)

	err := SetAgentOrder([]string{"build", "plan"})
	if err != nil {
		t.Fatalf("SetAgentOrder with no agent section: %v", err)
	}

	data, _ := os.ReadFile(configPath)
	raw := string(data)
	// Config should be unchanged
	if raw != initial {
		t.Errorf("config should be unchanged when no agent section, got: %s", raw)
	}
}

func TestDiscoverMarkdownAgents_HiddenField(t *testing.T) {
	dir := t.TempDir()

	// hidden: true agent
	hiddenContent := `---
description: Internal researcher
mode: subagent
hidden: true
---

You are hidden.
`
	mustWriteFile(t, filepath.Join(dir, "adv-researcher.md"), []byte(hiddenContent), 0644)

	// hidden: false agent (explicit)
	visibleContent := `---
description: Librarian
mode: subagent
hidden: false
---

You are visible.
`
	mustWriteFile(t, filepath.Join(dir, "librarian.md"), []byte(visibleContent), 0644)

	// no hidden field (defaults to false)
	defaultContent := `---
description: Explorer
mode: subagent
---

You explore.
`
	mustWriteFile(t, filepath.Join(dir, "explore-custom.md"), []byte(defaultContent), 0644)

	raw := []byte(`{}`)
	seen := make(map[string]bool)
	targets := discoverMarkdownAgents(dir, raw, seen, true)

	if len(targets) != 3 {
		t.Fatalf("expected 3 agents, got %d", len(targets))
	}

	byName := make(map[string]Target)
	for _, tgt := range targets {
		byName[tgt.Name] = tgt
	}

	if !byName["adv-researcher"].Hidden {
		t.Error("adv-researcher should have Hidden=true")
	}
	if byName["librarian"].Hidden {
		t.Error("librarian should have Hidden=false (explicit)")
	}
	if byName["explore-custom"].Hidden {
		t.Error("explore-custom should have Hidden=false (default)")
	}
}

func TestDiscoverTargets_DescriptionFromJSON(t *testing.T) {
	raw := []byte(`{
		"agent": {
			"adv-reviewer": {
				"mode": "subagent",
				"hidden": true,
				"description": "Lead review synthesizer"
			}
		}
	}`)

	targets := discoverTargets("/nonexistent", raw)

	var reviewer *Target
	for i := range targets {
		if targets[i].Name == "adv-reviewer" {
			reviewer = &targets[i]
			break
		}
	}
	if reviewer == nil {
		t.Fatal("adv-reviewer not found in targets")
	}
	if reviewer.Description != "Lead review synthesizer" {
		t.Errorf("description = %q, want %q", reviewer.Description, "Lead review synthesizer")
	}
	if !reviewer.Hidden {
		t.Error("adv-reviewer should have Hidden=true")
	}
}

func TestDiscoverMarkdownAgents_DescriptionFromFrontmatter(t *testing.T) {
	dir := t.TempDir()

	content := `---
description: Security auditor for OWASP checks
mode: subagent
hidden: true
---

You are a security auditor.
`
	mustWriteFile(t, filepath.Join(dir, "adv-security-reviewer.md"), []byte(content), 0644)

	raw := []byte(`{}`)
	seen := make(map[string]bool)
	targets := discoverMarkdownAgents(dir, raw, seen, true)

	if len(targets) != 1 {
		t.Fatalf("expected 1 agent, got %d", len(targets))
	}
	if targets[0].Description != "Security auditor for OWASP checks" {
		t.Errorf("description = %q, want %q", targets[0].Description, "Security auditor for OWASP checks")
	}
}

// -- PreferencesConfig tests -------------------------------------------------

func TestPreferencesPath_RespectsOPENCODE_CONFIG_DIR(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENCODE_CONFIG_DIR", dir)
	got := PreferencesPath()
	want := filepath.Join(dir, "omp-preferences.json")
	if got != want {
		t.Errorf("PreferencesPath() = %q, want %q", got, want)
	}
}

func TestLoadPreferences_FileNotExist(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENCODE_CONFIG_DIR", dir)
	pc, err := LoadPreferences()
	if err != nil {
		t.Fatalf("LoadPreferences() error on missing file: %v", err)
	}
	if len(pc.TargetModels) != 0 {
		t.Errorf("expected empty TargetModels, got %d", len(pc.TargetModels))
	}
}

func TestLoadPreferences_ExistingFile(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENCODE_CONFIG_DIR", dir)
	content := `{
		"target_models": {
			"scout": "anthropic/claude-opus-4",
			"general": "openai/gpt-5"
		}
	}`
	mustWriteFile(t, filepath.Join(dir, "omp-preferences.json"), []byte(content), 0644)

	pc, err := LoadPreferences()
	if err != nil {
		t.Fatalf("LoadPreferences() error: %v", err)
	}
	if pc.TargetModels["scout"] != "anthropic/claude-opus-4" {
		t.Errorf("TargetModels[scout] = %q, want anthropic/claude-opus-4", pc.TargetModels["scout"])
	}
	if pc.TargetModels["general"] != "openai/gpt-5" {
		t.Errorf("TargetModels[general] = %q, want openai/gpt-5", pc.TargetModels["general"])
	}
}

func TestLoadPreferences_SanitizesAndRewritesUnmappedMainAgents(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENCODE_CONFIG_DIR", dir)
	content := `{
		"target_models": {
			"build": "anthropic/claude-opus-4",
			"plan": "openai/gpt-5",
			"adv": "google/gemini-2.5-pro",
			"general": "anthropic/claude-haiku-4"
		},
		"cleared_models": {
			"build": true,
			"adv": true,
			"general": true
		}
	}`
	path := filepath.Join(dir, "omp-preferences.json")
	mustWriteFile(t, path, []byte(content), 0644)

	pc, err := LoadPreferences()
	if err != nil {
		t.Fatalf("LoadPreferences() error: %v", err)
	}

	for _, name := range []string{"build", "plan", "adv"} {
		if _, ok := pc.TargetModels[name]; ok {
			t.Fatalf("TargetModels[%s] should be removed during load", name)
		}
		if _, ok := pc.ClearedModels[name]; ok {
			t.Fatalf("ClearedModels[%s] should be removed during load", name)
		}
	}
	if pc.TargetModels["general"] != "anthropic/claude-haiku-4" {
		t.Fatalf("TargetModels[general] = %q, want anthropic/claude-haiku-4", pc.TargetModels["general"])
	}
	if !pc.ClearedModels["general"] {
		t.Fatal("ClearedModels[general] should be preserved")
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading rewritten preferences: %v", err)
	}
	json := string(data)
	for _, name := range []string{"build", "plan", "adv"} {
		if gjson.Get(json, "target_models."+name).Exists() {
			t.Fatalf("rewritten target_models.%s should be removed", name)
		}
		if gjson.Get(json, "cleared_models."+name).Exists() {
			t.Fatalf("rewritten cleared_models.%s should be removed", name)
		}
	}
}

func TestLoadPreferences_NilMapInitialized(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENCODE_CONFIG_DIR", dir)
	mustWriteFile(t, filepath.Join(dir, "omp-preferences.json"), []byte(`{}`), 0644)

	pc, err := LoadPreferences()
	if err != nil {
		t.Fatalf("LoadPreferences() error: %v", err)
	}
	if pc.TargetModels == nil {
		t.Error("TargetModels should be initialized (not nil)")
	}
}

func TestLoadPreferences_CorruptJSON(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENCODE_CONFIG_DIR", dir)
	mustWriteFile(t, filepath.Join(dir, "omp-preferences.json"), []byte(`{not valid`), 0644)

	_, err := LoadPreferences()
	if err == nil {
		t.Error("LoadPreferences() should return error for corrupt JSON")
	}
}

func TestSavePreferences_RoundTrip(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENCODE_CONFIG_DIR", dir)

	pc := PreferencesConfig{
		TargetModels: map[string]string{
			"scout":   "anthropic/claude-opus-4",
			"general": "anthropic/claude-haiku-4",
			"refine":  "openai/gpt-5",
		},
	}
	if err := SavePreferences(pc); err != nil {
		t.Fatalf("SavePreferences() error: %v", err)
	}
	loaded, err := LoadPreferences()
	if err != nil {
		t.Fatalf("LoadPreferences() error: %v", err)
	}
	if loaded.TargetModels["scout"] != "anthropic/claude-opus-4" {
		t.Errorf("scout = %q, want anthropic/claude-opus-4", loaded.TargetModels["scout"])
	}
	if loaded.TargetModels["general"] != "anthropic/claude-haiku-4" {
		t.Errorf("general = %q, want anthropic/claude-haiku-4", loaded.TargetModels["general"])
	}
	if loaded.TargetModels["refine"] != "openai/gpt-5" {
		t.Errorf("refine = %q, want openai/gpt-5", loaded.TargetModels["refine"])
	}
}

func TestSavePreferences_StripsUnmappedMainAgents(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENCODE_CONFIG_DIR", dir)

	pc := PreferencesConfig{
		TargetModels: map[string]string{
			"build":   "anthropic/claude-opus-4",
			"plan":    "openai/gpt-5",
			"adv":     "google/gemini-2.5-pro",
			"general": "anthropic/claude-haiku-4",
		},
		ClearedModels: map[string]bool{
			"build":   true,
			"adv":     true,
			"general": true,
		},
	}
	if err := SavePreferences(pc); err != nil {
		t.Fatalf("SavePreferences() error: %v", err)
	}

	loaded, err := LoadPreferences()
	if err != nil {
		t.Fatalf("LoadPreferences() error: %v", err)
	}
	for _, name := range []string{"build", "plan", "adv"} {
		if _, ok := loaded.TargetModels[name]; ok {
			t.Fatalf("TargetModels[%s] should not be saved", name)
		}
		if _, ok := loaded.ClearedModels[name]; ok {
			t.Fatalf("ClearedModels[%s] should not be saved", name)
		}
	}
	if loaded.TargetModels["general"] != "anthropic/claude-haiku-4" {
		t.Fatalf("TargetModels[general] = %q, want anthropic/claude-haiku-4", loaded.TargetModels["general"])
	}
	if !loaded.ClearedModels["general"] {
		t.Fatal("ClearedModels[general] should be preserved")
	}
}

func TestSavePreferences_AtomicWrite(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENCODE_CONFIG_DIR", dir)

	pc := PreferencesConfig{
		TargetModels: map[string]string{"scout": "openai/gpt-5"},
	}
	if err := SavePreferences(pc); err != nil {
		t.Fatalf("SavePreferences() error: %v", err)
	}

	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".omp-") && strings.Contains(e.Name(), ".tmp") {
			t.Errorf("temp file left behind after SavePreferences: %s", e.Name())
		}
	}
}

func TestApplyPreferences_WritesModelToAgents(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENCODE_CONFIG_DIR", dir)

	initial := `{
  "agent": {
	    "scout": {"mode": "primary"},
	    "general": {"mode": "subagent"}
  }
}`
	mustWriteFile(t, filepath.Join(dir, "opencode.json"), []byte(initial), 0644)

	targets := []Target{
		{Name: "scout", Kind: KindAgent},
		{Name: "general", Kind: KindAgent},
	}
	pc := PreferencesConfig{
		TargetModels: map[string]string{
			"scout":   "anthropic/claude-opus-4",
			"general": "anthropic/claude-haiku-4",
		},
	}

	if err := ApplyPreferences(pc, targets); err != nil {
		t.Fatalf("ApplyPreferences() error: %v", err)
	}

	data, _ := os.ReadFile(filepath.Join(dir, "opencode.json"))
	raw := string(data)

	if gjson.Get(raw, "agent.scout.model").String() != "anthropic/claude-opus-4" {
		t.Errorf("scout model = %q, want anthropic/claude-opus-4", gjson.Get(raw, "agent.scout.model").String())
	}
	if gjson.Get(raw, "agent.general.model").String() != "anthropic/claude-haiku-4" {
		t.Errorf("general model = %q, want anthropic/claude-haiku-4", gjson.Get(raw, "agent.general.model").String())
	}
}

func TestApplyPreferences_CreatesEntryForTargetNotInConfig(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENCODE_CONFIG_DIR", dir)

	initial := `{"agent": {"scout": {}}}`
	mustWriteFile(t, filepath.Join(dir, "opencode.json"), []byte(initial), 0644)

	targets := []Target{
		{Name: "scout", Kind: KindAgent},
		{Name: "refine", Kind: KindAgent}, // not in config yet
	}
	pc := PreferencesConfig{
		TargetModels: map[string]string{
			"scout":  "anthropic/claude-opus-4",
			"refine": "anthropic/claude-opus-4",
		},
	}

	if err := ApplyPreferences(pc, targets); err != nil {
		t.Fatalf("ApplyPreferences() error: %v", err)
	}

	data, _ := os.ReadFile(filepath.Join(dir, "opencode.json"))
	raw := string(data)

	if gjson.Get(raw, "agent.scout.model").String() != "anthropic/claude-opus-4" {
		t.Errorf("scout model should be set")
	}
	if gjson.Get(raw, "agent.refine.model").String() != "anthropic/claude-opus-4" {
		t.Errorf("refine model = %q, want anthropic/claude-opus-4 (should create entry for target not in config)",
			gjson.Get(raw, "agent.refine.model").String())
	}
}

func TestApplyPreferences_UnmappedMainAgentsAreClearedFromConfig(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENCODE_CONFIG_DIR", dir)

	initial := `{
  "agent": {
    "build": {"model": "old/build", "mode": "primary"},
    "plan": {"model": "old/plan", "mode": "primary"},
    "adv": {"model": "old/adv", "mode": "primary"},
    "general": {"model": "old/general", "mode": "subagent"}
  }
}`
	mustWriteFile(t, filepath.Join(dir, "opencode.json"), []byte(initial), 0644)

	targets := []Target{
		{Name: "build", Kind: KindAgent, Mode: "primary"},
		{Name: "plan", Kind: KindAgent, Mode: "primary"},
		{Name: "adv", Kind: KindAgent, Mode: "primary"},
		{Name: "general", Kind: KindAgent, Mode: "subagent"},
	}
	pc := PreferencesConfig{
		TargetModels: map[string]string{
			"build":   "new/build",
			"plan":    "new/plan",
			"adv":     "new/adv",
			"general": "new/general",
		},
	}

	if err := ApplyPreferences(pc, targets); err != nil {
		t.Fatalf("ApplyPreferences() error: %v", err)
	}

	data, _ := os.ReadFile(filepath.Join(dir, "opencode.json"))
	raw := string(data)

	for _, name := range []string{"build", "plan", "adv"} {
		if gjson.Get(raw, "agent."+name+".model").Exists() {
			t.Fatalf("%s model should be removed from config", name)
		}
	}
	if gjson.Get(raw, "agent.general.model").String() != "new/general" {
		t.Fatalf("general model = %q, want new/general", gjson.Get(raw, "agent.general.model").String())
	}
}

func TestApplyPreferences_ClearSkipsTargetNotInConfig(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENCODE_CONFIG_DIR", dir)

	initial := `{"agent": {"build": {"model": "old/model"}}}`
	mustWriteFile(t, filepath.Join(dir, "opencode.json"), []byte(initial), 0644)

	targets := []Target{
		{Name: "build", Kind: KindAgent},
		{Name: "plan", Kind: KindAgent}, // not in config
	}
	pc := PreferencesConfig{
		TargetModels:  map[string]string{},
		ClearedModels: map[string]bool{"build": true, "plan": true},
	}

	if err := ApplyPreferences(pc, targets); err != nil {
		t.Fatalf("ApplyPreferences() error: %v", err)
	}

	data, _ := os.ReadFile(filepath.Join(dir, "opencode.json"))
	raw := string(data)

	if gjson.Get(raw, "agent.build.model").Exists() {
		t.Errorf("build model should be removed")
	}
	if gjson.Get(raw, "agent.plan").Exists() {
		t.Errorf("plan should not be created when only clearing (not in config)")
	}
}

func TestApplyPreferences_NoAssignmentSkipsTarget(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENCODE_CONFIG_DIR", dir)

	initial := `{"agent": {"scout": {"model": "existing/model"}}}`
	mustWriteFile(t, filepath.Join(dir, "opencode.json"), []byte(initial), 0644)

	targets := []Target{{Name: "scout", Kind: KindAgent}}
	pc := PreferencesConfig{
		TargetModels: map[string]string{}, // scout has no assignment
	}

	if err := ApplyPreferences(pc, targets); err != nil {
		t.Fatalf("ApplyPreferences() error: %v", err)
	}

	data, _ := os.ReadFile(filepath.Join(dir, "opencode.json"))
	got := gjson.Get(string(data), "agent.scout.model").String()
	if got != "existing/model" {
		t.Errorf("scout model = %q, want existing/model (no assignment should not change it)", got)
	}
}

func TestApplyPreferences_EmptyModelSkipsTarget(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENCODE_CONFIG_DIR", dir)

	initial := `{"agent": {"scout": {"model": "existing/model"}}}`
	mustWriteFile(t, filepath.Join(dir, "opencode.json"), []byte(initial), 0644)

	targets := []Target{{Name: "scout", Kind: KindAgent}}
	pc := PreferencesConfig{
		TargetModels: map[string]string{"scout": ""}, // empty model
	}

	if err := ApplyPreferences(pc, targets); err != nil {
		t.Fatalf("ApplyPreferences() error: %v", err)
	}

	data, _ := os.ReadFile(filepath.Join(dir, "opencode.json"))
	got := gjson.Get(string(data), "agent.scout.model").String()
	if got != "existing/model" {
		t.Errorf("scout model = %q, want existing/model (empty model should not overwrite)", got)
	}
}

func TestApplyPreferences_ClearedModelRemovesFromConfig(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENCODE_CONFIG_DIR", dir)

	// opencode.json already has a model set for scout
	initial := `{"agent": {"scout": {"model": "old/model", "mode": "primary"}}}`
	mustWriteFile(t, filepath.Join(dir, "opencode.json"), []byte(initial), 0644)

	targets := []Target{{Name: "scout", Kind: KindAgent}}
	// Preferences has ClearedModels indicating scout was explicitly cleared
	pc := PreferencesConfig{
		TargetModels:  map[string]string{},
		ClearedModels: map[string]bool{"scout": true},
	}

	if err := ApplyPreferences(pc, targets); err != nil {
		t.Fatalf("ApplyPreferences() error: %v", err)
	}

	data, _ := os.ReadFile(filepath.Join(dir, "opencode.json"))
	raw := string(data)
	if gjson.Get(raw, "agent.scout.model").Exists() {
		t.Errorf("scout model should be removed from config after clearing, got %q",
			gjson.Get(raw, "agent.scout.model").String())
	}
	// Other fields should be preserved
	if !gjson.Get(raw, "agent.scout.mode").Exists() {
		t.Error("agent.scout.mode should be preserved after clearing model")
	}
}

func TestApplyPreferences_OverwritesExistingModel(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENCODE_CONFIG_DIR", dir)

	// opencode.json already has a model set for scout
	initial := `{"agent": {"scout": {"model": "old/model"}}}`
	mustWriteFile(t, filepath.Join(dir, "opencode.json"), []byte(initial), 0644)

	targets := []Target{{Name: "scout", Kind: KindAgent}}
	pc := PreferencesConfig{
		TargetModels: map[string]string{"scout": "new/model"},
	}

	if err := ApplyPreferences(pc, targets); err != nil {
		t.Fatalf("ApplyPreferences() error: %v", err)
	}

	data, _ := os.ReadFile(filepath.Join(dir, "opencode.json"))
	got := gjson.Get(string(data), "agent.scout.model").String()
	if got != "new/model" {
		t.Errorf("scout model = %q, want new/model (overwrite should work)", got)
	}
}

// -- Provider ADV tests ------------------------------------------------------

func TestTargetIsModelMappable_ProviderVariantsAllowed(t *testing.T) {
	tests := []struct {
		name   string
		target Target
		want   bool
	}{
		{name: "adv-claude mapped", target: Target{Name: "adv-claude", Kind: KindAgent, Mode: "primary"}, want: true},
		{name: "adv-gpt mapped", target: Target{Name: "adv-gpt", Kind: KindAgent, Mode: "primary"}, want: true},
		{name: "adv-glm mapped", target: Target{Name: "adv-glm", Kind: KindAgent, Mode: "primary"}, want: true},
		{name: "adv-kimi mapped", target: Target{Name: "adv-kimi", Kind: KindAgent, Mode: "primary"}, want: true},
		{name: "adv still unmapped", target: Target{Name: "adv", Kind: KindAgent, Mode: "primary"}, want: false},
		{name: "build still unmapped", target: Target{Name: "build", Kind: KindAgent, Mode: "primary"}, want: false},
		{name: "plan still unmapped", target: Target{Name: "plan", Kind: KindAgent, Mode: "primary"}, want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.target.IsModelMappable(); got != tt.want {
				t.Fatalf("IsModelMappable() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestDiscoverTargets_ProviderVariantsFromGlobalAgents(t *testing.T) {
	dir := t.TempDir()
	agentDir := filepath.Join(dir, "agents")
	mustMkdirAll(t, agentDir, 0755)

	for _, name := range []string{"adv-claude", "adv-gpt", "adv-glm", "adv-kimi"} {
		content := `---
name: ` + name + `
mode: primary
---
`
		mustWriteFile(t, filepath.Join(agentDir, name+".md"), []byte(content), 0644)
	}

	raw := []byte(`{}`)
	targets := discoverTargets(dir, raw)

	names := make(map[string]bool)
	for _, tgt := range targets {
		names[tgt.Name] = true
	}

	for _, expected := range []string{"adv-claude", "adv-gpt", "adv-glm", "adv-kimi"} {
		if !names[expected] {
			t.Errorf("missing provider variant: %s", expected)
		}
	}
}

func TestDiscoverTargets_DoesNotDiscoverProjectLocalProviderAgents(t *testing.T) {
	root := t.TempDir()
	globalAgentDir := filepath.Join(root, "global", "agents")
	projectDir := filepath.Join(root, "project", ".opencode", "agents")
	mustMkdirAll(t, globalAgentDir, 0755)
	mustMkdirAll(t, projectDir, 0755)

	// Global has adv-claude
	mustWriteFile(t, filepath.Join(globalAgentDir, "adv-claude.md"), []byte("---\nmode: primary\n---\n"), 0644)
	// Project-local has adv-gpt (must be ignored for provider-ADV)
	mustWriteFile(t, filepath.Join(projectDir, "adv-gpt.md"), []byte("---\nmode: primary\n---\n"), 0644)

	oldWD, _ := os.Getwd()
	defer func() {
		if err := os.Chdir(oldWD); err != nil {
			t.Fatalf("chdir back to %s: %v", oldWD, err)
		}
	}()
	mustChdir(t, filepath.Join(root, "project"))

	t.Setenv("OPENCODE_CONFIG_DIR", filepath.Join(root, "global"))

	raw := []byte(`{}`)
	targets := discoverTargets(filepath.Join(root, "global"), raw)

	names := make(map[string]bool)
	for _, tgt := range targets {
		names[tgt.Name] = true
	}

	if !names["adv-claude"] {
		t.Error("adv-claude from global should be discovered")
	}
	if names["adv-gpt"] {
		t.Error("adv-gpt from project-local .opencode/agents must be excluded")
	}
}

func TestApplyPreferences_WritesProviderADVDisableAndModel(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENCODE_CONFIG_DIR", dir)

	initial := `{"agent": {}}`
	mustWriteFile(t, filepath.Join(dir, "opencode.json"), []byte(initial), 0644)

	targets := []Target{
		{Name: "adv-claude", Kind: KindAgent, Mode: "primary"},
		{Name: "adv-gpt", Kind: KindAgent, Mode: "primary"},
	}
	pc := PreferencesConfig{
		TargetModels: map[string]string{
			"adv-claude": "anthropic/claude-sonnet-4-20250514",
		},
		AdvProviders: map[string]AdvProviderConfig{
			"adv-claude": {Enabled: true, Model: "anthropic/claude-sonnet-4-20250514"},
			"adv-gpt":    {Enabled: false},
		},
	}

	if err := ApplyPreferences(pc, targets); err != nil {
		t.Fatalf("ApplyPreferences() error: %v", err)
	}

	data, _ := os.ReadFile(filepath.Join(dir, "opencode.json"))
	raw := string(data)

	if gjson.Get(raw, "agent.adv-claude.model").String() != "anthropic/claude-sonnet-4-20250514" {
		t.Errorf("adv-claude model = %q, want anthropic/claude-sonnet-4-20250514", gjson.Get(raw, "agent.adv-claude.model").String())
	}
	if gjson.Get(raw, "agent.adv-claude.disable").Bool() != false {
		t.Errorf("adv-claude disable should be false (enabled), got %v", gjson.Get(raw, "agent.adv-claude.disable").Bool())
	}
	if gjson.Get(raw, "agent.adv-gpt.disable").Bool() != true {
		t.Errorf("adv-gpt disable should be true (disabled), got %v", gjson.Get(raw, "agent.adv-gpt.disable").Bool())
	}
}

func TestLoadPreferences_AdvProvidersRoundTrip(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENCODE_CONFIG_DIR", dir)

	pc := PreferencesConfig{
		AdvProviders: map[string]AdvProviderConfig{
			"adv-claude": {Enabled: true, Model: "anthropic/claude-sonnet-4-20250514"},
			"adv-gpt":    {Enabled: false},
		},
	}
	if err := SavePreferences(pc); err != nil {
		t.Fatalf("SavePreferences() error: %v", err)
	}

	loaded, err := LoadPreferences()
	if err != nil {
		t.Fatalf("LoadPreferences() error: %v", err)
	}

	if !loaded.AdvProviders["adv-claude"].Enabled {
		t.Error("adv-claude should be enabled")
	}
	if loaded.AdvProviders["adv-claude"].Model != "anthropic/claude-sonnet-4-20250514" {
		t.Errorf("adv-claude model = %q, want anthropic/claude-sonnet-4-20250514", loaded.AdvProviders["adv-claude"].Model)
	}
	if loaded.AdvProviders["adv-gpt"].Enabled {
		t.Error("adv-gpt should be disabled")
	}
}

func TestSavePreferences_SanitizesAdvProviders(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENCODE_CONFIG_DIR", dir)

	pc := PreferencesConfig{
		AdvProviders: map[string]AdvProviderConfig{
			"adv-claude": {Enabled: true},
			"adv":        {Enabled: true}, // invalid — should be stripped
			"build":      {Enabled: true}, // invalid — should be stripped
			"custom":     {Enabled: true}, // invalid — not a provider variant
		},
	}
	if err := SavePreferences(pc); err != nil {
		t.Fatalf("SavePreferences() error: %v", err)
	}

	loaded, err := LoadPreferences()
	if err != nil {
		t.Fatalf("LoadPreferences() error: %v", err)
	}

	if _, ok := loaded.AdvProviders["adv-claude"]; !ok {
		t.Error("adv-claude should be preserved")
	}
	if _, ok := loaded.AdvProviders["adv"]; ok {
		t.Error("adv should be stripped from AdvProviders")
	}
	if _, ok := loaded.AdvProviders["build"]; ok {
		t.Error("build should be stripped from AdvProviders")
	}
	if _, ok := loaded.AdvProviders["custom"]; ok {
		t.Error("custom should be stripped from AdvProviders")
	}
}

// -- ApplyPreferences backup + atomic-write tests ----------------------------

// findBackups returns the list of .omp-backup.* files in dir.
func findBackups(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read dir %s: %v", dir, err)
	}
	var backups []string
	for _, e := range entries {
		if !e.IsDir() && strings.Contains(e.Name(), ".omp-backup.") {
			backups = append(backups, e.Name())
		}
	}
	return backups
}

// findTempFiles returns the list of .omp-*.tmp files in dir (used to verify
// atomic write cleanup).
func findTempFiles(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read dir %s: %v", dir, err)
	}
	var tmps []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasPrefix(e.Name(), ".omp-") && strings.HasSuffix(e.Name(), ".tmp") {
			tmps = append(tmps, e.Name())
		}
	}
	return tmps
}

func TestApplyPreferences_CreatesBackup(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENCODE_CONFIG_DIR", dir)

	initial := `{"agent": {"scout": {"mode": "primary"}}}`
	mustWriteFile(t, filepath.Join(dir, "opencode.json"), []byte(initial), 0644)

	pc := PreferencesConfig{
		TargetModels: map[string]string{"scout": "anthropic/claude-opus-4"},
	}
	if err := ApplyPreferences(pc, []Target{{Name: "scout", Kind: KindAgent}}); err != nil {
		t.Fatalf("ApplyPreferences() error: %v", err)
	}

	backups := findBackups(t, dir)
	if len(backups) == 0 {
		t.Fatalf("expected at least one .omp-backup.* file, found none")
	}
}

func TestApplyPreferences_WritesConfigOwnerOnly(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENCODE_CONFIG_DIR", dir)
	configPath := filepath.Join(dir, "opencode.json")
	mustWriteFile(t, configPath, []byte(`{"agent": {"scout": {"mode": "primary"}}}`), 0644)

	pc := PreferencesConfig{
		TargetModels: map[string]string{"scout": "anthropic/claude-opus-4"},
	}
	if err := ApplyPreferences(pc, []Target{{Name: "scout", Kind: KindAgent}}); err != nil {
		t.Fatalf("ApplyPreferences() error: %v", err)
	}

	info, err := os.Stat(configPath)
	if err != nil {
		t.Fatalf("stat opencode.json: %v", err)
	}
	if got := info.Mode().Perm(); got != 0600 {
		t.Fatalf("mode = %o, want 0600", got)
	}
}

func TestApplyPreferences_BackupContainsOriginal(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENCODE_CONFIG_DIR", dir)

	original := `{"agent": {"scout": {"mode": "primary", "model": "old/model"}}}`
	mustWriteFile(t, filepath.Join(dir, "opencode.json"), []byte(original), 0644)

	pc := PreferencesConfig{
		TargetModels: map[string]string{"scout": "anthropic/claude-opus-4"},
	}
	if err := ApplyPreferences(pc, []Target{{Name: "scout", Kind: KindAgent}}); err != nil {
		t.Fatalf("ApplyPreferences() error: %v", err)
	}

	backups := findBackups(t, dir)
	if len(backups) == 0 {
		t.Fatalf("expected backup file, found none")
	}
	backupData, err := os.ReadFile(filepath.Join(dir, backups[0]))
	if err != nil {
		t.Fatalf("read backup %s: %v", backups[0], err)
	}
	if string(backupData) != original {
		t.Errorf("backup content = %q, want %q", string(backupData), original)
	}
}

func TestApplyPreferences_AtomicWriteLeavesNoTempFile(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENCODE_CONFIG_DIR", dir)

	initial := `{"agent": {"scout": {"mode": "primary"}}}`
	mustWriteFile(t, filepath.Join(dir, "opencode.json"), []byte(initial), 0644)

	pc := PreferencesConfig{
		TargetModels: map[string]string{"scout": "anthropic/claude-opus-4"},
	}
	if err := ApplyPreferences(pc, []Target{{Name: "scout", Kind: KindAgent}}); err != nil {
		t.Fatalf("ApplyPreferences() error: %v", err)
	}

	tmps := findTempFiles(t, dir)
	if len(tmps) > 0 {
		t.Errorf("expected no leftover .omp-*.tmp files, found: %v", tmps)
	}
}

func TestApplyPreferences_PrunesBackupsToMostRecentFive(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENCODE_CONFIG_DIR", dir)
	configPath := filepath.Join(dir, "opencode.json")
	mustWriteFile(t, configPath, []byte(`{"agent": {"scout": {"mode": "primary"}}}`), 0644)

	base := time.Now().Add(-10 * time.Hour)
	for i := 0; i < 6; i++ {
		name := filepath.Join(dir, "opencode.json.omp-backup.old-"+string(rune('0'+i)))
		mustWriteFile(t, name, []byte("old"), 0600)
		mod := base.Add(time.Duration(i) * time.Hour)
		if err := os.Chtimes(name, mod, mod); err != nil {
			t.Fatalf("chtimes %s: %v", name, err)
		}
	}

	pc := PreferencesConfig{
		TargetModels: map[string]string{"scout": "anthropic/claude-opus-4"},
	}
	if err := ApplyPreferences(pc, []Target{{Name: "scout", Kind: KindAgent}}); err != nil {
		t.Fatalf("ApplyPreferences() error: %v", err)
	}

	backups := findBackups(t, dir)
	if len(backups) != maxOpencodeBackups {
		t.Fatalf("backup count = %d (%v), want %d", len(backups), backups, maxOpencodeBackups)
	}
	for _, backup := range backups {
		if backup == "opencode.json.omp-backup.old-0" || backup == "opencode.json.omp-backup.old-1" {
			t.Fatalf("old backup %q should have been pruned; backups=%v", backup, backups)
		}
	}
}

func TestApplyPreferences_MissingConfigErrorsAndNoBackup(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENCODE_CONFIG_DIR", dir)
	// Do NOT write opencode.json — should error on read.

	pc := PreferencesConfig{
		TargetModels: map[string]string{"scout": "anthropic/claude-opus-4"},
	}
	err := ApplyPreferences(pc, []Target{{Name: "scout", Kind: KindAgent}})
	if err == nil {
		t.Fatalf("ApplyPreferences() expected error for missing config, got nil")
	}
	if !strings.Contains(err.Error(), "reading config") {
		t.Errorf("error = %q, want one containing 'reading config'", err.Error())
	}

	backups := findBackups(t, dir)
	if len(backups) > 0 {
		t.Errorf("expected no backup files when config missing, found: %v", backups)
	}
}
