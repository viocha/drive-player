package main

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// playbackProgressVersion identifies the on-disk playback progress schema.
const playbackProgressVersion = 1

type PlaybackProgressResult struct {
	Found     bool    `json:"found"`
	Position  float64 `json:"position"`
	Duration  float64 `json:"duration"`
	UpdatedAt string  `json:"updatedAt"`
}

type PlaybackProgressStats struct {
	Count      int   `json:"count"`
	TotalBytes int64 `json:"totalBytes"`
}

type playbackProgressRecord struct {
	Username  string    `json:"username"`
	Path      string    `json:"path"`
	Position  float64   `json:"position"`
	Duration  float64   `json:"duration"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type playbackProgressDisk struct {
	Version int                               `json:"version"`
	Entries map[string]playbackProgressRecord `json:"entries"`
}

type PlaybackProgressStore struct {
	mu       sync.Mutex
	filePath string
	maxAge   time.Duration
	maxBytes int64
	entries  map[string]playbackProgressRecord
}

func NewPlaybackProgressStore(filePath string, maxAge time.Duration, maxBytes int64) (*PlaybackProgressStore, error) {
	store := &PlaybackProgressStore{
		filePath: filePath,
		maxAge:   maxAge,
		maxBytes: maxBytes,
		entries:  make(map[string]playbackProgressRecord),
	}
	data, readErr := os.ReadFile(filePath)
	if readErr == nil {
		var disk playbackProgressDisk
		if json.Unmarshal(data, &disk) == nil && disk.Entries != nil {
			store.entries = disk.Entries
		}
	} else if !errors.Is(readErr, os.ErrNotExist) {
		return nil, fmt.Errorf("read playback progress: %w", readErr)
	}

	store.mu.Lock()
	changed := store.pruneAgeLocked(time.Now())
	changed = store.pruneCompletedLocked() || changed
	changed = store.pruneSizeLocked() || changed
	var err error
	if changed {
		err = store.persistLocked()
	}
	store.mu.Unlock()
	if err != nil {
		return nil, err
	}
	return store, nil
}

func (s *PlaybackProgressStore) Path() string {
	return s.filePath
}

func (s *PlaybackProgressStore) SetLimits(maxAge time.Duration, maxBytes int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.maxAge = maxAge
	s.maxBytes = maxBytes
	s.pruneAgeLocked(time.Now())
	s.pruneSizeLocked()
	return s.persistLocked()
}

func (s *PlaybackProgressStore) Get(username, remotePath string) (PlaybackProgressResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	changed := s.pruneAgeLocked(time.Now())
	changed = s.pruneCompletedLocked() || changed
	record, found := s.entries[playbackProgressKey(username, remotePath)]
	if changed {
		if err := s.persistLocked(); err != nil {
			return PlaybackProgressResult{}, err
		}
	}
	if !found {
		return PlaybackProgressResult{Found: false}, nil
	}
	return PlaybackProgressResult{
		Found:     true,
		Position:  record.Position,
		Duration:  record.Duration,
		UpdatedAt: record.UpdatedAt.Format(time.RFC3339),
	}, nil
}

func (s *PlaybackProgressStore) Save(username, remotePath string, position, duration float64) (PlaybackProgressStats, error) {
	if math.IsNaN(position) || math.IsInf(position, 0) || position < 0 {
		return PlaybackProgressStats{}, errors.New("invalid playback position")
	}
	if math.IsNaN(duration) || math.IsInf(duration, 0) || duration < 0 {
		return PlaybackProgressStats{}, errors.New("invalid playback duration")
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	key := playbackProgressKey(username, remotePath)
	now := time.Now()
	s.pruneAgeLocked(now)
	if duration > 0 && position >= duration {
		delete(s.entries, key)
	} else {
		s.entries[key] = playbackProgressRecord{
			Username:  strings.TrimSpace(username),
			Path:      normalizeRemotePath(remotePath),
			Position:  position,
			Duration:  duration,
			UpdatedAt: now,
		}
	}
	s.pruneSizeLocked()
	if err := s.persistLocked(); err != nil {
		return PlaybackProgressStats{}, err
	}
	return s.statsLocked(), nil
}

func (s *PlaybackProgressStore) Stats() (PlaybackProgressStats, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.pruneAgeLocked(time.Now()) || s.pruneCompletedLocked() || s.pruneSizeLocked() {
		if err := s.persistLocked(); err != nil {
			return PlaybackProgressStats{}, err
		}
	}
	return s.statsLocked(), nil
}

func (s *PlaybackProgressStore) Clear() (PlaybackProgressStats, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.entries = make(map[string]playbackProgressRecord)
	if err := os.Remove(s.filePath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return PlaybackProgressStats{}, fmt.Errorf("remove playback progress: %w", err)
	}
	return PlaybackProgressStats{}, nil
}

func (s *PlaybackProgressStore) pruneCompletedLocked() bool {
	changed := false
	for key, record := range s.entries {
		if record.Duration > 0 && record.Position >= record.Duration {
			delete(s.entries, key)
			changed = true
		}
	}
	return changed
}

func (s *PlaybackProgressStore) pruneAgeLocked(now time.Time) bool {
	if s.maxAge <= 0 {
		return false
	}
	changed := false
	for key, record := range s.entries {
		if record.UpdatedAt.IsZero() || now.Sub(record.UpdatedAt) > s.maxAge {
			delete(s.entries, key)
			changed = true
		}
	}
	return changed
}

func (s *PlaybackProgressStore) pruneSizeLocked() bool {
	if s.maxBytes <= 0 {
		return false
	}
	changed := false
	for len(s.entries) > 0 {
		data, err := s.marshalLocked()
		if err != nil || int64(len(data)) <= s.maxBytes {
			break
		}
		keys := make([]string, 0, len(s.entries))
		for key := range s.entries {
			keys = append(keys, key)
		}
		sort.Slice(keys, func(i, j int) bool {
			return s.entries[keys[i]].UpdatedAt.Before(s.entries[keys[j]].UpdatedAt)
		})
		delete(s.entries, keys[0])
		changed = true
	}
	return changed
}

func (s *PlaybackProgressStore) persistLocked() error {
	if len(s.entries) == 0 {
		if err := os.Remove(s.filePath); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("remove empty playback progress: %w", err)
		}
		return nil
	}
	data, err := s.marshalLocked()
	if err != nil {
		return err
	}
	dir := filepath.Dir(s.filePath)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create playback progress directory: %w", err)
	}
	tmp, err := os.CreateTemp(dir, "playback-progress-*.tmp")
	if err != nil {
		return fmt.Errorf("create playback progress temp file: %w", err)
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("set playback progress permissions: %w", err)
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write playback progress: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close playback progress: %w", err)
	}
	_ = os.Remove(s.filePath)
	if err := os.Rename(tmpPath, s.filePath); err != nil {
		return fmt.Errorf("save playback progress: %w", err)
	}
	return nil
}

func (s *PlaybackProgressStore) marshalLocked() ([]byte, error) {
	data, err := json.MarshalIndent(playbackProgressDisk{Version: playbackProgressVersion, Entries: s.entries}, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("encode playback progress: %w", err)
	}
	return data, nil
}

func (s *PlaybackProgressStore) statsLocked() PlaybackProgressStats {
	if len(s.entries) == 0 {
		return PlaybackProgressStats{}
	}
	data, err := s.marshalLocked()
	if err != nil {
		return PlaybackProgressStats{Count: len(s.entries)}
	}
	return PlaybackProgressStats{Count: len(s.entries), TotalBytes: int64(len(data))}
}

func playbackProgressKey(username, remotePath string) string {
	source := strings.TrimSpace(username) + "\n" + normalizeRemotePath(remotePath)
	return fmt.Sprintf("%x", sha256.Sum256([]byte(source)))
}
