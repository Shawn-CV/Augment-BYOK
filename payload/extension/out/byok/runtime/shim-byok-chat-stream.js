"use strict";

const { traceAsyncGenerator } = require("../infra/trace");
const { normalizeString } = require("../infra/util");
const { providerLabel, providerRequestContext } = require("./shim-common");
const {
  captureAugmentChatToolDefinitions,
  summarizeAugmentChatRequest,
  isAugmentChatRequestEmpty,
  logAugmentChatStart,
  prepareAugmentChatRequestForByok,
  resolveSupportToolUseStart
} = require("./shim-augment-chat");
const {
  normalizeAugmentChatRequest,
  buildSystemPrompt,
  convertOpenAiTools,
  convertOpenAiResponsesTools,
  convertAnthropicTools,
  convertGeminiTools,
  buildToolMetaByName,
  buildOpenAiMessages,
  buildOpenAiResponsesInput,
  buildAnthropicMessages,
  buildGeminiContents
} = require("../core/augment-chat");
const { STOP_REASON_END_TURN, makeBackChatChunk } = require("../core/augment-protocol");
const { openAiChatStreamChunks } = require("../providers/openai");
const { openAiResponsesChatStreamChunks } = require("../providers/openai-responses");
const { anthropicChatStreamChunks } = require("../providers/anthropic");
const { geminiChatStreamChunks } = require("../providers/gemini");

function openAiCompatibleChatStream({
  baseUrl,
  apiKey,
  model,
  req,
  timeoutMs,
  abortSignal,
  extraHeaders,
  requestDefaults,
  toolMetaByName,
  supportToolUseStart
}) {
  return openAiChatStreamChunks({
    baseUrl,
    apiKey,
    model,
    messages: buildOpenAiMessages(req),
    tools: convertOpenAiTools(req.tool_definitions),
    timeoutMs,
    abortSignal,
    extraHeaders,
    requestDefaults,
    toolMetaByName,
    supportToolUseStart
  });
}

function anthropicChatStream({
  baseUrl,
  apiKey,
  model,
  req,
  timeoutMs,
  abortSignal,
  extraHeaders,
  requestDefaults,
  toolMetaByName,
  supportToolUseStart
}) {
  return anthropicChatStreamChunks({
    baseUrl,
    apiKey,
    model,
    system: buildSystemPrompt(req),
    messages: buildAnthropicMessages(req),
    tools: convertAnthropicTools(req.tool_definitions),
    timeoutMs,
    abortSignal,
    extraHeaders,
    requestDefaults,
    toolMetaByName,
    supportToolUseStart
  });
}

function openAiResponsesChatStream({
  baseUrl,
  apiKey,
  model,
  req,
  timeoutMs,
  abortSignal,
  extraHeaders,
  requestDefaults,
  toolMetaByName,
  supportToolUseStart
}) {
  const { instructions, input } = buildOpenAiResponsesInput(req);
  return openAiResponsesChatStreamChunks({
    baseUrl,
    apiKey,
    model,
    instructions,
    input,
    tools: convertOpenAiResponsesTools(req.tool_definitions),
    timeoutMs,
    abortSignal,
    extraHeaders,
    requestDefaults,
    toolMetaByName,
    supportToolUseStart
  });
}

function geminiChatStream({
  baseUrl,
  apiKey,
  model,
  req,
  timeoutMs,
  abortSignal,
  extraHeaders,
  requestDefaults,
  toolMetaByName,
  supportToolUseStart
}) {
  const { systemInstruction, contents } = buildGeminiContents(req);
  return geminiChatStreamChunks({
    baseUrl,
    apiKey,
    model,
    systemInstruction,
    contents,
    tools: convertGeminiTools(req.tool_definitions),
    timeoutMs,
    abortSignal,
    extraHeaders,
    requestDefaults,
    toolMetaByName,
    supportToolUseStart
  });
}

async function* streamChatByProvider({
  type,
  baseUrl,
  apiKey,
  model,
  req,
  timeoutMs,
  abortSignal,
  extraHeaders,
  requestDefaults,
  toolMetaByName,
  supportToolUseStart,
  traceLabel
}) {
  if (type === "openai_compatible") {
    const gen = openAiCompatibleChatStream({ baseUrl, apiKey, model, req, timeoutMs, abortSignal, extraHeaders, requestDefaults, toolMetaByName, supportToolUseStart });
    yield* traceAsyncGenerator(`${traceLabel} openai_compatible`, gen);
    return;
  }
  if (type === "anthropic") {
    const gen = anthropicChatStream({ baseUrl, apiKey, model, req, timeoutMs, abortSignal, extraHeaders, requestDefaults, toolMetaByName, supportToolUseStart });
    yield* traceAsyncGenerator(`${traceLabel} anthropic`, gen);
    return;
  }
  if (type === "openai_responses") {
    const gen = openAiResponsesChatStream({ baseUrl, apiKey, model, req, timeoutMs, abortSignal, extraHeaders, requestDefaults, toolMetaByName, supportToolUseStart });
    yield* traceAsyncGenerator(`${traceLabel} openai_responses`, gen);
    return;
  }
  if (type === "gemini_ai_studio") {
    const gen = geminiChatStream({ baseUrl, apiKey, model, req, timeoutMs, abortSignal, extraHeaders, requestDefaults, toolMetaByName, supportToolUseStart });
    yield* traceAsyncGenerator(`${traceLabel} gemini_ai_studio`, gen);
    return;
  }
  throw new Error(`未知 provider.type: ${type}`);
}

async function* byokChatStream({ cfg, provider, model, requestedModel, body, timeoutMs, abortSignal, upstreamCompletionURL, upstreamApiToken, requestId }) {
  const { type, baseUrl, apiKey, extraHeaders, requestDefaults } = providerRequestContext(provider);
  const req = normalizeAugmentChatRequest(body);
  const conversationId = normalizeString(req?.conversation_id ?? req?.conversationId ?? req?.conversationID);
  const rid = normalizeString(requestId);

  captureAugmentChatToolDefinitions({
    endpoint: "/chat-stream",
    req,
    provider,
    providerType: type,
    requestedModel,
    conversationId,
    requestId: rid
  });

  const summary = summarizeAugmentChatRequest(req);
  logAugmentChatStart({ kind: "chat-stream", requestId: rid, provider, providerType: type, model, requestedModel, conversationId, summary });
  if (isAugmentChatRequestEmpty(summary)) {
    yield makeBackChatChunk({ text: "", stop_reason: STOP_REASON_END_TURN });
    return;
  }

  await prepareAugmentChatRequestForByok({
    cfg,
    req,
    requestedModel,
    fallbackProvider: provider,
    fallbackModel: model,
    timeoutMs,
    abortSignal,
    upstreamCompletionURL,
    upstreamApiToken,
    requestId: rid
  });

  const toolMetaByName = buildToolMetaByName(req.tool_definitions);
  const supportToolUseStart = resolveSupportToolUseStart(req);
  const traceLabel = `[chat-stream] upstream${rid ? ` rid=${rid}` : ""} provider=${providerLabel(provider)} type=${type || "unknown"} model=${normalizeString(model) || "unknown"}`;

  yield* streamChatByProvider({
    type,
    baseUrl,
    apiKey,
    model,
    req,
    timeoutMs,
    abortSignal,
    extraHeaders,
    requestDefaults,
    toolMetaByName,
    supportToolUseStart,
    traceLabel
  });
}

module.exports = { byokChatStream };
