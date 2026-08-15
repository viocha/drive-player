package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync"
	"testing"
	"time"
)

func TestQuarkChunkedRangeProxy(t *testing.T) {
	t.Parallel()

	data := bytes.Repeat([]byte("x"), 701)
	var mu sync.Mutex
	var objectRanges []string
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/1/clouddrive/file/sort":
			if got := r.Header.Get("Cookie"); got != "session=old" {
				t.Errorf("list cookie = %q", got)
			}
			writeJSON(t, w, map[string]any{
				"status":  200,
				"code":    0,
				"message": "",
				"data": map[string]any{
					"list": []map[string]any{{
						"fid":        "fid-big",
						"file_name":  "big.mp4",
						"pdir_fid":   "0",
						"dir":        false,
						"file":       true,
						"size":       len(data),
						"updated_at": 1_700_000_000,
					}},
				},
				"metadata": map[string]any{"_page": 1, "_size": 100, "_count": 1, "_total": 1},
			})
		case "/1/clouddrive/file/download":
			if got := r.Header.Get("Cookie"); got != "session=old" {
				t.Errorf("download API cookie = %q", got)
			}
			if got := r.Header.Get("User-Agent"); got != quarkDesktopUserAgent {
				t.Errorf("download API user-agent = %q", got)
			}
			var body struct {
				FIDs []string `json:"fids"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Errorf("decode download body: %v", err)
			}
			if !reflect.DeepEqual(body.FIDs, []string{"fid-big"}) {
				t.Errorf("download fids = %#v", body.FIDs)
			}
			w.Header().Add("Set-Cookie", "__puus=fresh; Path=/; HttpOnly")
			writeJSON(t, w, map[string]any{
				"status":  200,
				"code":    0,
				"message": "",
				"data": []map[string]any{{
					"fid":          "fid-big",
					"file_name":    "big.mp4",
					"download_url": server.URL + "/object",
					"size":         len(data),
				}},
			})
		case "/object":
			if got := r.Header.Get("Cookie"); got != "__puus=fresh" {
				t.Errorf("object cookie = %q", got)
			}
			mu.Lock()
			objectRanges = append(objectRanges, r.Header.Get("Range"))
			mu.Unlock()
			http.ServeContent(w, r, "big.mp4", time.Time{}, bytes.NewReader(data))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	quark, err := newQuarkDrive(server.URL, time.Hour, time.Hour, 300)
	if err != nil {
		t.Fatal(err)
	}
	defer quark.Close()
	quark.SetCookie("session=old")

	req, err := http.NewRequest(http.MethodGet, quark.URLForPath("/big.mp4"), nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Range", "bytes=10-700")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusPartialContent {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	if got := resp.Header.Get("Content-Range"); got != "bytes 10-700/701" {
		t.Fatalf("Content-Range = %q", got)
	}
	if !bytes.Equal(body, data[10:701]) {
		t.Fatalf("body length = %d, want %d", len(body), 691)
	}

	mu.Lock()
	ranges := append([]string(nil), objectRanges...)
	mu.Unlock()
	wantRanges := []string{"bytes=10-309", "bytes=310-609", "bytes=610-700"}
	if !reflect.DeepEqual(ranges, wantRanges) {
		t.Fatalf("ranges = %#v, want %#v", ranges, wantRanges)
	}

	mu.Lock()
	objectRanges = nil
	mu.Unlock()
	fullResp, err := http.Get(quark.URLForPath("/big.mp4"))
	if err != nil {
		t.Fatal(err)
	}
	fullBody, err := io.ReadAll(fullResp.Body)
	fullResp.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if fullResp.StatusCode != http.StatusOK {
		t.Fatalf("full status = %d", fullResp.StatusCode)
	}
	if !bytes.Equal(fullBody, data) {
		t.Fatalf("full body length = %d, want %d", len(fullBody), len(data))
	}
	mu.Lock()
	fullRanges := append([]string(nil), objectRanges...)
	mu.Unlock()
	wantFullRanges := []string{"bytes=0-299", "bytes=300-599", "bytes=600-700"}
	if !reflect.DeepEqual(fullRanges, wantFullRanges) {
		t.Fatalf("full ranges = %#v, want %#v", fullRanges, wantFullRanges)
	}

	stats := quark.IDCacheStats()
	if stats.Count != 1 {
		t.Fatalf("ID cache count = %d, want 1", stats.Count)
	}
	if cleared := quark.ClearIDCache(); cleared.Count != 0 {
		t.Fatalf("cleared ID cache count = %d", cleared.Count)
	}
	if entries := quark.DownloadCacheEntries(); len(entries) != 1 || entries[0].Path != "/big.mp4" {
		t.Fatalf("download cache = %#v", entries)
	}
}

func TestQuarkProxyCancellationPropagatesUpstream(t *testing.T) {
	t.Parallel()

	upstreamStarted := make(chan struct{})
	upstreamCanceled := make(chan struct{})
	var startOnce sync.Once
	var cancelOnce sync.Once
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/1/clouddrive/file/sort":
			writeJSON(t, w, map[string]any{
				"status": 200, "code": 0, "message": "",
				"data": map[string]any{"list": []map[string]any{{
					"fid": "fid-cancel", "file_name": "cancel.mp4", "pdir_fid": "0",
					"dir": false, "file": true, "size": 700,
				}}},
				"metadata": map[string]any{"_page": 1, "_size": 100, "_count": 1, "_total": 1},
			})
		case "/1/clouddrive/file/download":
			w.Header().Add("Set-Cookie", "__puus=fresh; Path=/")
			writeJSON(t, w, map[string]any{
				"status": 200, "code": 0, "message": "",
				"data": []map[string]any{{
					"fid": "fid-cancel", "file_name": "cancel.mp4",
					"download_url": server.URL + "/object", "size": 700,
				}},
			})
		case "/object":
			w.Header().Set("Content-Type", "video/mp4")
			w.Header().Set("Content-Range", "bytes 0-299/700")
			w.Header().Set("Content-Length", "300")
			w.WriteHeader(http.StatusPartialContent)
			if flusher, ok := w.(http.Flusher); ok {
				flusher.Flush()
			}
			startOnce.Do(func() { close(upstreamStarted) })
			<-r.Context().Done()
			cancelOnce.Do(func() { close(upstreamCanceled) })
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	quark, err := newQuarkDrive(server.URL, time.Hour, time.Hour, 300)
	if err != nil {
		t.Fatal(err)
	}
	defer quark.Close()
	quark.SetCookie("session=old")

	ctx, cancel := context.WithCancel(context.Background())
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, quark.URLForPath("/cancel.mp4"), nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Range", "bytes=0-699")
	requestDone := make(chan error, 1)
	go func() {
		resp, requestErr := http.DefaultClient.Do(req)
		if resp != nil {
			resp.Body.Close()
		}
		requestDone <- requestErr
	}()

	select {
	case <-upstreamStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("upstream request did not start")
	}
	cancel()
	select {
	case <-upstreamCanceled:
	case <-time.After(2 * time.Second):
		t.Fatal("upstream request context was not canceled")
	}
	select {
	case <-requestDone:
	case <-time.After(2 * time.Second):
		t.Fatal("downstream request did not finish after cancellation")
	}
}

func TestParseSingleByteRange(t *testing.T) {
	t.Parallel()
	tests := []struct {
		header        string
		start, end    int64
		partial, fail bool
	}{
		{"", 0, 999, false, false},
		{"bytes=100-", 100, 999, true, false},
		{"bytes=100-199", 100, 199, true, false},
		{"bytes=-100", 900, 999, true, false},
		{"bytes=100-2000", 100, 999, true, false},
		{"bytes=1000-", 0, 0, false, true},
		{"bytes=0-1,3-4", 0, 0, false, true},
	}
	for _, test := range tests {
		t.Run(test.header, func(t *testing.T) {
			start, end, partial, err := parseSingleByteRange(test.header, 1000)
			if test.fail {
				if err == nil {
					t.Fatal("expected error")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if start != test.start || end != test.end || partial != test.partial {
				t.Fatalf("got %d-%d partial=%v", start, end, partial)
			}
		})
	}
}

func writeJSON(t *testing.T, w http.ResponseWriter, value any) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(value); err != nil {
		t.Errorf("encode response: %v", err)
	}
}

func ExampleQuarkDrive_chunking() {
	fmt.Println(defaultQuarkChunkSize / 1024 / 1024)
	// Output: 300
}
