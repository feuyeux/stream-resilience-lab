export interface AnthropicNamedSseEvent {
  event: string;
  data: Record<string, unknown>;
}

export interface AnthropicTextDeltaEvent {
  event: "content_block_delta";
  data: {
    type: "content_block_delta";
    index: 0;
    delta: {
      type: "text_delta";
      text: string;
    };
  };
}

export function makeAnthropicMessage(id: string, model: string, text: string) {
  return {
    id,
    type: "message",
    role: "assistant",
    content: [
      {
        type: "text",
        text
      }
    ],
    model,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 8,
      output_tokens: Math.max(1, text.split(/\s+/).length)
    }
  };
}

export function makeAnthropicMessageStart(id: string, model: string): AnthropicNamedSseEvent {
  return {
    event: "message_start",
    data: {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 8, output_tokens: 0 }
      }
    }
  };
}

export function makeAnthropicContentBlockStart(): AnthropicNamedSseEvent {
  return {
    event: "content_block_start",
    data: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" }
    }
  };
}

export function makeAnthropicToolUseBlockStart(): AnthropicNamedSseEvent {
  return {
    event: "content_block_start",
    data: {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "toolu_mock",
        name: "mock_tool",
        input: {}
      }
    }
  };
}

export function makeAnthropicTextDelta(text: string): AnthropicTextDeltaEvent {
  return {
    event: "content_block_delta",
    data: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text }
    }
  };
}

export function makeAnthropicStop(outputTokens: number): AnthropicNamedSseEvent[] {
  return [
    {
      event: "content_block_stop",
      data: { type: "content_block_stop", index: 0 }
    },
    {
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: outputTokens }
      }
    },
    {
      event: "message_stop",
      data: { type: "message_stop" }
    }
  ];
}

export function makeAnthropicToolJsonDelta(partialJson: string): AnthropicNamedSseEvent {
  return {
    event: "content_block_delta",
    data: {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "input_json_delta",
        partial_json: partialJson
      }
    }
  };
}
