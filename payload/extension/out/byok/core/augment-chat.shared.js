"use strict";

const { normalizeString } = require("../infra/util");
const {
  REQUEST_NODE_TEXT,
  REQUEST_NODE_TOOL_RESULT,
  REQUEST_NODE_IMAGE,
  REQUEST_NODE_IMAGE_ID,
  REQUEST_NODE_IDE_STATE,
  REQUEST_NODE_EDIT_EVENTS,
  REQUEST_NODE_CHECKPOINT_REF,
  REQUEST_NODE_CHANGE_PERSONALITY,
  REQUEST_NODE_FILE,
  REQUEST_NODE_FILE_ID,
  REQUEST_NODE_HISTORY_SUMMARY,
  RESPONSE_NODE_RAW_RESPONSE,
  RESPONSE_NODE_MAIN_TEXT_FINISHED,
  RESPONSE_NODE_TOOL_USE,
  RESPONSE_NODE_TOOL_USE_START,
  TOOL_RESULT_CONTENT_TEXT,
  TOOL_RESULT_CONTENT_IMAGE,
  IMAGE_FORMAT_JPEG,
  IMAGE_FORMAT_GIF,
  IMAGE_FORMAT_WEBP
} = require("./augment-protocol");
const { asRecord, asArray, asString, pick, normalizeNodeType } = require("./augment-struct");
const {
  personaTypeToLabel,
  formatIdeStateForPrompt,
  formatEditEventsForPrompt,
  formatCheckpointRefForPrompt,
  formatChangePersonalityForPrompt,
  formatImageIdForPrompt,
  formatFileIdForPrompt,
  formatFileNodeForPrompt,
  formatHistorySummaryForPrompt
} = require("./augment-node-format");

function isPlaceholderMessage(message) {
  const s = String(message || "").trim();
  if (!s) return false;
  if (s.length > 16) return false;
  for (const ch of s) if (ch !== "-") return false;
  return true;
}

function mapImageFormatToMimeType(format) {
  const f = Number(format);
  if (f === IMAGE_FORMAT_JPEG) return "image/jpeg";
  if (f === IMAGE_FORMAT_GIF) return "image/gif";
  if (f === IMAGE_FORMAT_WEBP) return "image/webp";
  return "image/png";
}

function buildUserSegmentsFromRequest(message, nodes) {
  const segments = [];
  let lastText = null;
  const pushText = (text) => {
    const trimmed = String(text || "").trim();
    if (!trimmed || isPlaceholderMessage(trimmed)) return;
    if (lastText === trimmed) return;
    segments.push({ kind: "text", text: String(text) });
    lastText = trimmed;
  };
  pushText(message);
  for (const node of asArray(nodes)) {
    const r = asRecord(node);
    const t = normalizeNodeType(r);
    if (t === REQUEST_NODE_TEXT) {
      const tn = asRecord(pick(r, ["text_node", "textNode"]));
      pushText(pick(tn, ["content"]));
    } else if (t === REQUEST_NODE_TOOL_RESULT) {
      continue;
    } else if (t === REQUEST_NODE_IMAGE) {
      const img = asRecord(pick(r, ["image_node", "imageNode"]));
      const data = normalizeString(pick(img, ["image_data", "imageData"]));
      if (!data) continue;
      segments.push({ kind: "image", media_type: mapImageFormatToMimeType(pick(img, ["format"])), data });
      lastText = null;
    } else if (t === REQUEST_NODE_IMAGE_ID) pushText(formatImageIdForPrompt(pick(r, ["image_id_node", "imageIdNode"])));
    else if (t === REQUEST_NODE_IDE_STATE) pushText(formatIdeStateForPrompt(pick(r, ["ide_state_node", "ideStateNode"])));
    else if (t === REQUEST_NODE_EDIT_EVENTS) pushText(formatEditEventsForPrompt(pick(r, ["edit_events_node", "editEventsNode"])));
    else if (t === REQUEST_NODE_CHECKPOINT_REF) pushText(formatCheckpointRefForPrompt(pick(r, ["checkpoint_ref_node", "checkpointRefNode"])));
    else if (t === REQUEST_NODE_CHANGE_PERSONALITY) pushText(formatChangePersonalityForPrompt(pick(r, ["change_personality_node", "changePersonalityNode"])));
    else if (t === REQUEST_NODE_FILE) pushText(formatFileNodeForPrompt(pick(r, ["file_node", "fileNode"])));
    else if (t === REQUEST_NODE_FILE_ID) pushText(formatFileIdForPrompt(pick(r, ["file_id_node", "fileIdNode"])));
    else if (t === REQUEST_NODE_HISTORY_SUMMARY) pushText(formatHistorySummaryForPrompt(pick(r, ["history_summary_node", "historySummaryNode"])));
  }
  return segments;
}

function collectExchangeRequestNodes(exchange) {
  const ex = asRecord(exchange);
  return [...asArray(pick(ex, ["request_nodes", "requestNodes"])), ...asArray(pick(ex, ["structured_request_nodes", "structuredRequestNodes"])), ...asArray(pick(ex, ["nodes"]))];
}

function collectExchangeOutputNodes(exchange) {
  const ex = asRecord(exchange);
  return [...asArray(pick(ex, ["response_nodes", "responseNodes"])), ...asArray(pick(ex, ["structured_output_nodes", "structuredOutputNodes"]))];
}

function buildTextOrPartsFromSegments(segments, opts) {
  const segs = asArray(segments);
  if (!segs.length) return null;
  const hasImage = segs.some((s) => s && typeof s === "object" && s.kind === "image");
  if (!hasImage) {
    const parts = segs
      .filter((s) => s && typeof s === "object" && s.kind === "text")
      .map((s) => String(s.text || "").trim())
      .filter(Boolean);
    const text = parts.join("\n\n").trim();
    return text ? text : null;
  }

  const makeTextPart = typeof opts?.makeTextPart === "function" ? opts.makeTextPart : (text) => ({ type: "text", text });
  const makeImagePart =
    typeof opts?.makeImagePart === "function"
      ? opts.makeImagePart
      : ({ data, media_type }) => ({ type: "image_url", image_url: { url: `data:${media_type};base64,${data}` } });

  const out = [];
  let textBuf = "";
  const flushText = () => {
    const t = textBuf.trim();
    if (t) out.push(makeTextPart(t));
    textBuf = "";
  };

  for (const s of segs) {
    if (!s || typeof s !== "object") continue;
    if (s.kind === "text") {
      const t = String(s.text || "").trim();
      if (!t) continue;
      if (textBuf) textBuf += "\n\n";
      textBuf += t;
    } else if (s.kind === "image") {
      flushText();
      const data = normalizeString(s.data);
      if (!data) continue;
      const media_type = normalizeString(s.media_type) || "image/png";
      out.push(makeImagePart({ data, media_type, segment: s }));
    }
  }
  flushText();
  return out.length ? out : null;
}

function extractToolResultTextsFromRequestNodes(nodes) {
  const out = [];
  for (const node of asArray(nodes)) {
    const r = asRecord(node);
    if (normalizeNodeType(r) !== REQUEST_NODE_TOOL_RESULT) continue;
    const tr = asRecord(pick(r, ["tool_result_node", "toolResultNode"]));
    const toolUseId = normalizeString(pick(tr, ["tool_use_id", "toolUseId"]));
    if (!toolUseId) continue;
    const text = summarizeToolResultText(pick(tr, ["content"]), pick(tr, ["content_nodes", "contentNodes"]));
    out.push({ toolUseId, text: normalizeString(text) ? text : "" });
  }
  return out;
}

function buildUserSegmentsWithExtraText(req, nodesAll) {
  const nodes = asArray(nodesAll);
  const nonToolNodes = nodes.filter((n) => normalizeNodeType(n) !== REQUEST_NODE_TOOL_RESULT);
  const extraTextParts = buildUserExtraTextParts(req, { hasNodes: nonToolNodes.length > 0 });
  const segments = buildUserSegmentsFromRequest(req && typeof req === "object" ? req.message : "", nonToolNodes);
  for (const t of asArray(extraTextParts)) segments.push({ kind: "text", text: String(t ?? "") });
  return segments;
}

function summarizeToolResultText(fallbackText, contentNodes) {
  const nodes = asArray(contentNodes);
  const parts = [];
  let lastText = "";
  for (const n of nodes) {
    const r = asRecord(n);
    const t = Number(pick(r, ["type", "node_type", "nodeType"]));
    if (t === TOOL_RESULT_CONTENT_TEXT) {
      const text = normalizeString(pick(r, ["text_content", "textContent"]));
      if (!text || isPlaceholderMessage(text)) continue;
      if (lastText && lastText === text) continue;
      parts.push(text);
      lastText = text;
    } else if (t === TOOL_RESULT_CONTENT_IMAGE) {
      const img = asRecord(pick(r, ["image_content", "imageContent"]));
      const data = normalizeString(pick(img, ["image_data", "imageData"]));
      if (!data) continue;
      parts.push(`[image omitted: format=${Number(pick(img, ["format"])) || 0} bytes≈${Math.floor((data.length * 3) / 4)}]`);
      lastText = "";
    }
  }
  if (parts.length) return parts.join("\n\n").trim();
  return String(fallbackText || "").trim();
}

function normalizeToolDefinitions(raw) {
  const list = asArray(raw);
  const out = [];
  for (const it of list) {
    const r = asRecord(it);
    const name = normalizeString(pick(r, ["name"]));
    if (!name) continue;
    const description = asString(pick(r, ["description"])) || "";
    const input_schema = pick(r, ["input_schema", "inputSchema"]);
    const input_schema_json = asString(pick(r, ["input_schema_json", "inputSchemaJson"])) || "";
    const mcp_server_name = asString(pick(r, ["mcp_server_name", "mcpServerName"])) || "";
    const mcp_tool_name = asString(pick(r, ["mcp_tool_name", "mcpToolName"])) || "";
    out.push({ name, description, input_schema: input_schema && typeof input_schema === "object" ? input_schema : null, input_schema_json, mcp_server_name, mcp_tool_name });
  }
  return out;
}

function resolveToolSchema(def) {
  if (def && def.input_schema && typeof def.input_schema === "object" && !Array.isArray(def.input_schema)) return def.input_schema;
  const raw = normalizeString(def && def.input_schema_json);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return { type: "object", properties: {} };
}

function coerceOpenAiStrictJsonSchema(schema, depth) {
  const d = Number.isFinite(Number(depth)) ? Number(depth) : 0;
  if (d > 50) return schema;
  if (Array.isArray(schema)) return schema.map((x) => coerceOpenAiStrictJsonSchema(x, d + 1));
  if (!schema || typeof schema !== "object") return schema;

  const out = { ...schema };

  const t = out.type;
  const hasObjectType = t === "object" || (Array.isArray(t) && t.some((x) => normalizeString(x).toLowerCase() === "object"));
  const hasProps = out.properties && typeof out.properties === "object" && !Array.isArray(out.properties);
  if (hasObjectType || hasProps) {
    if (!hasObjectType) out.type = "object";
    if (!hasProps) out.properties = {};
    out.additionalProperties = false;
    const props = out.properties && typeof out.properties === "object" && !Array.isArray(out.properties) ? out.properties : {};
    out.properties = props;
    // OpenAI Responses strict 要求 required 覆盖 properties 的每个 key（且最好不要包含 properties 之外的 key）
    out.required = Object.keys(props);
  }

  if (out.properties && typeof out.properties === "object" && !Array.isArray(out.properties)) {
    const props = out.properties;
    const next = {};
    for (const k of Object.keys(props)) next[k] = coerceOpenAiStrictJsonSchema(props[k], d + 1);
    out.properties = next;
  }

  if (out.items != null) out.items = coerceOpenAiStrictJsonSchema(out.items, d + 1);
  if (out.prefixItems != null) out.prefixItems = coerceOpenAiStrictJsonSchema(out.prefixItems, d + 1);
  if (out.additionalProperties != null && out.additionalProperties !== false) out.additionalProperties = false;

  if (Array.isArray(out.anyOf)) out.anyOf = out.anyOf.map((x) => coerceOpenAiStrictJsonSchema(x, d + 1));
  if (Array.isArray(out.oneOf)) out.oneOf = out.oneOf.map((x) => coerceOpenAiStrictJsonSchema(x, d + 1));
  if (Array.isArray(out.allOf)) out.allOf = out.allOf.map((x) => coerceOpenAiStrictJsonSchema(x, d + 1));
  if (out.not != null) out.not = coerceOpenAiStrictJsonSchema(out.not, d + 1);

  if (out.$defs && typeof out.$defs === "object" && !Array.isArray(out.$defs)) {
    const defs = out.$defs;
    const next = {};
    for (const k of Object.keys(defs)) next[k] = coerceOpenAiStrictJsonSchema(defs[k], d + 1);
    out.$defs = next;
  }
  if (out.definitions && typeof out.definitions === "object" && !Array.isArray(out.definitions)) {
    const defs = out.definitions;
    const next = {};
    for (const k of Object.keys(defs)) next[k] = coerceOpenAiStrictJsonSchema(defs[k], d + 1);
    out.definitions = next;
  }

  return out;
}

function convertOpenAiTools(toolDefs) {
  const defs = normalizeToolDefinitions(toolDefs);
  return defs.map((d) => ({ type: "function", function: { name: d.name, ...(normalizeString(d.description) ? { description: d.description } : {}), parameters: resolveToolSchema(d) } }));
}

function convertAnthropicTools(toolDefs) {
  const defs = normalizeToolDefinitions(toolDefs);
  return defs.map((d) => ({ name: d.name, ...(normalizeString(d.description) ? { description: d.description } : {}), input_schema: resolveToolSchema(d) }));
}

function convertGeminiTools(toolDefs) {
  const defs = normalizeToolDefinitions(toolDefs);
  const decls = defs.map((d) => ({ name: d.name, ...(normalizeString(d.description) ? { description: d.description } : {}), parameters: resolveToolSchema(d) }));
  if (!decls.length) return [];
  return [{ functionDeclarations: decls }];
}

function convertOpenAiResponsesTools(toolDefs) {
  const defs = normalizeToolDefinitions(toolDefs);
  return defs.map((d) => ({
    type: "function",
    name: d.name,
    parameters: coerceOpenAiStrictJsonSchema(resolveToolSchema(d)),
    strict: true,
    ...(normalizeString(d.description) ? { description: d.description } : {})
  }));
}

function buildToolMetaByName(toolDefs) {
  const defs = normalizeToolDefinitions(toolDefs);
  const map = new Map();
  for (const d of defs) {
    const toolName = normalizeString(d.name);
    if (!toolName) continue;
    const mcpServerName = normalizeString(d.mcp_server_name);
    const mcpToolName = normalizeString(d.mcp_tool_name);
    if (!mcpServerName && !mcpToolName) continue;
    map.set(toolName, { mcpServerName: mcpServerName || undefined, mcpToolName: mcpToolName || undefined });
  }
  return map;
}

function normalizeChatHistoryItem(raw) {
  const r = asRecord(raw);
  const request_id = asString(pick(r, ["request_id", "requestId", "requestID", "id"]));
  const request_message = asString(pick(r, ["request_message", "requestMessage", "message"]));
  const response_text = asString(pick(r, ["response_text", "responseText", "response", "text"]));
  const request_nodes = asArray(pick(r, ["request_nodes", "requestNodes"]));
  const structured_request_nodes = asArray(pick(r, ["structured_request_nodes", "structuredRequestNodes"]));
  const nodes = asArray(pick(r, ["nodes"]));
  const response_nodes = asArray(pick(r, ["response_nodes", "responseNodes"]));
  const structured_output_nodes = asArray(pick(r, ["structured_output_nodes", "structuredOutputNodes"]));
  return { request_id, request_message, response_text, request_nodes, structured_request_nodes, nodes, response_nodes, structured_output_nodes };
}

function normalizeAugmentChatRequest(body) {
  const b = asRecord(body);
  const rawMessage = asString(pick(b, ["message"]));
  const rawPrompt = asString(pick(b, ["prompt"]));
  const rawInstruction = asString(pick(b, ["instruction"]));
  const useMessage = normalizeString(rawMessage) && !isPlaceholderMessage(rawMessage);
  const usePrompt = !useMessage && normalizeString(rawPrompt);
  const message = useMessage ? rawMessage : usePrompt ? rawPrompt : rawInstruction;
  const message_source = useMessage ? "message" : usePrompt ? "prompt" : normalizeString(rawInstruction) ? "instruction" : "";
  const conversation_id = asString(pick(b, ["conversation_id", "conversationId", "conversationID"]));
  const chat_history = asArray(pick(b, ["chat_history", "chatHistory"])).map(normalizeChatHistoryItem);
  const blobs = asRecord(pick(b, ["blobs"]));
  const external_source_ids = asArray(pick(b, ["external_source_ids", "externalSourceIds"]));
  const user_guided_blobs = asArray(pick(b, ["user_guided_blobs", "userGuidedBlobs", "user_specified_files", "userSpecifiedFiles"]));
  const disable_auto_external_sources = Boolean(pick(b, ["disable_auto_external_sources", "disableAutoExternalSources"]));
  const disable_retrieval = Boolean(pick(b, ["disable_retrieval", "disableRetrieval"]));
  const context_code_exchange_request_id = asString(pick(b, ["context_code_exchange_request_id", "contextCodeExchangeRequestId"]));
  const tool_definitions = asArray(pick(b, ["tool_definitions", "toolDefinitions"]));
  const nodes = asArray(pick(b, ["nodes"]));
  const structured_request_nodes = asArray(pick(b, ["structured_request_nodes", "structuredRequestNodes"]));
  const request_nodes = asArray(pick(b, ["request_nodes", "requestNodes"]));
  let agent_memories = asString(pick(b, ["agent_memories", "agentMemories"]));
  if (!normalizeString(agent_memories)) {
    const mi = pick(b, ["memories_info", "memoriesInfo"]);
    if (typeof mi === "string") agent_memories = mi;
    else {
      const r = asRecord(mi);
      const direct = asString(pick(r, ["agent_memories", "agentMemories", "memories", "memory", "text", "content"]));
      if (normalizeString(direct)) agent_memories = direct;
      else {
        const arr = asArray(pick(r, ["items", "memories", "memory"]));
        const joined = arr.map((x) => normalizeString(String(x))).filter(Boolean).join("\n");
        if (normalizeString(joined)) agent_memories = joined;
      }
    }
  }
  const mode = asString(pick(b, ["mode"]));
  const prefix = asString(pick(b, ["prefix"]));
  const selected_code = asString(pick(b, ["selected_code", "selectedCode", "selected_text", "selectedText", "selected_code_snippet", "selectedCodeSnippet"]));
  const disable_selected_code_details = Boolean(pick(b, ["disable_selected_code_details", "disableSelectedCodeDetails"]));
  const suffix = asString(pick(b, ["suffix"]));
  const diff = asString(pick(b, ["diff"]));
  const lang = asString(pick(b, ["lang", "language"]));
  const path = asString(pick(b, ["path"]));
  const user_guidelines = asString(pick(b, ["user_guidelines", "userGuidelines"]));
  const workspace_guidelines = asString(pick(b, ["workspace_guidelines", "workspaceGuidelines"]));
  const persona_type = Number(pick(b, ["persona_type", "personaType"]));
  const silent = Boolean(pick(b, ["silent"]));
  const canvas_id = asString(pick(b, ["canvas_id", "canvasId"]));
  const request_id_override = asString(pick(b, ["request_id_override", "requestIdOverride"]));
  const rules = pick(b, ["rules"]);
  const feature_detection_flags = asRecord(pick(b, ["feature_detection_flags", "featureDetectionFlags"]));
  return { message, message_source, conversation_id, chat_history, blobs, external_source_ids, user_guided_blobs, disable_auto_external_sources, disable_retrieval, context_code_exchange_request_id, tool_definitions, nodes, structured_request_nodes, request_nodes, agent_memories, mode, prefix, selected_code, disable_selected_code_details, suffix, diff, lang, path, user_guidelines, workspace_guidelines, persona_type, silent, canvas_id, request_id_override, rules, feature_detection_flags };
}

function coerceRulesText(rules) {
  if (Array.isArray(rules)) return rules.map((x) => normalizeString(String(x))).filter(Boolean).join("\n");
  return normalizeString(rules);
}

function buildInlineCodeContextText(req) {
  if (req && typeof req === "object" && req.disable_selected_code_details === true) return "";
  const prefix = typeof req?.prefix === "string" ? req.prefix : "";
  const selected = typeof req?.selected_code === "string" ? req.selected_code : "";
  const suffix = typeof req?.suffix === "string" ? req.suffix : "";
  return `${prefix}${selected}${suffix}`.trim();
}

function buildUserExtraTextParts(req, { hasNodes } = {}) {
  if (hasNodes) return [];
  if (req && typeof req === "object" && req.message_source === "prompt") return [];
  if (req && typeof req === "object" && req.disable_selected_code_details === true) return [];
  const main = typeof req?.message === "string" ? req.message.trim() : "";
  const out = [];
  const code = buildInlineCodeContextText(req);
  if (normalizeString(code) && code.trim() !== main) out.push(code);
  const diff = typeof req?.diff === "string" ? req.diff.trim() : "";
  if (normalizeString(diff) && diff !== code && diff !== main) out.push(diff);
  return out;
}

function buildSystemPrompt(req) {
  const parts = [];
  const persona = personaTypeToLabel(req && typeof req === "object" ? req.persona_type : 0);
  if (persona && persona !== "DEFAULT") parts.push(`Persona: ${persona}`);
  if (normalizeString(req.user_guidelines)) parts.push(req.user_guidelines.trim());
  if (normalizeString(req.workspace_guidelines)) parts.push(req.workspace_guidelines.trim());
  const rulesText = coerceRulesText(req.rules);
  if (rulesText) parts.push(rulesText);
  if (normalizeString(req.agent_memories)) parts.push(req.agent_memories.trim());
  if (normalizeString(req.mode).toUpperCase() === "AGENT") parts.push("You are an AI coding assistant with access to tools. Use tools when needed to complete tasks.");
  if (normalizeString(req.lang)) parts.push(`The user is working with ${req.lang.trim()} code.`);
  if (normalizeString(req.path)) parts.push(`Current file path: ${req.path.trim()}`);
  return parts.join("\n\n").trim();
}

function extractAssistantTextFromOutputNodes(nodes) {
  const list = asArray(nodes);
  let finished = "";
  let raw = "";
  for (const n of list) {
    const r = asRecord(n);
    const t = normalizeNodeType(r);
    const content = asString(pick(r, ["content"]));
    if (t === RESPONSE_NODE_MAIN_TEXT_FINISHED && normalizeString(content)) finished = content;
    else if (t === RESPONSE_NODE_RAW_RESPONSE && content) raw += content;
  }
  return normalizeString(finished) ? finished.trim() : raw.trim();
}

function extractToolCallsFromOutputNodes(nodes) {
  const list = asArray(nodes);
  const toolUse = [];
  const toolUseStart = [];
  for (const n of list) {
    const r = asRecord(n);
    const t = normalizeNodeType(r);
    if (t === RESPONSE_NODE_TOOL_USE) toolUse.push(r);
    else if (t === RESPONSE_NODE_TOOL_USE_START) toolUseStart.push(r);
  }
  const chosen = toolUse.length ? toolUse : toolUseStart;
  const seen = new Set();
  const out = [];
  for (const n of chosen) {
    const tu = asRecord(pick(n, ["tool_use", "toolUse"]));
    const toolName = normalizeString(pick(tu, ["tool_name", "toolName"]));
    if (!toolName) continue;
    let id = normalizeString(pick(tu, ["tool_use_id", "toolUseId"]));
    if (!id) {
      const nodeId = Number(pick(n, ["id"]));
      const hint = toolName.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 48) || "tool";
      const suffix = Number.isFinite(nodeId) && nodeId > 0 ? String(Math.floor(nodeId)) : String(out.length + 1);
      id = `tool-${hint}-${suffix}`;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    const args = normalizeString(pick(tu, ["input_json", "inputJson"])) || "{}";
    out.push({ id, type: "function", function: { name: toolName, arguments: args } });
  }
  return out;
}

function parseJsonObjectOrEmpty(json) {
  const raw = normalizeString(json) || "{}";
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) return v;
  } catch {}
  return {};
}

module.exports = {
  asRecord,
  asArray,
  asString,
  pick,
  isPlaceholderMessage,
  mapImageFormatToMimeType,
  buildUserSegmentsFromRequest,
  collectExchangeRequestNodes,
  collectExchangeOutputNodes,
  buildTextOrPartsFromSegments,
  extractToolResultTextsFromRequestNodes,
  buildUserSegmentsWithExtraText,
  summarizeToolResultText,
  normalizeToolDefinitions,
  resolveToolSchema,
  coerceOpenAiStrictJsonSchema,
  convertOpenAiTools,
  convertAnthropicTools,
  convertGeminiTools,
  convertOpenAiResponsesTools,
  buildToolMetaByName,
  normalizeNodeType,
  normalizeAugmentChatRequest,
  coerceRulesText,
  buildInlineCodeContextText,
  buildUserExtraTextParts,
  formatIdeStateForPrompt,
  formatEditEventsForPrompt,
  formatCheckpointRefForPrompt,
  formatChangePersonalityForPrompt,
  formatImageIdForPrompt,
  formatFileIdForPrompt,
  formatFileNodeForPrompt,
  formatHistorySummaryForPrompt,
  buildSystemPrompt,
  extractAssistantTextFromOutputNodes,
  extractToolCallsFromOutputNodes,
  parseJsonObjectOrEmpty
};
