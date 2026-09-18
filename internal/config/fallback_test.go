package config

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tidwall/gjson"
)

// -- ValidateFallbackChain ---------------------------------------------------

func TestValidateFallbackChain_ValidSingleEntry(t *testing.T) {
	if err := ValidateFallbackChain([]string{"openai/gpt-5"}); err != nil {
		t.Errorf("expected nil error, got %v", err)
	}
}

func TestValidateFallbackChain_ValidMultiEntry(t *testing.T) {
	chain := []string{"openai/gpt-5", "google/gemini-2.5-pro", "anthropic/claude-sonnet-4-5"}
	if err := ValidateFallbackChain(chain); err != nil {
		t.Errorf("expected nil error for valid chain, got %v", err)
	}
}

func TestValidateFallbackChain_Empty(t *testing.T) {
	if err := ValidateFallbackChain([]string{}); err != nil {
		t.Errorf("empty chain should be valid (no fallback), got %v", err)
	}
	if err := ValidateFallbackChain(nil); err != nil {
		t.Errorf("nil chain should be valid (no fallback), got %v", err)
	}
}

func TestValidateFallbackChain_TooLong(t *testing.T) {
	chain := make([]string, MaxChainLength+1)
	for i := range chain {
		// Distinct values to avoid duplicate-detection false-positive.
		chain[i] = "provider/model-" + string(rune('a'+i))
	}
	err := ValidateFallbackChain(chain)
	if err == nil {
		t.Fatal("expected error for chain longer than MaxChainLength")
	}
	if !strings.Contains(err.Error(), "max") && !strings.Contains(err.Error(), "length") {
		t.Errorf("error should mention length/max, got: %v", err)
	}
}

func TestValidateFallbackChain_BadPattern(t *testing.T) {
	bad := [][]string{
		{"GPT-5"},                // no slash
		{"openai/"},              // empty model
		{"/gpt-5"},               // empty provider
		{"OpenAI/gpt-5"},         // uppercase provider not allowed (pattern starts [a-z0-9])
		{"-openai/gpt-5"},        // leading hyphen in provider not allowed
		{"openai/gpt-5 extra"},   // trailing space (invalid model chars)
		{"openai/gpt$5"},         // disallowed `$` in model
		{"openai/../secret"},     // path-traversal-like model segment
		{"openai/model..secret"}, // consecutive dots rejected
	}
	for _, chain := range bad {
		err := ValidateFallbackChain(chain)
		if err == nil {
			t.Errorf("expected error for chain %v, got nil", chain)
		}
	}
}

func TestValidateFallbackChain_Duplicates(t *testing.T) {
	chain := []string{"openai/gpt-5", "openai/gpt-5"}
	err := ValidateFallbackChain(chain)
	if err == nil {
		t.Fatal("expected error for duplicate entries")
	}
	if !strings.Contains(strings.ToLower(err.Error()), "duplicate") {
		t.Errorf("error should mention duplicates, got: %v", err)
	}
}

func TestModelKeyPattern_AcceptsSchemaExamples(t *testing.T) {
	// Examples from schema/fallback-schema.json must match the pattern.
	valid := []string{
		"openai/gpt-5",
		"google/gemini-2.5-pro",
		"anthropic/claude-sonnet-4-5",
	}
	for _, k := range valid {
		if err := ValidateFallbackChain([]string{k}); err != nil {
			t.Errorf("schema example %q rejected: %v", k, err)
		}
	}
}

func TestFallbackJSONPath_MatchesContract(t *testing.T) {
	// The constant must equal the canonical schema path.
	want := "options.fallback_models"
	if FallbackJSONPath != want {
		t.Errorf("FallbackJSONPath = %q, want %q", FallbackJSONPath, want)
	}
}

// -- ValidateBlockedModels ---------------------------------------------------

func TestValidateBlockedModels_Valid(t *testing.T) {
	if err := ValidateBlockedModels([]string{"openai/gpt-5", "google/gemini-2.5-pro"}); err != nil {
		t.Errorf("expected nil error, got %v", err)
	}
}

func TestValidateBlockedModels_Empty(t *testing.T) {
	if err := ValidateBlockedModels([]string{}); err != nil {
		t.Errorf("empty list should be valid (nothing blocked), got %v", err)
	}
	if err := ValidateBlockedModels(nil); err != nil {
		t.Errorf("nil list should be valid (nothing blocked), got %v", err)
	}
}

func TestValidateBlockedModels_TooLong(t *testing.T) {
	list := make([]string, MaxBlocklistLength+1)
	for i := range list {
		list[i] = "provider/model-" + string(rune('a'+i))
	}
	err := ValidateBlockedModels(list)
	if err == nil {
		t.Fatal("expected error for list longer than MaxBlocklistLength")
	}
	if !strings.Contains(err.Error(), "max") && !strings.Contains(err.Error(), "length") {
		t.Errorf("error should mention length/max, got: %v", err)
	}
}

func TestValidateBlockedModels_BadPatternAndDuplicates(t *testing.T) {
	bad := [][]string{
		{"BADNOSLASH"},
		{"openai/"},
		{"/gpt-5"},
		{"OpenAI/gpt-5"},
		{"openai/../secret"},
		{"openai/gpt-5", "openai/gpt-5"}, // duplicate
	}
	for _, list := range bad {
		err := ValidateBlockedModels(list)
		if err == nil {
			t.Errorf("expected error for list %v, got nil", list)
		}
	}
}

func TestValidateBlockedModels_AcceptsCapWithoutError(t *testing.T) {
	list := make([]string, MaxBlocklistLength)
	for i := range list {
		list[i] = "provider/model-" + string(rune('a'+i))
	}
	if err := ValidateBlockedModels(list); err != nil {
		t.Errorf("list at exactly MaxBlocklistLength should be valid, got %v", err)
	}
}

// -- sanitizePreferences extensions -----------------------------------------

func TestSanitizePreferences_InitsTargetFallbacks(t *testing.T) {
	pc := PreferencesConfig{}
	out, changed := sanitizePreferences(pc)
	if out.TargetFallbacks == nil {
		t.Error("TargetFallbacks should be initialized to empty map, not nil")
	}
	if !changed {
		t.Error("changed flag should be true when initializing TargetFallbacks")
	}
}

func TestSanitizePreferences_DropsInvalidChains(t *testing.T) {
	pc := PreferencesConfig{
		TargetModels: map[string]string{},
		TargetFallbacks: map[string][]string{
			"scout": {"openai/gpt-5", "google/gemini-2.5-pro"},
			"bad":   {"INVALID"},                      // bad pattern
			"dup":   {"openai/gpt-5", "openai/gpt-5"}, // duplicates
		},
	}
	out, changed := sanitizePreferences(pc)
	if !changed {
		t.Error("expected changed=true after dropping invalid chains")
	}
	if _, ok := out.TargetFallbacks["scout"]; !ok {
		t.Error("scout chain (valid) should be preserved")
	}
	if _, ok := out.TargetFallbacks["bad"]; ok {
		t.Error("bad chain (invalid pattern) should be dropped")
	}
	if _, ok := out.TargetFallbacks["dup"]; ok {
		t.Error("dup chain (duplicate entries) should be dropped")
	}
}

func TestSanitizePreferences_DropsUnmappableTargetFallbacks(t *testing.T) {
	pc := PreferencesConfig{
		TargetFallbacks: map[string][]string{
			"scout": {"openai/gpt-5"},
			"build": {"openai/gpt-5"}, // unmapped main agent
			"adv":   {"openai/gpt-5"}, // unmapped main agent
		},
	}
	out, _ := sanitizePreferences(pc)
	if _, ok := out.TargetFallbacks["scout"]; !ok {
		t.Error("scout (mappable) should be preserved")
	}
	if _, ok := out.TargetFallbacks["build"]; ok {
		t.Error("build (unmapped main agent) should be dropped")
	}
	if _, ok := out.TargetFallbacks["adv"]; ok {
		t.Error("adv (unmapped main agent) should be dropped")
	}
}

func TestSanitizePreferences_InitsTargetBlocked(t *testing.T) {
	pc := PreferencesConfig{}
	out, changed := sanitizePreferences(pc)
	if out.TargetBlocked == nil {
		t.Error("TargetBlocked should be initialized to empty map, not nil")
	}
	if !changed {
		t.Error("changed flag should be true when initializing TargetBlocked")
	}
}

func TestSanitizePreferences_DropsInvalidAndUnmappableBlocked(t *testing.T) {
	pc := PreferencesConfig{
		TargetBlocked: map[string][]string{
			"scout": {"openai/gpt-5", "google/gemini-2.5-pro"},
			"bad":   {"INVALID"},
			"dup":   {"openai/gpt-5", "openai/gpt-5"},
			"build": {"openai/gpt-5"}, // unmapped main agent
		},
	}
	out, changed := sanitizePreferences(pc)
	if !changed {
		t.Error("expected changed=true after dropping invalid blocked lists")
	}
	if _, ok := out.TargetBlocked["scout"]; !ok {
		t.Error("scout blocked list (valid) should be preserved")
	}
	if _, ok := out.TargetBlocked["bad"]; ok {
		t.Error("bad blocked list (invalid pattern) should be dropped")
	}
	if _, ok := out.TargetBlocked["dup"]; ok {
		t.Error("dup blocked list (duplicate entries) should be dropped")
	}
	if _, ok := out.TargetBlocked["build"]; ok {
		t.Error("build blocked list (unmapped main agent) should be dropped")
	}
}

// -- Target.FallbackModels + discoverTargets fallback read -------------------

// withNoopCommandRunner stubs out the opencode CLI so model discovery falls
// back to provider.*.models in the config under test.
func withNoopCommandRunner(t *testing.T) {
	t.Helper()
	orig := CommandRunner
	CommandRunner = func(_ context.Context, _ string, _ ...string) ([]byte, error) {
		return nil, &os.PathError{Op: "exec", Path: "opencode", Err: os.ErrNotExist}
	}
	t.Cleanup(func() { CommandRunner = orig })
}

// findTargetByName returns the Target with the given name, or nil if absent.
func findTargetByName(targets []Target, name string) *Target {
	for i := range targets {
		if targets[i].Name == name {
			return &targets[i]
		}
	}
	return nil
}

func TestDiscoverTargets_ReadsFallbackChainFromJSONOptionsPath(t *testing.T) {
	withNoopCommandRunner(t)
	dir := t.TempDir()
	t.Setenv("OPENCODE_CONFIG_DIR", dir)
	configJSON := `{
  "agent": {
    "scout": {
      "model": "anthropic/claude-opus-4",
      "options": {
        "fallback_models": ["openai/gpt-5", "google/gemini-2.5-pro"]
      }
    }
  }
}`
	mustWriteFile(t, filepath.Join(dir, "opencode.json"), []byte(configJSON), 0644)

	state, err := Load()
	if err != nil {
		t.Fatalf("Load() error: %v", err)
	}

	scout := findTargetByName(state.Targets, "scout")
	if scout == nil {
		t.Fatal("scout target should be discovered")
	}
	want := []string{"openai/gpt-5", "google/gemini-2.5-pro"}
	if len(scout.FallbackModels) != len(want) {
		t.Fatalf("FallbackModels length = %d, want %d (chain: %v)",
			len(scout.FallbackModels), len(want), scout.FallbackModels)
	}
	for i, m := range want {
		if scout.FallbackModels[i] != m {
			t.Errorf("FallbackModels[%d] = %q, want %q", i, scout.FallbackModels[i], m)
		}
	}
}

func TestDiscoverTargets_EmptyChainWhenAbsent(t *testing.T) {
	withNoopCommandRunner(t)
	dir := t.TempDir()
	t.Setenv("OPENCODE_CONFIG_DIR", dir)
	mustWriteFile(t, filepath.Join(dir, "opencode.json"),
		[]byte(`{"agent": {"scout": {"model": "anthropic/claude-opus-4"}}}`), 0644)

	state, err := Load()
	if err != nil {
		t.Fatalf("Load() error: %v", err)
	}
	scout := findTargetByName(state.Targets, "scout")
	if scout == nil {
		t.Fatal("scout should be discovered")
	}
	if len(scout.FallbackModels) != 0 {
		t.Errorf("FallbackModels = %v, want empty (no chain configured)", scout.FallbackModels)
	}
}

func TestDiscoverTargets_BuiltInAgentFallbackChain(t *testing.T) {
	// Verify the read path also picks up chains on built-in agents like
	// "general" / "explore" which are seeded by builtinAgents before the
	// JSON-loop iteration.
	withNoopCommandRunner(t)
	dir := t.TempDir()
	t.Setenv("OPENCODE_CONFIG_DIR", dir)
	configJSON := `{
  "agent": {
    "general": {
      "model": "anthropic/claude-opus-4",
      "options": {
        "fallback_models": ["openai/gpt-5"]
      }
    }
  }
}`
	mustWriteFile(t, filepath.Join(dir, "opencode.json"), []byte(configJSON), 0644)

	state, err := Load()
	if err != nil {
		t.Fatalf("Load() error: %v", err)
	}
	gen := findTargetByName(state.Targets, "general")
	if gen == nil {
		t.Fatal("general (built-in) should be present")
	}
	if len(gen.FallbackModels) != 1 || gen.FallbackModels[0] != "openai/gpt-5" {
		t.Errorf("FallbackModels = %v, want [openai/gpt-5]", gen.FallbackModels)
	}
}

func TestDiscoverTargets_MarkdownFrontmatterFallback(t *testing.T) {
	withNoopCommandRunner(t)
	dir := t.TempDir()
	t.Setenv("OPENCODE_CONFIG_DIR", dir)
	mustWriteFile(t, filepath.Join(dir, "opencode.json"), []byte(`{}`), 0644)

	agentsDir := filepath.Join(dir, "agents")
	mustMkdirAll(t, agentsDir, 0755)
	mdContent := `---
mode: subagent
model: anthropic/claude-opus-4
fallback_models: ["openai/gpt-5", "google/gemini-2.5-pro"]
---
Custom agent prompt.
`
	mustWriteFile(t, filepath.Join(agentsDir, "custom.md"), []byte(mdContent), 0644)

	state, err := Load()
	if err != nil {
		t.Fatalf("Load() error: %v", err)
	}
	custom := findTargetByName(state.Targets, "custom")
	if custom == nil {
		t.Fatal("custom (markdown) should be discovered")
	}
	want := []string{"openai/gpt-5", "google/gemini-2.5-pro"}
	if len(custom.FallbackModels) != len(want) {
		t.Fatalf("FallbackModels = %v, want %v", custom.FallbackModels, want)
	}
	for i, m := range want {
		if custom.FallbackModels[i] != m {
			t.Errorf("FallbackModels[%d] = %q, want %q", i, custom.FallbackModels[i], m)
		}
	}
}

func TestDiscoverTargets_JSONOverridesMarkdownFallback(t *testing.T) {
	withNoopCommandRunner(t)
	dir := t.TempDir()
	t.Setenv("OPENCODE_CONFIG_DIR", dir)

	configJSON := `{
  "agent": {
    "custom": {
      "options": {
        "fallback_models": ["json/winner"]
      }
    }
  }
}`
	mustWriteFile(t, filepath.Join(dir, "opencode.json"), []byte(configJSON), 0644)

	agentsDir := filepath.Join(dir, "agents")
	mustMkdirAll(t, agentsDir, 0755)
	mdContent := `---
mode: subagent
fallback_models: ["md/loser"]
---
Body.
`
	mustWriteFile(t, filepath.Join(agentsDir, "custom.md"), []byte(mdContent), 0644)

	state, err := Load()
	if err != nil {
		t.Fatalf("Load() error: %v", err)
	}
	custom := findTargetByName(state.Targets, "custom")
	if custom == nil {
		t.Fatal("custom should be discovered")
	}
	if len(custom.FallbackModels) != 1 || custom.FallbackModels[0] != "json/winner" {
		t.Errorf("FallbackModels = %v, want [json/winner] (JSON should override markdown)",
			custom.FallbackModels)
	}
}

func TestParseFrontmatterList_InlineArray(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "agent.md")
	mustWriteFile(t, path,
		[]byte(`---
fallback_models: ["openai/gpt-5", "google/gemini-2.5-pro"]
---
Body.`),
		0644)

	got := parseFrontmatterList(path, "fallback_models")
	want := []string{"openai/gpt-5", "google/gemini-2.5-pro"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i, v := range want {
		if got[i] != v {
			t.Errorf("got[%d] = %q, want %q", i, got[i], v)
		}
	}
}

func TestParseFrontmatterList_MultilineArray(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "agent.md")
	mustWriteFile(t, path,
		[]byte(`---
fallback_models:
  - openai/gpt-5
  - "google/gemini-2.5-pro"
---
Body.`),
		0644)

	got := parseFrontmatterList(path, "fallback_models")
	want := []string{"openai/gpt-5", "google/gemini-2.5-pro"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i, v := range want {
		if got[i] != v {
			t.Errorf("got[%d] = %q, want %q", i, got[i], v)
		}
	}
}

func TestParseFrontmatterList_Missing(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "agent.md")
	mustWriteFile(t, path,
		[]byte("---\nmode: subagent\n---\nBody."), 0644)

	got := parseFrontmatterList(path, "fallback_models")
	if len(got) != 0 {
		t.Errorf("got %v, want empty", got)
	}
}

// -- ApplyPreferences fallback chain writes ---------------------------------

// readOpencodeJSON returns the gjson result for path in the current
// OPENCODE_CONFIG_DIR's opencode.json.
func readOpencodeJSON(t *testing.T) []byte {
	t.Helper()
	data, err := os.ReadFile(ConfigPath())
	if err != nil {
		t.Fatalf("read opencode.json: %v", err)
	}
	return data
}

func readPluginFallback(t *testing.T, raw []byte, agent string) gjson.Result {
	t.Helper()
	path, ok := pluginFallbackPath(raw, agent)
	if !ok {
		t.Fatalf("routing plugin fallback path missing in config: %s", string(raw))
	}
	return gjson.GetBytes(raw, path)
}

func TestApplyPreferences_WritesFallbackChain(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENCODE_CONFIG_DIR", dir)
	mustWriteFile(t, filepath.Join(dir, "opencode.json"),
		[]byte(`{"agent": {"scout": {"mode": "primary"}}}`), 0644)

	pc := PreferencesConfig{
		TargetFallbacks: map[string][]string{
			"scout": {"openai/gpt-5", "google/gemini-2.5-pro"},
		},
	}
	err := ApplyPreferences(pc, []Target{{Name: "scout", Kind: KindAgent}})
	if err != nil {
		t.Fatalf("ApplyPreferences() error: %v", err)
	}

	raw := readOpencodeJSON(t)
	res := readPluginFallback(t, raw, "scout")
	if !res.IsArray() {
		t.Fatalf("expected fallback_models to be an array, got %v", res)
	}
	got := []string{}
	for _, r := range res.Array() {
		got = append(got, r.String())
	}
	want := []string{"openai/gpt-5", "google/gemini-2.5-pro"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i, v := range want {
		if got[i] != v {
			t.Errorf("got[%d] = %q, want %q", i, got[i], v)
		}
	}
}

func TestApplyPreferences_WritesPrimaryModelAndChainTogether(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENCODE_CONFIG_DIR", dir)
	mustWriteFile(t, filepath.Join(dir, "opencode.json"),
		[]byte(`{"agent": {"scout": {"mode": "primary"}}}`), 0644)

	pc := PreferencesConfig{
		TargetModels:    map[string]string{"scout": "anthropic/claude-opus-4"},
		TargetFallbacks: map[string][]string{"scout": {"openai/gpt-5"}},
	}
	if err := ApplyPreferences(pc, []Target{{Name: "scout", Kind: KindAgent}}); err != nil {
		t.Fatalf("ApplyPreferences() error: %v", err)
	}

	raw := readOpencodeJSON(t)
	if got := gjson.GetBytes(raw, "agent.scout.model").String(); got != "anthropic/claude-opus-4" {
		t.Errorf("primary model = %q, want anthropic/claude-opus-4", got)
	}
	chain := readPluginFallback(t, raw, "scout").Array()
	if len(chain) != 1 || chain[0].String() != "openai/gpt-5" {
		t.Errorf("chain = %v, want [openai/gpt-5]", chain)
	}
}

func TestApplyPreferences_ClearsEmptyChain(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENCODE_CONFIG_DIR", dir)
	// Pre-existing chain at plugin tuple options plus legacy options fallback.
	initial := `{"agent": {"scout": {"options": {"fallback_models": ["legacy/model"]}}}, "plugin": [["@sharper-flow/opencode-model-routing-plugin", {"agents": {"scout": {"fallback_models": ["openai/gpt-5"]}}}]]}`
	mustWriteFile(t, filepath.Join(dir, "opencode.json"), []byte(initial), 0644)

	// Empty chain in preferences should clear the field.
	pc := PreferencesConfig{
		TargetFallbacks: map[string][]string{"scout": {}},
	}
	if err := ApplyPreferences(pc, []Target{{Name: "scout", Kind: KindAgent}}); err != nil {
		t.Fatalf("ApplyPreferences() error: %v", err)
	}

	raw := readOpencodeJSON(t)
	if path, ok := pluginFallbackPath(raw, "scout"); ok && gjson.GetBytes(raw, path).Exists() {
		t.Errorf("expected plugin fallback_models to be cleared, but path still exists: %s", gjson.GetBytes(raw, path).Raw)
	}
	if gjson.GetBytes(raw, "agent.scout."+FallbackJSONPath).Exists() {
		t.Errorf("expected legacy fallback_models to be cleared, but path still exists: %s", gjson.GetBytes(raw, "agent.scout."+FallbackJSONPath).Raw)
	}
}

func TestApplyPreferences_PreservesOtherOptionsSiblings(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENCODE_CONFIG_DIR", dir)
	initial := `{"agent": {"scout": {"options": {"existing_key": "keep_me", "fallback_models": []}}}}`
	mustWriteFile(t, filepath.Join(dir, "opencode.json"), []byte(initial), 0644)

	pc := PreferencesConfig{
		TargetFallbacks: map[string][]string{"scout": {"openai/gpt-5"}},
	}
	if err := ApplyPreferences(pc, []Target{{Name: "scout", Kind: KindAgent}}); err != nil {
		t.Fatalf("ApplyPreferences() error: %v", err)
	}

	raw := readOpencodeJSON(t)
	if got := gjson.GetBytes(raw, "agent.scout.options.existing_key").String(); got != "keep_me" {
		t.Errorf("existing_key = %q, want keep_me (sjson should preserve siblings)", got)
	}
	if gjson.GetBytes(raw, "agent.scout."+FallbackJSONPath).Exists() {
		t.Errorf("legacy fallback_models should be removed after plugin-owned write")
	}
	if got := readPluginFallback(t, raw, "scout").Array(); len(got) != 1 || got[0].String() != "openai/gpt-5" {
		t.Errorf("plugin fallback chain = %v, want [openai/gpt-5]", got)
	}
}

func TestApplyPreferences_RejectsInvalidChain(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENCODE_CONFIG_DIR", dir)
	initial := `{"agent": {"scout": {}}}`
	mustWriteFile(t, filepath.Join(dir, "opencode.json"), []byte(initial), 0644)

	pc := PreferencesConfig{
		TargetFallbacks: map[string][]string{
			"scout": {"INVALID"}, // bad pattern: uppercase + no slash
		},
	}
	err := ApplyPreferences(pc, []Target{{Name: "scout", Kind: KindAgent}})
	if err == nil {
		t.Fatal("expected error for invalid chain, got nil")
	}
	if !strings.Contains(err.Error(), "invalid fallback chain") &&
		!strings.Contains(err.Error(), "fallback") {
		t.Errorf("error = %q, want one mentioning fallback chain", err.Error())
	}
	// Verify nothing was written to fallback_models on error path.
	raw := readOpencodeJSON(t)
	if gjson.GetBytes(raw, "agent.scout."+FallbackJSONPath).Exists() {
		t.Errorf("invalid chain should NOT have been written")
	}
}

func TestApplyPreferences_ChainWriteCreatesBackupToo(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENCODE_CONFIG_DIR", dir)
	mustWriteFile(t, filepath.Join(dir, "opencode.json"),
		[]byte(`{"agent": {"scout": {"mode": "primary"}}}`), 0644)

	pc := PreferencesConfig{
		TargetFallbacks: map[string][]string{"scout": {"openai/gpt-5"}},
	}
	if err := ApplyPreferences(pc, []Target{{Name: "scout", Kind: KindAgent}}); err != nil {
		t.Fatalf("ApplyPreferences() error: %v", err)
	}

	backups := findBackups(t, dir)
	if len(backups) == 0 {
		t.Errorf("expected backup file before chain write, found none")
	}
}

// -- blocked_models read path + ApplyPreferences round-trip -------------------

func TestDiscoverTargets_ReadsBlockedModelsFromPluginTuple(t *testing.T) {
	withNoopCommandRunner(t)
	dir := t.TempDir()
	t.Setenv("OPENCODE_CONFIG_DIR", dir)
	configJSON := `{
  "agent": {"scout": {"mode": "subagent"}},
  "plugin": [
    ["@sharper-flow/opencode-model-routing-plugin", {
      "agents": {
        "scout": {
          "fallback_models": ["openai/gpt-5"],
          "blocked_models": ["anthropic/claude-sonnet-4-5"]
        }
      }
    }]
  ]
}`
	mustWriteFile(t, filepath.Join(dir, "opencode.json"), []byte(configJSON), 0644)

	state, err := Load()
	if err != nil {
		t.Fatalf("Load() error: %v", err)
	}
	scout := findTargetByName(state.Targets, "scout")
	if scout == nil {
		t.Fatal("scout target should be discovered")
	}
	if len(scout.BlockedModels) != 1 || scout.BlockedModels[0] != "anthropic/claude-sonnet-4-5" {
		t.Errorf("BlockedModels = %v, want [anthropic/claude-sonnet-4-5]", scout.BlockedModels)
	}
	if len(scout.FallbackModels) != 1 || scout.FallbackModels[0] != "openai/gpt-5" {
		t.Errorf("FallbackModels = %v, want [openai/gpt-5]", scout.FallbackModels)
	}
}

func TestDiscoverTargets_NoBlockedModelsWhenAbsent(t *testing.T) {
	withNoopCommandRunner(t)
	dir := t.TempDir()
	t.Setenv("OPENCODE_CONFIG_DIR", dir)
	configJSON := `{
  "agent": {"scout": {"mode": "subagent"}},
  "plugin": [
    ["@sharper-flow/opencode-model-routing-plugin", {
      "agents": {"scout": {"fallback_models": ["openai/gpt-5"]}}
    }]
  ]
}`
	mustWriteFile(t, filepath.Join(dir, "opencode.json"), []byte(configJSON), 0644)

	state, err := Load()
	if err != nil {
		t.Fatalf("Load() error: %v", err)
	}
	scout := findTargetByName(state.Targets, "scout")
	if scout == nil {
		t.Fatal("scout target should be discovered")
	}
	if len(scout.BlockedModels) != 0 {
		t.Errorf("BlockedModels = %v, want empty", scout.BlockedModels)
	}
}

func TestApplyPreferences_WritesBlockedModelsRoundTrip(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENCODE_CONFIG_DIR", dir)
	mustWriteFile(t, filepath.Join(dir, "opencode.json"),
		[]byte(`{"agent": {"scout": {"mode": "primary"}}}`), 0644)

	withNoopCommandRunner(t)
	pc := PreferencesConfig{
		TargetFallbacks: map[string][]string{
			"scout": {"openai/gpt-5", "google/gemini-2.5-pro"},
		},
		TargetBlocked: map[string][]string{
			"scout": {"anthropic/claude-sonnet-4-5", "minimax/token-plan"},
		},
	}
	if err := ApplyPreferences(pc, []Target{{Name: "scout", Kind: KindAgent}}); err != nil {
		t.Fatalf("ApplyPreferences() error: %v", err)
	}

	// Round-trip: what the writer stored must read back identically.
	raw := readOpencodeJSON(t)
	blockedPath, ok := pluginBlockedPath(raw, "scout")
	if !ok {
		t.Fatalf("routing plugin blocked path missing in config: %s", string(raw))
	}
	res := gjson.GetBytes(raw, blockedPath)
	if !res.IsArray() {
		t.Fatalf("expected blocked_models to be an array, got %v", res)
	}
	got := []string{}
	for _, r := range res.Array() {
		got = append(got, r.String())
	}
	want := []string{"anthropic/claude-sonnet-4-5", "minimax/token-plan"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i, v := range want {
		if got[i] != v {
			t.Errorf("got[%d] = %q, want %q", i, got[i], v)
		}
	}

	// And the Load-side read path agrees with the written bytes.
	state, err := Load()
	if err != nil {
		t.Fatalf("Load() error: %v", err)
	}
	scout := findTargetByName(state.Targets, "scout")
	if scout == nil {
		t.Fatal("scout target should be discovered")
	}
	if len(scout.BlockedModels) != len(want) {
		t.Fatalf("Target.BlockedModels = %v, want %v", scout.BlockedModels, want)
	}
	for i, v := range want {
		if scout.BlockedModels[i] != v {
			t.Errorf("Target.BlockedModels[%d] = %q, want %q", i, scout.BlockedModels[i], v)
		}
	}
	// The fallback chain written in the same apply survived untouched.
	if len(scout.FallbackModels) != 2 || scout.FallbackModels[0] != "openai/gpt-5" {
		t.Errorf("FallbackModels = %v, want [openai/gpt-5 google/gemini-2.5-pro]", scout.FallbackModels)
	}
}

func TestApplyPreferences_ClearsEmptyBlockedList(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENCODE_CONFIG_DIR", dir)
	initial := `{"agent": {"scout": {"mode": "primary"}}, "plugin": [["@sharper-flow/opencode-model-routing-plugin", {"agents": {"scout": {"fallback_models": ["openai/gpt-5"], "blocked_models": ["anthropic/claude-sonnet-4-5"]}}}]]}`
	mustWriteFile(t, filepath.Join(dir, "opencode.json"), []byte(initial), 0644)

	// Empty blocked list in preferences clears the field; the chain stays.
	pc := PreferencesConfig{
		TargetFallbacks: map[string][]string{"scout": {"openai/gpt-5"}},
		TargetBlocked:   map[string][]string{"scout": {}},
	}
	if err := ApplyPreferences(pc, []Target{{Name: "scout", Kind: KindAgent}}); err != nil {
		t.Fatalf("ApplyPreferences() error: %v", err)
	}

	raw := readOpencodeJSON(t)
	if path, ok := pluginBlockedPath(raw, "scout"); ok && gjson.GetBytes(raw, path).Exists() {
		t.Errorf("expected plugin blocked_models to be cleared, but path still exists: %s",
			gjson.GetBytes(raw, path).Raw)
	}
	if path, ok := pluginFallbackPath(raw, "scout"); !ok || !gjson.GetBytes(raw, path).Exists() {
		t.Errorf("expected plugin fallback_models to survive the blocked clear")
	}
}

func TestApplyPreferences_RejectsInvalidBlockedList(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENCODE_CONFIG_DIR", dir)
	mustWriteFile(t, filepath.Join(dir, "opencode.json"),
		[]byte(`{"agent": {"scout": {}}}`), 0644)

	pc := PreferencesConfig{
		TargetBlocked: map[string][]string{"scout": {"INVALID"}},
	}
	err := ApplyPreferences(pc, []Target{{Name: "scout", Kind: KindAgent}})
	if err == nil {
		t.Fatal("expected error for invalid blocked list, got nil")
	}
	if !strings.Contains(err.Error(), "invalid blocked models") {
		t.Errorf("error = %q, want one mentioning blocked models", err.Error())
	}
	// Nothing written on the error path.
	raw := readOpencodeJSON(t)
	if path, ok := pluginBlockedPath(raw, "scout"); ok && gjson.GetBytes(raw, path).Exists() {
		t.Errorf("invalid blocked list should NOT have been written")
	}
}

func TestApplyPreferences_BlockedListSkipsUnmappableTargets(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENCODE_CONFIG_DIR", dir)
	mustWriteFile(t, filepath.Join(dir, "opencode.json"),
		[]byte(`{}`), 0644)

	pc := PreferencesConfig{
		TargetBlocked: map[string][]string{"build": {"openai/gpt-5"}},
	}
	if err := ApplyPreferences(pc, []Target{{Name: "build", Kind: KindAgent, Mode: "primary", BuiltIn: true, Locked: true}}); err != nil {
		t.Fatalf("ApplyPreferences() error: %v", err)
	}
	raw := readOpencodeJSON(t)
	if path, ok := pluginBlockedPath(raw, "build"); ok && gjson.GetBytes(raw, path).Exists() {
		t.Errorf("unmappable target should not get a blocked list written")
	}
}
