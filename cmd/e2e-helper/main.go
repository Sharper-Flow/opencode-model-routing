// e2e-helper is a non-interactive driver for ApplyPreferences used by
// scripts/e2e-smoke.sh and scripts/e2e-v2-runtime.sh. It seeds a known
// PreferencesConfig with both a primary model and a fallback chain, then
// calls ApplyPreferences against the directory pointed to by
// OPENCODE_CONFIG_DIR.
//
// Optional environment overrides for scenario fixtures:
//   - OMR_E2E_AGENT: target agent name (default "adv-researcher")
//   - OMR_E2E_MODEL: primary model override (default "anthropic/claude-sonnet-4-5")
//   - OMR_E2E_CHAIN: comma-separated fallback chain
//     (default "openai/gpt-5,google/gemini-2.5-pro")
//
// Output: a single line "OK" on success, or the error message on failure.
// Exit 0 on success, non-zero otherwise.
package main

import (
	"fmt"
	"os"
	"strings"

	"github.com/Sharper-Flow/opencode-model-routing/internal/config"
)

func main() {
	if os.Getenv("OPENCODE_CONFIG_DIR") == "" {
		fmt.Fprintln(os.Stderr, "OPENCODE_CONFIG_DIR is required")
		os.Exit(2)
	}

	agent := os.Getenv("OMR_E2E_AGENT")
	if agent == "" {
		agent = "adv-researcher"
	}
	model := os.Getenv("OMR_E2E_MODEL")
	if model == "" {
		model = "anthropic/claude-sonnet-4-5"
	}
	chain := strings.Split(strings.TrimSpace(os.Getenv("OMR_E2E_CHAIN")), ",")
	if len(chain) == 0 || chain[0] == "" {
		chain = []string{"openai/gpt-5", "google/gemini-2.5-pro"}
	}

	pc := config.PreferencesConfig{
		TargetModels: map[string]string{
			agent: model,
		},
		TargetFallbacks: map[string][]string{
			agent: chain,
		},
	}
	targets := []config.Target{
		{Name: agent, Kind: config.KindAgent, Mode: "subagent"},
	}
	if err := config.ApplyPreferences(pc, targets); err != nil {
		fmt.Fprintf(os.Stderr, "ApplyPreferences failed: %v\n", err)
		os.Exit(1)
	}
	fmt.Println("OK")
}
