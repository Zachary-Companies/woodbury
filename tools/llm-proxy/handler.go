package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"time"
)

type ProxyHandler struct {
	config *Config
	logger *Logger
}

func NewProxyHandler(cfg *Config, logger *Logger) *ProxyHandler {
	return &ProxyHandler{config: cfg, logger: logger}
}

// HandleMessages handles POST /v1/messages (Anthropic Messages API)
func (h *ProxyHandler) HandleMessages(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", 405)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "Failed to read body", 400)
		return
	}
	defer r.Body.Close()

	var req AnthropicRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, fmt.Sprintf("Invalid JSON: %s", err), 400)
		return
	}

	backendName := h.config.ResolveBackend(req.Model)
	backend, ok := h.config.Backends[backendName]
	if !ok {
		http.Error(w, fmt.Sprintf("Unknown backend: %s", backendName), 500)
		return
	}

	if backend.APIKey == "" {
		http.Error(w, fmt.Sprintf("No API key for backend %s (env: %s)", backendName, backend.APIKeyEnv), 500)
		return
	}

	promptPreview := extractPromptPreview(req)
	log.Printf("[proxy] %s → %s (model=%s, stream=%v)", r.RemoteAddr, backendName, req.Model, req.Stream)

	// Handle streaming
	if req.Stream {
		if backendName == "anthropic" {
			inputTokens, outputTokens, latencyMs, err := CallAnthropicStream(backend, body, r.Header, w)
			logEntry := RequestLog{
				Model: req.Model, Backend: backendName,
				InputTokens: inputTokens, OutputTokens: outputTokens,
				LatencyMs: latencyMs, PromptPreview: promptPreview,
				Status: 200,
			}
			logEntry.CostUSD = h.calculateCost(req.Model, inputTokens, outputTokens)
			if err != nil {
				logEntry.Error = err.Error()
				logEntry.Status = 500
			}
			h.logger.Log(logEntry)
		} else {
			// For non-Anthropic streaming, fall back to non-streaming for now
			h.handleNonStreaming(w, req, body, backendName, backend, promptPreview, r.Header)
		}
		return
	}

	h.handleNonStreaming(w, req, body, backendName, backend, promptPreview, r.Header)
}

func (h *ProxyHandler) handleNonStreaming(w http.ResponseWriter, req AnthropicRequest, body []byte, backendName string, backend Backend, promptPreview string, headers http.Header) {
	var result *ProviderResult
	var statusCode int
	var err error

	switch backendName {
	case "anthropic":
		result, statusCode, err = CallAnthropic(backend, body, headers)
	case "openai":
		result, statusCode, err = CallOpenAI(backend, req)
	default:
		// Default: try Anthropic passthrough
		result, statusCode, err = CallAnthropic(backend, body, headers)
	}

	logEntry := RequestLog{
		Model:         req.Model,
		Backend:       backendName,
		PromptPreview: promptPreview,
		Status:        statusCode,
	}

	if err != nil {
		logEntry.Error = err.Error()
		logEntry.Status = 500
		h.logger.Log(logEntry)
		http.Error(w, fmt.Sprintf("Backend error: %s", err), 500)
		return
	}

	if result != nil {
		logEntry.InputTokens = result.InputTokens
		logEntry.OutputTokens = result.OutputTokens
		logEntry.LatencyMs = result.LatencyMs
		logEntry.CostUSD = h.calculateCost(req.Model, result.InputTokens, result.OutputTokens)
		if len(result.Response.Content) > 0 {
			logEntry.ResponsePreview = result.Response.Content[0].Text
		}
	}

	h.logger.Log(logEntry)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	if result != nil && result.RawBody != nil {
		w.Write(result.RawBody)
	}
}

// HandleChatCompletions handles POST /v1/chat/completions (OpenAI format)
func (h *ProxyHandler) HandleChatCompletions(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", 405)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "Failed to read body", 400)
		return
	}
	defer r.Body.Close()

	var req OpenAIRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, fmt.Sprintf("Invalid JSON: %s", err), 400)
		return
	}

	backendName := h.config.ResolveBackend(req.Model)
	backend, ok := h.config.Backends[backendName]
	if !ok {
		http.Error(w, fmt.Sprintf("Unknown backend: %s", backendName), 500)
		return
	}

	log.Printf("[proxy] OpenAI format %s → %s (model=%s)", r.RemoteAddr, backendName, req.Model)

	if backendName == "openai" {
		// Forward directly
		result, statusCode, err := callOpenAIDirect(backend, body)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(statusCode)
		w.Write(result)
		return
	}

	// Translate to Anthropic and back
	// (simplified: just pass through as OpenAI format if possible)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(501)
	json.NewEncoder(w).Encode(map[string]string{"error": "OpenAI→Anthropic translation not yet implemented"})
}

// HandleModels returns available models
func (h *ProxyHandler) HandleModels(w http.ResponseWriter, r *http.Request) {
	models := []map[string]interface{}{
		{"id": "claude-sonnet-4-20250514", "object": "model", "owned_by": "anthropic"},
		{"id": "claude-opus-4-20250514", "object": "model", "owned_by": "anthropic"},
		{"id": "gpt-4o", "object": "model", "owned_by": "openai"},
		{"id": "gpt-4o-mini", "object": "model", "owned_by": "openai"},
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"data": models})
}

// HandleStats returns usage statistics
func (h *ProxyHandler) HandleStats(w http.ResponseWriter, r *http.Request) {
	stats := h.logger.GetStats()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(stats)
}

// HandleHealth returns health status
func (h *ProxyHandler) HandleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":  "ok",
		"version": "1.0.0",
		"port":    h.config.Port,
		"default": h.config.DefaultBackend,
	})
}

func (h *ProxyHandler) calculateCost(model string, inputTokens, outputTokens int) float64 {
	rate, ok := h.config.CostRates[model]
	if !ok {
		// Try prefix match
		for m, r := range h.config.CostRates {
			if len(model) >= len(m) && model[:len(m)] == m {
				rate = r
				ok = true
				break
			}
		}
	}
	if !ok {
		return 0
	}
	return (float64(inputTokens) / 1_000_000 * rate.InputPer1M) + (float64(outputTokens) / 1_000_000 * rate.OutputPer1M)
}

func extractPromptPreview(req AnthropicRequest) string {
	if len(req.Messages) > 0 {
		last := req.Messages[len(req.Messages)-1]
		return truncate(extractTextContent(last.Content), 200)
	}
	return ""
}

func callOpenAIDirect(backend Backend, body []byte) ([]byte, int, error) {
	req, err := http.NewRequest("POST", backend.BaseURL+"/v1/chat/completions", io.NopCloser(io.Reader(bytes.NewReader(body))))
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+backend.APIKey)

	resp, err := (&http.Client{Timeout: 120 * time.Second}).Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	result, _ := io.ReadAll(resp.Body)
	return result, resp.StatusCode, nil
}
