"use strict";

const { normalizeString } = require("../infra/util");
const { asRecord, asArray, asString, pick } = require("./augment-struct");
const { renderHistorySummaryNodeValue } = require("./augment-history-summary");
const { PERSONA_PROTOTYPER, PERSONA_BRAINSTORM, PERSONA_REVIEWER } = require("./augment-protocol");

function truncateInlineText(v, maxChars) {
  const s = normalizeString(asString(v));
  const max = Number.isFinite(Number(maxChars)) && Number(maxChars) > 0 ? Math.floor(Number(maxChars)) : 200;
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function personaTypeToLabel(v) {
  const n = Number(v);
  if (n === PERSONA_PROTOTYPER) return "PROTOTYPER";
  if (n === PERSONA_BRAINSTORM) return "BRAINSTORM";
  if (n === PERSONA_REVIEWER) return "REVIEWER";
  return "DEFAULT";
}

function formatIdeStateForPrompt(v) {
  const ide = asRecord(v);
  const lines = ["[IDE_STATE]"];
  const unchanged = pick(ide, ["workspace_folders_unchanged", "workspaceFoldersUnchanged"]);
  if (typeof unchanged === "boolean") lines.push(`workspace_folders_unchanged=${unchanged}`);

  const folders = asArray(pick(ide, ["workspace_folders", "workspaceFolders"]));
  if (folders.length) {
    lines.push("workspace_folders:");
    for (const f of folders.slice(0, 8)) {
      const r = asRecord(f);
      const repoRoot = truncateInlineText(pick(r, ["repository_root", "repositoryRoot"]), 200);
      const folderRoot = truncateInlineText(pick(r, ["folder_root", "folderRoot"]), 200);
      if (!repoRoot && !folderRoot) continue;
      lines.push(`- repository_root=${repoRoot || "(unknown)"} folder_root=${folderRoot || "(unknown)"}`);
    }
  }

  const term = asRecord(pick(ide, ["current_terminal", "currentTerminal"]));
  if (Object.keys(term).length) {
    const tid = Number(pick(term, ["terminal_id", "terminalId"]));
    const cwd = truncateInlineText(pick(term, ["current_working_directory", "currentWorkingDirectory"]), 200);
    if (Number.isFinite(tid) || cwd) lines.push(`current_terminal: id=${Number.isFinite(tid) ? tid : "?"} cwd=${cwd || "(unknown)"}`);
  }

  if (lines.length === 1) return "";
  lines.push("[/IDE_STATE]");
  return lines.join("\n").trim();
}

function formatEditEventsForPrompt(v) {
  const node = asRecord(v);
  const lines = ["[EDIT_EVENTS]"];
  const src = pick(node, ["source"]);
  if (src != null && src !== "") lines.push(`source=${truncateInlineText(src, 200)}`);

  const events = asArray(pick(node, ["edit_events", "editEvents"]));
  for (const ev of events.slice(0, 6)) {
    const r = asRecord(ev);
    const path = truncateInlineText(pick(r, ["path"]), 200);
    const beforeBlob = truncateInlineText(pick(r, ["before_blob_name", "beforeBlobName"]), 120);
    const afterBlob = truncateInlineText(pick(r, ["after_blob_name", "afterBlobName"]), 120);
    const edits = asArray(pick(r, ["edits"]));
    lines.push(`- file: ${path || "(unknown)"} edits=${edits.length}${beforeBlob ? ` before=${beforeBlob}` : ""}${afterBlob ? ` after=${afterBlob}` : ""}`);

    for (const ed of edits.slice(0, 6)) {
      const e = asRecord(ed);
      const afterStart = Number(pick(e, ["after_line_start", "afterLineStart"]));
      const beforeStart = Number(pick(e, ["before_line_start", "beforeLineStart"]));
      const beforeText = truncateInlineText(pick(e, ["before_text", "beforeText"]), 200);
      const afterText = truncateInlineText(pick(e, ["after_text", "afterText"]), 200);
      lines.push(`  - edit: after_line_start=${Number.isFinite(afterStart) ? afterStart : "?"} before_line_start=${Number.isFinite(beforeStart) ? beforeStart : "?"} before="${beforeText}" after="${afterText}"`);
    }
  }

  if (lines.length === 1) return "";
  lines.push("[/EDIT_EVENTS]");
  return lines.join("\n").trim();
}

function formatCheckpointRefForPrompt(v) {
  const r = asRecord(v);
  const lines = ["[CHECKPOINT_REF]"];
  const requestId = truncateInlineText(pick(r, ["request_id", "requestId"]), 120);
  if (requestId) lines.push(`request_id=${requestId}`);
  const from = Number(pick(r, ["from_timestamp", "fromTimestamp"]));
  const to = Number(pick(r, ["to_timestamp", "toTimestamp"]));
  if (Number.isFinite(from) || Number.isFinite(to)) lines.push(`from_timestamp=${Number.isFinite(from) ? from : "?"} to_timestamp=${Number.isFinite(to) ? to : "?"}`);
  const src = pick(r, ["source"]);
  if (src != null && src !== "") lines.push(`source=${truncateInlineText(src, 200)}`);
  if (lines.length === 1) return "";
  lines.push("[/CHECKPOINT_REF]");
  return lines.join("\n").trim();
}

function formatChangePersonalityForPrompt(v) {
  const p = asRecord(v);
  const t = personaTypeToLabel(pick(p, ["personality_type", "personalityType"]));
  const custom = truncateInlineText(pick(p, ["custom_instructions", "customInstructions"]), 1000);
  const lines = ["[CHANGE_PERSONALITY]", `personality_type=${t}`];
  if (custom) lines.push(`custom_instructions=${custom}`);
  lines.push("[/CHANGE_PERSONALITY]");
  return lines.join("\n").trim();
}

function formatImageIdForPrompt(v) {
  const img = asRecord(v);
  const id = truncateInlineText(pick(img, ["image_id", "imageId"]), 200);
  if (!id) return "";
  const fmt = Number(pick(img, ["format"]));
  return `[IMAGE_ID] image_id=${id} format=${Number.isFinite(fmt) ? fmt : "?"}`.trim();
}

function formatFileIdForPrompt(v) {
  const f = asRecord(v);
  const id = truncateInlineText(pick(f, ["file_id", "fileId"]), 200);
  const name = truncateInlineText(pick(f, ["file_name", "fileName"]), 200);
  if (!id && !name) return "";
  return `[FILE_ID] file_name=${name || "(unknown)"} file_id=${id || "(unknown)"}`.trim();
}

function formatFileNodeForPrompt(v) {
  const f = asRecord(v);
  const raw = asString(pick(f, ["file_data", "fileData"]));
  const format = normalizeString(asString(pick(f, ["format"]))) || "application/octet-stream";
  if (!raw.trim()) return `[FILE] format=${format} (empty)`;

  const parts = raw.startsWith("data:") ? raw.split(";base64,") : null;
  const b64 = parts && parts.length >= 2 ? parts.slice(1).join(";base64,") : raw;
  const approxBytes = Math.floor((b64.length * 3) / 4);
  const isTextLike = format.startsWith("text/") || ["application/json", "application/xml", "application/yaml", "application/x-yaml", "application/markdown"].includes(format);
  if (!isTextLike) return `[FILE] format=${format} bytes≈${approxBytes} (content omitted)`;

  try {
    const decoded = Buffer.from(b64, "base64").toString("utf8");
    const max = 20000;
    const content = decoded.length > max ? decoded.slice(0, max) + "\n\n[Content truncated due to length...]" : decoded;
    return `[FILE] format=${format} bytes≈${approxBytes}\n\n${content}`.trim();
  } catch {
    return `[FILE] format=${format} bytes≈${approxBytes} (decode failed)`;
  }
}

function formatHistorySummaryForPrompt(v) {
  const rendered = typeof renderHistorySummaryNodeValue === "function" ? renderHistorySummaryNodeValue(v, []) : null;
  if (normalizeString(rendered)) return String(rendered).trim();
  const h = asRecord(v);
  const summaryText = truncateInlineText(pick(h, ["summary_text", "summaryText"]), 3000);
  const reqId = truncateInlineText(pick(h, ["summarization_request_id", "summarizationRequestId"]), 120);
  const dropped = Number(pick(h, ["history_beginning_dropped_num_exchanges", "historyBeginningDroppedNumExchanges"]));
  const abridged = truncateInlineText(pick(h, ["history_middle_abridged_text", "historyMiddleAbridgedText"]), 2000);
  const endLen = asArray(pick(h, ["history_end", "historyEnd"])).length;
  const tmpl = truncateInlineText(pick(h, ["message_template", "messageTemplate"]), 400);
  const lines = ["[HISTORY_SUMMARY]"];
  if (reqId) lines.push(`summarization_request_id=${reqId}`);
  if (Number.isFinite(dropped) && dropped) lines.push(`history_beginning_dropped_num_exchanges=${dropped}`);
  if (tmpl) lines.push(`message_template=${tmpl}`);
  if (summaryText) lines.push(`summary_text=${summaryText}`);
  if (abridged) lines.push(`history_middle_abridged_text=${abridged}`);
  if (endLen) lines.push(`history_end_exchanges=${endLen}`);
  if (lines.length === 1) return "";
  lines.push("[/HISTORY_SUMMARY]");
  return lines.join("\n").trim();
}

module.exports = {
  truncateInlineText,
  personaTypeToLabel,
  formatIdeStateForPrompt,
  formatEditEventsForPrompt,
  formatCheckpointRefForPrompt,
  formatChangePersonalityForPrompt,
  formatImageIdForPrompt,
  formatFileIdForPrompt,
  formatFileNodeForPrompt,
  formatHistorySummaryForPrompt
};
