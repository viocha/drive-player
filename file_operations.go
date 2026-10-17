package main

import (
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"unicode"
)

func (s *AppService) fileAccount(id string) (WebDAVAccount, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	index := accountIndexByID(s.config.Accounts, id)
	if index < 0 {
		return WebDAVAccount{}, errors.New("WebDAV 账户不存在")
	}
	return s.config.Accounts[index], nil
}

func (s *AppService) GetFileLink(accountID, remotePath string, credentials bool) (string, error) {
	account, err := s.fileAccount(accountID)
	if err != nil {
		return "", err
	}
	u, err := buildUpstreamURL(account.Endpoint, remotePath, nil)
	if err != nil {
		return "", err
	}
	u.User = nil
	if credentials && (account.Username != "" || account.Password != "") {
		u.User = url.UserPassword(account.Username, account.Password)
	}
	return u.String(), nil
}

func (s *AppService) ListAccountDirectory(ctx context.Context, accountID, remotePath string) ([]FileEntry, error) {
	account, err := s.fileAccount(accountID)
	if err != nil {
		return nil, err
	}
	return s.listDirectoryWithAccount(ctx, remotePath, account)
}

func (s *AppService) MoveEntry(ctx context.Context, accountID, remotePath, targetDirectory string) (string, error) {
	remotePath = normalizeRemotePath(remotePath)
	targetDirectory = normalizeRemotePath(targetDirectory)
	if remotePath == "/" {
		return "", errors.New("不能移动根目录")
	}
	if targetDirectory == remotePath || strings.HasPrefix(targetDirectory, remotePath+"/") {
		return "", errors.New("不能移动到自身或子目录")
	}
	target := path.Join(targetDirectory, path.Base(remotePath))
	account, err := s.fileAccount(accountID)
	if err != nil {
		return "", err
	}
	if target == remotePath {
		return target, nil
	}
	destination, err := buildUpstreamURL(account.Endpoint, target, nil)
	if err != nil {
		return "", err
	}
	destination.User = nil
	if err := s.mutateEntry(ctx, account, "MOVE", remotePath, destination.String()); err != nil {
		return "", err
	}
	return target, nil
}

// RenameEntry 只修改主文件名，目录名称整体可编辑。
func (s *AppService) RenameEntry(ctx context.Context, accountID, remotePath, stem string, directory bool) (string, error) {
	remotePath = normalizeRemotePath(remotePath)
	if remotePath == "/" {
		return "", errors.New("不能重命名根目录")
	}
	if strings.TrimSpace(stem) == "" || stem == "." || stem == ".." || strings.ContainsAny(stem, "/\\") || strings.IndexFunc(stem, unicode.IsControl) >= 0 {
		return "", errors.New("名称不能为空，不能包含路径分隔符或控制字符")
	}
	name := stem
	if !directory {
		original := path.Base(remotePath)
		if dot := strings.LastIndex(original, "."); dot > 0 {
			name += original[dot:]
		}
	}
	target := path.Join(path.Dir(remotePath), name)
	if target == remotePath {
		return target, nil
	}
	account, err := s.fileAccount(accountID)
	if err != nil {
		return "", err
	}
	destination, err := buildUpstreamURL(account.Endpoint, target, nil)
	if err != nil {
		return "", err
	}
	destination.User = nil
	if err := s.mutateEntry(ctx, account, "MOVE", remotePath, destination.String()); err != nil {
		return "", err
	}
	return target, nil
}

func (s *AppService) DeleteEntry(ctx context.Context, accountID, remotePath string) error {
	remotePath = normalizeRemotePath(remotePath)
	if remotePath == "/" {
		return errors.New("不能删除根目录")
	}
	account, err := s.fileAccount(accountID)
	if err != nil {
		return err
	}
	return s.mutateEntry(ctx, account, "DELETE", remotePath, "")
}

func (s *AppService) mutateEntry(ctx context.Context, account WebDAVAccount, method, remotePath, destination string) error {
	u, err := buildUpstreamURL(account.Endpoint, remotePath, nil)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), nil)
	if err != nil {
		return err
	}
	if account.Username != "" || account.Password != "" {
		req.SetBasicAuth(account.Username, account.Password)
	}
	req.Header.Set("User-Agent", "DrivePlayer/1.0")
	if destination != "" {
		req.Header.Set("Destination", destination)
		req.Header.Set("Overwrite", "F")
	}
	// 修改操作不跟随重定向，避免将请求和凭据发送到其他地址。
	client := *s.httpClient
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("%s 失败：%s %s", method, resp.Status, strings.TrimSpace(string(body)))
	}
	if resp.StatusCode == http.StatusMultiStatus {
		var result struct {
			Responses []struct {
				Status string `xml:"status"`
			} `xml:"response"`
		}
		if err := xml.NewDecoder(resp.Body).Decode(&result); err != nil {
			return fmt.Errorf("解析操作结果：%w", err)
		}
		for _, item := range result.Responses {
			fields := strings.Fields(item.Status)
			if len(fields) < 2 {
				return errors.New("WebDAV 返回无效的操作状态")
			}
			code, _ := strconv.Atoi(fields[1])
			if code < 200 || code >= 300 {
				return fmt.Errorf("%s 未完成：%s", method, item.Status)
			}
		}
	}
	return nil
}
