package tui

import (
	"strings"
	"testing"

	"github.com/Sharper-Flow/opencode-model-routing/internal/config"
	tea "github.com/charmbracelet/bubbletea"
)

func TestUpdate_WindowSizeDoesNotPanic(t *testing.T) {
	m := New(&config.State{}, config.PreferencesConfig{
		TargetModels: map[string]string{},
	})

	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("Update panicked on window size message: %v", r)
		}
	}()

	_, _ = m.Update(tea.WindowSizeMsg{Width: 120, Height: 30})
}

func TestView_AssignmentsView_ShowsTitle(t *testing.T) {
	state := &config.State{
		Targets: []config.Target{
			{Name: "scout", Kind: config.KindAgent, Mode: "primary", Model: "anthropic/claude-opus-4"},
		},
	}
	m := New(state, config.PreferencesConfig{
		TargetModels: map[string]string{},
	})

	updated, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 80})
	rendered := updated.(Model).View()

	if !strings.Contains(rendered, "Agents") {
		t.Fatalf("expected 'Agents' in render, got:\n%s", rendered)
	}
}

func TestView_AssignmentsView_ShowsAgentName(t *testing.T) {
	state := &config.State{
		Targets: []config.Target{
			{Name: "scout", Kind: config.KindAgent, Mode: "primary", Model: "anthropic/claude-opus-4"},
		},
	}
	m := New(state, config.PreferencesConfig{
		TargetModels: map[string]string{},
	})

	updated, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 80})
	rendered := updated.(Model).View()

	if !strings.Contains(rendered, "scout") {
		t.Fatalf("expected agent name 'scout' in render, got:\n%s", rendered)
	}
}

func TestView_AssignmentsView_ShowsAssignedModel(t *testing.T) {
	state := &config.State{
		Targets: []config.Target{
			{Name: "scout", Kind: config.KindAgent, Mode: "primary"},
		},
	}
	prefs := config.PreferencesConfig{
		TargetModels: map[string]string{"scout": "anthropic/claude-opus-4"},
	}
	m := New(state, prefs)

	updated, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 80})
	rendered := updated.(Model).View()

	if !strings.Contains(rendered, "anthropic/claude-opus-4") {
		t.Fatalf("expected model 'anthropic/claude-opus-4' in render, got:\n%s", rendered)
	}
}

func TestBuildTargetItems_HiddenAgentsInSubagentsSection(t *testing.T) {
	targets := []config.Target{
		{Name: "scout", Kind: config.KindAgent},
		{Name: "adv-reviewer", Kind: config.KindAgent, Hidden: true},
		{Name: "adv-hardener", Kind: config.KindAgent, Hidden: true},
	}
	prefs := config.PreferencesConfig{
		TargetModels: map[string]string{},
	}
	items := buildTargetItems(targets, prefs)

	// Collect sections and which agents appear under each
	var currentSection string
	agentsBySection := make(map[string][]string)
	for _, item := range items {
		if s, ok := item.(sectionItem); ok {
			currentSection = s.label
			continue
		}
		if ti, ok := item.(targetItem); ok {
			agentsBySection[currentSection] = append(agentsBySection[currentSection], ti.target.Name)
		}
	}

	// "scout" should be under "Agents"
	if agents := agentsBySection["Agents"]; len(agents) != 1 || agents[0] != "scout" {
		t.Errorf("Agents section = %v, want [scout]", agents)
	}

	// hidden agents should be under "Sub-agents"
	subs := agentsBySection["Sub-agents"]
	if len(subs) != 2 {
		t.Fatalf("Sub-agents section = %v, want [adv-reviewer, adv-hardener]", subs)
	}
	if subs[0] != "adv-reviewer" || subs[1] != "adv-hardener" {
		t.Errorf("Sub-agents = %v, want [adv-reviewer, adv-hardener]", subs)
	}
}

func TestBuildTargetItems_ModeSubagentsInSubagentsSection(t *testing.T) {
	targets := []config.Target{
		{Name: "scout", Kind: config.KindAgent, Mode: "primary"},
		{Name: "general", Kind: config.KindAgent, Mode: "subagent"},
		{Name: "explore", Kind: config.KindAgent, Mode: "subagent"},
	}
	prefs := config.PreferencesConfig{TargetModels: map[string]string{}}
	items := buildTargetItems(targets, prefs)

	var currentSection string
	sections := map[string][]string{}
	for _, item := range items {
		if s, ok := item.(sectionItem); ok {
			currentSection = s.label
			continue
		}
		if ti, ok := item.(targetItem); ok {
			sections[currentSection] = append(sections[currentSection], ti.target.Name)
		}
	}

	if got := sections["Agents"]; len(got) != 1 || got[0] != "scout" {
		t.Errorf("Agents section = %v, want [scout]", got)
	}
	if got := sections["Sub-agents"]; len(got) != 2 || got[0] != "general" || got[1] != "explore" {
		t.Errorf("Sub-agents section = %v, want [general explore]", got)
	}
}

func TestBuildTargetItems_SeparatesAgentsAndSubagents(t *testing.T) {
	targets := []config.Target{
		{Name: "scout", Kind: config.KindAgent},
		{Name: "adv-reviewer", Kind: config.KindAgent, Hidden: true},
	}
	prefs := config.PreferencesConfig{
		TargetModels: map[string]string{},
	}
	items := buildTargetItems(targets, prefs)

	var sections []string
	for _, item := range items {
		if s, ok := item.(sectionItem); ok {
			sections = append(sections, s.label)
		}
	}
	if len(sections) != 2 || sections[0] != "Agents" || sections[1] != "Sub-agents" {
		t.Errorf("expected [Agents, Sub-agents] sections, got %v", sections)
	}
}

func TestBuildTargetItems_ShowsModelInDescription(t *testing.T) {
	targets := []config.Target{
		{Name: "scout", Kind: config.KindAgent, Model: "anthropic/claude-opus-4"},
	}
	prefs := config.PreferencesConfig{
		TargetModels: map[string]string{"scout": "openai/gpt-5"},
	}

	items := buildTargetItems(targets, prefs)
	for _, item := range items {
		ti, ok := item.(targetItem)
		if !ok {
			continue
		}
		desc := ti.Description()
		if !strings.Contains(desc, "openai/gpt-5") {
			t.Fatalf("expected model in description, got: %s", desc)
		}
		return
	}
	t.Fatal("target item not found")
}

func TestBuildTargetItems_PendingChangeShown(t *testing.T) {
	targets := []config.Target{
		{Name: "scout", Kind: config.KindAgent, Model: "anthropic/claude-opus-4"},
	}
	prefs := config.PreferencesConfig{
		TargetModels: map[string]string{"scout": "openai/gpt-5"},
	}

	items := buildTargetItems(targets, prefs)
	for _, item := range items {
		ti, ok := item.(targetItem)
		if !ok {
			continue
		}
		desc := ti.Description()
		// Should show pending change since pref differs from current
		if !strings.Contains(desc, "pending") {
			t.Fatalf("expected 'pending' in description when model differs, got: %s", desc)
		}
		return
	}
	t.Fatal("target item not found")
}

func TestBuildTargetItems_SubagentDescriptionShowsStickyOverride(t *testing.T) {
	targets := []config.Target{{Name: "adv-reviewer", Kind: config.KindAgent, Hidden: true, Model: "anthropic/claude-haiku-4"}}
	prefs := config.PreferencesConfig{TargetModels: map[string]string{}}

	items := buildTargetItems(targets, prefs)
	for _, item := range items {
		ti, ok := item.(targetItem)
		if !ok {
			continue
		}
		if !strings.Contains(ti.Description(), "sticky override") {
			t.Fatalf("expected sticky override description, got: %s", ti.Description())
		}
		return
	}
	t.Fatal("target item not found")
}

func TestBuildModelPickItems_IncludesClearOption(t *testing.T) {
	models := []config.Model{
		{ID: "anthropic/claude-opus-4", Provider: "anthropic", Name: "Claude Opus 4"},
	}
	items := buildModelPickItems(models)

	if len(items) != 2 {
		t.Fatalf("expected 2 items (clear + 1 model), got %d", len(items))
	}
	first, ok := items[0].(pickItem)
	if !ok {
		t.Fatal("first item should be a pickItem")
	}
	if first.value != "" {
		t.Errorf("first item value should be empty (clear option), got %q", first.value)
	}
}

func TestView_AssignmentsView_ShowsKeyHints(t *testing.T) {
	state := &config.State{
		Targets: []config.Target{{Name: "scout", Kind: config.KindAgent}},
	}
	prefs := config.PreferencesConfig{TargetModels: map[string]string{}}
	m := New(state, prefs)

	rendered := m.View()
	if !strings.Contains(rendered, "set model") {
		t.Fatalf("expected 'set model' hint in view, got:\n%s", rendered)
	}
	if !strings.Contains(rendered, "d: clear") {
		t.Fatalf("expected 'd: clear' hint in view, got:\n%s", rendered)
	}
	if !strings.Contains(rendered, "a: apply") {
		t.Fatalf("expected 'a: apply' hint in view, got:\n%s", rendered)
	}
	if !strings.Contains(rendered, "D: clear sub-agents") {
		t.Fatalf("expected 'D: clear sub-agents' hint in view, got:\n%s", rendered)
	}
	if !strings.Contains(rendered, "sticky overrides") {
		t.Fatalf("expected sticky override warning in view, got:\n%s", rendered)
	}
}

func TestClearSubagentOverrides_ClearsOnlySubagents(t *testing.T) {
	state := &config.State{Targets: []config.Target{
		{Name: "scout", Kind: config.KindAgent, Mode: "primary"},
		{Name: "general", Kind: config.KindAgent, Mode: "subagent"},
		{Name: "adv-reviewer", Kind: config.KindAgent, Hidden: true},
	}}
	prefs := config.PreferencesConfig{TargetModels: map[string]string{
		"scout":        "openai/gpt-5",
		"general":      "anthropic/claude-haiku-4",
		"adv-reviewer": "anthropic/claude-haiku-4",
	}}
	m := New(state, prefs)

	updated, cmd := m.clearSubagentOverrides()
	if cmd == nil {
		t.Fatal("expected save command when clearing sub-agent overrides")
	}
	model := updated.(Model)

	if got := model.prefs.TargetModels["scout"]; got != "openai/gpt-5" {
		t.Fatalf("scout mapping = %q, want openai/gpt-5", got)
	}
	if _, ok := model.prefs.TargetModels["general"]; ok {
		t.Fatal("general mapping should be cleared")
	}
	if _, ok := model.prefs.TargetModels["adv-reviewer"]; ok {
		t.Fatal("adv-reviewer mapping should be cleared")
	}
	if !model.prefs.ClearedModels["general"] || !model.prefs.ClearedModels["adv-reviewer"] {
		t.Fatalf("expected cleared models for sub-agents, got %#v", model.prefs.ClearedModels)
	}
}

func TestBuildTargetItems_HidesUnmappedMainAgentsAndOverlays(t *testing.T) {
	targets := []config.Target{
		{Name: "build", Kind: config.KindAgent, Mode: "primary"},
		{Name: "plan", Kind: config.KindAgent, Mode: "primary"},
		{Name: "adv", Kind: config.KindAgent, Mode: "primary"},
		{Name: "scout", Kind: config.KindAgent, Mode: "primary"},
		{Name: "general", Kind: config.KindAgent, Mode: "subagent"},
	}

	items := buildTargetItems(targets, config.PreferencesConfig{TargetModels: map[string]string{}})

	var names []string
	for _, item := range items {
		if ti, ok := item.(targetItem); ok {
			names = append(names, ti.target.Name)
		}
	}

	if len(names) != 2 || names[0] != "scout" || names[1] != "general" {
		t.Fatalf("visible target names = %v, want [scout general]", names)
	}
}

func TestBuildTargetItems_ShowsADVProviderAgentsSection(t *testing.T) {
	targets := []config.Target{
		{Name: "scout", Kind: config.KindAgent, Mode: "primary"},
		{Name: "adv-claude", Kind: config.KindAgent, Mode: "primary"},
		{Name: "adv-gpt", Kind: config.KindAgent, Mode: "primary"},
	}
	prefs := config.PreferencesConfig{AdvProviders: map[string]config.AdvProviderConfig{
		"adv-claude": {Enabled: true},
		"adv-gpt":    {Enabled: false},
	}}
	items := buildTargetItems(targets, prefs)

	var sections []string
	for _, item := range items {
		if s, ok := item.(sectionItem); ok {
			sections = append(sections, s.label)
		}
	}

	found := false
	for _, s := range sections {
		if s == "ADV Provider Agents" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected 'ADV Provider Agents' section, got sections: %v", sections)
	}
}

func TestBuildTargetItems_ProviderVariantShowsModelFromTargetFallback(t *testing.T) {
	targets := []config.Target{
		{Name: "adv-claude", Kind: config.KindAgent, Mode: "primary", Model: "anthropic/claude-sonnet-4"},
	}
	prefs := config.PreferencesConfig{AdvProviders: map[string]config.AdvProviderConfig{
		"adv-claude": {Enabled: true, Model: ""},
	}}
	items := buildTargetItems(targets, prefs)

	for _, item := range items {
		ti, ok := item.(targetItem)
		if !ok {
			continue
		}
		desc := ti.Description()
		if !strings.Contains(desc, "enabled  model: anthropic/claude-sonnet-4") {
			t.Fatalf("expected 'enabled  model: anthropic/claude-sonnet-4' in description, got: %s", desc)
		}
		return
	}
	t.Fatal("target item not found")
}

func TestBuildTargetItems_ProviderVariantEnabledNoModel(t *testing.T) {
	targets := []config.Target{
		{Name: "adv-claude", Kind: config.KindAgent, Mode: "primary"},
	}
	prefs := config.PreferencesConfig{AdvProviders: map[string]config.AdvProviderConfig{
		"adv-claude": {Enabled: true, Model: ""},
	}}
	items := buildTargetItems(targets, prefs)

	for _, item := range items {
		ti, ok := item.(targetItem)
		if !ok {
			continue
		}
		desc := ti.Description()
		if desc != "enabled" {
			t.Fatalf("expected 'enabled' when no model in either source, got: %s", desc)
		}
		return
	}
	t.Fatal("target item not found")
}

func TestBuildTargetItems_ProviderVariantShowsEnabledStatus(t *testing.T) {
	targets := []config.Target{
		{Name: "adv-claude", Kind: config.KindAgent, Mode: "primary"},
	}
	prefs := config.PreferencesConfig{AdvProviders: map[string]config.AdvProviderConfig{
		"adv-claude": {Enabled: true, Model: "anthropic/claude-sonnet-4"},
	}}
	items := buildTargetItems(targets, prefs)

	for _, item := range items {
		ti, ok := item.(targetItem)
		if !ok {
			continue
		}
		if !strings.Contains(ti.Description(), "enabled") {
			t.Fatalf("expected 'enabled' in description, got: %s", ti.Description())
		}
		return
	}
	t.Fatal("target item not found")
}

func TestBuildTargetItems_ProviderVariantShowsDisabledStatus(t *testing.T) {
	targets := []config.Target{
		{Name: "adv-gpt", Kind: config.KindAgent, Mode: "primary"},
	}
	prefs := config.PreferencesConfig{AdvProviders: map[string]config.AdvProviderConfig{
		"adv-gpt": {Enabled: false},
	}}
	items := buildTargetItems(targets, prefs)

	for _, item := range items {
		ti, ok := item.(targetItem)
		if !ok {
			continue
		}
		if !strings.Contains(ti.Description(), "disabled") {
			t.Fatalf("expected 'disabled' in description, got: %s", ti.Description())
		}
		return
	}
	t.Fatal("target item not found")
}

func TestUpdate_ToggleEnableProviderVariant(t *testing.T) {
	state := &config.State{
		Targets: []config.Target{
			{Name: "adv-claude", Kind: config.KindAgent, Mode: "primary"},
		},
	}
	prefs := config.PreferencesConfig{AdvProviders: map[string]config.AdvProviderConfig{
		"adv-claude": {Enabled: false},
	}}
	m := New(state, prefs)
	updated, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 80})
	m = updated.(Model)

	// Navigate past section header to the provider item
	m.assignmentList.Select(1)

	// Press 'e' to toggle enable
	updated, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'e'}})
	if cmd == nil {
		t.Fatal("expected save command after toggling provider")
	}
	model := updated.(Model)
	if !model.prefs.AdvProviders["adv-claude"].Enabled {
		t.Fatal("expected adv-claude to be enabled after toggle")
	}
}

func TestView_AssignmentsView_ShowsToggleHint(t *testing.T) {
	state := &config.State{
		Targets: []config.Target{{Name: "adv-claude", Kind: config.KindAgent, Mode: "primary"}},
	}
	prefs := config.PreferencesConfig{AdvProviders: map[string]config.AdvProviderConfig{}}
	m := New(state, prefs)

	rendered := m.View()
	if !strings.Contains(rendered, "e: toggle enable/disable") {
		t.Fatalf("expected 'e: toggle enable/disable' hint in view, got:\n%s", rendered)
	}
}

func TestModelPickDoneMsg_ProviderVariantUpdatesAdvProvidersModel(t *testing.T) {
	state := &config.State{Targets: []config.Target{{Name: "adv-claude", Kind: config.KindAgent, Mode: "primary"}}}
	prefs := config.PreferencesConfig{AdvProviders: map[string]config.AdvProviderConfig{
		"adv-claude": {Enabled: true},
	}}
	m := New(state, prefs)

	updated, cmd := m.Update(modelPickDoneMsg{targetName: "adv-claude", model: "anthropic/claude-sonnet-4"})
	if cmd == nil {
		t.Fatal("expected save command after provider model pick")
	}
	model := updated.(Model)
	if got := model.prefs.AdvProviders["adv-claude"].Model; got != "anthropic/claude-sonnet-4" {
		t.Fatalf("provider model = %q, want anthropic/claude-sonnet-4", got)
	}
}

func TestClearModel_ProviderVariantClearsAdvProvidersModel(t *testing.T) {
	state := &config.State{Targets: []config.Target{{Name: "adv-claude", Kind: config.KindAgent, Mode: "primary"}}}
	prefs := config.PreferencesConfig{AdvProviders: map[string]config.AdvProviderConfig{
		"adv-claude": {Enabled: true, Model: "anthropic/claude-sonnet-4"},
	}}
	m := New(state, prefs)
	updated, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 80})
	m = updated.(Model)
	m.assignmentList.Select(1)

	updated, cmd := m.clearModel()
	if cmd == nil {
		t.Fatal("expected save command after clearing provider model")
	}
	model := updated.(Model)
	if got := model.prefs.AdvProviders["adv-claude"].Model; got != "" {
		t.Fatalf("provider model = %q, want empty", got)
	}
}

func TestView_AssignmentsView_ShowsMissingProviderFilesWarning(t *testing.T) {
	state := &config.State{
		Targets: []config.Target{{Name: "adv-claude", Kind: config.KindAgent, Mode: "primary"}},
	}
	prefs := config.PreferencesConfig{AdvProviders: map[string]config.AdvProviderConfig{}}
	m := New(state, prefs)

	rendered := m.View()
	if !strings.Contains(rendered, "ADV provider agent file(s) missing") {
		t.Fatalf("expected missing provider files warning, got:\n%s", rendered)
	}
}
