package config

import (
	"context"
	"fmt"
	"os/exec"
	"sort"
	"strings"
	"time"
)

// RefreshTimeout is the maximum time allowed for `opencode models --refresh`.
const RefreshTimeout = 30 * time.Second

// CommandRunner is the function used to run an external command.
// It is a package-level variable so tests can replace it without spawning
// real subprocesses.
//
// The function receives the command name and its arguments. It must return
// the combined stdout+stderr output and any error (including non-zero exit).
var CommandRunner func(ctx context.Context, name string, args ...string) ([]byte, error) = defaultCommandRunner

func defaultCommandRunner(ctx context.Context, name string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	return cmd.CombinedOutput()
}

// RefreshModels runs `opencode models --refresh` to update the provider model
// registry before the config is loaded. This ensures the model picker always
// shows the latest available models.
//
// Returns an error if:
//   - the `opencode` binary is not found in PATH
//   - the command exits with a non-zero status
//   - the command exceeds RefreshTimeout
func RefreshModels() error {
	ctx, cancel := context.WithTimeout(context.Background(), RefreshTimeout)
	defer cancel()

	out, err := CommandRunner(ctx, "opencode", "models", "--refresh")
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded || err == context.DeadlineExceeded {
			return fmt.Errorf(
				"opencode models --refresh timed out after %s; check your network connection or API key configuration",
				RefreshTimeout,
			)
		}
		if isNotFound(err) {
			return fmt.Errorf(
				"opencode binary not found in PATH; install opencode and ensure it is on your PATH, then retry",
			)
		}
		return fmt.Errorf(
			"opencode models --refresh failed: %w\n  Output: %s",
			err, string(out),
		)
	}
	return nil
}

// FetchTimeout is the maximum time allowed for `opencode models` (list only).
const FetchTimeout = 30 * time.Second

// FetchModels runs `opencode models` (without --refresh) and returns the
// parsed model list. It uses the same CommandRunner seam as RefreshModels so
// tests can inject fake output.
//
// Returns an error if:
//   - the `opencode` binary is not found in PATH
//   - the command exits with a non-zero status
//   - the command exceeds FetchTimeout
//
// Returns an empty slice (no error) when the command succeeds but produces no
// parseable model lines — callers should treat this as a signal to fall back
// to config-based discovery.
func FetchModels() ([]Model, error) {
	ctx, cancel := context.WithTimeout(context.Background(), FetchTimeout)
	defer cancel()

	out, err := CommandRunner(ctx, "opencode", "models")
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded || err == context.DeadlineExceeded {
			return nil, fmt.Errorf(
				"opencode models timed out after %s; check your network connection or API key configuration",
				FetchTimeout,
			)
		}
		if isNotFound(err) {
			return nil, fmt.Errorf(
				"opencode binary not found in PATH; install opencode and ensure it is on your PATH, then retry",
			)
		}
		return nil, fmt.Errorf("opencode models failed: %w\n  Output: %s", err, string(out))
	}

	return ParseModels(out), nil
}

// ParseModels parses the default `opencode models` output into a slice of
// Model values. The expected format is one `provider/model` ID per line.
//
// Parsing rules (locked to the documented CLI contract):
//   - Each line must contain at least one '/' separator
//   - The provider is the first path segment (before the first '/')
//   - The full line (trimmed) is the canonical model ID
//   - Lines that are blank or contain no '/' are silently skipped
//   - Lines where the provider or model portion is empty are skipped
//   - Duplicate IDs are deduplicated (first occurrence wins)
//   - Results are sorted deterministically by ID
func ParseModels(output []byte) []Model {
	seen := make(map[string]bool)
	var models []Model

	for _, raw := range strings.Split(string(output), "\n") {
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}

		idx := strings.Index(line, "/")
		if idx < 0 {
			continue // no separator — malformed
		}

		provider := line[:idx]
		modelPart := line[idx+1:]
		if provider == "" || modelPart == "" {
			continue // empty provider or empty model portion — malformed
		}

		id := line // full line is the canonical ID
		if seen[id] {
			continue
		}
		seen[id] = true

		// Name defaults to the model portion (after the first '/').
		// The config-based path uses the "name" field from JSON; here we
		// use the model portion as a reasonable display default.
		models = append(models, Model{
			Provider: provider,
			ID:       id,
			Name:     modelPart,
		})
	}

	sort.Slice(models, func(i, j int) bool {
		return models[i].ID < models[j].ID
	})

	return models
}

// isNotFound reports whether err indicates the binary was not found in PATH.
func isNotFound(err error) bool {
	if err == nil {
		return false
	}
	if err == exec.ErrNotFound {
		return true
	}
	// On some systems the error message describes the missing binary.
	msg := err.Error()
	return strings.Contains(msg, "executable file not found") ||
		strings.Contains(msg, "no such file or directory")
}
