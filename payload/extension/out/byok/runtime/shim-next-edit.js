"use strict";

const nodePath = require("path");

const { state } = require("../config/state");
const { normalizeString } = require("../infra/util");
const { normalizeBlobsMap, coerceBlobText } = require("../core/blob-utils");
const { extractDiagnosticsList, pickDiagnosticPath, pickDiagnosticStartLine, pickDiagnosticEndLine } = require("../core/diagnostics-utils");
const { pickPath, pickNumResults } = require("../core/next-edit-fields");
const { bestMatchIndex, bestInsertionIndex } = require("../core/text-match");

const WORKSPACE_BLOB_MAX_CHARS = 2_000_000;

function normalizeLineNumber(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return 0;
  return Math.floor(n);
}

function normalizeNewlines(s) {
  return typeof s === "string" ? s.replace(/\r\n/g, "\n") : "";
}

function countNewlines(s) {
  const text = typeof s === "string" ? s : "";
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n += 1;
  return n;
}

function clampLineNumber(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 1;
  if (v <= 1) return 1;
  return Math.floor(v);
}

function trimTrailingNewlines(s) {
  const t = normalizeNewlines(s);
  return t.replace(/\n+$/g, "");
}

function resolveTextField(obj, keys) {
  const b = obj && typeof obj === "object" ? obj : {};
  for (const k of Array.isArray(keys) ? keys : []) {
    if (typeof b[k] === "string") return b[k];
  }
  return "";
}

async function readWorkspaceFileTextByPath(p) {
  const raw = normalizeString(p);
  if (!raw) return "";
  const vscode = state.vscode;
  const ws = vscode && vscode.workspace ? vscode.workspace : null;
  const Uri = vscode && vscode.Uri ? vscode.Uri : null;
  if (!ws || !ws.fs || typeof ws.fs.readFile !== "function" || !Uri) return "";

  const tryRead = async (uri) => {
    try {
      const bytes = await ws.fs.readFile(uri);
      return Buffer.from(bytes).toString("utf8");
    } catch {
      return "";
    }
  };

  if (raw.includes("://")) {
    try { return await tryRead(Uri.parse(raw)); } catch {}
  }

  try {
    if (nodePath.isAbsolute(raw)) return await tryRead(Uri.file(raw));
  } catch {}

  const rel = raw.replace(/\\/g, "/").replace(/^\/+/, "");
  const folders = Array.isArray(ws.workspaceFolders) ? ws.workspaceFolders : [];
  for (const f of folders) {
    const base = f && f.uri ? f.uri : null;
    if (!base) continue;
    const u = Uri.joinPath(base, rel);
    const txt = await tryRead(u);
    if (txt) return txt;
  }
  return "";
}

async function maybeAugmentBodyWithWorkspaceBlob(body, { pathHint, blobKey } = {}) {
  const b = body && typeof body === "object" ? body : {};
  const blobs = normalizeBlobsMap(b.blobs);

  const hint = normalizeString(pathHint);
  const path = hint || pickPath(b);
  if (!path) return b;

  const key = normalizeString(blobKey) || path;
  if (blobs && coerceBlobText(blobs[key])) return b;

  const txt = await readWorkspaceFileTextByPath(path);
  if (!txt) return b;
  if (txt.length > WORKSPACE_BLOB_MAX_CHARS) return b;
  return { ...b, blobs: { ...(blobs || {}), [key]: txt } };
}

async function buildInstructionReplacementMeta(body) {
  const b = body && typeof body === "object" ? body : {};
  const selectedTextRaw = resolveTextField(b, ["selected_text", "selectedText"]);
  const prefixRaw = resolveTextField(b, ["prefix"]);
  const suffixRaw = resolveTextField(b, ["suffix"]);
  const targetPath = normalizeString(resolveTextField(b, ["target_file_path", "targetFilePath"]));
  const path = normalizeString(resolveTextField(b, ["path", "pathName"]));
  const filePath = targetPath || path;

  const targetFileContentRaw = resolveTextField(b, ["target_file_content", "targetFileContent"]);
  const fileTextRaw = targetFileContentRaw ? targetFileContentRaw : await readWorkspaceFileTextByPath(filePath);
  const fileText = normalizeNewlines(fileTextRaw);
  const selectedText = normalizeNewlines(selectedTextRaw);
  const prefix = normalizeNewlines(prefixRaw);
  const suffix = normalizeNewlines(suffixRaw);

  const prefixHint = prefix ? prefix.slice(Math.max(0, prefix.length - 400)) : "";
  const suffixHint = suffix ? suffix.slice(0, 400) : "";

  if (fileText && selectedText) {
    const idx = bestMatchIndex(fileText, selectedText, { prefixHint, suffixHint });
    if (idx >= 0) {
      const startLine = 1 + countNewlines(fileText.slice(0, idx));
      const trimmed = trimTrailingNewlines(selectedText);
      const endLine = startLine + countNewlines(trimmed);
      return {
        replacement_start_line: clampLineNumber(startLine),
        replacement_end_line: clampLineNumber(endLine),
        replacement_old_text: selectedText
      };
    }
  }

  const insertIdx = fileText ? bestInsertionIndex(fileText, { prefixHint, suffixHint }) : 0;
  const insertLine = fileText ? 1 + countNewlines(fileText.slice(0, insertIdx)) : 1;
  const lines = fileText ? fileText.split("\n") : [];
  const lineBefore = insertLine > 1 && lines[insertLine - 2] != null ? String(lines[insertLine - 2]).trimEnd() : "";
  const oldText = selectedText ? selectedText : `PURE INSERTION AFTER LINE:${lineBefore}`;
  return {
    replacement_start_line: clampLineNumber(insertLine),
    replacement_end_line: clampLineNumber(insertLine),
    replacement_old_text: oldText
  };
}

function pickNextEditLocationCandidates(body) {
  const b = body && typeof body === "object" ? body : {};
  const max = pickNumResults(b, { defaultValue: 1, max: 6 });

  const out = [];
  const seen = new Set();
  const push = ({ path, start, stop, score = 1, source }) => {
    const p = normalizeString(path);
    const a = normalizeLineNumber(start);
    const z = normalizeLineNumber(stop);
    if (!p || a === null || z === null) return false;
    const key = `${p}:${a}:${Math.max(a, z)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    out.push({
      item: { path: p, range: { start: a, stop: Math.max(a, z) } },
      score,
      debug_info: { source: normalizeString(source) || "unknown" }
    });
    return true;
  };

  const diags = extractDiagnosticsList(b.diagnostics);
  for (const d of diags) {
    const path = pickDiagnosticPath(d);
    if (!path) continue;
    const start = pickDiagnosticStartLine(d);
    if (start === null) continue;
    const stop = pickDiagnosticEndLine(d, start);
    push({ path, start, stop, score: 1, source: "diagnostic" });
    if (out.length >= max) break;
  }

  if (out.length < max) {
    const path = pickPath(b);
    if (path) push({ path, start: 0, stop: 0, score: 1, source: "fallback:path" });
  }

  if (out.length < max) {
    // 某些请求不带 path，但会带 blobs（key 往往是 path/blobName）。
    const blobs = normalizeBlobsMap(b.blobs);
    if (blobs) {
      for (const k of Object.keys(blobs)) {
        push({ path: k, start: 0, stop: 0, score: 1, source: "fallback:blobs" });
        if (out.length >= max) break;
      }
    }
  }

  return out;
}

module.exports = { maybeAugmentBodyWithWorkspaceBlob, buildInstructionReplacementMeta, pickNextEditLocationCandidates };

