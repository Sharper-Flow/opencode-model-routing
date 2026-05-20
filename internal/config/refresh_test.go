package config

import (
	"context"
	"errors"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// withCommandRunner temporarily replaces CommandRunner for the duration of the
// test and restores it on cleanup.
func withCommandRunner(t *testing.T, fn func(ctx context.Context, name string, args ...string) ([]byte, error)) {
	t.Helper()
	orig := CommandRunner
	CommandRunner = fn
	t.Cleanup(func() { CommandRunner = orig })
}

func TestRefreshModels_Success(t *testing.T) {
	withCommandRunner(t, func(ctx context.Context, name string, args ...string) ([]byte, error) {
		if name != "opencode" || len(args) < 2 || args[0] != "models" || args[1] != "--refresh" {
			t.Errorf("unexpected command: %s %v", name, args)
		}
		return []byte("refreshed 42 models"), nil
	})

	if err := RefreshModels(); err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
}

func TestRefreshModels_NonZeroExit(t *testing.T) {
	withCommandRunner(t, func(ctx context.Context, name string, args ...string) ([]byte, error) {
		return []byte("API error: unauthorized"), &exec.ExitError{}
	})

	err := RefreshModels()
	if err == nil {
		t.Fatal("expected error on non-zero exit, got nil")
	}
	if !strings.Contains(err.Error(), "failed") {
		t.Errorf("error should mention 'failed', got: %v", err)
	}
	if !strings.Contains(err.Error(), "API error: unauthorized") {
		t.Errorf("error should include command output, got: %v", err)
	}
}

func TestRefreshModels_BinaryNotFound(t *testing.T) {
	withCommandRunner(t, func(ctx context.Context, name string, args ...string) ([]byte, error) {
		return nil, exec.ErrNotFound
	})

	err := RefreshModels()
	if err == nil {
		t.Fatal("expected error when binary not found, got nil")
	}
	if !strings.Contains(err.Error(), "not found in PATH") {
		t.Errorf("error should mention PATH, got: %v", err)
	}
}

func TestRefreshModels_BinaryNotFoundByMessage(t *testing.T) {
	withCommandRunner(t, func(ctx context.Context, name string, args ...string) ([]byte, error) {
		return nil, errors.New("executable file not found in $PATH")
	})

	err := RefreshModels()
	if err == nil {
		t.Fatal("expected error when binary not found, got nil")
	}
	if !strings.Contains(err.Error(), "not found in PATH") {
		t.Errorf("error should mention PATH, got: %v", err)
	}
}

func TestRefreshModels_Timeout(t *testing.T) {
	withCommandRunner(t, func(ctx context.Context, name string, args ...string) ([]byte, error) {
		// Simulate the context being cancelled (deadline exceeded)
		<-ctx.Done()
		return nil, ctx.Err()
	})

	// Override timeout to something very short so the test doesn't take 30s
	orig := RefreshTimeout
	// We can't change the const, but we can test the timeout path by making
	// the runner return a deadline-exceeded error directly.
	_ = orig

	withCommandRunner(t, func(ctx context.Context, name string, args ...string) ([]byte, error) {
		return nil, context.DeadlineExceeded
	})

	err := RefreshModels()
	if err == nil {
		t.Fatal("expected timeout error, got nil")
	}
	if !strings.Contains(err.Error(), "timed out") {
		t.Errorf("error should mention timeout, got: %v", err)
	}
}

func TestRefreshModels_CommandArgs(t *testing.T) {
	var gotName string
	var gotArgs []string

	withCommandRunner(t, func(ctx context.Context, name string, args ...string) ([]byte, error) {
		gotName = name
		gotArgs = args
		return nil, nil
	})

	_ = RefreshModels()

	if gotName != "opencode" {
		t.Errorf("command name = %q, want opencode", gotName)
	}
	if len(gotArgs) != 2 || gotArgs[0] != "models" || gotArgs[1] != "--refresh" {
		t.Errorf("args = %v, want [models --refresh]", gotArgs)
	}
}

func TestRefreshModels_ContextHasTimeout(t *testing.T) {
	var deadline time.Time
	var hasDeadline bool

	withCommandRunner(t, func(ctx context.Context, name string, args ...string) ([]byte, error) {
		deadline, hasDeadline = ctx.Deadline()
		return nil, nil
	})

	before := time.Now()
	_ = RefreshModels()

	if !hasDeadline {
		t.Error("context should have a deadline set")
	}
	if deadline.Before(before) {
		t.Error("deadline should be in the future")
	}
	if deadline.After(before.Add(RefreshTimeout + time.Second)) {
		t.Errorf("deadline %v is too far in the future (expected ~%s)", deadline, RefreshTimeout)
	}
}

// -- ParseModels tests -------------------------------------------------------
// These tests lock the CLI contract: `opencode models` outputs one
// `provider/model` ID per line. Each line must contain at least one `/` with
// non-empty provider and model portions (multi-slash IDs like
// "openrouter/anthropic/claude-haiku-4.5:nitro" are valid). Blank lines and
// non-conforming lines are silently skipped. Results are deduped and sorted by ID.

func TestParseModels_BasicLines(t *testing.T) {
	input := "anthropic/claude-sonnet-4-6\ngoogle/gemini-2.5-pro\nopenai/gpt-5\n"
	models := ParseModels([]byte(input))
	if len(models) != 3 {
		t.Fatalf("expected 3 models, got %d: %v", len(models), models)
	}
	// Should be sorted by ID
	if models[0].ID != "anthropic/claude-sonnet-4-6" {
		t.Errorf("models[0].ID = %q, want anthropic/claude-sonnet-4-6", models[0].ID)
	}
	if models[1].ID != "google/gemini-2.5-pro" {
		t.Errorf("models[1].ID = %q, want google/gemini-2.5-pro", models[1].ID)
	}
	if models[2].ID != "openai/gpt-5" {
		t.Errorf("models[2].ID = %q, want openai/gpt-5", models[2].ID)
	}
}

func TestParseModels_ProviderAndIDExtracted(t *testing.T) {
	input := "anthropic/claude-sonnet-4-6\n"
	models := ParseModels([]byte(input))
	if len(models) != 1 {
		t.Fatalf("expected 1 model, got %d", len(models))
	}
	if models[0].Provider != "anthropic" {
		t.Errorf("Provider = %q, want anthropic", models[0].Provider)
	}
	if models[0].ID != "anthropic/claude-sonnet-4-6" {
		t.Errorf("ID = %q, want anthropic/claude-sonnet-4-6", models[0].ID)
	}
	// Name defaults to model part when no display name available
	if models[0].Name != "claude-sonnet-4-6" {
		t.Errorf("Name = %q, want claude-sonnet-4-6", models[0].Name)
	}
}

func TestParseModels_SkipsBlankLines(t *testing.T) {
	input := "\nanthropic/claude-sonnet-4-6\n\ngoogle/gemini-2.5-pro\n\n"
	models := ParseModels([]byte(input))
	if len(models) != 2 {
		t.Fatalf("expected 2 models (blank lines skipped), got %d", len(models))
	}
}

func TestParseModels_SkipsMalformedLines(t *testing.T) {
	// Lines without exactly one '/' separator are malformed
	input := "notamodel\nanthropic/claude-sonnet-4-6\njust-a-word\n/leading-slash\ntrailing-slash/\n"
	models := ParseModels([]byte(input))
	if len(models) != 1 {
		t.Fatalf("expected 1 valid model, got %d: %v", len(models), models)
	}
	if models[0].ID != "anthropic/claude-sonnet-4-6" {
		t.Errorf("ID = %q, want anthropic/claude-sonnet-4-6", models[0].ID)
	}
}

func TestParseModels_DedupeByID(t *testing.T) {
	input := "anthropic/claude-sonnet-4-6\nanthropic/claude-sonnet-4-6\ngoogle/gemini-2.5-pro\n"
	models := ParseModels([]byte(input))
	if len(models) != 2 {
		t.Fatalf("expected 2 models after dedupe, got %d", len(models))
	}
}

func TestParseModels_DeterministicSort(t *testing.T) {
	// Provide in reverse order; expect sorted output
	input := "openai/gpt-5\ngoogle/gemini-2.5-pro\nanthropic/claude-sonnet-4-6\n"
	models := ParseModels([]byte(input))
	if len(models) != 3 {
		t.Fatalf("expected 3 models, got %d", len(models))
	}
	if models[0].ID != "anthropic/claude-sonnet-4-6" {
		t.Errorf("models[0].ID = %q, want anthropic/claude-sonnet-4-6 (sorted)", models[0].ID)
	}
	if models[2].ID != "openai/gpt-5" {
		t.Errorf("models[2].ID = %q, want openai/gpt-5 (sorted)", models[2].ID)
	}
}

func TestParseModels_EmptyInput(t *testing.T) {
	models := ParseModels([]byte(""))
	if len(models) != 0 {
		t.Errorf("expected 0 models for empty input, got %d", len(models))
	}
}

func TestParseModels_MultiSlashIDIsValid(t *testing.T) {
	// IDs like openrouter/anthropic/claude-haiku-4.5:nitro have multiple slashes
	// The provider is the first segment; the rest is the model ID portion.
	// The full ID is the whole line.
	input := "openrouter/anthropic/claude-haiku-4.5:nitro\n"
	models := ParseModels([]byte(input))
	if len(models) != 1 {
		t.Fatalf("expected 1 model for multi-slash ID, got %d", len(models))
	}
	if models[0].Provider != "openrouter" {
		t.Errorf("Provider = %q, want openrouter", models[0].Provider)
	}
	if models[0].ID != "openrouter/anthropic/claude-haiku-4.5:nitro" {
		t.Errorf("ID = %q, want openrouter/anthropic/claude-haiku-4.5:nitro", models[0].ID)
	}
}

// -- FetchModels tests -------------------------------------------------------
// FetchModels runs `opencode models` (no --refresh) and returns parsed []Model.

func TestFetchModels_Success(t *testing.T) {
	withCommandRunner(t, func(ctx context.Context, name string, args ...string) ([]byte, error) {
		if name == "opencode" && len(args) == 2 && args[0] == "models" && args[1] == "--refresh" {
			return nil, nil // refresh call
		}
		if name == "opencode" && len(args) == 1 && args[0] == "models" {
			return []byte("anthropic/claude-sonnet-4-6\ngoogle/gemini-2.5-pro\n"), nil
		}
		t.Errorf("unexpected command: %s %v", name, args)
		return nil, nil
	})

	models, err := FetchModels()
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
	if len(models) != 2 {
		t.Fatalf("expected 2 models, got %d", len(models))
	}
}

func TestFetchModels_CommandArgs(t *testing.T) {
	var gotName string
	var gotArgs []string

	withCommandRunner(t, func(ctx context.Context, name string, args ...string) ([]byte, error) {
		// Capture the non-refresh call
		if len(args) == 1 && args[0] == "models" {
			gotName = name
			gotArgs = args
		}
		return nil, nil
	})

	_, _ = FetchModels()

	if gotName != "opencode" {
		t.Errorf("command name = %q, want opencode", gotName)
	}
	if len(gotArgs) != 1 || gotArgs[0] != "models" {
		t.Errorf("args = %v, want [models]", gotArgs)
	}
}

func TestFetchModels_NoVerboseFlag(t *testing.T) {
	// Ensure --verbose is never passed (machine consumption uses default output)
	withCommandRunner(t, func(ctx context.Context, name string, args ...string) ([]byte, error) {
		for _, arg := range args {
			if arg == "--verbose" || arg == "-v" {
				t.Errorf("FetchModels must not pass verbose flag, got args: %v", args)
			}
		}
		return []byte("anthropic/claude-sonnet-4-6\n"), nil
	})

	_, _ = FetchModels()
}

func TestFetchModels_BinaryNotFound(t *testing.T) {
	withCommandRunner(t, func(ctx context.Context, name string, args ...string) ([]byte, error) {
		return nil, exec.ErrNotFound
	})

	_, err := FetchModels()
	if err == nil {
		t.Fatal("expected error when binary not found, got nil")
	}
}

func TestFetchModels_NonZeroExitReturnsError(t *testing.T) {
	withCommandRunner(t, func(ctx context.Context, name string, args ...string) ([]byte, error) {
		return []byte("some error output"), &exec.ExitError{}
	})

	_, err := FetchModels()
	if err == nil {
		t.Fatal("expected error on non-zero exit, got nil")
	}
}

func TestFetchModels_EmptyOutputReturnsEmpty(t *testing.T) {
	withCommandRunner(t, func(ctx context.Context, name string, args ...string) ([]byte, error) {
		return []byte(""), nil
	})

	models, err := FetchModels()
	if err != nil {
		t.Fatalf("expected no error for empty output, got: %v", err)
	}
	if len(models) != 0 {
		t.Errorf("expected 0 models for empty output, got %d", len(models))
	}
}

func TestFetchModels_HasTimeout(t *testing.T) {
	var hasDeadline bool

	withCommandRunner(t, func(ctx context.Context, name string, args ...string) ([]byte, error) {
		if len(args) == 1 && args[0] == "models" {
			_, hasDeadline = ctx.Deadline()
		}
		return []byte("anthropic/claude-sonnet-4-6\n"), nil
	})

	_, _ = FetchModels()

	if !hasDeadline {
		t.Error("FetchModels context should have a deadline set")
	}
}

func TestIsNotFound(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want bool
	}{
		{"nil", nil, false},
		{"exec.ErrNotFound", exec.ErrNotFound, true},
		{"executable file not found", errors.New("executable file not found in $PATH"), true},
		{"no such file or directory", errors.New("fork/exec /usr/bin/opencode: no such file or directory"), true},
		{"exit error", &exec.ExitError{}, false},
		{"generic error", errors.New("some other error"), false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := isNotFound(tt.err)
			if got != tt.want {
				t.Errorf("isNotFound(%v) = %v, want %v", tt.err, got, tt.want)
			}
		})
	}
}
