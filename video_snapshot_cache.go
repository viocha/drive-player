package main

import (
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const maxVideoSnapshotPayloadBytes = 128 * 1024 * 1024

type VideoSnapshot struct {
	Position float64 `json:"position"`
	URL      string  `json:"url"`
}

type VideoSnapshotCacheStats struct {
	Count      int   `json:"count"`
	TotalBytes int64 `json:"totalBytes"`
}

type VideoSnapshotCache struct {
	mu       sync.Mutex
	dir      string
	maxAge   time.Duration
	maxBytes int64
}

type videoSnapshotFile struct {
	path    string
	name    string
	size    int64
	modTime time.Time
}

type videoSnapshotEntry struct {
	Position float64
	FileName string
}

func NewVideoSnapshotCache(dir string, maxAge time.Duration, maxBytes int64) (*VideoSnapshotCache, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("create video snapshot cache directory: %w", err)
	}
	cache := &VideoSnapshotCache{dir: dir, maxAge: maxAge, maxBytes: maxBytes}
	cache.mu.Lock()
	_, err := cache.pruneLocked(time.Now())
	cache.mu.Unlock()
	if err != nil {
		return nil, err
	}
	return cache, nil
}

func (c *VideoSnapshotCache) SetLimits(maxAge time.Duration, maxBytes int64) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.maxAge = maxAge
	c.maxBytes = maxBytes
	_, err := c.pruneLocked(time.Now())
	return err
}

func (c *VideoSnapshotCache) GetSeries(key string) ([]videoSnapshotEntry, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	now := time.Now()
	entries, err := os.ReadDir(c.dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read video snapshot cache directory: %w", err)
	}

	prefix := key + "--"
	result := make([]videoSnapshotEntry, 0, 10)
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasPrefix(entry.Name(), prefix) || !isVideoSnapshotCacheFile(entry.Name()) {
			continue
		}
		position, ok := videoSnapshotPosition(entry.Name(), prefix)
		if !ok {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		if c.maxAge > 0 && now.Sub(info.ModTime()) > c.maxAge {
			_ = os.Remove(filepath.Join(c.dir, entry.Name()))
			continue
		}
		result = append(result, videoSnapshotEntry{
			Position: position,
			FileName: entry.Name(),
		})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Position < result[j].Position })
	return result, nil
}

func (c *VideoSnapshotCache) Save(key string, position float64, dataURL string) (VideoSnapshotCacheStats, error) {
	if math.IsNaN(position) || math.IsInf(position, 0) || position < 0 {
		return VideoSnapshotCacheStats{}, errors.New("invalid video snapshot position")
	}
	data, err := decodeVideoSnapshotDataURL(dataURL)
	if err != nil {
		return VideoSnapshotCacheStats{}, err
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	if err := os.MkdirAll(c.dir, 0o700); err != nil {
		return VideoSnapshotCacheStats{}, fmt.Errorf("create video snapshot cache directory: %w", err)
	}

	baseName := fmt.Sprintf("%s--%012d", key, int64(math.Round(position*1000)))
	return c.saveImageLocked(baseName+".png", data)
}

func (c *VideoSnapshotCache) saveImageLocked(fileName string, data []byte) (VideoSnapshotCacheStats, error) {
	baseName := strings.TrimSuffix(fileName, filepath.Ext(fileName))
	finalPath := filepath.Join(c.dir, fileName)
	tmp, err := os.CreateTemp(c.dir, baseName+"-*.tmp")
	if err != nil {
		return VideoSnapshotCacheStats{}, fmt.Errorf("create video snapshot temp file: %w", err)
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return VideoSnapshotCacheStats{}, fmt.Errorf("set video snapshot permissions: %w", err)
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return VideoSnapshotCacheStats{}, fmt.Errorf("write video snapshot: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return VideoSnapshotCacheStats{}, fmt.Errorf("close video snapshot: %w", err)
	}
	_ = os.Remove(finalPath)
	if err := os.Rename(tmpPath, finalPath); err != nil {
		return VideoSnapshotCacheStats{}, fmt.Errorf("save video snapshot: %w", err)
	}
	now := time.Now()
	_ = os.Chtimes(finalPath, now, now)
	return c.pruneLocked(now)
}

// 封面和关键帧截图共享容量、有效期和淘汰规则。
func (c *VideoSnapshotCache) SaveCover(key, dataURL string) (VideoSnapshotCacheStats, error) {
	mimeType, data, err := decodeThumbnailDataURL(dataURL)
	if err != nil {
		return VideoSnapshotCacheStats{}, err
	}
	ext := map[string]string{"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}[mimeType]
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := os.MkdirAll(c.dir, 0o700); err != nil {
		return VideoSnapshotCacheStats{}, err
	}
	stats, err := c.saveImageLocked(key+"--cover"+ext, data)
	if err != nil {
		return stats, err
	}
	for _, other := range []string{".png", ".jpg", ".webp"} {
		if other != ext {
			_ = os.Remove(filepath.Join(c.dir, key+"--cover"+other))
		}
	}
	return c.pruneLocked(time.Now())
}

func (c *VideoSnapshotCache) GetCover(key string) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, ext := range []string{".webp", ".jpg", ".png"} {
		name := key + "--cover" + ext
		info, err := os.Stat(filepath.Join(c.dir, name))
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return "", err
		}
		if c.maxAge > 0 && time.Since(info.ModTime()) > c.maxAge {
			_ = os.Remove(filepath.Join(c.dir, name))
			continue
		}
		return name, nil
	}
	return "", nil
}

func (c *VideoSnapshotCache) ClearSeries(key string) (VideoSnapshotCacheStats, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	entries, err := os.ReadDir(c.dir)
	if errors.Is(err, os.ErrNotExist) {
		return VideoSnapshotCacheStats{}, nil
	}
	if err != nil {
		return VideoSnapshotCacheStats{}, fmt.Errorf("read video snapshot cache directory: %w", err)
	}
	prefix := key + "--"
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasPrefix(entry.Name(), prefix) || !isVideoSnapshotCacheFile(entry.Name()) {
			continue
		}
		if err := os.Remove(filepath.Join(c.dir, entry.Name())); err != nil && !errors.Is(err, os.ErrNotExist) {
			return VideoSnapshotCacheStats{}, fmt.Errorf("remove video snapshot: %w", err)
		}
	}
	return c.pruneLocked(time.Now())
}

func (c *VideoSnapshotCache) Stats() (VideoSnapshotCacheStats, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.pruneLocked(time.Now())
}

func (c *VideoSnapshotCache) Clear() (VideoSnapshotCacheStats, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	entries, err := os.ReadDir(c.dir)
	if errors.Is(err, os.ErrNotExist) {
		return VideoSnapshotCacheStats{}, nil
	}
	if err != nil {
		return VideoSnapshotCacheStats{}, fmt.Errorf("read video snapshot cache directory: %w", err)
	}
	for _, entry := range entries {
		if entry.IsDir() || !isVideoSnapshotCacheFile(entry.Name()) {
			continue
		}
		if err := os.Remove(filepath.Join(c.dir, entry.Name())); err != nil && !errors.Is(err, os.ErrNotExist) {
			return VideoSnapshotCacheStats{}, fmt.Errorf("remove video snapshot cache file: %w", err)
		}
	}
	return VideoSnapshotCacheStats{}, nil
}

func (c *VideoSnapshotCache) pruneLocked(now time.Time) (VideoSnapshotCacheStats, error) {
	files, err := c.listFilesLocked()
	if err != nil {
		return VideoSnapshotCacheStats{}, err
	}
	kept := files[:0]
	for _, file := range files {
		if c.maxAge > 0 && now.Sub(file.modTime) > c.maxAge {
			_ = os.Remove(file.path)
			continue
		}
		kept = append(kept, file)
	}
	files = kept
	sort.Slice(files, func(i, j int) bool { return files[i].modTime.Before(files[j].modTime) })
	var total int64
	for _, file := range files {
		total += file.size
	}
	for c.maxBytes > 0 && total > c.maxBytes && len(files) > 0 {
		oldest := files[0]
		files = files[1:]
		if err := os.Remove(oldest.path); err == nil || errors.Is(err, os.ErrNotExist) {
			total -= oldest.size
		}
	}
	return VideoSnapshotCacheStats{Count: len(files), TotalBytes: total}, nil
}

func (c *VideoSnapshotCache) listFilesLocked() ([]videoSnapshotFile, error) {
	entries, err := os.ReadDir(c.dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read video snapshot cache directory: %w", err)
	}
	files := make([]videoSnapshotFile, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !isVideoSnapshotCacheFile(entry.Name()) {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		files = append(files, videoSnapshotFile{
			path:    filepath.Join(c.dir, entry.Name()),
			name:    entry.Name(),
			size:    info.Size(),
			modTime: info.ModTime(),
		})
	}
	return files, nil
}

func decodeVideoSnapshotDataURL(value string) ([]byte, error) {
	header, payload, ok := strings.Cut(value, ",")
	if !ok || header != "data:image/png;base64" {
		return nil, errors.New("video snapshot must be a PNG data URL")
	}
	data, err := base64.StdEncoding.DecodeString(payload)
	if err != nil {
		return nil, errors.New("invalid video snapshot base64 data")
	}
	if len(data) == 0 {
		return nil, errors.New("video snapshot is empty")
	}
	if len(data) > maxVideoSnapshotPayloadBytes {
		return nil, fmt.Errorf("video snapshot exceeds %d bytes", maxVideoSnapshotPayloadBytes)
	}
	return data, nil
}

func isVideoSnapshotCacheFile(name string) bool {
	ext := strings.ToLower(filepath.Ext(name))
	return strings.Contains(name, "--") && (ext == ".png" || ((ext == ".jpg" || ext == ".webp") && strings.HasSuffix(strings.TrimSuffix(name, ext), "--cover")))
}

func videoSnapshotPosition(name, prefix string) (float64, bool) {
	base := strings.TrimSuffix(name, filepath.Ext(name))
	value := strings.TrimPrefix(base, prefix)
	if value == base || value == "" {
		return 0, false
	}
	millis, err := strconv.ParseInt(value, 10, 64)
	if err != nil || millis < 0 {
		return 0, false
	}
	return float64(millis) / 1000, true
}

func videoSnapshotCacheKey(accountKey, remotePath, modifiedAt string) string {
	source := strings.Join([]string{strings.TrimSpace(accountKey), normalizeRemotePath(remotePath), strings.TrimSpace(modifiedAt)}, "\n")
	return fmt.Sprintf("%x", sha256.Sum256([]byte(source)))
}
