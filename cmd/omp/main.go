package main

import (
	"errors"
	"fmt"
	"io"
	"os"

	"github.com/sharperflow/opencode-model-preferences/internal/config"
	"github.com/sharperflow/opencode-model-preferences/internal/tui"
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

// run is the testable entry point. It writes errors to w and returns them so
// callers can inspect without os.Exit coupling.
func run(w io.Writer) error {
	// Refresh the provider model registry before loading config so the picker
	// always shows the latest available models.
	if err := config.RefreshModels(); err != nil {
		return fmt.Errorf("refreshing models: %w", err)
	}

	state, err := config.Load()
	if err != nil {
		return fmt.Errorf("loading config: %w", err)
	}

	if len(state.Models) == 0 {
		return fmt.Errorf(
			"no models found via opencode CLI or provider config\n" +
				"  Ensure 'opencode models' works, or configure providers in ~/.config/opencode/opencode.json",
		)
	}

	prefs, err := config.LoadPreferences()
	if err != nil {
		return fmt.Errorf("loading preferences: %w", err)
	}

	m := tui.New(state, prefs)
	if _, err := runProgram(m); err != nil {
		if errors.Is(err, tea.ErrInterrupted) || errors.Is(err, tea.ErrProgramKilled) {
			return nil
		}
		return fmt.Errorf("running TUI: %w", err)
	}
	return nil
}
