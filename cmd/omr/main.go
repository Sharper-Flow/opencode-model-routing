package main

import (
	"errors"
	"fmt"
	"io"
	"os"

	"github.com/Sharper-Flow/opencode-model-routing/internal/config"
	"github.com/Sharper-Flow/opencode-model-routing/internal/tui"
	tea "github.com/charmbracelet/bubbletea"
)

var runProgram = func(m tea.Model) (tea.Model, error) {
	p := tea.NewProgram(m, tea.WithAltScreen())
	return p.Run()
}

func main() {
	if err := run(os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// run is the testable OMR-native entry point. It preserves the existing model
// refresh/load flow while reporting OMR-specific top-level errors.
func run(w io.Writer) error {
	if err := config.RefreshModels(); err != nil {
		return fmt.Errorf("omr: refreshing models: %w", err)
	}

	state, err := config.Load()
	if err != nil {
		return fmt.Errorf("omr: loading config: %w", err)
	}

	if len(state.Models) == 0 {
		return fmt.Errorf(
			"omr: no models found via opencode CLI or provider config\n" +
				"  Ensure 'opencode models' works, or configure providers in ~/.config/opencode/opencode.json(c)",
		)
	}

	prefs, err := config.LoadPreferences()
	if err != nil {
		return fmt.Errorf("omr: loading preferences: %w", err)
	}

	m := tui.New(state, prefs)
	if _, err := runProgram(m); err != nil {
		if errors.Is(err, tea.ErrInterrupted) || errors.Is(err, tea.ErrProgramKilled) {
			return nil
		}
		return fmt.Errorf("omr: running TUI: %w", err)
	}
	return nil
}
