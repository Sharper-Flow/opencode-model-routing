// Package config — atomic.go
//
// Shared utilities for atomic file writes and pre-mutation backups, used by
// any config persistence path that needs crash-safety and rollback evidence.
package config

import (
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// writeFileAtomic writes data to path atomically using a temp file + rename,
// so a crash mid-write cannot corrupt the destination file.
func writeFileAtomic(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".omp-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return err
	}
	if err := os.Chmod(tmpName, perm); err != nil {
		os.Remove(tmpName)
		return err
	}
	return os.Rename(tmpName, path)
}

// writeBackup copies the file at path to <path>.omp-backup.<RFC3339-timestamp>
// before any destructive mutation. Returns nil silently when the source file
// does not exist (fresh-install case — nothing to back up). Any other error
// (read failure, write failure) is propagated so callers MUST handle it
// rather than silently swallowing.
//
// Backup permission mirrors the writeFileAtomic default (0600) because the
// backup may contain provider credentials or other sensitive opencode.json
// content. The caller is responsible for periodic cleanup of accumulated
// backup files.
func writeBackup(path string) error {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("reading source for backup: %w", err)
	}
	// RFC3339 is filesystem-safe and human-readable. Colons are valid on the
	// platforms we target (linux/macOS); the alternative `RFC3339Nano` would
	// add nanosecond precision but the use case (rollback evidence) doesn't
	// need it.
	stamp := time.Now().UTC().Format(time.RFC3339)
	backupPath := path + ".omp-backup." + stamp
	if err := os.WriteFile(backupPath, data, 0600); err != nil {
		return fmt.Errorf("writing backup %s: %w", backupPath, err)
	}
	return nil
}
