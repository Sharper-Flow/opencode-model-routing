// Package config — atomic.go
//
// Shared utility for atomic file writes, used by SavePreferences and any
// future config persistence that needs crash-safe writes.
package config

import (
	"os"
	"path/filepath"
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
