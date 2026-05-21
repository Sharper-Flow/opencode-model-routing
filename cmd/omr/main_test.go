package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Sharper-Flow/opencode-model-routing/internal/config"
	tea "github.com/charmbracelet/bubbletea"
)

func withOMRCommandRunner(t *testing.T, fn func(ctx context.Context, name string, args ...string) ([]byte, error)) {
	t.Helper()
	orig := config.CommandRunner
	config.CommandRunner = fn
	t.Cleanup(func() { config.CommandRunner = orig })
}

func withOMRConfigDir(t *testing.T, jsonContent string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "opencode.json"), []byte(jsonContent), 0644); err != nil {
		t.Fatalf("writing test config: %v", err)
	}
	t.Setenv("OPENCODE_CONFIG_DIR", dir)
	return dir
}

func withOMRRunProgram(t *testing.T, fn func(m tea.Model) (tea.Model, error)) {
	t.Helper()
	orig := runProgram
	runProgram = fn
	t.Cleanup(func() { runProgram = orig })
}

func TestOMRRun_RefreshCalledBeforeLoad(t *testing.T) {
	var refreshCalled bool
	withOMRCommandRunner(t, func(ctx context.Context, name string, args ...string) ([]byte, error) {
		if name == "opencode" && len(args) == 2 && args[0] == "models" && args[1] == "--refresh" {
			refreshCalled = true
			return nil, nil
		}
		return nil, &omrExitErr{}
	})
	withOMRConfigDir(t, `{"provider": {"anthropic": {"models": {"claude-sonnet-4": {"name": "Claude Sonnet 4"}}}}}`)
	withOMRRunProgram(t, func(m tea.Model) (tea.Model, error) { return m, tea.ErrInterrupted })

	var buf bytes.Buffer
	_ = run(&buf)
	if !refreshCalled {
		t.Error("expected opencode models --refresh to be called on startup")
	}
}

func TestOMRRun_UsesOMRNoModelsError(t *testing.T) {
	withOMRCommandRunner(t, func(ctx context.Context, name string, args ...string) ([]byte, error) { return nil, nil })
	withOMRConfigDir(t, `{}`)

	var buf bytes.Buffer
	err := run(&buf)
	if err == nil {
		t.Fatal("expected error when no models found, got nil")
	}
	if !strings.Contains(err.Error(), "omr") || !strings.Contains(err.Error(), "no models found") {
		t.Fatalf("error = %q, want OMR-native no models message", err.Error())
	}
}

type omrExitErr struct{}

func (e *omrExitErr) Error() string { return "exit status 1" }
