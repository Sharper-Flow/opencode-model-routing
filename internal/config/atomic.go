// Package config — atomic.go
//
// Shared utilities for atomic file writes and pre-mutation backups, used by
// any config persistence path that needs crash-safety and rollback evidence.
package config

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const maxOpencodeBackups = 5

// writeFileAtomic writes data to path atomically using a temp file + rename,
// so a crash mid-write cannot corrupt the destination file.
func writeFileAtomic(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".omr-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	// Best-effort cleanup paths: Close/Remove errors in failure branches are
	// intentionally discarded — the primary error from Write/Close/Chmod is
	// what the caller needs, and a leaked tempfile in /tmp-style dirs is
	// noise, not a correctness issue.
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
		return err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpName)
		return err
	}
	if err := os.Chmod(tmpName, perm); err != nil {
		_ = os.Remove(tmpName)
		return err
	}
	return os.Rename(tmpName, path)
}

// writeBackup copies the file at path to <path>.omr-backup.<RFC3339-timestamp>
// before any destructive mutation. Returns nil silently when the source file
// does not exist (fresh-install case — nothing to back up). Any other error
// (read failure, write failure) is propagated so callers MUST handle it
// rather than silently swallowing.
//
// Backup permission is always 0600 because opencode.json may contain provider
// credentials or other sensitive OpenCode config content.
func writeBackup(path string) error {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("reading source for backup: %w", err)
	}
	// RFC3339Nano keeps filenames human-readable while avoiding collisions when
	// tests or scripts apply preferences multiple times in the same second.
	stamp := time.Now().UTC().Format(time.RFC3339Nano)
	backupPath := path + ".omr-backup." + stamp
	if err := os.WriteFile(backupPath, data, 0600); err != nil {
		return fmt.Errorf("writing backup %s: %w", backupPath, err)
	}
	return nil
}

func pruneBackups(path string, keep int) error {
	if keep < 0 {
		return fmt.Errorf("backup retention must be non-negative, got %d", keep)
	}

	dir := filepath.Dir(path)
	prefix := filepath.Base(path) + ".omr-backup."
	entries, err := os.ReadDir(dir)
	if err != nil {
		return fmt.Errorf("reading backup directory: %w", err)
	}

	type backupFile struct {
		name    string
		modTime time.Time
	}
	backups := make([]backupFile, 0)
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasPrefix(entry.Name(), prefix) {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			return fmt.Errorf("stat backup %s: %w", entry.Name(), err)
		}
		backups = append(backups, backupFile{name: entry.Name(), modTime: info.ModTime()})
	}

	sort.Slice(backups, func(i, j int) bool {
		if backups[i].modTime.Equal(backups[j].modTime) {
			return backups[i].name > backups[j].name
		}
		return backups[i].modTime.After(backups[j].modTime)
	})
	if len(backups) <= keep {
		return nil
	}

	for _, backup := range backups[keep:] {
		if err := os.Remove(filepath.Join(dir, backup.name)); err != nil {
			return fmt.Errorf("removing old backup %s: %w", backup.name, err)
		}
	}
	return nil
}
