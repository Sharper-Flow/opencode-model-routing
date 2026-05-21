package tui

import (
	"fmt"

	"github.com/Sharper-Flow/opencode-model-routing/internal/config"
)

// RoutingStack is the TUI's routing-first view model for one configurable
// OpenCode target: primary model plus ordered fallback chain.
type RoutingStack struct {
	Target         config.Target
	TargetName     string
	PrimaryModel   string
	FallbackModels []string
}

// RoutingValidationFinding reports a structural issue in a routing stack.
type RoutingValidationFinding struct {
	Code    string
	Message string
	Model   string
}

// BuildRoutingStacks normalizes discovered target state plus pending
// preferences into routing-stack view models for the TUI.
func BuildRoutingStacks(state *config.State, prefs config.PreferencesConfig) []RoutingStack {
	if state == nil {
		return nil
	}
	stacks := make([]RoutingStack, 0, len(state.Targets))
	for _, target := range state.Targets {
		if target.Kind != config.KindAgent || !target.IsModelMappable() {
			continue
		}

		primary := target.Model
		if pref, ok := prefs.TargetModels[target.Name]; ok {
			primary = pref
		}
		if prefs.ClearedModels[target.Name] {
			primary = ""
		}

		fallbacks := append([]string(nil), target.FallbackModels...)
		if prefs.TargetFallbacks != nil {
			if prefChain, ok := prefs.TargetFallbacks[target.Name]; ok {
				fallbacks = append([]string(nil), prefChain...)
			}
		}

		stacks = append(stacks, RoutingStack{
			Target:         target,
			TargetName:     target.Name,
			PrimaryModel:   primary,
			FallbackModels: fallbacks,
		})
	}
	return stacks
}

// ValidateRoutingStack applies structural fallback-chain validation and, when a
// model registry is provided, checks that configured models are available.
func ValidateRoutingStack(stack RoutingStack, models []config.Model) []RoutingValidationFinding {
	var findings []RoutingValidationFinding
	if err := config.ValidateFallbackChain(stack.FallbackModels); err != nil {
		findings = append(findings, RoutingValidationFinding{
			Code:    "invalid_fallback_chain",
			Message: fmt.Sprintf("invalid fallback chain for %s: %v", stack.TargetName, err),
		})
	}

	if len(models) == 0 {
		return findings
	}
	available := make(map[string]bool, len(models))
	for _, model := range models {
		available[model.ID] = true
	}
	if stack.PrimaryModel != "" && !available[stack.PrimaryModel] {
		findings = append(findings, RoutingValidationFinding{
			Code:    "unavailable_model",
			Model:   stack.PrimaryModel,
			Message: fmt.Sprintf("primary model %s is not available", stack.PrimaryModel),
		})
	}
	for _, model := range stack.FallbackModels {
		if model == "" || available[model] {
			continue
		}
		findings = append(findings, RoutingValidationFinding{
			Code:    "unavailable_model",
			Model:   model,
			Message: fmt.Sprintf("fallback model %s is not available", model),
		})
	}
	return findings
}
