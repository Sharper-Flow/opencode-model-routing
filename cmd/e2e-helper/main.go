// e2e-helper is a non-interactive driver for ApplyPreferences used by
// scripts/e2e-smoke.sh. It seeds a known PreferencesConfig with both a
// primary model and a fallback chain, then calls ApplyPreferences against
// the directory pointed to by OPENCODE_CONFIG_DIR.
//
// Output: a single line "OK" on success, or the error message on failure.
// Exit 0 on success, non-zero otherwise.
package main

import (
	"fmt"
	"os"

	"github.com/Sharper-Flow/opencode-model-routing/internal/config"
)

func main() {
	if os.Getenv("OPENCODE_CONFIG_DIR") == "" {
		fmt.Fprintln(os.Stderr, "OPENCODE_CONFIG_DIR is required")
		os.Exit(2)
	}

	pc := config.PreferencesConfig{
		TargetModels: map[string]string{
			"adv-researcher": "anthropic/claude-sonnet-4-5",
		},
		TargetFallbacks: map[string][]string{
			"adv-researcher": {"openai/gpt-5", "google/gemini-2.5-pro"},
		},
	}
	targets := []config.Target{
		{Name: "adv-researcher", Kind: config.KindAgent, Mode: "subagent"},
	}
	if err := config.ApplyPreferences(pc, targets); err != nil {
		fmt.Fprintf(os.Stderr, "ApplyPreferences failed: %v\n", err)
		os.Exit(1)
	}
	fmt.Println("OK")
}
