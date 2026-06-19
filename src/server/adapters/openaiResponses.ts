export interface NamedSseEvent {
  event: string;
  data: Record<string, unknown>;
}

export function makeOpenAIResponse(id: string, model: string, text: string) {
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    completed_at: Math.floor(Date.now() / 1000),
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model,
    output: [
      {
        type: "message",
        id: `msg_${id}`,
        status: "completed",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text,
            annotations: []
          }
        ]
      }
    ],
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: true,
    temperature: 1,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_p: 1,
    truncation: "disabled",
    usage: {
      input_tokens: 8,
      output_tokens: Math.max(1, text.split(/\s+/).length),
      total_tokens: 8 + Math.max(1, text.split(/\s+/).length)
    },
    user: null,
    metadata: {}
  };
}

export function makeOpenAIResponseCreated(id: string, model: string): NamedSseEvent {
  return {
    event: "response.created",
    data: {
      type: "response.created",
      response: {
        id,
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        status: "in_progress",
        model,
        output: [],
        error: null,
        incomplete_details: null
      }
    }
  };
}

export function makeOpenAIResponseTextDelta(itemId: string, delta: string): NamedSseEvent {
  return {
    event: "response.output_text.delta",
    data: {
      type: "response.output_text.delta",
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      delta
    }
  };
}

export function makeOpenAIResponseCompleted(id: string, model: string, text: string): NamedSseEvent {
  return {
    event: "response.completed",
    data: {
      type: "response.completed",
      response: makeOpenAIResponse(id, model, text)
    }
  };
}

export function makeOpenAIResponseFunctionDelta(partialArguments: string): NamedSseEvent {
  return {
    event: "response.function_call_arguments.delta",
    data: {
      type: "response.function_call_arguments.delta",
      item_id: "fc_mock",
      output_index: 0,
      delta: partialArguments
    }
  };
}
