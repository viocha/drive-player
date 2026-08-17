package main

import (
	"context"
	"crypto/sha256"
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
	defaultWebDAVEndpoint            = "https://webdav.123pan.cn/webdav"
	defaultURLCacheTTL               = 30
	defaultQuarkIDCacheTTL           = 30
	defaultThumbnailMaxAgeDays       = 30
	defaultThumbnailMaxSizeMB        = 512
	defaultThumbnailOffsetPercent    = 10
	defaultVideoSnapshotMaxAgeDays   = 30
	defaultVideoSnapshotMaxSizeMB    = 1024
	defaultPlaybackMaxAgeDays        = 365
	defaultPlaybackMaxSizeMB         = 16
	defaultFullscreenHUDEnabled      = false
	defaultFullscreenHUDSideOffsetPX = 0
	defaultMobileLongPressRate       = 3.0
	minThumbnailMaxAgeDays           = 1
	maxThumbnailMaxAgeDays           = 3650
	minThumbnailMaxSizeMB            = 16
	maxThumbnailMaxSizeMB            = 10240
	minThumbnailOffsetPercent        = 0
	maxThumbnailOffsetPercent        = 100
	minVideoSnapshotMaxAgeDays       = 1
	maxVideoSnapshotMaxAgeDays       = 3650
	minVideoSnapshotMaxSizeMB        = 64
	maxVideoSnapshotMaxSizeMB        = 10240
	minPlaybackMaxAgeDays            = 1
	maxPlaybackMaxAgeDays            = 3650
	minPlaybackMaxSizeMB             = 1
	maxPlaybackMaxSizeMB             = 1024
	minFullscreenHUDSideOffsetPX     = 0
	maxFullscreenHUDSideOffsetPX     = 200
	minMobileLongPressRate           = 1.0
	maxMobileLongPressRate           = 8.0
	minQuarkIDCacheTTLMinutes        = 1
	maxQuarkIDCacheTTLMinutes        = 1440
	provider123                      = "123"
	providerQuark                    = "quark"
)

type AppState struct {
	Connected                    bool    `json:"connected"`
	Connected123                 bool    `json:"connected123"`
	ConnectedQuark               bool    `json:"connectedQuark"`
	Provider                     string  `json:"provider"`
	Username                     string  `json:"username"`
	Password                     string  `json:"password"`
	QuarkCookie                  string  `json:"quarkCookie"`
	Endpoint                     string  `json:"endpoint"`
	QuarkEndpoint                string  `json:"quarkEndpoint"`
	WebDAVCacheTTLMinutes        int     `json:"webdavCacheTTLMinutes"`
	QuarkDownloadCacheTTLMinutes int     `json:"quarkDownloadCacheTTLMinutes"`
	QuarkIDCacheTTLMinutes       int     `json:"quarkIDCacheTTLMinutes"`
	ThumbnailMaxAgeDays          int     `json:"thumbnailMaxAgeDays"`
	ThumbnailMaxSizeMB           int     `json:"thumbnailMaxSizeMB"`
	ThumbnailOffsetPercent       int     `json:"thumbnailOffsetPercent"`
	VideoSnapshotMaxAgeDays      int     `json:"videoSnapshotMaxAgeDays"`
	VideoSnapshotMaxSizeMB       int     `json:"videoSnapshotMaxSizeMB"`
	PlaybackMaxAgeDays           int     `json:"playbackMaxAgeDays"`
	PlaybackMaxSizeMB            int     `json:"playbackMaxSizeMB"`
	FullscreenHUDEnabled         bool    `json:"fullscreenHudEnabled"`
	FullscreenHUDSideOffsetPX    int     `json:"fullscreenHudSideOffsetPx"`
	MobileLongPressRate          float64 `json:"mobileLongPressRate"`
	StorageDirectory             string  `json:"storageDirectory"`
	ConfigPath                   string  `json:"configPath"`
	ThumbnailDirectory           string  `json:"thumbnailDirectory"`
	VideoSnapshotDirectory       string  `json:"videoSnapshotDirectory"`
	PlaybackProgressPath         string  `json:"playbackProgressPath"`
	ProxyBaseURL                 string  `json:"proxyBaseUrl"`
	WebDAVProxyBaseURL           string  `json:"webdavProxyBaseUrl"`
	QuarkProxyBaseURL            string  `json:"quarkProxyBaseUrl"`
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
	WebDAVCacheTTLMinutes        int     `json:"webdavCacheTTLMinutes"`
	QuarkDownloadCacheTTLMinutes int     `json:"quarkDownloadCacheTTLMinutes"`
	QuarkIDCacheTTLMinutes       int     `json:"quarkIDCacheTTLMinutes"`
	ThumbnailMaxAgeDays          int     `json:"thumbnailMaxAgeDays"`
	ThumbnailMaxSizeMB           int     `json:"thumbnailMaxSizeMB"`
	ThumbnailOffsetPercent       int     `json:"thumbnailOffsetPercent"`
	VideoSnapshotMaxAgeDays      int     `json:"videoSnapshotMaxAgeDays"`
	VideoSnapshotMaxSizeMB       int     `json:"videoSnapshotMaxSizeMB"`
	PlaybackMaxAgeDays           int     `json:"playbackMaxAgeDays"`
	PlaybackMaxSizeMB            int     `json:"playbackMaxSizeMB"`
	FullscreenHUDEnabled         bool    `json:"fullscreenHudEnabled"`
	FullscreenHUDSideOffsetPX    int     `json:"fullscreenHudSideOffsetPx"`
	MobileLongPressRate          float64 `json:"mobileLongPressRate"`
	Username                     string  `json:"username"`
	Password                     string  `json:"password"`
	Provider                     string  `json:"provider"`
	QuarkCookie                  string  `json:"quarkCookie"`
}

type credentials struct {
	username string
	password string
}

type AppService struct {
	mu             sync.RWMutex
	credentials    credentials
	provider       string
	quarkCookie    string
	connected123   bool
	connectedQuark bool
	config         diskConfig
	configPath     string
	proxy          *WebDAVProxy
	quark          *QuarkDrive
	thumbnails     *ThumbnailCache
	videoSnapshots *VideoSnapshotCache
	progress       *PlaybackProgressStore
	httpClient     *http.Client
}

func NewAppService() (*AppService, error) {
	configPath, err := resolveConfigPath()
	if err != nil {
		return nil, err
	}

	config := diskConfig{
		WebDAVCacheTTLMinutes:        defaultURLCacheTTL,
		QuarkDownloadCacheTTLMinutes: defaultURLCacheTTL,
		QuarkIDCacheTTLMinutes:       defaultQuarkIDCacheTTL,
		ThumbnailMaxAgeDays:          defaultThumbnailMaxAgeDays,
		ThumbnailMaxSizeMB:           defaultThumbnailMaxSizeMB,
		ThumbnailOffsetPercent:       defaultThumbnailOffsetPercent,
		VideoSnapshotMaxAgeDays:      defaultVideoSnapshotMaxAgeDays,
		VideoSnapshotMaxSizeMB:       defaultVideoSnapshotMaxSizeMB,
		PlaybackMaxAgeDays:           defaultPlaybackMaxAgeDays,
		PlaybackMaxSizeMB:            defaultPlaybackMaxSizeMB,
		FullscreenHUDEnabled:         defaultFullscreenHUDEnabled,
		FullscreenHUDSideOffsetPX:    defaultFullscreenHUDSideOffsetPX,
		MobileLongPressRate:          defaultMobileLongPressRate,
		Provider:                     provider123,
	}
	if data, err := os.ReadFile(configPath); err == nil {
		_ = json.Unmarshal(data, &config)
	}
	if config.WebDAVCacheTTLMinutes < 1 || config.WebDAVCacheTTLMinutes > 24*60 {
		config.WebDAVCacheTTLMinutes = defaultURLCacheTTL
	}
	if config.QuarkDownloadCacheTTLMinutes < 1 || config.QuarkDownloadCacheTTLMinutes > 24*60 {
		config.QuarkDownloadCacheTTLMinutes = defaultURLCacheTTL
	}
	if config.QuarkIDCacheTTLMinutes < minQuarkIDCacheTTLMinutes || config.QuarkIDCacheTTLMinutes > maxQuarkIDCacheTTLMinutes {
		config.QuarkIDCacheTTLMinutes = defaultQuarkIDCacheTTL
	}
	if config.ThumbnailMaxAgeDays < minThumbnailMaxAgeDays || config.ThumbnailMaxAgeDays > maxThumbnailMaxAgeDays {
		config.ThumbnailMaxAgeDays = defaultThumbnailMaxAgeDays
	}
	if config.ThumbnailMaxSizeMB < minThumbnailMaxSizeMB || config.ThumbnailMaxSizeMB > maxThumbnailMaxSizeMB {
		config.ThumbnailMaxSizeMB = defaultThumbnailMaxSizeMB
	}
	if config.ThumbnailOffsetPercent < minThumbnailOffsetPercent || config.ThumbnailOffsetPercent > maxThumbnailOffsetPercent {
		config.ThumbnailOffsetPercent = defaultThumbnailOffsetPercent
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

	proxy, err := NewWebDAVProxy(defaultWebDAVEndpoint, time.Duration(config.WebDAVCacheTTLMinutes)*time.Minute)
	if err != nil {
		return nil, err
	}
	quark, err := NewQuarkDrive(
		time.Duration(config.QuarkDownloadCacheTTLMinutes)*time.Minute,
		time.Duration(config.QuarkIDCacheTTLMinutes)*time.Minute,
	)
	if err != nil {
		_ = proxy.Close()
		return nil, err
	}
	thumbnailCache, err := NewThumbnailCache(
		filepath.Join(filepath.Dir(configPath), "thumbnails"),
		time.Duration(config.ThumbnailMaxAgeDays)*24*time.Hour,
		int64(config.ThumbnailMaxSizeMB)*1024*1024,
	)
	if err != nil {
		_ = proxy.Close()
		_ = quark.Close()
		return nil, err
	}
	videoSnapshotDirectory := filepath.Join(filepath.Dir(configPath), "video-snapshots")
	videoSnapshotCache, err := NewVideoSnapshotCache(
		videoSnapshotDirectory,
		time.Duration(config.VideoSnapshotMaxAgeDays)*24*time.Hour,
		int64(config.VideoSnapshotMaxSizeMB)*1024*1024,
	)
	if err != nil {
		_ = proxy.Close()
		_ = quark.Close()
		return nil, err
	}
	proxy.SetVideoSnapshotDirectory(videoSnapshotDirectory)
	playbackProgress, err := NewPlaybackProgressStore(
		filepath.Join(filepath.Dir(configPath), "playback-progress.json"),
		time.Duration(config.PlaybackMaxAgeDays)*24*time.Hour,
		int64(config.PlaybackMaxSizeMB)*1024*1024,
	)
	if err != nil {
		_ = proxy.Close()
		_ = quark.Close()
		return nil, err
	}
	service := &AppService{
		config:         config,
		configPath:     configPath,
		proxy:          proxy,
		quark:          quark,
		thumbnails:     thumbnailCache,
		videoSnapshots: videoSnapshotCache,
		progress:       playbackProgress,
		httpClient:     &http.Client{Timeout: 30 * time.Second},
	}
	if config.Username != "" && config.Password != "" {
		service.credentials = credentials{username: config.Username, password: config.Password}
	}
	service.provider = config.Provider
	service.quarkCookie = config.QuarkCookie
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
	proxyErr := s.proxy.Close()
	quarkErr := s.quark.Close()
	if proxyErr != nil {
		return proxyErr
	}
	return quarkErr
}

func (s *AppService) GetState() AppState {
	s.mu.RLock()
	defer s.mu.RUnlock()
	storageDirectory := filepath.Dir(s.configPath)
	proxyBaseURL := s.proxy.BaseURL()
	if s.provider == providerQuark {
		proxyBaseURL = s.quark.BaseURL()
	}
	return AppState{
		Connected:                    s.connected123 || s.connectedQuark,
		Connected123:                 s.connected123,
		ConnectedQuark:               s.connectedQuark,
		Provider:                     s.provider,
		Username:                     s.credentials.username,
		Password:                     s.credentials.password,
		QuarkCookie:                  s.quarkCookie,
		Endpoint:                     defaultWebDAVEndpoint,
		QuarkEndpoint:                defaultQuarkAPIEndpoint,
		WebDAVCacheTTLMinutes:        s.config.WebDAVCacheTTLMinutes,
		QuarkDownloadCacheTTLMinutes: s.config.QuarkDownloadCacheTTLMinutes,
		QuarkIDCacheTTLMinutes:       s.config.QuarkIDCacheTTLMinutes,
		ThumbnailMaxAgeDays:          s.config.ThumbnailMaxAgeDays,
		ThumbnailMaxSizeMB:           s.config.ThumbnailMaxSizeMB,
		ThumbnailOffsetPercent:       s.config.ThumbnailOffsetPercent,
		VideoSnapshotMaxAgeDays:      s.config.VideoSnapshotMaxAgeDays,
		VideoSnapshotMaxSizeMB:       s.config.VideoSnapshotMaxSizeMB,
		PlaybackMaxAgeDays:           s.config.PlaybackMaxAgeDays,
		PlaybackMaxSizeMB:            s.config.PlaybackMaxSizeMB,
		FullscreenHUDEnabled:         s.config.FullscreenHUDEnabled,
		FullscreenHUDSideOffsetPX:    s.config.FullscreenHUDSideOffsetPX,
		MobileLongPressRate:          s.config.MobileLongPressRate,
		StorageDirectory:             storageDirectory,
		ConfigPath:                   s.configPath,
		ThumbnailDirectory:           filepath.Join(storageDirectory, "thumbnails"),
		VideoSnapshotDirectory:       filepath.Join(storageDirectory, "video-snapshots"),
		PlaybackProgressPath:         s.progress.Path(),
		ProxyBaseURL:                 proxyBaseURL,
		WebDAVProxyBaseURL:           s.proxy.BaseURL(),
		QuarkProxyBaseURL:            s.quark.BaseURL(),
	}
}

func (s *AppService) Login(ctx context.Context, username, password string) (AppState, error) {
	username = strings.TrimSpace(username)
	if username == "" || password == "" {
		return AppState{}, errors.New("账号和密码不能为空")
	}

	creds := credentials{username: username, password: password}
	if _, err := s.listDirectoryWithCredentials(ctx, "/", creds); err != nil {
		return AppState{}, fmt.Errorf("WebDAV 登录失败: %w", err)
	}

	s.mu.Lock()
	previousConfig := s.config
	previousCredentials := s.credentials
	previousProvider := s.provider
	previousConnected := s.connected123
	s.config.Username = username
	s.config.Password = password
	s.config.Provider = provider123
	config := s.config
	s.credentials = creds
	s.provider = provider123
	s.connected123 = true
	s.mu.Unlock()
	if err := s.saveConfig(config); err != nil {
		s.mu.Lock()
		s.config = previousConfig
		s.credentials = previousCredentials
		s.provider = previousProvider
		s.connected123 = previousConnected
		s.mu.Unlock()
		return AppState{}, err
	}
	s.proxy.SetCredentials(username, password)
	s.proxy.ClearCache()

	return s.GetState(), nil
}

func (s *AppService) LoginQuark(ctx context.Context, cookie string) (AppState, error) {
	cookie = strings.TrimSpace(cookie)
	if cookie == "" {
		return AppState{}, errors.New("Cookie 不能为空")
	}
	if err := s.quark.ValidateCookie(ctx, cookie); err != nil {
		return AppState{}, fmt.Errorf("夸克网盘登录失败: %w", err)
	}

	s.mu.Lock()
	previousConfig := s.config
	previousProvider := s.provider
	previousCookie := s.quarkCookie
	previousConnected := s.connectedQuark
	s.config.Provider = providerQuark
	s.config.QuarkCookie = cookie
	config := s.config
	s.provider = providerQuark
	s.quarkCookie = cookie
	s.connectedQuark = true
	s.mu.Unlock()
	if err := s.saveConfig(config); err != nil {
		s.mu.Lock()
		s.config = previousConfig
		s.provider = previousProvider
		s.quarkCookie = previousCookie
		s.connectedQuark = previousConnected
		s.mu.Unlock()
		return AppState{}, err
	}
	s.quark.SetCookie(cookie)
	s.quark.ClearIDCache()
	s.quark.ClearDownloadCache()
	return s.GetState(), nil
}

func (s *AppService) Logout() AppState {
	s.mu.Lock()
	provider := s.provider
	if provider == providerQuark {
		s.config.QuarkCookie = ""
		s.quarkCookie = ""
		s.connectedQuark = false
		if s.connected123 {
			s.provider = provider123
		}
	} else {
		s.config.Username = ""
		s.config.Password = ""
		s.credentials = credentials{}
		s.connected123 = false
		if s.connectedQuark {
			s.provider = providerQuark
		}
	}
	s.config.Provider = s.provider
	config := s.config
	s.mu.Unlock()
	_ = s.saveConfig(config)
	if provider == providerQuark {
		s.quark.SetCookie("")
		s.quark.ClearIDCache()
		s.quark.ClearDownloadCache()
	} else {
		s.proxy.SetCredentials("", "")
		s.proxy.ClearCache()
	}
	return s.GetState()
}

func (s *AppService) SwitchProvider(provider string) (AppState, error) {
	provider = strings.TrimSpace(provider)
	if provider != provider123 && provider != providerQuark {
		return AppState{}, errors.New("未知网盘类型")
	}

	s.mu.Lock()
	if (provider == provider123 && !s.connected123) || (provider == providerQuark && !s.connectedQuark) {
		s.mu.Unlock()
		return AppState{}, errors.New("目标网盘尚未登录")
	}
	previousProvider := s.provider
	previousConfigProvider := s.config.Provider
	s.provider = provider
	s.config.Provider = provider
	config := s.config
	s.mu.Unlock()

	if err := s.saveConfig(config); err != nil {
		s.mu.Lock()
		s.provider = previousProvider
		s.config.Provider = previousConfigProvider
		s.mu.Unlock()
		return AppState{}, err
	}
	return s.GetState(), nil
}

func (s *AppService) ListDirectory(ctx context.Context, remotePath string) ([]FileEntry, error) {
	provider, err := s.currentProvider()
	if err != nil {
		return nil, err
	}
	remotePath = normalizeRemotePath(remotePath)
	if provider == providerQuark {
		return s.quark.ListDirectory(ctx, remotePath)
	}
	creds, err := s.currentCredentials()
	if err != nil {
		return nil, err
	}
	return s.listDirectoryWithCredentials(ctx, remotePath, creds)
}

func (s *AppService) GetPlaybackURL(remotePath string) (string, error) {
	provider, err := s.currentProvider()
	if err != nil {
		return "", err
	}
	if provider == providerQuark {
		return s.quark.URLForPath(normalizeRemotePath(remotePath)), nil
	}
	if _, err := s.currentCredentials(); err != nil {
		return "", err
	}
	return s.proxy.URLForPath(normalizeRemotePath(remotePath)), nil
}

func (s *AppService) ListRedirectCache(provider string) ([]RedirectCacheEntry, error) {
	switch strings.TrimSpace(provider) {
	case providerQuark:
		return s.quark.DownloadCacheEntries(), nil
	case provider123:
		return s.proxy.CacheEntries(), nil
	default:
		return nil, errors.New("未知网盘类型")
	}
}

func (s *AppService) ClearRedirectCache(provider string) error {
	switch strings.TrimSpace(provider) {
	case providerQuark:
		s.quark.ClearDownloadCache()
		return nil
	case provider123:
		s.proxy.ClearCache()
		return nil
	default:
		return errors.New("未知网盘类型")
	}
}

func (s *AppService) SetWebDAVCacheTTL(minutes int) (AppState, error) {
	if minutes < 1 || minutes > 24*60 {
		return AppState{}, errors.New("123 URL 缓存时间必须在 1 到 1440 分钟之间")
	}

	s.mu.Lock()
	previous := s.config
	s.config.WebDAVCacheTTLMinutes = minutes
	config := s.config
	s.mu.Unlock()

	if err := s.saveConfig(config); err != nil {
		s.mu.Lock()
		s.config = previous
		s.mu.Unlock()
		return AppState{}, err
	}
	s.proxy.SetTTL(time.Duration(minutes) * time.Minute)
	return s.GetState(), nil
}

func (s *AppService) SetQuarkDownloadCacheTTL(minutes int) (AppState, error) {
	if minutes < 1 || minutes > 24*60 {
		return AppState{}, errors.New("夸克下载 URL 缓存时间必须在 1 到 1440 分钟之间")
	}

	s.mu.Lock()
	previous := s.config
	s.config.QuarkDownloadCacheTTLMinutes = minutes
	config := s.config
	s.mu.Unlock()

	if err := s.saveConfig(config); err != nil {
		s.mu.Lock()
		s.config = previous
		s.mu.Unlock()
		return AppState{}, err
	}
	s.quark.SetDownloadTTL(time.Duration(minutes) * time.Minute)
	return s.GetState(), nil
}

func (s *AppService) GetQuarkIDCacheStats() QuarkIDCacheStats {
	return s.quark.IDCacheStats()
}

func (s *AppService) ClearQuarkIDCache() QuarkIDCacheStats {
	return s.quark.ClearIDCache()
}

func (s *AppService) SetQuarkIDCacheTTL(minutes int) (AppState, error) {
	if minutes < minQuarkIDCacheTTLMinutes || minutes > maxQuarkIDCacheTTLMinutes {
		return AppState{}, fmt.Errorf("夸克路径 ID 缓存时间必须在 %d 到 %d 分钟之间", minQuarkIDCacheTTLMinutes, maxQuarkIDCacheTTLMinutes)
	}
	s.mu.Lock()
	previous := s.config
	s.config.QuarkIDCacheTTLMinutes = minutes
	config := s.config
	s.mu.Unlock()
	if err := s.saveConfig(config); err != nil {
		s.mu.Lock()
		s.config = previous
		s.mu.Unlock()
		return AppState{}, err
	}
	s.quark.SetIDTTL(time.Duration(minutes) * time.Minute)
	return s.GetState(), nil
}

func (s *AppService) GetThumbnail(remotePath, modifiedAt string) (ThumbnailResult, error) {
	accountKey, err := s.currentAccountKey()
	if err != nil {
		return ThumbnailResult{}, err
	}
	s.mu.RLock()
	offsetPercent := s.config.ThumbnailOffsetPercent
	s.mu.RUnlock()
	return s.thumbnails.Get(thumbnailCacheKey(accountKey, remotePath, modifiedAt, offsetPercent))
}

func (s *AppService) SaveThumbnail(remotePath, modifiedAt, dataURL string) (ThumbnailCacheStats, error) {
	accountKey, err := s.currentAccountKey()
	if err != nil {
		return ThumbnailCacheStats{}, err
	}
	s.mu.RLock()
	offsetPercent := s.config.ThumbnailOffsetPercent
	s.mu.RUnlock()
	return s.thumbnails.Save(thumbnailCacheKey(accountKey, remotePath, modifiedAt, offsetPercent), dataURL)
}

func (s *AppService) GetThumbnailCacheStats() (ThumbnailCacheStats, error) {
	return s.thumbnails.Stats()
}

func (s *AppService) ClearThumbnailCache() (ThumbnailCacheStats, error) {
	return s.thumbnails.Clear()
}

func (s *AppService) SetThumbnailSettings(maxAgeDays, maxSizeMB, offsetPercent int) (AppState, error) {
	if maxAgeDays < minThumbnailMaxAgeDays || maxAgeDays > maxThumbnailMaxAgeDays {
		return AppState{}, fmt.Errorf("缩略图保留时间必须在 %d 到 %d 天之间", minThumbnailMaxAgeDays, maxThumbnailMaxAgeDays)
	}
	if maxSizeMB < minThumbnailMaxSizeMB || maxSizeMB > maxThumbnailMaxSizeMB {
		return AppState{}, fmt.Errorf("缩略图缓存上限必须在 %d 到 %d MB 之间", minThumbnailMaxSizeMB, maxThumbnailMaxSizeMB)
	}
	if offsetPercent < minThumbnailOffsetPercent || offsetPercent > maxThumbnailOffsetPercent {
		return AppState{}, fmt.Errorf("缩略图截帧位置必须在 %d%% 到 %d%% 之间", minThumbnailOffsetPercent, maxThumbnailOffsetPercent)
	}

	s.mu.Lock()
	previous := s.config
	s.config.ThumbnailMaxAgeDays = maxAgeDays
	s.config.ThumbnailMaxSizeMB = maxSizeMB
	s.config.ThumbnailOffsetPercent = offsetPercent
	config := s.config
	s.mu.Unlock()

	if err := s.saveConfig(config); err != nil {
		s.mu.Lock()
		s.config = previous
		s.mu.Unlock()
		return AppState{}, err
	}
	if err := s.thumbnails.SetLimits(time.Duration(maxAgeDays)*24*time.Hour, int64(maxSizeMB)*1024*1024); err != nil {
		return AppState{}, err
	}
	return s.GetState(), nil
}

func (s *AppService) GetVideoSnapshots(remotePath, modifiedAt string) ([]VideoSnapshot, error) {
	accountKey, err := s.currentAccountKey()
	if err != nil {
		return nil, err
	}
	entries, err := s.videoSnapshots.GetSeries(videoSnapshotCacheKey(accountKey, remotePath, modifiedAt))
	if err != nil {
		return nil, err
	}
	result := make([]VideoSnapshot, 0, len(entries))
	for _, entry := range entries {
		result = append(result, VideoSnapshot{
			Position: entry.Position,
			URL:      s.proxy.VideoSnapshotURL(entry.FileName),
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

func (s *AppService) SetVideoSnapshotSettings(maxAgeDays, maxSizeMB int) (AppState, error) {
	if maxAgeDays < minVideoSnapshotMaxAgeDays || maxAgeDays > maxVideoSnapshotMaxAgeDays {
		return AppState{}, fmt.Errorf("视频截图保留时间必须在 %d 到 %d 天之间", minVideoSnapshotMaxAgeDays, maxVideoSnapshotMaxAgeDays)
	}
	if maxSizeMB < minVideoSnapshotMaxSizeMB || maxSizeMB > maxVideoSnapshotMaxSizeMB {
		return AppState{}, fmt.Errorf("视频截图缓存上限必须在 %d 到 %d MB 之间", minVideoSnapshotMaxSizeMB, maxVideoSnapshotMaxSizeMB)
	}

	s.mu.Lock()
	previous := s.config
	s.config.VideoSnapshotMaxAgeDays = maxAgeDays
	s.config.VideoSnapshotMaxSizeMB = maxSizeMB
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

func (s *AppService) currentCredentials() (credentials, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if !s.connected123 || s.provider != provider123 || s.credentials.username == "" || s.credentials.password == "" {
		return credentials{}, errors.New("尚未登录 WebDAV")
	}
	return s.credentials, nil
}

func (s *AppService) currentProvider() (string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	switch s.provider {
	case provider123:
		if !s.connected123 {
			return "", errors.New("123 云盘尚未登录")
		}
	case providerQuark:
		if !s.connectedQuark {
			return "", errors.New("夸克网盘尚未登录")
		}
	default:
		return "", errors.New("未知网盘类型")
	}
	return s.provider, nil
}

func (s *AppService) currentAccountKey() (string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.provider == providerQuark {
		if !s.connectedQuark || s.quarkCookie == "" {
			return "", errors.New("尚未登录夸克网盘")
		}
		sum := sha256.Sum256([]byte(s.quarkCookie))
		return fmt.Sprintf("quark:%x", sum[:]), nil
	}
	if s.provider != provider123 {
		return "", errors.New("未知网盘类型")
	}
	if !s.connected123 || s.credentials.username == "" || s.credentials.password == "" {
		return "", errors.New("尚未登录 WebDAV")
	}
	return s.credentials.username, nil
}

func (s *AppService) listDirectoryWithCredentials(ctx context.Context, remotePath string, creds credentials) ([]FileEntry, error) {
	remotePath = normalizeRemotePath(remotePath)
	upstreamURL, err := buildUpstreamURL(defaultWebDAVEndpoint, remotePath, nil)
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
	req.SetBasicAuth(creds.username, creds.password)
	req.Header.Set("Depth", "1")
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

	entries := make([]FileEntry, 0, len(result.Responses))
	for _, item := range result.Responses {
		entry, ok := davResponseToEntry(item)
		if !ok || sameRemotePath(entry.Path, remotePath) {
			continue
		}
		entries = append(entries, entry)
	}

	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].IsDirectory != entries[j].IsDirectory {
			return entries[i].IsDirectory
		}
		return strings.ToLower(entries[i].Name) < strings.ToLower(entries[j].Name)
	})
	return entries, nil
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

func davResponseToEntry(item davResponse) (FileEntry, bool) {
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

	remotePath := remotePathFromHref(item.Href)
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

func remotePathFromHref(href string) string {
	u, err := url.Parse(href)
	if err != nil {
		return ""
	}
	decoded, err := url.PathUnescape(u.EscapedPath())
	if err != nil {
		decoded = u.Path
	}
	base, _ := url.Parse(defaultWebDAVEndpoint)
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
