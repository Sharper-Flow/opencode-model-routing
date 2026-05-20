package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/sharperflow/opencode-model-preferences/internal/config"
	tea "github.com/charmbracelet/bubbletea"
)

// withCommandRunner temporarily replaces config.CommandRunner for the test.
func withCommandRunner(t *testing.T, fn func(ctx context.Context, name string, args ...string) ([]byte, error)) {
	t.Helper()
	orig := config.CommandRunner
	config.CommandRunner = fn
	t.Cleanup(func() { config.CommandRunner = orig })
}

// withConfigDir sets OPENCODE_CONFIG_DIR to a temp dir containing opencode.json
// with the given content, and restores the env var on cleanup.
func withConfigDir(t *testing.T, jsonContent string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "opencode.json"), []byte(jsonContent), 0644); err != nil {
		t.Fatalf("writing test config: %v", err)
	}
	t.Setenv("OPENCODE_CONFIG_DIR", dir)
	return dir
}

func withRunProgram(t *testing.T, fn func(m tea.Model) (tea.Model, error)) {
	t.Helper()
	orig := runProgram
	runProgram = fn
	t.Cleanup(func() { runProgram = orig })
}

func TestRun_RefreshCalledBeforeLoad(t *testing.T) {
	var refreshCalled bool

	withCommandRunner(t, func(ctx context.Context, name string, args ...string) ([]byte, error) {
		if name == "opencode" && len(args) == 2 && args[0] == "models" && args[1] == "--refresh" {
			refreshCalled = true
			return nil, nil
		}
		// For the `opencode models` fetch call inside Load, return an error so
		// the fallback path is used and the TUI doesn't hang waiting for input.
		return nil, &exitErr{}
	})

	// Config with at least one model so run() doesn't fail on "no models"
	withConfigDir(t, `{
		"provider": {
			"anthropic": {
				"models": {
					"claude-sonnet-4": {"name": "Claude Sonnet 4"}
				}
			}
		}
	}`)

	// Mock runProgram so the TUI doesn't hang waiting for a TTY.
	withRunProgram(t, func(m tea.Model) (tea.Model, error) {
		return m, tea.ErrInterrupted
	})

	var buf bytes.Buffer
	_ = run(&buf)

	if !refreshCalled {
		t.Error("expected opencode models --refresh to be called on startup")
	}
}

func TestRun_RefreshFailureBlocksLaunch(t *testing.T) {
	withCommandRunner(t, func(ctx context.Context, name string, args ...string) ([]byte, error) {
		return nil, context.DeadlineExceeded
	})

	withConfigDir(t, `{"provider": {"anthropic": {"models": {"claude-sonnet-4": {}}}}}`)

	var buf bytes.Buffer
	err := run(&buf)

	if err == nil {
		t.Fatal("expected error when refresh fails, got nil")
	}
	if !strings.Contains(err.Error(), "refreshing models") {
		t.Errorf("error should mention 'refreshing models', got: %v", err)
	}
}

func TestRun_RefreshCommandIsCorrect(t *testing.T) {
	var refreshArgs []string

	withCommandRunner(t, func(ctx context.Context, name string, args ...string) ([]byte, error) {
		// Capture the --refresh call specifically
		if name == "opencode" && len(args) == 2 && args[0] == "models" && args[1] == "--refresh" {
			refreshArgs = args
		}
		return nil, nil
	})

	withConfigDir(t, `{"provider": {"anthropic": {"models": {"claude-sonnet-4": {}}}}}`)

	// Mock runProgram so the TUI doesn't hang waiting for a TTY.
	withRunProgram(t, func(m tea.Model) (tea.Model, error) {
		return m, tea.ErrInterrupted
	})

	var buf bytes.Buffer
	_ = run(&buf)

	if len(refreshArgs) != 2 || refreshArgs[0] != "models" || refreshArgs[1] != "--refresh" {
		t.Errorf("refresh args = %v, want [models --refresh]", refreshArgs)
	}
}

// TestRun_CLIFetchFailureAllowsLaunchWithConfigModels verifies that when the
// `opencode models` fetch (inside Load) fails, startup still succeeds as long
// as the config has provider models to fall back to.
func TestRun_CLIFetchFailureAllowsLaunchWithConfigModels(t *testing.T) {
	withCommandRunner(t, func(ctx context.Context, name string, args ...string) ([]byte, error) {
		if name == "opencode" && len(args) == 2 && args[0] == "models" && args[1] == "--refresh" {
			return nil, nil // refresh succeeds
		}
		if name == "opencode" && len(args) == 1 && args[0] == "models" {
			return []byte("error: provider unavailable"), &exitErr{} // fetch fails
		}
		return nil, nil
	})

	// Config has models — fallback should kick in
	withConfigDir(t, `{"provider": {"anthropic": {"models": {"claude-sonnet-4": {"name": "Claude Sonnet 4"}}}}}`)

	// Mock runProgram so the TUI doesn't hang waiting for a TTY.
	withRunProgram(t, func(m tea.Model) (tea.Model, error) {
		return m, tea.ErrInterrupted
	})

	var buf bytes.Buffer
	err := run(&buf)

	// run() must NOT fail with "no models found" — fallback to config models should succeed
	if err != nil && strings.Contains(err.Error(), "no models found") {
		t.Errorf("CLI fetch failure should fall back to config models, not report 'no models found': %v", err)
	}
}

// TestRun_BothCLIAndConfigEmptyFails verifies that when both CLI fetch and
// config models are empty, run() still returns the "no models found" error.
func TestRun_BothCLIAndConfigEmptyFails(t *testing.T) {
	withCommandRunner(t, func(ctx context.Context, name string, args ...string) ([]byte, error) {
		return nil, nil // all commands succeed but return nothing useful
	})

	// Config has no provider models
	withConfigDir(t, `{}`)

	var buf bytes.Buffer
	err := run(&buf)

	if err == nil {
		t.Fatal("expected error when both CLI and config have no models, got nil")
	}
	if !strings.Contains(err.Error(), "no models found") {
		t.Errorf("error should mention 'no models found', got: %v", err)
	}
}

// exitErr is a minimal error type that satisfies the non-zero exit check.
type exitErr struct{}

func (e *exitErr) Error() string { return "exit status 1" }

func TestRun_NoModelsAfterRefresh(t *testing.T) {
	withCommandRunner(t, func(ctx context.Context, name string, args ...string) ([]byte, error) {
		return nil, nil // refresh succeeds
	})

	// Config with no provider models
	withConfigDir(t, `{}`)

	var buf bytes.Buffer
	err := run(&buf)

	if err == nil {
		t.Fatal("expected error when no models found, got nil")
	}
	if !strings.Contains(err.Error(), "no models found") {
		t.Errorf("error should mention 'no models found', got: %v", err)
	}
}

func TestRun_InterruptedIsGracefulExit(t *testing.T) {
	withCommandRunner(t, func(ctx context.Context, name string, args ...string) ([]byte, error) {
		if name == "opencode" && len(args) == 2 && args[0] == "models" && args[1] == "--refresh" {
			return nil, nil
		}
		return nil, &exitErr{}
	})

	withConfigDir(t, `{"provider": {"anthropic": {"models": {"claude-sonnet-4": {"name": "Claude Sonnet 4"}}}}}`)
	withRunProgram(t, func(m tea.Model) (tea.Model, error) {
		return nil, tea.ErrInterrupted
	})

	var buf bytes.Buffer
	err := run(&buf)
	if err != nil {
		t.Fatalf("expected nil error for interrupted close, got: %v", err)
	}
}

func TestRun_ProgramKilledIsGracefulExit(t *testing.T) {
	withCommandRunner(t, func(ctx context.Context, name string, args ...string) ([]byte, error) {
		if name == "opencode" && len(args) == 2 && args[0] == "models" && args[1] == "--refresh" {
			return nil, nil
		}
		return nil, &exitErr{}
	})

	withConfigDir(t, `{"provider": {"anthropic": {"models": {"claude-sonnet-4": {"name": "Claude Sonnet 4"}}}}}`)
	withRunProgram(t, func(m tea.Model) (tea.Model, error) {
		return nil, tea.ErrProgramKilled
	})

	var buf bytes.Buffer
	err := run(&buf)
	if err != nil {
		t.Fatalf("expected nil error for killed close, got: %v", err)
	}
}

func TestRun_NonInterruptProgramErrorStillFails(t *testing.T) {
	withCommandRunner(t, func(ctx context.Context, name string, args ...string) ([]byte, error) {
		if name == "opencode" && len(args) == 2 && args[0] == "models" && args[1] == "--refresh" {
			return nil, nil
		}
		return nil, &exitErr{}
	})

	withConfigDir(t, `{"provider": {"anthropic": {"models": {"claude-sonnet-4": {"name": "Claude Sonnet 4"}}}}}`)
	withRunProgram(t, func(m tea.Model) (tea.Model, error) {
		return nil, errors.New("boom")
	})

	var buf bytes.Buffer
	err := run(&buf)
	if err == nil {
		t.Fatal("expected error for non-interrupt program failure, got nil")
	}
	if !strings.Contains(err.Error(), "running TUI") {
		t.Fatalf("expected wrapped running TUI error, got: %v", err)
	}
}
