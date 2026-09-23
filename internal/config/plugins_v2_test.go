package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tidwall/gjson"
)

// -- V2 native plugins target ------------------------------------------------
//
// OpenCode 2 carries plugin options in a native "plugins" array of
// {package, options} objects. OMR writes that shape when an OMR entry already
// exists there, and keeps writing the V1 tuple in every other case (V2 reads
// V1 tuples in memory, so the tuple remains the cross-runtime safe default).

const v2ConfigFixture = `{
  "model": "anthropic/claude-opus-4",
  "plugins": [
    "unrelated-other-plugin",
    {"package": "@sharper-flow/opencode-model-routing-plugin", "options": {"cooldownMsByCategory": {"rate_limit": 60000}}},
    {"package": "another-unrelated", "options": {"enabled": true}}
  ],
  "agents": {"general": {"model": "anthropic/claude-opus-4"}}
}`

func TestRoutingPluginsV2Index_FindsObjectAndStringEntries(t *testing.T) {
	raw := []byte(v2ConfigFixture)
	idx, ok := routingPluginsV2Index(raw)
	if !ok {
		t.Fatalf("routingPluginsV2Index() not found in V2 fixture")
	}
	if idx != 1 {
		t.Errorf("index = %d, want 1", idx)
	}

	// A plain "plugins" string array names the routing plugin directly.
	rawString := []byte(`{"plugins": ["other", "@sharper-flow/opencode-model-routing-plugin"]}`)
	idx, ok = routingPluginsV2Index(rawString)
	if !ok || idx != 1 {
		t.Errorf("string-entry index = %d ok=%v, want 1 true", idx, ok)
	}

	if _, ok := routingPluginsV2Index([]byte(`{"plugins": ["other"]}`)); ok {
		t.Errorf("unrelated plugins array must not match")
	}
	if _, ok := routingPluginsV2Index([]byte(`{"plugin": []}`)); ok {
		t.Errorf("V1 plugin key must not match the V2 finder")
	}
}

func TestPluginPaths_V2NativeEntry(t *testing.T) {
	raw := []byte(v2ConfigFixture)
	fallbackPath, ok := pluginFallbackPath(raw, "general")
	if !ok {
		t.Fatalf("pluginFallbackPath() not found for V2 config")
	}
	if fallbackPath != "plugins.1.options.agents.general.fallback_models" {
		t.Errorf("fallback path = %q", fallbackPath)
	}
	blockedPath, ok := pluginBlockedPath(raw, "general")
	if !ok {
		t.Fatalf("pluginBlockedPath() not found for V2 config")
	}
	if blockedPath != "plugins.1.options.agents.general.blocked_models" {
		t.Errorf("blocked path = %q", blockedPath)
	}
}

func TestBuildApplyPlan_V2NativeTargetPreservesEntryAndConfig(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "opencode.json")
	original := v2ConfigFixture
	mustWriteFile(t, configPath, []byte(original), 0644)

	pc := PreferencesConfig{
		TargetFallbacks: map[string][]string{"general": {"openai/gpt-5.2", "google/gemini-3-pro"}},
		TargetBlocked:   map[string][]string{"general": {"openai/gpt-5-mini"}},
	}
	plan, err := BuildApplyPlan([]byte(original), configPath, pc, []Target{{Name: "general", Kind: KindAgent}})
	if err != nil {
		t.Fatalf("BuildApplyPlan() error: %v", err)
	}
	if string(plan.Updated) == original {
		t.Fatalf("plan produced no changes")
	}

	// Chain + blocked set land under the V2 object options.
	chain := gjson.GetBytes(plan.Updated, "plugins.1.options.agents.general.fallback_models")
	if !chain.IsArray() || len(chain.Array()) != 2 {
		t.Fatalf("V2 fallback chain missing: %s", chain.Raw)
	}
	if chain.Array()[0].String() != "openai/gpt-5.2" {
		t.Errorf("chain[0] = %q", chain.Array()[0].String())
	}
	blocked := gjson.GetBytes(plan.Updated, "plugins.1.options.agents.general.blocked_models")
	if !blocked.IsArray() || blocked.Array()[0].String() != "openai/gpt-5-mini" {
		t.Fatalf("V2 blocked set missing: %s", blocked.Raw)
	}

	// Unrelated fields inside the OMR entry survive.
	if got := gjson.GetBytes(plan.Updated, "plugins.1.options.cooldownMsByCategory.rate_limit").Int(); got != 60000 {
		t.Errorf("unrelated plugin option clobbered: %d", got)
	}
	// Unrelated entries and top-level fields survive untouched.
	if got := gjson.GetBytes(plan.Updated, "plugins.0").String(); got != "unrelated-other-plugin" {
		t.Errorf("unrelated plugin entry changed: %q", got)
	}
	if got := gjson.GetBytes(plan.Updated, "plugins.2.package").String(); got != "another-unrelated" {
		t.Errorf("unrelated object entry changed: %q", got)
	}
	if got := gjson.GetBytes(plan.Updated, "agents.general.model").String(); got != "anthropic/claude-opus-4" {
		t.Errorf("unrelated agents field changed: %q", got)
	}
	if _, exists := routingPluginIndex(plan.Updated); exists {
		t.Errorf("V1 plugin tuple must not be created for a V2-native config")
	}
}

func TestBuildApplyPlan_V1TupleConfigRetainsTupleTarget(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "opencode.json")
	original := `{"plugin": [["/plugins/opencode-model-routing", {"agents": {"general": {"fallback_models": ["old/one"]}}}]], "agents": {"general": {"model": "a/b"}}}`
	mustWriteFile(t, configPath, []byte(original), 0644)

	pc := PreferencesConfig{
		TargetFallbacks: map[string][]string{"general": {"new/two"}},
	}
	plan, err := BuildApplyPlan([]byte(original), configPath, pc, []Target{{Name: "general", Kind: KindAgent}})
	if err != nil {
		t.Fatalf("BuildApplyPlan() error: %v", err)
	}

	chain := gjson.GetBytes(plan.Updated, "plugin.0.1.agents.general.fallback_models")
	if !chain.IsArray() || chain.Array()[0].String() != "new/two" {
		t.Fatalf("V1 tuple chain not updated in place: %s", plan.Updated)
	}
	if gjson.GetBytes(plan.Updated, "plugins").Exists() {
		t.Errorf("V1 tuple config must not gain a V2 plugins array")
	}
	if _, exists := routingPluginsV2Index(plan.Updated); exists {
		t.Errorf("V2 target must not be created for a V1 tuple config")
	}
}

func TestBuildApplyPlan_NoPluginEntryCreatesV1Tuple(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "opencode.json")
	original := `{"agents": {"general": {"model": "a/b"}}}`
	mustWriteFile(t, configPath, []byte(original), 0644)

	pc := PreferencesConfig{
		TargetFallbacks: map[string][]string{"general": {"openai/gpt-5.2"}},
	}
	plan, err := BuildApplyPlan([]byte(original), configPath, pc, []Target{{Name: "general", Kind: KindAgent}})
	if err != nil {
		t.Fatalf("BuildApplyPlan() error: %v", err)
	}
	if _, exists := routingPluginsV2Index(plan.Updated); exists {
		t.Errorf("first write must create the V1 tuple, not a V2 entry")
	}
	chain := gjson.GetBytes(plan.Updated, "plugin.0.1.agents.general.fallback_models")
	if !chain.IsArray() || chain.Array()[0].String() != "openai/gpt-5.2" {
		t.Fatalf("first-write tuple chain missing: %s", plan.Updated)
	}
}

func TestBuildApplyPlan_V2StringEntryGainsOptionsObject(t *testing.T) {
	raw := []byte(`{"plugins": ["@sharper-flow/opencode-model-routing-plugin"]}`)
	updated, idx, err := ensureRoutingPluginOptions(raw)
	if err != nil {
		t.Fatalf("ensureRoutingPluginOptions() error: %v", err)
	}
	if idx != 0 {
		t.Errorf("idx = %d, want 0", idx)
	}
	if !gjson.GetBytes(updated, "plugins.0.options").Exists() {
		t.Errorf("options object not created: %s", updated)
	}
	if got := gjson.GetBytes(updated, "plugins.0.package").String(); got != RoutingPluginID {
		t.Errorf("upgraded entry lost the package spec: %q", got)
	}
}

func TestReadFallbackChain_V2NativeEntry(t *testing.T) {
	raw := []byte(`{
		"plugins": [{"package": "@sharper-flow/opencode-model-routing-plugin", "options": {"agents": {"general": {"fallback_models": ["openai/gpt-5.2"]}}}}],
		"agent": {"general": {"options": {"fallback_models": ["legacy/one"]}}}
	}`)
	chain := readFallbackChain(raw, "general")
	if len(chain) != 1 || chain[0] != "openai/gpt-5.2" {
		t.Errorf("readFallbackChain() = %v, want [openai/gpt-5.2]", chain)
	}

	blocked := readBlockedModels(raw, "general")
	if len(blocked) != 0 {
		t.Errorf("readBlockedModels() = %v, want empty", blocked)
	}
}

func TestReadFallbackChain_V2PreferredOverV1Tuple(t *testing.T) {
	raw := []byte(`{
		"plugin": [["omr", {"agents": {"general": {"fallback_models": ["v1/one"]}}}]],
		"plugins": [{"package": "omr-plugin-path/opencode-model-routing", "options": {"agents": {"general": {"fallback_models": ["v2/two"]}}}}]
	}`)
	chain := readFallbackChain(raw, "general")
	if len(chain) != 1 || chain[0] != "v2/two" {
		t.Errorf("readFallbackChain() = %v, want the V2 chain [v2/two]", chain)
	}
}

func TestApplyPreferences_V2NativeConfigWritesAndPreserves(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENCODE_CONFIG_DIR", dir)
	configPath := filepath.Join(dir, "opencode.json")
	mustWriteFile(t, configPath, []byte(v2ConfigFixture), 0644)

	pc := PreferencesConfig{
		TargetFallbacks: map[string][]string{"general": {"openai/gpt-5.2"}},
	}
	if err := ApplyPreferences(pc, []Target{{Name: "general", Kind: KindAgent}}); err != nil {
		t.Fatalf("ApplyPreferences() error: %v", err)
	}

	after, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read config after apply: %v", err)
	}
	if !gjson.GetBytes(after, "plugins.1.options.agents.general.fallback_models").IsArray() {
		t.Fatalf("applied config missing V2 chain: %s", after)
	}
	if !strings.Contains(string(after), "unrelated-other-plugin") {
		t.Errorf("unrelated plugin entry lost during apply")
	}
	if backups := findBackups(t, dir); len(backups) == 0 {
		t.Errorf("ApplyPreferences wrote no backup")
	}
}

func TestBuildApplyPlan_V2NativeFirstInstallAppendsIntoPlugins(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "opencode.json")
	// A V2-native config whose plugins array has no OMR entry yet.
	original := `{
		"$schema": "https://opencode.ai/config.json",
		"plugins": ["unrelated-first", {"package": "another-unrelated", "options": {"enabled": true}}],
		"agents": {"general": {"mode": "subagent", "model": "anthropic/claude-opus-4"}}
	}`
	mustWriteFile(t, configPath, []byte(original), 0644)

	pc := PreferencesConfig{
		TargetFallbacks: map[string][]string{"general": {"openai/gpt-5.2"}},
	}
	plan, err := BuildApplyPlan([]byte(original), configPath, pc, []Target{{Name: "general", Kind: KindAgent}})
	if err != nil {
		t.Fatalf("BuildApplyPlan() error: %v", err)
	}

	// First install must register inside the existing plugins array...
	omr := gjson.GetBytes(plan.Updated, "plugins.#(package==\"@sharper-flow/opencode-model-routing-plugin\")")
	if !omr.Exists() {
		t.Fatalf("OMR entry not appended to the native plugins array: %s", plan.Updated)
	}
	if idx, ok := routingPluginsV2Index(plan.Updated); !ok || idx != 2 {
		t.Errorf("routingPluginsV2Index() = %d ok=%v, want 2 true", idx, ok)
	}
	chain := gjson.GetBytes(plan.Updated, "plugins.2.options.agents.general.fallback_models")
	if !chain.IsArray() || chain.Array()[0].String() != "openai/gpt-5.2" {
		t.Fatalf("first-install chain missing under the appended entry: %s", plan.Updated)
	}
	// ...and must never create a parallel V1 tuple.
	if gjson.GetBytes(plan.Updated, "plugin").Exists() {
		t.Errorf("V2-native first install created a V1 plugin tuple: %s", plan.Updated)
	}
	// Unrelated entries and the agents section survive untouched.
	if got := gjson.GetBytes(plan.Updated, "plugins.0").String(); got != "unrelated-first" {
		t.Errorf("unrelated string entry changed: %q", got)
	}
	if got := gjson.GetBytes(plan.Updated, "agents.general.model").String(); got != "anthropic/claude-opus-4" {
		t.Errorf("unrelated agents entry changed: %q", got)
	}
}

// The agents CLI gap: omr must discover, read, and write agents carried under
// the V2 native "agents" section, not only the V1 "agent" key.
func TestDiscoverTargets_V2AgentsSection(t *testing.T) {
	raw := []byte(`{
		"plugins": [{"package": "@sharper-flow/opencode-model-routing-plugin", "options": {"agents": {"reviewer": {"fallback_models": ["openai/gpt-5.2"]}}}}],
		"agents": {
			"reviewer": {"mode": "subagent", "model": "anthropic/claude-opus-4", "description": "reviews things"},
			"build": {"model": "openai/gpt-5.2"}
		}
	}`)
	targets := discoverTargets(t.TempDir(), raw)
	byName := map[string]Target{}
	for _, tgt := range targets {
		byName[tgt.Name] = tgt
	}
	rev, ok := byName["reviewer"]
	if !ok {
		t.Fatalf("V2 agents-section agent 'reviewer' not discovered: %+v", targets)
	}
	if rev.Model != "anthropic/claude-opus-4" || rev.Mode != "subagent" {
		t.Errorf("reviewer = %+v", rev)
	}
	if len(rev.FallbackModels) != 1 || rev.FallbackModels[0] != "openai/gpt-5.2" {
		t.Errorf("reviewer fallback = %v", rev.FallbackModels)
	}
	if b, ok := byName["build"]; !ok || b.Model != "openai/gpt-5.2" {
		t.Errorf("build override from agents section not read: %+v", byName["build"])
	}
}

func TestBuildApplyPlan_V2AgentsModelWritePreservesConfig(t *testing.T) {
	raw := []byte(`{
		"plugins": ["other"],
		"agents": {"reviewer": {"mode": "subagent"}},
		"model": "anthropic/claude-opus-4"
	}`)
	pc := PreferencesConfig{
		TargetModels: map[string]string{"reviewer": "openai/gpt-5.2"},
	}
	plan, err := BuildApplyPlan(raw, "opencode.json", pc, []Target{{Name: "reviewer", Kind: KindAgent}})
	if err != nil {
		t.Fatalf("BuildApplyPlan() error: %v", err)
	}
	if got := gjson.GetBytes(plan.Updated, "agents.reviewer.model").String(); got != "openai/gpt-5.2" {
		t.Fatalf("model override written to %q, want agents.reviewer.model", got)
	}
	if gjson.GetBytes(plan.Updated, "agent").Exists() {
		t.Errorf("V1 agent key created for a V2-native config: %s", plan.Updated)
	}
	// Unrelated top-level fields and the unrelated plugin entry survive.
	if got := gjson.GetBytes(plan.Updated, "model").String(); got != "anthropic/claude-opus-4" {
		t.Errorf("unrelated top-level model changed: %q", got)
	}
	if got := gjson.GetBytes(plan.Updated, "plugins.0").String(); got != "other" {
		t.Errorf("unrelated plugin entry changed: %q", got)
	}
}

// The ADV enable/disable toggle must address the agent where the config
// defines its agents — the V2 native "agents" key for a V2-native config,
// never the V1 "agent" key — and must use the V2 field spelling "disabled"
// (the V2 agents contract spells the toggle "disabled"; "disable" is the
// legacy V1 field).
func TestBuildApplyPlan_V2AdvToggleWritesNativeDisabled(t *testing.T) {
	raw := []byte(`{
		"plugins": ["other"],
		"agents": {"reviewer": {"mode": "all"}}
	}`)
	pc := PreferencesConfig{
		AdvProviders: map[string]AdvProviderConfig{
			"adv-claude": {Enabled: false},
			"adv-gpt":    {Enabled: true, Model: "openai/gpt-5.2"},
		},
	}
	targets := []Target{
		{Name: "adv-claude", Kind: KindAgent, Mode: "primary"},
		{Name: "adv-gpt", Kind: KindAgent, Mode: "primary"},
	}
	plan, err := BuildApplyPlan(raw, "opencode.json", pc, targets)
	if err != nil {
		t.Fatalf("BuildApplyPlan() error: %v", err)
	}
	if !gjson.GetBytes(plan.Updated, "agents.adv-claude.disabled").Bool() {
		t.Errorf("agents.adv-claude.disabled not written: %s", plan.Updated)
	}
	if gjson.GetBytes(plan.Updated, "agents.adv-gpt.disabled").Bool() {
		t.Errorf("agents.adv-gpt should stay enabled: %s", plan.Updated)
	}
	if gjson.GetBytes(plan.Updated, "agents.adv-claude.disable").Exists() {
		t.Errorf("legacy disable field written under the V2 agents section: %s", plan.Updated)
	}
	if got := gjson.GetBytes(plan.Updated, "agents.adv-gpt.model").String(); got != "openai/gpt-5.2" {
		t.Errorf("agents.adv-gpt.model = %q", got)
	}
	if gjson.GetBytes(plan.Updated, "agent").Exists() {
		t.Errorf("V1 agent key created by the ADV toggle on a V2-native config: %s", plan.Updated)
	}
	// Unrelated entries survive.
	if got := gjson.GetBytes(plan.Updated, "plugins.0").String(); got != "other" {
		t.Errorf("unrelated plugin entry changed: %q", got)
	}
	if got := gjson.GetBytes(plan.Updated, "agents.reviewer.mode").String(); got != "all" {
		t.Errorf("unrelated agents entry changed: %q", got)
	}
}

func TestBuildApplyPlan_MixedPluginKeysKeepExistingOMROwner(t *testing.T) {
	raw := []byte(`{
		"plugins": ["unrelated-v2"],
		"plugin": [["/tmp/local/opencode-model-routing/plugin", {
			"cooldownMsByCategory": {"rate_limit": 60000},
			"agents": {
				"other": {"fallback_models": ["old/one"], "blocked_models": ["old/two"]}
			}
		}]],
		"agents": {"general": {"mode": "subagent"}, "other": {"mode": "subagent"}}
	}`)
	pc := PreferencesConfig{TargetFallbacks: map[string][]string{"general": {"new/one"}}}
	plan, err := BuildApplyPlan(raw, "opencode.json", pc, []Target{{Name: "general", Kind: KindAgent}})
	if err != nil {
		t.Fatalf("BuildApplyPlan() error: %v", err)
	}
	if _, ok := routingPluginsV2Index(plan.Updated); ok {
		t.Fatalf("created a second OMR registration: %s", plan.Updated)
	}
	if got := gjson.GetBytes(plan.Updated, "plugins.0").String(); got != "unrelated-v2" {
		t.Errorf("unrelated V2 plugin changed: %q", got)
	}
	if got := gjson.GetBytes(plan.Updated, "plugin.0.0").String(); got != "/tmp/local/opencode-model-routing/plugin" {
		t.Errorf("existing OMR package path changed: %q", got)
	}
	if got := gjson.GetBytes(plan.Updated, "plugin.0.1.cooldownMsByCategory.rate_limit").Int(); got != 60000 {
		t.Errorf("existing OMR option changed: %d", got)
	}
	if got := gjson.GetBytes(plan.Updated, "plugin.0.1.agents.general.fallback_models.0").String(); got != "new/one" {
		t.Errorf("new chain not written to existing OMR entry: %q", got)
	}
	if got := readFallbackChain(plan.Updated, "other"); len(got) != 1 || got[0] != "old/one" {
		t.Errorf("other agent chain lost: %v", got)
	}
	if got := readBlockedModels(plan.Updated, "other"); len(got) != 1 || got[0] != "old/two" {
		t.Errorf("other agent blocklist lost: %v", got)
	}
}

func TestSetAgentOrder_V2AgentsSectionStaysInPlace(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENCODE_CONFIG_DIR", dir)
	configPath := filepath.Join(dir, "opencode.json")
	mustWriteFile(t, configPath, []byte(`{"agents": {"zeta": {"mode": "primary"}, "alpha": {"mode": "primary"}}}`), 0644)

	if err := SetAgentOrder([]string{"alpha", "zeta"}); err != nil {
		t.Fatalf("SetAgentOrder() error: %v", err)
	}
	after, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	keys := []string{}
	gjson.GetBytes(after, "agents").ForEach(func(name, _ gjson.Result) bool {
		keys = append(keys, name.String())
		return true
	})
	if len(keys) != 2 || keys[0] != "alpha" || keys[1] != "zeta" {
		t.Errorf("agents order = %v, want [alpha zeta]", keys)
	}
	if gjson.GetBytes(after, "agent").Exists() {
		t.Errorf("reorder created a V1 agent key: %s", after)
	}
}
