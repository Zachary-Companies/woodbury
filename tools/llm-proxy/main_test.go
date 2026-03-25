package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestDefaultConfig(t *testing.T) {
	cfg := DefaultConfig()
	if cfg.Port != 8642 {
		t.Errorf("expected port 8642, got %d", cfg.Port)
	}
	if cfg.DefaultBackend != "anthropic" {
		t.Errorf("expected default backend anthropic, got %s", cfg.DefaultBackend)
	}
	if _, ok := cfg.Backends["anthropic"]; !ok {
		t.Error("missing anthropic backend")
	}
	if _, ok := cfg.Backends["openai"]; !ok {
		t.Error("missing openai backend")
	}
}

func TestResolveBackend(t *testing.T) {
	cfg := DefaultConfig()

	tests := []struct {
		model    string
		expected string
	}{
		{"claude-sonnet-4-20250514", "anthropic"},
		{"claude-opus-4-20250514", "anthropic"},
		{"gpt-4o", "openai"},
		{"gpt-4o-mini", "openai"},
		{"o1-mini", "openai"},
		{"o3-mini", "openai"},
		{"unknown-model", "anthropic"}, // fallback to default
	}

	for _, tt := range tests {
		t.Run(tt.model, func(t *testing.T) {
			result := cfg.ResolveBackend(tt.model)
			if result != tt.expected {
				t.Errorf("model %q: expected %s, got %s", tt.model, tt.expected, result)
			}
		})
	}
}

func TestMatchGlob(t *testing.T) {
	tests := []struct {
		pattern  string
		s        string
		expected bool
	}{
		{"*", "anything", true},
		{"claude-*", "claude-sonnet-4", true},
		{"claude-*", "gpt-4o", false},
		{"gpt-*", "gpt-4o-mini", true},
		{"exact", "exact", true},
		{"exact", "other", false},
	}
	for _, tt := range tests {
		result := matchGlob(tt.pattern, tt.s)
		if result != tt.expected {
			t.Errorf("matchGlob(%q, %q) = %v, want %v", tt.pattern, tt.s, result, tt.expected)
		}
	}
}

func TestAnthropicToOpenAI(t *testing.T) {
	req := AnthropicRequest{
		Model:     "gpt-4o",
		MaxTokens: 1000,
		System:    "You are helpful.",
		Messages: []AnthropicMessage{
			{Role: "user", Content: "Hello!"},
		},
	}

	oaiReq := AnthropicToOpenAI(req)

	if oaiReq.Model != "gpt-4o" {
		t.Errorf("expected model gpt-4o, got %s", oaiReq.Model)
	}
	if oaiReq.MaxTokens != 1000 {
		t.Errorf("expected max_tokens 1000, got %d", oaiReq.MaxTokens)
	}
	if len(oaiReq.Messages) != 2 {
		t.Fatalf("expected 2 messages (system + user), got %d", len(oaiReq.Messages))
	}
	if oaiReq.Messages[0].Role != "system" {
		t.Errorf("expected first message role 'system', got %s", oaiReq.Messages[0].Role)
	}
	if oaiReq.Messages[0].Content != "You are helpful." {
		t.Errorf("expected system content 'You are helpful.', got %s", oaiReq.Messages[0].Content)
	}
	if oaiReq.Messages[1].Role != "user" {
		t.Errorf("expected second message role 'user', got %s", oaiReq.Messages[1].Role)
	}
}

func TestAnthropicToOpenAI_ContentBlocks(t *testing.T) {
	req := AnthropicRequest{
		Model:     "gpt-4o",
		MaxTokens: 100,
		Messages: []AnthropicMessage{
			{Role: "user", Content: []interface{}{
				map[string]interface{}{"type": "text", "text": "What is 2+2?"},
			}},
		},
	}

	oaiReq := AnthropicToOpenAI(req)
	if len(oaiReq.Messages) != 1 {
		t.Fatalf("expected 1 message, got %d", len(oaiReq.Messages))
	}
	if oaiReq.Messages[0].Content != "What is 2+2?" {
		t.Errorf("expected content 'What is 2+2?', got %s", oaiReq.Messages[0].Content)
	}
}

func TestOpenAIToAnthropicResponse(t *testing.T) {
	oaiResp := OpenAIResponse{
		ID:     "chatcmpl-123",
		Object: "chat.completion",
		Model:  "gpt-4o",
		Choices: []OpenAIChoice{
			{Index: 0, Message: OpenAIMessage{Role: "assistant", Content: "4"}, FinishReason: "stop"},
		},
		Usage: OpenAIUsage{PromptTokens: 10, CompletionTokens: 5, TotalTokens: 15},
	}

	anthResp := OpenAIToAnthropicResponse(oaiResp, "gpt-4o")
	if anthResp.Type != "message" {
		t.Errorf("expected type 'message', got %s", anthResp.Type)
	}
	if anthResp.Role != "assistant" {
		t.Errorf("expected role 'assistant', got %s", anthResp.Role)
	}
	if len(anthResp.Content) != 1 || anthResp.Content[0].Text != "4" {
		t.Errorf("unexpected content: %+v", anthResp.Content)
	}
	if anthResp.StopReason != "end_turn" {
		t.Errorf("expected stop_reason 'end_turn', got %s", anthResp.StopReason)
	}
	if anthResp.Usage.InputTokens != 10 || anthResp.Usage.OutputTokens != 5 {
		t.Errorf("unexpected usage: %+v", anthResp.Usage)
	}
}

func TestHealthEndpoint(t *testing.T) {
	cfg := DefaultConfig()
	logger := &Logger{}
	handler := NewProxyHandler(&cfg, logger)

	req := httptest.NewRequest("GET", "/health", nil)
	w := httptest.NewRecorder()
	handler.HandleHealth(w, req)

	if w.Code != 200 {
		t.Errorf("expected 200, got %d", w.Code)
	}

	var resp map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if resp["status"] != "ok" {
		t.Errorf("expected status 'ok', got %v", resp["status"])
	}
}

func TestModelsEndpoint(t *testing.T) {
	cfg := DefaultConfig()
	logger := &Logger{}
	handler := NewProxyHandler(&cfg, logger)

	req := httptest.NewRequest("GET", "/v1/models", nil)
	w := httptest.NewRecorder()
	handler.HandleModels(w, req)

	if w.Code != 200 {
		t.Errorf("expected 200, got %d", w.Code)
	}

	var resp map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &resp)
	data, ok := resp["data"].([]interface{})
	if !ok || len(data) == 0 {
		t.Error("expected non-empty models list")
	}
}

func TestMessagesEndpoint_NoAPIKey(t *testing.T) {
	cfg := DefaultConfig()
	// Don't resolve API keys — they'll be empty
	logger := &Logger{}
	handler := NewProxyHandler(&cfg, logger)

	body := `{"model":"claude-sonnet-4-20250514","max_tokens":100,"messages":[{"role":"user","content":"Hi"}]}`
	req := httptest.NewRequest("POST", "/v1/messages", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.HandleMessages(w, req)

	if w.Code != 500 {
		t.Errorf("expected 500 (no API key), got %d", w.Code)
	}
}

func TestMessagesEndpoint_InvalidJSON(t *testing.T) {
	cfg := DefaultConfig()
	logger := &Logger{}
	handler := NewProxyHandler(&cfg, logger)

	req := httptest.NewRequest("POST", "/v1/messages", bytes.NewBufferString("not json"))
	w := httptest.NewRecorder()
	handler.HandleMessages(w, req)

	if w.Code != 400 {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

func TestMessagesEndpoint_MethodNotAllowed(t *testing.T) {
	cfg := DefaultConfig()
	logger := &Logger{}
	handler := NewProxyHandler(&cfg, logger)

	req := httptest.NewRequest("GET", "/v1/messages", nil)
	w := httptest.NewRecorder()
	handler.HandleMessages(w, req)

	if w.Code != 405 {
		t.Errorf("expected 405, got %d", w.Code)
	}
}

func TestSQLiteLogger(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")

	logger, err := NewLogger(dbPath)
	if err != nil {
		t.Fatalf("failed to create logger: %v", err)
	}
	defer logger.Close()

	logger.Log(RequestLog{
		Model: "claude-sonnet-4", Backend: "anthropic",
		InputTokens: 100, OutputTokens: 50,
		CostUSD: 0.001, LatencyMs: 500,
		PromptPreview: "Hello", ResponsePreview: "Hi there",
		Status: 200,
	})
	logger.Log(RequestLog{
		Model: "gpt-4o", Backend: "openai",
		InputTokens: 200, OutputTokens: 100,
		CostUSD: 0.002, LatencyMs: 300,
		Status: 200,
	})

	stats := logger.GetStats()
	if stats.TotalRequests != 2 {
		t.Errorf("expected 2 requests, got %d", stats.TotalRequests)
	}
	if stats.TotalInput != 300 {
		t.Errorf("expected 300 input tokens, got %d", stats.TotalInput)
	}
	if stats.TotalOutput != 150 {
		t.Errorf("expected 150 output tokens, got %d", stats.TotalOutput)
	}
	if len(stats.ByModel) != 2 {
		t.Errorf("expected 2 models in stats, got %d", len(stats.ByModel))
	}
}

func TestCostCalculation(t *testing.T) {
	cfg := DefaultConfig()
	logger := &Logger{}
	handler := NewProxyHandler(&cfg, logger)

	// claude-sonnet-4: $3/1M input, $15/1M output
	cost := handler.calculateCost("claude-sonnet-4-20250514", 1000000, 1000000)
	expected := 3.0 + 15.0
	if cost != expected {
		t.Errorf("expected cost $%.2f, got $%.2f", expected, cost)
	}

	// gpt-4o-mini: $0.15/1M input, $0.6/1M output
	cost = handler.calculateCost("gpt-4o-mini", 1000000, 1000000)
	expected = 0.15 + 0.6
	if cost != expected {
		t.Errorf("expected cost $%.2f, got $%.2f", expected, cost)
	}
}

func TestAnthropicPassthrough(t *testing.T) {
	// Mock Anthropic API server
	mockServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Verify headers
		if r.Header.Get("x-api-key") != "test-key" {
			t.Errorf("expected x-api-key 'test-key', got %s", r.Header.Get("x-api-key"))
		}
		if r.Header.Get("anthropic-version") != "2023-06-01" {
			t.Errorf("expected anthropic-version header")
		}

		body, _ := io.ReadAll(r.Body)
		var req AnthropicRequest
		json.Unmarshal(body, &req)

		resp := AnthropicResponse{
			ID: "msg_test", Type: "message", Role: "assistant",
			Content: []ContentBlock{{Type: "text", Text: "Hello from mock!"}},
			Model:   req.Model, StopReason: "end_turn",
			Usage:   AnthropicUsage{InputTokens: 10, OutputTokens: 5},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	defer mockServer.Close()

	cfg := DefaultConfig()
	cfg.Backends["anthropic"] = Backend{
		APIKey:  "test-key",
		BaseURL: mockServer.URL,
	}

	tmpDir := t.TempDir()
	logger, _ := NewLogger(filepath.Join(tmpDir, "test.db"))
	defer logger.Close()

	handler := NewProxyHandler(&cfg, logger)

	body := `{"model":"claude-sonnet-4-20250514","max_tokens":100,"messages":[{"role":"user","content":"Hi"}]}`
	req := httptest.NewRequest("POST", "/v1/messages", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.HandleMessages(w, req)

	if w.Code != 200 {
		t.Errorf("expected 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	var resp AnthropicResponse
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp.ID != "msg_test" {
		t.Errorf("expected id 'msg_test', got %s", resp.ID)
	}
	if len(resp.Content) == 0 || resp.Content[0].Text != "Hello from mock!" {
		t.Errorf("unexpected content: %+v", resp.Content)
	}

	// Verify logging
	stats := logger.GetStats()
	if stats.TotalRequests != 1 {
		t.Errorf("expected 1 logged request, got %d", stats.TotalRequests)
	}
}

func TestConfigYAML(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.yaml")
	os.WriteFile(cfgPath, []byte(`
port: 9999
default_backend: openai
backends:
  openai:
    api_key_env: OPENAI_API_KEY
    base_url: https://api.openai.com
routes:
  - match: "*"
    backend: openai
`), 0644)

	cfg, err := LoadConfig(cfgPath)
	if err != nil {
		t.Fatalf("failed to load config: %v", err)
	}
	if cfg.Port != 9999 {
		t.Errorf("expected port 9999, got %d", cfg.Port)
	}
	if cfg.DefaultBackend != "openai" {
		t.Errorf("expected default_backend openai, got %s", cfg.DefaultBackend)
	}
}

func TestTruncate(t *testing.T) {
	if truncate("short", 10) != "short" {
		t.Error("should not truncate short strings")
	}
	result := truncate("this is a longer string", 10)
	if result != "this is a ..." {
		t.Errorf("expected truncation, got %q", result)
	}
}
