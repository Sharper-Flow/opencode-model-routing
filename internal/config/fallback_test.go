package config

import (
	"strings"
	"testing"
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
		{"GPT-5"},              // no slash
		{"openai/"},            // empty model
		{"/gpt-5"},             // empty provider
		{"OpenAI/gpt-5"},       // uppercase provider not allowed (pattern starts [a-z0-9])
		{"-openai/gpt-5"},      // leading hyphen in provider not allowed
		{"openai/gpt-5 extra"}, // trailing space (invalid model chars)
		{"openai/gpt$5"},       // disallowed `$` in model
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
