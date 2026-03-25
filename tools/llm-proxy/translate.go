package main

// Anthropic Messages API types
type AnthropicRequest struct {
	Model       string              `json:"model"`
	MaxTokens   int                 `json:"max_tokens"`
	System      interface{}         `json:"system,omitempty"` // string or []ContentBlock
	Messages    []AnthropicMessage  `json:"messages"`
	Stream      bool                `json:"stream,omitempty"`
	Temperature *float64            `json:"temperature,omitempty"`
	TopP        *float64            `json:"top_p,omitempty"`
	StopSeqs    []string            `json:"stop_sequences,omitempty"`
	Tools       []interface{}       `json:"tools,omitempty"`
	Metadata    interface{}         `json:"metadata,omitempty"`
}

type AnthropicMessage struct {
	Role    string      `json:"role"`
	Content interface{} `json:"content"` // string or []ContentBlock
}

type ContentBlock struct {
	Type string `json:"type"`
	Text string `json:"text,omitempty"`
	// tool_use, tool_result fields omitted for simplicity
}

type AnthropicResponse struct {
	ID           string             `json:"id"`
	Type         string             `json:"type"`
	Role         string             `json:"role"`
	Content      []ContentBlock     `json:"content"`
	Model        string             `json:"model"`
	StopReason   string             `json:"stop_reason"`
	StopSequence *string            `json:"stop_sequence"`
	Usage        AnthropicUsage     `json:"usage"`
}

type AnthropicUsage struct {
	InputTokens  int `json:"input_tokens"`
	OutputTokens int `json:"output_tokens"`
}

// OpenAI Chat Completions API types
type OpenAIRequest struct {
	Model       string          `json:"model"`
	Messages    []OpenAIMessage `json:"messages"`
	MaxTokens   int             `json:"max_completion_tokens,omitempty"`
	Stream      bool            `json:"stream,omitempty"`
	Temperature *float64        `json:"temperature,omitempty"`
	TopP        *float64        `json:"top_p,omitempty"`
	Stop        []string        `json:"stop,omitempty"`
}

type OpenAIMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type OpenAIResponse struct {
	ID      string          `json:"id"`
	Object  string          `json:"object"`
	Model   string          `json:"model"`
	Choices []OpenAIChoice  `json:"choices"`
	Usage   OpenAIUsage     `json:"usage"`
}

type OpenAIChoice struct {
	Index        int           `json:"index"`
	Message      OpenAIMessage `json:"message"`
	FinishReason string        `json:"finish_reason"`
}

type OpenAIUsage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
}

// AnthropicToOpenAI converts an Anthropic Messages request to OpenAI Chat format
func AnthropicToOpenAI(req AnthropicRequest) OpenAIRequest {
	var messages []OpenAIMessage

	// Convert system to a system message
	if req.System != nil {
		switch s := req.System.(type) {
		case string:
			if s != "" {
				messages = append(messages, OpenAIMessage{Role: "system", Content: s})
			}
		case []interface{}:
			var text string
			for _, block := range s {
				if m, ok := block.(map[string]interface{}); ok {
					if t, ok := m["text"].(string); ok {
						text += t + "\n"
					}
				}
			}
			if text != "" {
				messages = append(messages, OpenAIMessage{Role: "system", Content: text})
			}
		}
	}

	// Convert messages
	for _, msg := range req.Messages {
		content := extractTextContent(msg.Content)
		messages = append(messages, OpenAIMessage{Role: msg.Role, Content: content})
	}

	return OpenAIRequest{
		Model:       req.Model,
		Messages:    messages,
		MaxTokens:   req.MaxTokens,
		Stream:      req.Stream,
		Temperature: req.Temperature,
		TopP:        req.TopP,
		Stop:        req.StopSeqs,
	}
}

// OpenAIToAnthropicResponse converts an OpenAI response to Anthropic format
func OpenAIToAnthropicResponse(resp OpenAIResponse, model string) AnthropicResponse {
	var content []ContentBlock
	if len(resp.Choices) > 0 {
		content = append(content, ContentBlock{Type: "text", Text: resp.Choices[0].Message.Content})
	}

	stopReason := "end_turn"
	if len(resp.Choices) > 0 {
		switch resp.Choices[0].FinishReason {
		case "length":
			stopReason = "max_tokens"
		case "stop":
			stopReason = "end_turn"
		case "tool_calls":
			stopReason = "tool_use"
		}
	}

	return AnthropicResponse{
		ID:         resp.ID,
		Type:       "message",
		Role:       "assistant",
		Content:    content,
		Model:      model,
		StopReason: stopReason,
		Usage: AnthropicUsage{
			InputTokens:  resp.Usage.PromptTokens,
			OutputTokens: resp.Usage.CompletionTokens,
		},
	}
}

func extractTextContent(content interface{}) string {
	switch c := content.(type) {
	case string:
		return c
	case []interface{}:
		var text string
		for _, block := range c {
			if m, ok := block.(map[string]interface{}); ok {
				if m["type"] == "text" {
					if t, ok := m["text"].(string); ok {
						text += t
					}
				}
			}
		}
		return text
	}
	return ""
}
