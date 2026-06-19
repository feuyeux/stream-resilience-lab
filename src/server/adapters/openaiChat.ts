export function makeOpenAIChatCompletion(id: string, model: string, text: string) {
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text,
          refusal: null,
          annotations: []
        },
        logprobs: null,
        finish_reason: "stop"
      }
    ],
    usage: {
      prompt_tokens: 8,
      completion_tokens: Math.max(1, text.split(/\s+/).length),
      total_tokens: 8 + Math.max(1, text.split(/\s+/).length)
    }
  };
}

export function makeOpenAIChatDelta(id: string, model: string, content: string) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    system_fingerprint: "fp_mock",
    choices: [
      {
        index: 0,
        delta: { content },
        logprobs: null,
        finish_reason: null
      }
    ]
  };
}

export function makeOpenAIChatRoleDelta(id: string, model: string) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    system_fingerprint: "fp_mock",
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: "" },
        logprobs: null,
        finish_reason: null
      }
    ]
  };
}

export function makeOpenAIChatDoneDelta(id: string, model: string) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    system_fingerprint: "fp_mock",
    choices: [
      {
        index: 0,
        delta: {},
        logprobs: null,
        finish_reason: "stop"
      }
    ]
  };
}

export function makeOpenAIChatToolDelta(id: string, model: string, partialArguments: string) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_mock",
              type: "function",
              function: {
                name: "mock_tool",
                arguments: partialArguments
              }
            }
          ]
        },
        logprobs: null,
        finish_reason: null
      }
    ]
  };
}
