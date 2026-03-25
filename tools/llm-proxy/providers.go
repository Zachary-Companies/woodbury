package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

type ProviderResult struct {
	Response    AnthropicResponse
	InputTokens  int
	OutputTokens int
	LatencyMs    int64
	RawBody      []byte
}

// CallAnthropic forwards the request directly to the Anthropic API
func CallAnthropic(backend Backend, reqBody []byte, headers http.Header) (*ProviderResult, int, error) {
	start := time.Now()

	url := backend.BaseURL + "/v1/messages"
	httpReq, err := http.NewRequest("POST", url, bytes.NewReader(reqBody))
	if err != nil {
		return nil, 0, fmt.Errorf("create request: %w", err)
	}

	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("x-api-key", backend.APIKey)
	httpReq.Header.Set("anthropic-version", "2023-06-01")

	// Forward relevant headers
	if v := headers.Get("anthropic-beta"); v != "" {
		httpReq.Header.Set("anthropic-beta", v)
	}

	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Do(httpReq)
	if err != nil {
		return nil, 0, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, resp.StatusCode, fmt.Errorf("read response: %w", err)
	}

	latency := time.Since(start).Milliseconds()

	if resp.StatusCode != 200 {
		return &ProviderResult{LatencyMs: latency, RawBody: body}, resp.StatusCode, nil
	}

	var anthropicResp AnthropicResponse
	if err := json.Unmarshal(body, &anthropicResp); err != nil {
		return &ProviderResult{LatencyMs: latency, RawBody: body}, 200, nil
	}

	return &ProviderResult{
		Response:     anthropicResp,
		InputTokens:  anthropicResp.Usage.InputTokens,
		OutputTokens: anthropicResp.Usage.OutputTokens,
		LatencyMs:    latency,
		RawBody:      body,
	}, 200, nil
}

// CallAnthropicStream forwards a streaming request and pipes the SSE response
func CallAnthropicStream(backend Backend, reqBody []byte, headers http.Header, w http.ResponseWriter) (int, int, int64, error) {
	start := time.Now()

	url := backend.BaseURL + "/v1/messages"
	httpReq, err := http.NewRequest("POST", url, bytes.NewReader(reqBody))
	if err != nil {
		return 0, 0, 0, err
	}

	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("x-api-key", backend.APIKey)
	httpReq.Header.Set("anthropic-version", "2023-06-01")
	if v := headers.Get("anthropic-beta"); v != "" {
		httpReq.Header.Set("anthropic-beta", v)
	}

	client := &http.Client{Timeout: 300 * time.Second}
	resp, err := client.Do(httpReq)
	if err != nil {
		return 0, 0, 0, err
	}
	defer resp.Body.Close()

	// Set SSE headers
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(resp.StatusCode)

	flusher, _ := w.(http.Flusher)

	// Pipe through, tracking tokens from message_delta events
	var inputTokens, outputTokens int
	buf := make([]byte, 4096)
	for {
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			w.Write(buf[:n])
			if flusher != nil {
				flusher.Flush()
			}
			// Quick token extraction from SSE data
			chunk := string(buf[:n])
			inputTokens += extractTokenCount(chunk, "input_tokens")
			outputTokens += extractTokenCount(chunk, "output_tokens")
		}
		if readErr != nil {
			break
		}
	}

	return inputTokens, outputTokens, time.Since(start).Milliseconds(), nil
}

// CallOpenAI sends request to OpenAI (after translation) and returns Anthropic-format response
func CallOpenAI(backend Backend, anthropicReq AnthropicRequest) (*ProviderResult, int, error) {
	start := time.Now()

	openaiReq := AnthropicToOpenAI(anthropicReq)
	reqBody, err := json.Marshal(openaiReq)
	if err != nil {
		return nil, 0, fmt.Errorf("marshal: %w", err)
	}

	url := backend.BaseURL + "/v1/chat/completions"
	httpReq, err := http.NewRequest("POST", url, bytes.NewReader(reqBody))
	if err != nil {
		return nil, 0, fmt.Errorf("create request: %w", err)
	}

	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+backend.APIKey)

	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Do(httpReq)
	if err != nil {
		return nil, 0, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, resp.StatusCode, fmt.Errorf("read response: %w", err)
	}

	latency := time.Since(start).Milliseconds()

	if resp.StatusCode != 200 {
		return &ProviderResult{LatencyMs: latency, RawBody: body}, resp.StatusCode, nil
	}

	var openaiResp OpenAIResponse
	if err := json.Unmarshal(body, &openaiResp); err != nil {
		return &ProviderResult{LatencyMs: latency, RawBody: body}, 200, nil
	}

	anthropicResp := OpenAIToAnthropicResponse(openaiResp, anthropicReq.Model)
	resultBody, _ := json.Marshal(anthropicResp)

	return &ProviderResult{
		Response:     anthropicResp,
		InputTokens:  openaiResp.Usage.PromptTokens,
		OutputTokens: openaiResp.Usage.CompletionTokens,
		LatencyMs:    latency,
		RawBody:      resultBody,
	}, 200, nil
}

func extractTokenCount(chunk, field string) int {
	// Quick-and-dirty extraction from SSE JSON fragments
	idx := bytes.Index([]byte(chunk), []byte(`"`+field+`":`))
	if idx < 0 {
		return 0
	}
	rest := chunk[idx+len(field)+3:]
	var n int
	for _, c := range rest {
		if c >= '0' && c <= '9' {
			n = n*10 + int(c-'0')
		} else {
			break
		}
	}
	return n
}
