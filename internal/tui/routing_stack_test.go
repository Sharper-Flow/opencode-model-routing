package tui

import (
	"strings"
	"testing"

	"github.com/Sharper-Flow/opencode-model-routing/internal/config"
)

func TestBuildRoutingStacks_PreferencesOverrideDiscoveredState(t *testing.T) {
	state := &config.State{
		Targets: []config.Target{{
			Name:           "scout",
			Kind:           config.KindAgent,
			Mode:           "primary",
			Model:          "anthropic/old",
			FallbackModels: []string{"openai/old"},
		}},
	}
	prefs := config.PreferencesConfig{
		TargetModels:    map[string]string{"scout": "anthropic/new"},
		TargetFallbacks: map[string][]string{"scout": {"openai/gpt-5", "google/gemini-2.5-pro"}},
	}

	stacks := BuildRoutingStacks(state, prefs)
	if len(stacks) != 1 {
		t.Fatalf("stacks = %d, want 1", len(stacks))
	}
	stack := stacks[0]
	if stack.TargetName != "scout" {
		t.Fatalf("TargetName = %q, want scout", stack.TargetName)
	}
	if stack.PrimaryModel != "anthropic/new" {
		t.Fatalf("PrimaryModel = %q, want anthropic/new", stack.PrimaryModel)
	}
	want := []string{"openai/gpt-5", "google/gemini-2.5-pro"}
	if len(stack.FallbackModels) != len(want) {
		t.Fatalf("FallbackModels = %v, want %v", stack.FallbackModels, want)
	}
	for i := range want {
		if stack.FallbackModels[i] != want[i] {
			t.Fatalf("FallbackModels = %v, want %v", stack.FallbackModels, want)
		}
	}
}

func TestBuildRoutingStacks_UsesDiscoveredChainWhenPreferencesAbsent(t *testing.T) {
	state := &config.State{Targets: []config.Target{{
		Name:           "scout",
		Kind:           config.KindAgent,
		Mode:           "primary",
		Model:          "anthropic/current",
		FallbackModels: []string{"openai/gpt-5"},
	}}}
	stacks := BuildRoutingStacks(state, config.PreferencesConfig{})
	if len(stacks) != 1 {
		t.Fatalf("stacks = %d, want 1", len(stacks))
	}
	if got := stacks[0].FallbackModels; len(got) != 1 || got[0] != "openai/gpt-5" {
		t.Fatalf("FallbackModels = %v, want [openai/gpt-5]", got)
	}
}

func TestBuildRoutingStacks_SkipsUnmappableMainAgents(t *testing.T) {
	state := &config.State{Targets: []config.Target{
		{Name: "adv", Kind: config.KindAgent, Mode: "primary"},
		{Name: "build", Kind: config.KindAgent, Mode: "primary"},
		{Name: "general", Kind: config.KindAgent, Mode: "subagent"},
	}}
	stacks := BuildRoutingStacks(state, config.PreferencesConfig{})
	if len(stacks) != 1 || stacks[0].TargetName != "general" {
		t.Fatalf("stacks = %#v, want only general", stacks)
	}
}

func TestValidateRoutingStack_UsesStructuralFallbackValidation(t *testing.T) {
	stack := RoutingStack{TargetName: "scout", FallbackModels: []string{"INVALID"}}
	findings := ValidateRoutingStack(stack, nil)
	if len(findings) == 0 {
		t.Fatal("expected validation finding for invalid fallback model")
	}
	if !strings.Contains(findings[0].Message, "fallback chain") {
		t.Fatalf("finding = %#v, want fallback chain message", findings[0])
	}
}

func TestValidateRoutingStack_FlagsUnavailableModelsWhenRegistryProvided(t *testing.T) {
	stack := RoutingStack{TargetName: "scout", PrimaryModel: "anthropic/known", FallbackModels: []string{"openai/missing"}}
	models := []config.Model{{ID: "anthropic/known"}}
	findings := ValidateRoutingStack(stack, models)
	if len(findings) == 0 {
		t.Fatal("expected unavailable model finding")
	}
	var sawUnavailable bool
	for _, f := range findings {
		if f.Code == "unavailable_model" {
			sawUnavailable = true
		}
	}
	if !sawUnavailable {
		t.Fatalf("findings = %#v, want unavailable_model", findings)
	}
}
