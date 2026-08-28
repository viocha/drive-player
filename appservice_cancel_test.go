package main

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func TestListDirectoryWithAccountPropagatesCancellationToUpstream(t *testing.T) {
	started := make(chan struct{})
	upstreamCanceled := make(chan error, 1)

	service := &AppService{
		httpClient: &http.Client{
			Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
				close(started)
				<-req.Context().Done()
				upstreamCanceled <- req.Context().Err()
				return nil, req.Context().Err()
			}),
		},
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := service.listDirectoryWithAccount(ctx, "/", WebDAVAccount{ID: "test", Name: "test", Endpoint: "https://example.invalid/webdav", Username: "user", Password: "pass"})
		done <- err
	}()

	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("upstream PROPFIND did not start")
	}
	cancel()

	select {
	case err := <-upstreamCanceled:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("upstream context error = %v, want context.Canceled", err)
		}
	case <-time.After(time.Second):
		t.Fatal("upstream PROPFIND did not observe cancellation")
	}

	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("listDirectoryWithAccount error = %v, want context.Canceled", err)
		}
	case <-time.After(time.Second):
		t.Fatal("listDirectoryWithAccount did not return after cancellation")
	}
}
