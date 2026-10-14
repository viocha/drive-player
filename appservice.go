package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	defaultVideoDataMaxAgeMinutes              = 60
	defaultVideoDataMaxSizeMB                  = 512
	defaultVideoMetadataMaxAgeDays             = 365
	defaultVideoMetadataMaxSizeMB              = 16
	defaultVideoMetadataThumbnailOffsetPercent = 10
	defaultVideoSnapshotMaxAgeDays             = 365
	defaultVideoSnapshotMaxSizeMB              = 512
	defaultPlaybackMaxAgeDays                  = 365
	defaultPlaybackMaxSizeMB                   = 16
	defaultFullscreenHUDEnabled                = false
	defaultFullscreenHUDSideOffsetPX           = 0
	defaultMobileLongPressRate                 = 3.0
	minVideoMetadataMaxAgeDays                 = 1
	maxVideoMetadataMaxAgeDays                 = 3650
	minVideoMetadataMaxSizeMB                  = 16
	maxVideoMetadataMaxSizeMB                  = 10240
	minVideoMetadataThumbnailOffsetPercent     = 0
	maxVideoMetadataThumbnailOffsetPercent     = 100
	minVideoSnapshotMaxAgeDays                 = 1
	maxVideoSnapshotMaxAgeDays                 = 3650
	minVideoSnapshotMaxSizeMB                  = 64
	maxVideoSnapshotMaxSizeMB                  = 10240
	minPlaybackMaxAgeDays                      = 1
	maxPlaybackMaxAgeDays                      = 3650
	minPlaybackMaxSizeMB                       = 1
	maxPlaybackMaxSizeMB                       = 1024
	minFullscreenHUDSideOffsetPX               = 0
	maxFullscreenHUDSideOffsetPX               = 200
	minMobileLongPressRate                     = 1.0
	maxMobileLongPressRate                     = 8.0
)

type AppState struct {
	VideoDataMaxAgeMinutes              int                  `json:"videoDataMaxAgeMinutes"`
	VideoDataMaxSizeMB                  int                  `json:"videoDataMaxSizeMB"`
	Connected                           bool                 `json:"connected"`
	Accounts                            []WebDAVAccountState `json:"accounts"`
	ActiveAccountID                     string               `json:"activeAccountId"`
	VideoMetadataMaxAgeDays             int                  `json:"videoMetadataMaxAgeDays"`
	VideoMetadataMaxSizeMB              int                  `json:"videoMetadataMaxSizeMB"`
	VideoMetadataThumbnailOffsetPercent int                  `json:"videoMetadataThumbnailOffsetPercent"`
	VideoSnapshotMaxAgeDays             int                  `json:"videoSnapshotMaxAgeDays"`
	VideoSnapshotMaxSizeMB              int                  `json:"videoSnapshotMaxSizeMB"`
	PlaybackMaxAgeDays                  int                  `json:"playbackMaxAgeDays"`
	PlaybackMaxSizeMB                   int                  `json:"playbackMaxSizeMB"`
	FullscreenHUDEnabled                bool                 `json:"fullscreenHudEnabled"`
	FullscreenHUDSideOffsetPX           int                  `json:"fullscreenHudSideOffsetPx"`
	MobileLongPressRate                 float64              `json:"mobileLongPressRate"`
	StorageDirectory                    string               `json:"storageDirectory"`
	ConfigPath                          string               `json:"configPath"`
	VideoMetadataDirectory              string               `json:"videoMetadataDirectory"`
	VideoSnapshotDirectory              string               `json:"videoSnapshotDirectory"`
	PlaybackProgressPath                string               `json:"playbackProgressPath"`
}

type WebDAVAccount struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Endpoint string `json:"endpoint"`
	Username string `json:"username"`
	Password string `json:"password"`
}

type WebDAVAccountState struct {
	WebDAVAccount
}

type FileEntry struct {
	Name        string `json:"name"`
	Path        string `json:"path"`
	IsDirectory bool   `json:"isDirectory"`
	Size        int64  `json:"size"`
	ModifiedAt  string `json:"modifiedAt"`
	ContentType string `json:"contentType"`
}

type diskConfig struct {
	VideoDataMaxAgeMinutes              int             `json:"videoDataMaxAgeMinutes"`
	VideoDataMaxSizeMB                  int             `json:"videoDataMaxSizeMB"`
	Accounts                            []WebDAVAccount `json:"accounts"`
	ActiveAccountID                     string          `json:"activeAccountId"`
	VideoMetadataMaxAgeDays             int             `json:"videoMetadataMaxAgeDays"`
	VideoMetadataMaxSizeMB              int             `json:"videoMetadataMaxSizeMB"`
	VideoMetadataThumbnailOffsetPercent int             `json:"videoMetadataThumbnailOffsetPercent"`
	VideoSnapshotMaxAgeDays             int             `json:"videoSnapshotMaxAgeDays"`
	VideoSnapshotMaxSizeMB              int             `json:"videoSnapshotMaxSizeMB"`
	PlaybackMaxAgeDays                  int             `json:"playbackMaxAgeDays"`
	PlaybackMaxSizeMB                   int             `json:"playbackMaxSizeMB"`
	FullscreenHUDEnabled                bool            `json:"fullscreenHudEnabled"`
	FullscreenHUDSideOffsetPX           int             `json:"fullscreenHudSideOffsetPx"`
	MobileLongPressRate                 float64         `json:"mobileLongPressRate"`
}

type AppService struct {
	mu             sync.RWMutex
	config         diskConfig
	configPath     string
	proxy          *WebDAVProxy
	videoMetadata  *VideoMetadataCache
	videoSnapshots *VideoSnapshotCache
	videoData      *VideoDataCache
	progress       *PlaybackProgressStore
	httpClient     *http.Client
}

func NewAppService() (*AppService, error) {
	configPath, err := resolveConfigPath()
	if err != nil {
		return nil, err
	}

	config := diskConfig{
		VideoDataMaxAgeMinutes:              defaultVideoDataMaxAgeMinutes,
		VideoDataMaxSizeMB:                  defaultVideoDataMaxSizeMB,
		VideoMetadataMaxAgeDays:             defaultVideoMetadataMaxAgeDays,
		VideoMetadataMaxSizeMB:              defaultVideoMetadataMaxSizeMB,
		VideoMetadataThumbnailOffsetPercent: defaultVideoMetadataThumbnailOffsetPercent,
		VideoSnapshotMaxAgeDays:             defaultVideoSnapshotMaxAgeDays,
		VideoSnapshotMaxSizeMB:              defaultVideoSnapshotMaxSizeMB,
		PlaybackMaxAgeDays:                  defaultPlaybackMaxAgeDays,
		PlaybackMaxSizeMB:                   defaultPlaybackMaxSizeMB,
		FullscreenHUDEnabled:                defaultFullscreenHUDEnabled,
		FullscreenHUDSideOffsetPX:           defaultFullscreenHUDSideOffsetPX,
		MobileLongPressRate:                 defaultMobileLongPressRate,
	}
	if data, err := os.ReadFile(configPath); err == nil {
		_ = json.Unmarshal(data, &config)
	}
	if config.VideoDataMaxAgeMinutes < 1 || config.VideoDataMaxAgeMinutes > 10080 {
		config.VideoDataMaxAgeMinutes = defaultVideoDataMaxAgeMinutes
	}
	if config.VideoDataMaxSizeMB < 0 || config.VideoDataMaxSizeMB > 10240 {
		config.VideoDataMaxSizeMB = defaultVideoDataMaxSizeMB
	}
	if config.VideoMetadataMaxAgeDays < minVideoMetadataMaxAgeDays || config.VideoMetadataMaxAgeDays > maxVideoMetadataMaxAgeDays {
		config.VideoMetadataMaxAgeDays = defaultVideoMetadataMaxAgeDays
	}
	if config.VideoMetadataMaxSizeMB < minVideoMetadataMaxSizeMB || config.VideoMetadataMaxSizeMB > maxVideoMetadataMaxSizeMB {
		config.VideoMetadataMaxSizeMB = defaultVideoMetadataMaxSizeMB
	}
	if config.VideoMetadataThumbnailOffsetPercent < minVideoMetadataThumbnailOffsetPercent || config.VideoMetadataThumbnailOffsetPercent > maxVideoMetadataThumbnailOffsetPercent {
		config.VideoMetadataThumbnailOffsetPercent = defaultVideoMetadataThumbnailOffsetPercent
	}
	if config.VideoSnapshotMaxAgeDays < minVideoSnapshotMaxAgeDays || config.VideoSnapshotMaxAgeDays > maxVideoSnapshotMaxAgeDays {
		config.VideoSnapshotMaxAgeDays = defaultVideoSnapshotMaxAgeDays
	}
	if config.VideoSnapshotMaxSizeMB < minVideoSnapshotMaxSizeMB || config.VideoSnapshotMaxSizeMB > maxVideoSnapshotMaxSizeMB {
		config.VideoSnapshotMaxSizeMB = defaultVideoSnapshotMaxSizeMB
	}
	if config.PlaybackMaxAgeDays < minPlaybackMaxAgeDays || config.PlaybackMaxAgeDays > maxPlaybackMaxAgeDays {
		config.PlaybackMaxAgeDays = defaultPlaybackMaxAgeDays
	}
	if config.PlaybackMaxSizeMB < minPlaybackMaxSizeMB || config.PlaybackMaxSizeMB > maxPlaybackMaxSizeMB {
		config.PlaybackMaxSizeMB = defaultPlaybackMaxSizeMB
	}
	if config.FullscreenHUDSideOffsetPX < minFullscreenHUDSideOffsetPX || config.FullscreenHUDSideOffsetPX > maxFullscreenHUDSideOffsetPX {
		config.FullscreenHUDSideOffsetPX = defaultFullscreenHUDSideOffsetPX
	}
	if math.IsNaN(config.MobileLongPressRate) || math.IsInf(config.MobileLongPressRate, 0) || config.MobileLongPressRate < minMobileLongPressRate || config.MobileLongPressRate > maxMobileLongPressRate {
		config.MobileLongPressRate = defaultMobileLongPressRate
	}

	videoSnapshotDirectory := filepath.Join(filepath.Dir(configPath), "video-snapshots")
	videoSnapshotCache, err := NewVideoSnapshotCache(
		videoSnapshotDirectory,
		time.Duration(config.VideoSnapshotMaxAgeDays)*24*time.Hour,
		int64(config.VideoSnapshotMaxSizeMB)*1024*1024,
	)
	if err != nil {
		return nil, err
	}
	metadataDirectory := filepath.Join(filepath.Dir(configPath), "video-metadata")
	videoMetadataCache, err := NewVideoMetadataCache(
		metadataDirectory,
		time.Duration(config.VideoMetadataMaxAgeDays)*24*time.Hour,
		int64(config.VideoMetadataMaxSizeMB)*1024*1024,
	)
	if err != nil {
		return nil, err
	}
	playbackProgress, err := NewPlaybackProgressStore(
		filepath.Join(filepath.Dir(configPath), "playback-progress.json"),
		time.Duration(config.PlaybackMaxAgeDays)*24*time.Hour,
		int64(config.PlaybackMaxSizeMB)*1024*1024,
	)
	if err != nil {
		return nil, err
	}

	videoData, err := NewVideoDataCache(filepath.Join(filepath.Dir(configPath), "video-data"), time.Duration(config.VideoDataMaxAgeMinutes)*time.Minute, int64(config.VideoDataMaxSizeMB)*1024*1024)
	if err != nil {
		return nil, err
	}
	proxy, err := NewWebDAVProxy()
	if err != nil {
		return nil, err
	}
	proxy.SetVideoSnapshotDirectory(videoSnapshotDirectory)
	proxy.SetVideoDataCache(videoData)
	seenNames := make(map[string]struct{}, len(config.Accounts))
	seenIDs := make(map[string]struct{}, len(config.Accounts))
	for i := range config.Accounts {
		account, err := normalizeWebDAVAccount(config.Accounts[i])
		if err != nil {
			_ = proxy.Close()
			return nil, fmt.Errorf("invalid WebDAV account %d: %w", i+1, err)
		}
		nameKey := strings.ToLower(account.Name)
		if _, exists := seenNames[nameKey]; exists {
			_ = proxy.Close()
			return nil, fmt.Errorf("WebDAV 名称重复: %s", account.Name)
		}
		seenNames[nameKey] = struct{}{}
		if _, exists := seenIDs[account.ID]; exists {
			_ = proxy.Close()
			return nil, fmt.Errorf("WebDAV ID 重复: %s", account.ID)
		}
		seenIDs[account.ID] = struct{}{}
		if err := proxy.SetAccount(account); err != nil {
			_ = proxy.Close()
			return nil, err
		}
		config.Accounts[i] = account
	}
	if len(config.Accounts) == 0 {
		config.ActiveAccountID = ""
	} else if !proxy.HasAccount(config.ActiveAccountID) {
		config.ActiveAccountID = config.Accounts[0].ID
	}
	service := &AppService{
		config:         config,
		configPath:     configPath,
		proxy:          proxy,
		videoMetadata:  videoMetadataCache,
		videoSnapshots: videoSnapshotCache,
		videoData:      videoData,
		progress:       playbackProgress,
		httpClient:     &http.Client{Timeout: 30 * time.Second},
	}
	return service, nil
}

func resolveConfigPath() (string, error) {
	base, err := resolveAppDataDirectory()
	if err != nil {
		return "", fmt.Errorf("resolve config directory: %w", err)
	}
	dir := filepath.Join(base, "drive-player")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("create config directory: %w", err)
	}
	return filepath.Join(dir, "config.json"), nil
}

func (s *AppService) close() error {
	s.mu.RLock()
	proxy := s.proxy
	s.mu.RUnlock()
	if proxy == nil {
		return nil
	}
	return proxy.Close()
}

func (s *AppService) GetState() AppState {
	s.mu.RLock()
	defer s.mu.RUnlock()
	storageDirectory := filepath.Dir(s.configPath)
	accounts := make([]WebDAVAccountState, 0, len(s.config.Accounts))
	for _, account := range s.config.Accounts {
		accounts = append(accounts, WebDAVAccountState{
			WebDAVAccount: account,
		})
	}
	return AppState{
		VideoDataMaxAgeMinutes:              s.config.VideoDataMaxAgeMinutes,
		VideoDataMaxSizeMB:                  s.config.VideoDataMaxSizeMB,
		Connected:                           len(accounts) > 0 && s.config.ActiveAccountID != "",
		Accounts:                            accounts,
		ActiveAccountID:                     s.config.ActiveAccountID,
		VideoMetadataMaxAgeDays:             s.config.VideoMetadataMaxAgeDays,
		VideoMetadataMaxSizeMB:              s.config.VideoMetadataMaxSizeMB,
		VideoMetadataThumbnailOffsetPercent: s.config.VideoMetadataThumbnailOffsetPercent,
		VideoSnapshotMaxAgeDays:             s.config.VideoSnapshotMaxAgeDays,
		VideoSnapshotMaxSizeMB:              s.config.VideoSnapshotMaxSizeMB,
		PlaybackMaxAgeDays:                  s.config.PlaybackMaxAgeDays,
		PlaybackMaxSizeMB:                   s.config.PlaybackMaxSizeMB,
		FullscreenHUDEnabled:                s.config.FullscreenHUDEnabled,
		FullscreenHUDSideOffsetPX:           s.config.FullscreenHUDSideOffsetPX,
		MobileLongPressRate:                 s.config.MobileLongPressRate,
		StorageDirectory:                    storageDirectory,
		ConfigPath:                          s.configPath,
		VideoMetadataDirectory:              filepath.Join(storageDirectory, "video-metadata"),
		VideoSnapshotDirectory:              filepath.Join(storageDirectory, "video-snapshots"),
		PlaybackProgressPath:                s.progress.Path(),
	}
}

func (s *AppService) TestWebDAVAccount(ctx context.Context, id string) error {
	s.mu.RLock()
	index := accountIndexByID(s.config.Accounts, strings.TrimSpace(id))
	if index < 0 {
		s.mu.RUnlock()
		return errors.New("WebDAV 不存在")
	}
	account := s.config.Accounts[index]
	s.mu.RUnlock()

	result, err := s.fetchWebDAVProperties(ctx, "/", account, "0")
	if err != nil {
		return err
	}
	for _, item := range result.Responses {
		readable := false
		for _, prop := range item.PropStats {
			if strings.Contains(prop.Status, " 200 ") {
				readable = true
				break
			}
		}
		entry, ok := davResponseToEntry(item, account.Endpoint)
		if readable && ok && sameRemotePath(entry.Path, "/") && entry.IsDirectory {
			return nil
		}
	}
	return errors.New("WebDAV 根目录不可访问")
}

func (s *AppService) AddWebDAVAccount(ctx context.Context, name, endpoint, username, password string) (AppState, error) {
	account, err := normalizeWebDAVAccount(WebDAVAccount{
		ID:       newWebDAVAccountID(),
		Name:     name,
		Endpoint: endpoint,
		Username: username,
		Password: password,
	})
	if err != nil {
		return AppState{}, err
	}
	if _, err := s.listDirectoryWithAccount(ctx, "/", account); err != nil {
		return AppState{}, fmt.Errorf("WebDAV 连接失败: %w", err)
	}

	s.mu.Lock()
	if err := ensureUniqueWebDAVName(s.config.Accounts, account.Name, ""); err != nil {
		s.mu.Unlock()
		return AppState{}, err
	}
	if s.proxy == nil {
		s.mu.Unlock()
		return AppState{}, errors.New("WebDAV 代理未启动")
	}
	if err := s.proxy.SetAccount(account); err != nil {
		s.mu.Unlock()
		return AppState{}, err
	}
	previous := s.config
	s.config.Accounts = append(s.config.Accounts, account)
	s.config.ActiveAccountID = account.ID
	config := s.config
	s.mu.Unlock()
	if err := s.saveConfig(config); err != nil {
		s.mu.Lock()
		s.config = previous
		s.proxy.RemoveAccount(account.ID)
		s.mu.Unlock()
		return AppState{}, err
	}
	return s.GetState(), nil
}

func (s *AppService) UpdateWebDAVAccount(ctx context.Context, id, name, endpoint, username, password string) (AppState, error) {
	id = strings.TrimSpace(id)
	account, err := normalizeWebDAVAccount(WebDAVAccount{
		ID:       id,
		Name:     name,
		Endpoint: endpoint,
		Username: username,
		Password: password,
	})
	if err != nil {
		return AppState{}, err
	}
	if _, err := s.listDirectoryWithAccount(ctx, "/", account); err != nil {
		return AppState{}, fmt.Errorf("WebDAV 连接失败: %w", err)
	}

	s.mu.Lock()
	index := accountIndexByID(s.config.Accounts, id)
	if index < 0 {
		s.mu.Unlock()
		return AppState{}, errors.New("WebDAV 不存在")
	}
	if err := ensureUniqueWebDAVName(s.config.Accounts, account.Name, id); err != nil {
		s.mu.Unlock()
		return AppState{}, err
	}
	if s.proxy == nil {
		s.mu.Unlock()
		return AppState{}, errors.New("WebDAV 代理未启动")
	}
	oldAccount := s.config.Accounts[index]
	if err := s.proxy.SetAccount(account); err != nil {
		s.mu.Unlock()
		return AppState{}, err
	}
	previous := s.config
	s.config.Accounts[index] = account
	config := s.config
	s.mu.Unlock()
	if err := s.saveConfig(config); err != nil {
		s.mu.Lock()
		s.config = previous
		_ = s.proxy.SetAccount(oldAccount)
		s.mu.Unlock()
		return AppState{}, err
	}
	return s.GetState(), nil
}

func (s *AppService) RemoveWebDAVAccount(id string) (AppState, error) {
	id = strings.TrimSpace(id)
	s.mu.Lock()
	index := accountIndexByID(s.config.Accounts, id)
	if index < 0 {
		s.mu.Unlock()
		return AppState{}, errors.New("WebDAV 不存在")
	}
	previous := s.config
	removedAccount := s.config.Accounts[index]
	s.config.Accounts = append(s.config.Accounts[:index:index], s.config.Accounts[index+1:]...)
	if s.proxy != nil {
		s.proxy.RemoveAccount(id)
	}
	if s.config.ActiveAccountID == id {
		if len(s.config.Accounts) > 0 {
			s.config.ActiveAccountID = s.config.Accounts[0].ID
		} else {
			s.config.ActiveAccountID = ""
		}
	}
	config := s.config
	s.mu.Unlock()
	if err := s.saveConfig(config); err != nil {
		s.mu.Lock()
		s.config = previous
		if s.proxy != nil {
			_ = s.proxy.SetAccount(removedAccount)
		}
		s.mu.Unlock()
		return AppState{}, err
	}
	return s.GetState(), nil
}

func (s *AppService) SwitchWebDAVAccount(id string) (AppState, error) {
	id = strings.TrimSpace(id)
	s.mu.Lock()
	if accountIndexByID(s.config.Accounts, id) < 0 || s.proxy == nil || !s.proxy.HasAccount(id) {
		s.mu.Unlock()
		return AppState{}, errors.New("WebDAV 不存在")
	}
	previous := s.config.ActiveAccountID
	s.config.ActiveAccountID = id
	config := s.config
	s.mu.Unlock()
	if err := s.saveConfig(config); err != nil {
		s.mu.Lock()
		s.config.ActiveAccountID = previous
		s.mu.Unlock()
		return AppState{}, err
	}
	return s.GetState(), nil
}

func (s *AppService) ListDirectory(ctx context.Context, remotePath string) ([]FileEntry, error) {
	account, err := s.currentAccount()
	if err != nil {
		return nil, err
	}
	return s.listDirectoryWithAccount(ctx, remotePath, account)
}

func (s *AppService) GetPlaybackURL(remotePath, modifiedAt string, size int64) (string, error) {
	account, err := s.currentAccount()
	if err != nil {
		return "", err
	}
	s.mu.RLock()
	proxy := s.proxy
	s.mu.RUnlock()
	if proxy == nil {
		return "", errors.New("WebDAV 代理未启动")
	}
	return proxy.URLForFile(account.ID, normalizeRemotePath(remotePath), modifiedAt, size), nil
}

func (s *AppService) GetVideoDataCacheStats() (VideoDataCacheStats, error) {
	return s.videoData.Stats()
}

func (s *AppService) ClearVideoDataCache() (VideoDataCacheStats, error) { return s.videoData.Clear() }

func (s *AppService) SetVideoDataSettings(maxAgeMinutes, maxSizeMB int) (AppState, error) {
	if maxAgeMinutes < 1 || maxAgeMinutes > 10080 {
		return AppState{}, errors.New("视频数据保留时间必须在 1 到 10080 分钟之间")
	}
	if maxSizeMB < 0 || maxSizeMB > 10240 {
		return AppState{}, errors.New("视频数据缓存上限必须在 0 到 10240 MB 之间")
	}
	s.mu.Lock()
	previous := s.config
	s.config.VideoDataMaxAgeMinutes, s.config.VideoDataMaxSizeMB = maxAgeMinutes, maxSizeMB
	config := s.config
	s.mu.Unlock()
	if err := s.saveConfig(config); err != nil {
		s.mu.Lock()
		s.config = previous
		s.mu.Unlock()
		return AppState{}, err
	}
	if err := s.videoData.SetLimits(time.Duration(maxAgeMinutes)*time.Minute, int64(maxSizeMB)*1024*1024); err != nil {
		return AppState{}, err
	}
	return s.GetState(), nil
}

func (s *AppService) GetVideoMetadata(remotePath, modifiedAt string) (VideoMetadataResult, error) {
	accountKey, err := s.currentAccountKey()
	if err != nil {
		return VideoMetadataResult{}, err
	}
	return s.videoMetadata.Get(videoMetadataCacheKey(accountKey, remotePath, modifiedAt, defaultVideoMetadataThumbnailOffsetPercent))
}

func (s *AppService) SaveVideoMetadata(remotePath, modifiedAt string, width, height int, frameRate float64) (VideoMetadataCacheStats, error) {
	accountKey, err := s.currentAccountKey()
	if err != nil {
		return VideoMetadataCacheStats{}, err
	}
	return s.videoMetadata.Save(videoMetadataCacheKey(accountKey, remotePath, modifiedAt, defaultVideoMetadataThumbnailOffsetPercent), width, height, frameRate)
}

func (s *AppService) GetVideoCover(remotePath, modifiedAt string) (string, error) {
	key, err := s.videoCoverKey(remotePath, modifiedAt)
	if err != nil {
		return "", err
	}
	name, err := s.videoSnapshots.GetCover(key)
	if err != nil || name == "" {
		return "", err
	}
	return s.proxy.VideoSnapshotURL(name), nil
}

func (s *AppService) SaveVideoCover(remotePath, modifiedAt, dataURL string) (VideoSnapshotCacheStats, error) {
	key, err := s.videoCoverKey(remotePath, modifiedAt)
	if err != nil {
		return VideoSnapshotCacheStats{}, err
	}
	return s.videoSnapshots.SaveCover(key, dataURL)
}

func (s *AppService) videoCoverKey(remotePath, modifiedAt string) (string, error) {
	accountKey, err := s.currentAccountKey()
	if err != nil {
		return "", err
	}
	s.mu.RLock()
	offset := s.config.VideoMetadataThumbnailOffsetPercent
	s.mu.RUnlock()
	return videoMetadataCacheKey(accountKey, remotePath, modifiedAt, offset), nil
}

func (s *AppService) GetVideoMetadataCacheStats() (VideoMetadataCacheStats, error) {
	return s.videoMetadata.Stats()
}

func (s *AppService) ClearVideoMetadataCache() (VideoMetadataCacheStats, error) {
	return s.videoMetadata.Clear()
}

func (s *AppService) SetVideoMetadataSettings(maxAgeDays, maxSizeMB int) (AppState, error) {
	if maxAgeDays < minVideoMetadataMaxAgeDays || maxAgeDays > maxVideoMetadataMaxAgeDays {
		return AppState{}, fmt.Errorf("视频元信息保留时间必须在 %d 到 %d 天之间", minVideoMetadataMaxAgeDays, maxVideoMetadataMaxAgeDays)
	}
	if maxSizeMB < minVideoMetadataMaxSizeMB || maxSizeMB > maxVideoMetadataMaxSizeMB {
		return AppState{}, fmt.Errorf("视频元信息缓存上限必须在 %d 到 %d MB 之间", minVideoMetadataMaxSizeMB, maxVideoMetadataMaxSizeMB)
	}

	s.mu.Lock()
	previous := s.config
	s.config.VideoMetadataMaxAgeDays = maxAgeDays
	s.config.VideoMetadataMaxSizeMB = maxSizeMB
	config := s.config
	s.mu.Unlock()

	if err := s.saveConfig(config); err != nil {
		s.mu.Lock()
		s.config = previous
		s.mu.Unlock()
		return AppState{}, err
	}
	if err := s.videoMetadata.SetLimits(time.Duration(maxAgeDays)*24*time.Hour, int64(maxSizeMB)*1024*1024); err != nil {
		return AppState{}, err
	}
	return s.GetState(), nil
}

func (s *AppService) GetVideoSnapshots(remotePath, modifiedAt string) ([]VideoSnapshot, error) {
	accountKey, err := s.currentAccountKey()
	if err != nil {
		return nil, err
	}
	s.mu.RLock()
	proxy := s.proxy
	s.mu.RUnlock()
	if proxy == nil {
		return nil, errors.New("WebDAV 代理未启动")
	}
	entries, err := s.videoSnapshots.GetSeries(videoSnapshotCacheKey(accountKey, remotePath, modifiedAt))
	if err != nil {
		return nil, err
	}
	result := make([]VideoSnapshot, 0, len(entries))
	for _, entry := range entries {
		result = append(result, VideoSnapshot{
			Position: entry.Position,
			URL:      proxy.VideoSnapshotURL(entry.FileName),
		})
	}
	return result, nil
}

func (s *AppService) SaveVideoSnapshot(remotePath, modifiedAt string, position float64, dataURL string) (VideoSnapshotCacheStats, error) {
	accountKey, err := s.currentAccountKey()
	if err != nil {
		return VideoSnapshotCacheStats{}, err
	}
	return s.videoSnapshots.Save(videoSnapshotCacheKey(accountKey, remotePath, modifiedAt), position, dataURL)
}

func (s *AppService) ClearVideoSnapshots(remotePath, modifiedAt string) (VideoSnapshotCacheStats, error) {
	accountKey, err := s.currentAccountKey()
	if err != nil {
		return VideoSnapshotCacheStats{}, err
	}
	return s.videoSnapshots.ClearSeries(videoSnapshotCacheKey(accountKey, remotePath, modifiedAt))
}

func (s *AppService) GetVideoSnapshotCacheStats() (VideoSnapshotCacheStats, error) {
	return s.videoSnapshots.Stats()
}

func (s *AppService) ClearVideoSnapshotCache() (VideoSnapshotCacheStats, error) {
	return s.videoSnapshots.Clear()
}

func (s *AppService) SetVideoSnapshotSettings(maxAgeDays, maxSizeMB, offsetPercent int) (AppState, error) {
	if offsetPercent < minVideoMetadataThumbnailOffsetPercent || offsetPercent > maxVideoMetadataThumbnailOffsetPercent {
		return AppState{}, fmt.Errorf("封面截帧位置必须在 %d%% 到 %d%% 之间", minVideoMetadataThumbnailOffsetPercent, maxVideoMetadataThumbnailOffsetPercent)
	}
	if maxAgeDays < minVideoSnapshotMaxAgeDays || maxAgeDays > maxVideoSnapshotMaxAgeDays {
		return AppState{}, fmt.Errorf("视频关键帧保留时间必须在 %d 到 %d 天之间", minVideoSnapshotMaxAgeDays, maxVideoSnapshotMaxAgeDays)
	}
	if maxSizeMB < minVideoSnapshotMaxSizeMB || maxSizeMB > maxVideoSnapshotMaxSizeMB {
		return AppState{}, fmt.Errorf("视频关键帧缓存上限必须在 %d 到 %d MB 之间", minVideoSnapshotMaxSizeMB, maxVideoSnapshotMaxSizeMB)
	}

	s.mu.Lock()
	previous := s.config
	s.config.VideoSnapshotMaxAgeDays = maxAgeDays
	s.config.VideoSnapshotMaxSizeMB = maxSizeMB
	s.config.VideoMetadataThumbnailOffsetPercent = offsetPercent
	config := s.config
	s.mu.Unlock()

	if err := s.saveConfig(config); err != nil {
		s.mu.Lock()
		s.config = previous
		s.mu.Unlock()
		return AppState{}, err
	}
	if err := s.videoSnapshots.SetLimits(time.Duration(maxAgeDays)*24*time.Hour, int64(maxSizeMB)*1024*1024); err != nil {
		s.mu.Lock()
		s.config = previous
		s.mu.Unlock()
		_ = s.saveConfig(previous)
		_ = s.videoSnapshots.SetLimits(time.Duration(previous.VideoSnapshotMaxAgeDays)*24*time.Hour, int64(previous.VideoSnapshotMaxSizeMB)*1024*1024)
		return AppState{}, err
	}
	return s.GetState(), nil
}

func (s *AppService) GetPlaybackProgress(remotePath string) (PlaybackProgressResult, error) {
	accountKey, err := s.currentAccountKey()
	if err != nil {
		return PlaybackProgressResult{}, err
	}
	return s.progress.Get(accountKey, normalizeRemotePath(remotePath))
}

func (s *AppService) SavePlaybackProgress(remotePath string, position, duration float64) (PlaybackProgressStats, error) {
	accountKey, err := s.currentAccountKey()
	if err != nil {
		return PlaybackProgressStats{}, err
	}
	return s.progress.Save(accountKey, normalizeRemotePath(remotePath), position, duration)
}

func (s *AppService) GetPlaybackProgressStats() (PlaybackProgressStats, error) {
	return s.progress.Stats()
}

func (s *AppService) ClearPlaybackProgress() (PlaybackProgressStats, error) {
	return s.progress.Clear()
}

func (s *AppService) SetPlaybackProgressSettings(maxAgeDays, maxSizeMB int) (AppState, error) {
	if maxAgeDays < minPlaybackMaxAgeDays || maxAgeDays > maxPlaybackMaxAgeDays {
		return AppState{}, fmt.Errorf("播放进度保留时间必须在 %d 到 %d 天之间", minPlaybackMaxAgeDays, maxPlaybackMaxAgeDays)
	}
	if maxSizeMB < minPlaybackMaxSizeMB || maxSizeMB > maxPlaybackMaxSizeMB {
		return AppState{}, fmt.Errorf("播放进度存储上限必须在 %d 到 %d MB 之间", minPlaybackMaxSizeMB, maxPlaybackMaxSizeMB)
	}

	s.mu.Lock()
	previous := s.config
	s.config.PlaybackMaxAgeDays = maxAgeDays
	s.config.PlaybackMaxSizeMB = maxSizeMB
	config := s.config
	s.mu.Unlock()

	if err := s.saveConfig(config); err != nil {
		s.mu.Lock()
		s.config = previous
		s.mu.Unlock()
		return AppState{}, err
	}
	if err := s.progress.SetLimits(time.Duration(maxAgeDays)*24*time.Hour, int64(maxSizeMB)*1024*1024); err != nil {
		s.mu.Lock()
		s.config = previous
		s.mu.Unlock()
		_ = s.saveConfig(previous)
		_ = s.progress.SetLimits(time.Duration(previous.PlaybackMaxAgeDays)*24*time.Hour, int64(previous.PlaybackMaxSizeMB)*1024*1024)
		return AppState{}, err
	}
	return s.GetState(), nil
}

func (s *AppService) SetFullscreenHUDSettings(enabled bool, offsetPX int) (AppState, error) {
	if offsetPX < minFullscreenHUDSideOffsetPX || offsetPX > maxFullscreenHUDSideOffsetPX {
		return AppState{}, fmt.Errorf("全屏信息左右偏移必须在 %d 到 %d px 之间", minFullscreenHUDSideOffsetPX, maxFullscreenHUDSideOffsetPX)
	}

	s.mu.Lock()
	previous := s.config
	s.config.FullscreenHUDEnabled = enabled
	s.config.FullscreenHUDSideOffsetPX = offsetPX
	config := s.config
	s.mu.Unlock()

	if err := s.saveConfig(config); err != nil {
		s.mu.Lock()
		s.config = previous
		s.mu.Unlock()
		return AppState{}, err
	}
	return s.GetState(), nil
}

func (s *AppService) SetMobileLongPressRate(rate float64) (AppState, error) {
	if math.IsNaN(rate) || math.IsInf(rate, 0) || rate < minMobileLongPressRate || rate > maxMobileLongPressRate {
		return AppState{}, fmt.Errorf("移动端长按倍速必须在 %.1f 到 %.1f 倍之间", minMobileLongPressRate, maxMobileLongPressRate)
	}

	s.mu.Lock()
	previous := s.config
	s.config.MobileLongPressRate = rate
	config := s.config
	s.mu.Unlock()

	if err := s.saveConfig(config); err != nil {
		s.mu.Lock()
		s.config = previous
		s.mu.Unlock()
		return AppState{}, err
	}
	return s.GetState(), nil
}

func (s *AppService) GetBatteryPercent() int {
	return platformBatteryPercent()
}

func (s *AppService) OpenStorageDirectory() error {
	dir := filepath.Dir(s.configPath)
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("explorer.exe", dir)
	case "darwin":
		cmd = exec.Command("open", dir)
	default:
		cmd = exec.Command("xdg-open", dir)
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("open storage directory: %w", err)
	}
	return nil
}

func (s *AppService) saveConfig(config diskConfig) error {
	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return fmt.Errorf("encode settings: %w", err)
	}
	if err := os.WriteFile(s.configPath, data, 0o600); err != nil {
		return fmt.Errorf("save settings: %w", err)
	}
	return nil
}

func (s *AppService) currentAccountKey() (string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.config.ActiveAccountID == "" || s.proxy == nil || !s.proxy.HasAccount(s.config.ActiveAccountID) {
		return "", errors.New("尚未添加 WebDAV")
	}
	return s.config.ActiveAccountID, nil
}

func (s *AppService) currentAccount() (WebDAVAccount, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	id := s.config.ActiveAccountID
	if id == "" {
		return WebDAVAccount{}, errors.New("尚未添加 WebDAV")
	}
	index := accountIndexByID(s.config.Accounts, id)
	if index < 0 || s.proxy == nil || !s.proxy.HasAccount(id) {
		return WebDAVAccount{}, errors.New("当前 WebDAV 不存在")
	}
	return s.config.Accounts[index], nil
}

func (s *AppService) listDirectoryWithAccount(ctx context.Context, remotePath string, account WebDAVAccount) ([]FileEntry, error) {
	remotePath = normalizeRemotePath(remotePath)
	result, err := s.fetchWebDAVProperties(ctx, remotePath, account, "1")
	if err != nil {
		return nil, err
	}
	entries := make([]FileEntry, 0, len(result.Responses))
	for _, item := range result.Responses {
		entry, ok := davResponseToEntry(item, account.Endpoint)
		if !ok || sameRemotePath(entry.Path, remotePath) {
			continue
		}
		entries = append(entries, entry)
		if !entry.IsDirectory && s.proxy != nil {
			s.proxy.URLForFile(account.ID, entry.Path, entry.ModifiedAt, entry.Size)
		}
	}
	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].IsDirectory != entries[j].IsDirectory {
			return entries[i].IsDirectory
		}
		return strings.ToLower(entries[i].Name) < strings.ToLower(entries[j].Name)
	})
	return entries, nil
}

func (s *AppService) fetchWebDAVProperties(ctx context.Context, remotePath string, account WebDAVAccount, depth string) (*davMultiStatus, error) {
	upstreamURL, err := buildUpstreamURL(account.Endpoint, remotePath, nil)
	if err != nil {
		return nil, err
	}

	const propfindBody = `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:displayname />
    <d:resourcetype />
    <d:getcontentlength />
    <d:getlastmodified />
    <d:getcontenttype />
  </d:prop>
</d:propfind>`

	req, err := http.NewRequestWithContext(ctx, "PROPFIND", upstreamURL.String(), strings.NewReader(propfindBody))
	if err != nil {
		return nil, err
	}
	if account.Username != "" || account.Password != "" {
		req.SetBasicAuth(account.Username, account.Password)
	}
	req.Header.Set("Depth", depth)
	req.Header.Set("Content-Type", `application/xml; charset="utf-8"`)
	req.Header.Set("User-Agent", "DrivePlayer/1.0")

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return nil, fmt.Errorf("认证失败 (%s)", resp.Status)
	}
	if resp.StatusCode != http.StatusMultiStatus && (resp.StatusCode < 200 || resp.StatusCode >= 300) {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return nil, fmt.Errorf("PROPFIND %s: %s %s", remotePath, resp.Status, strings.TrimSpace(string(body)))
	}

	var result davMultiStatus
	if err := xml.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("parse WebDAV response: %w", err)
	}

	return &result, nil
}

func normalizeWebDAVAccount(account WebDAVAccount) (WebDAVAccount, error) {
	account.ID = strings.TrimSpace(account.ID)
	account.Name = strings.TrimSpace(account.Name)
	account.Endpoint = strings.TrimSpace(account.Endpoint)
	account.Username = strings.TrimSpace(account.Username)
	if account.ID == "" {
		return WebDAVAccount{}, errors.New("WebDAV ID 不能为空")
	}
	if account.Name == "" {
		return WebDAVAccount{}, errors.New("名称不能为空")
	}
	if account.Endpoint == "" {
		return WebDAVAccount{}, errors.New("WebDAV 地址不能为空")
	}
	u, err := url.Parse(account.Endpoint)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return WebDAVAccount{}, errors.New("WebDAV 地址必须是有效的 http/https URL")
	}
	u.Path = strings.TrimSuffix(u.Path, "/")
	u.RawPath = ""
	account.Endpoint = u.String()
	return account, nil
}

func ensureUniqueWebDAVName(accounts []WebDAVAccount, name, excludeID string) error {
	for _, account := range accounts {
		if account.ID != excludeID && strings.EqualFold(account.Name, name) {
			return fmt.Errorf("WebDAV 名称已存在: %s", name)
		}
	}
	return nil
}

func accountIndexByID(accounts []WebDAVAccount, id string) int {
	for i := range accounts {
		if accounts[i].ID == id {
			return i
		}
	}
	return -1
}

func newWebDAVAccountID() string {
	var value [16]byte
	if _, err := rand.Read(value[:]); err == nil {
		return hex.EncodeToString(value[:])
	}
	return fmt.Sprintf("%d", time.Now().UnixNano())
}

type davMultiStatus struct {
	Responses []davResponse `xml:"response"`
}

type davResponse struct {
	Href      string        `xml:"href"`
	PropStats []davPropStat `xml:"propstat"`
}

type davPropStat struct {
	Status string  `xml:"status"`
	Prop   davProp `xml:"prop"`
}

type davProp struct {
	DisplayName   string          `xml:"displayname"`
	ResourceType  davResourceType `xml:"resourcetype"`
	ContentLength string          `xml:"getcontentlength"`
	LastModified  string          `xml:"getlastmodified"`
	ContentType   string          `xml:"getcontenttype"`
}

type davResourceType struct {
	Collection *struct{} `xml:"collection"`
}

func davResponseToEntry(item davResponse, endpoint string) (FileEntry, bool) {
	var prop *davProp
	for i := range item.PropStats {
		if strings.Contains(item.PropStats[i].Status, " 200 ") {
			prop = &item.PropStats[i].Prop
			break
		}
	}
	if prop == nil && len(item.PropStats) > 0 {
		prop = &item.PropStats[0].Prop
	}
	if prop == nil {
		return FileEntry{}, false
	}

	remotePath := remotePathFromHref(item.Href, endpoint)
	if remotePath == "" {
		return FileEntry{}, false
	}
	name := strings.TrimSpace(prop.DisplayName)
	if name == "" {
		name = path.Base(strings.TrimSuffix(remotePath, "/"))
	}

	var size int64
	if prop.ContentLength != "" {
		size, _ = strconv.ParseInt(prop.ContentLength, 10, 64)
	}

	modifiedAt := ""
	if prop.LastModified != "" {
		if parsed, err := http.ParseTime(prop.LastModified); err == nil {
			modifiedAt = parsed.Local().Format(time.RFC3339)
		} else {
			modifiedAt = prop.LastModified
		}
	}

	return FileEntry{
		Name:        name,
		Path:        remotePath,
		IsDirectory: prop.ResourceType.Collection != nil,
		Size:        size,
		ModifiedAt:  modifiedAt,
		ContentType: prop.ContentType,
	}, true
}

func remotePathFromHref(href, endpoint string) string {
	u, err := url.Parse(href)
	if err != nil {
		return ""
	}
	decoded, err := url.PathUnescape(u.EscapedPath())
	if err != nil {
		decoded = u.Path
	}
	base, _ := url.Parse(endpoint)
	basePath := strings.TrimSuffix(base.Path, "/")
	if strings.HasPrefix(decoded, basePath) {
		decoded = strings.TrimPrefix(decoded, basePath)
	}
	return normalizeRemotePath(decoded)
}

func normalizeRemotePath(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || value == "/" {
		return "/"
	}
	value = "/" + strings.TrimLeft(value, "/")
	cleaned := path.Clean(value)
	if cleaned == "." {
		return "/"
	}
	return cleaned
}

func sameRemotePath(a, b string) bool {
	return strings.TrimSuffix(normalizeRemotePath(a), "/") == strings.TrimSuffix(normalizeRemotePath(b), "/")
}
