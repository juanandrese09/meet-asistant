import { createServer } from "node:http";
import { writeFile, readFile, mkdir, readdir } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";

const __dirname = dirname(fileURLToPath(import.meta.url));
const IS_VERCEL = !!process.env.VERCEL;
const LOCAL_TRANSCRIPTIONS_DIR = join(__dirname, "transcriptions");
const PORT = process.env.PORT || 3456;
const MAX_BODY_SIZE = 50 * 1024 * 1024; // 50MB

// API key for authenticating extension + dashboard requests
const API_KEY = process.env.API_KEY;

// Ensure OPENAI_API_KEY is set
if (!process.env.OPENAI_API_KEY) {
  throw new Error(
    "OPENAI_API_KEY environment variable is required. Set it in your .env file or Vercel environment variables."
  );
}

const openai = new OpenAI();

// Local: ensure transcriptions directory exists
if (!IS_VERCEL) {
  await mkdir(LOCAL_TRANSCRIPTIONS_DIR, { recursive: true });
}

// ─────────────────────────────────────────
//  Storage abstraction
//  Vercel → @vercel/blob (persistent)
//  Local  → filesystem
// ─────────────────────────────────────────

async function storageSave(filename, content) {
  const safeName = basename(filename);
  if (IS_VERCEL) {
    const { put } = await import("@vercel/blob");
    const blob = await put(`transcriptions/${safeName}`, content, {
      access: "private",
      addRandomSuffix: false,
    });
    return blob.url;
  }
  const path = join(LOCAL_TRANSCRIPTIONS_DIR, safeName);
  await writeFile(path, content);
  return path;
}

async function storageRead(filename) {
  const safeName = basename(filename);
  if (IS_VERCEL) {
    const { get } = await import("@vercel/blob");
    const result = await get(`transcriptions/${safeName}`, { access: "private", useCache: false });
    if (!result || result.statusCode !== 200 || !result.stream) {
      throw new Error(`File not found: ${safeName}`);
    }
    return await new Response(result.stream).text();
  }
  return await readFile(join(LOCAL_TRANSCRIPTIONS_DIR, safeName), "utf-8");
}

async function storageReadBuffer(filename) {
  const safeName = basename(filename);
  if (IS_VERCEL) {
    const { get } = await import("@vercel/blob");
    const result = await get(`transcriptions/${safeName}`, { access: "private", useCache: false });
    if (!result || result.statusCode !== 200 || !result.stream) {
      throw new Error(`File not found: ${safeName}`);
    }
    return Buffer.from(await new Response(result.stream).arrayBuffer());
  }
  return await readFile(join(LOCAL_TRANSCRIPTIONS_DIR, safeName));
}

async function storageList(suffix) {
  if (IS_VERCEL) {
    const { list } = await import("@vercel/blob");
    let allBlobs = [];
    let cursor;
    do {
      const result = await list({
        prefix: "transcriptions/",
        limit: 100,
        cursor,
      });
      allBlobs = allBlobs.concat(result.blobs);
      cursor = result.cursor;
    } while (cursor);
    return allBlobs
      .filter((b) => b.pathname.endsWith(suffix))
      .map((b) => b.pathname.replace("transcriptions/", ""));
  }
  const files = await readdir(LOCAL_TRANSCRIPTIONS_DIR);
  return files.filter((f) => f.endsWith(suffix));
}

async function storageDelete(filename) {
  const safeName = basename(filename);
  if (IS_VERCEL) {
    const { list, del } = await import("@vercel/blob");
    const { blobs } = await list({ prefix: `transcriptions/${safeName}` });
    const blob = blobs.find((b) => b.pathname === `transcriptions/${safeName}`);
    if (blob) await del(blob.url);
    return !!blob;
  }
  const { unlink } = await import("node:fs/promises");
  try {
    await unlink(join(LOCAL_TRANSCRIPTIONS_DIR, safeName));
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────
//  CORS helpers
// ─────────────────────────────────────────

const ALLOWED_ORIGINS = [
  "chrome-extension://extension-id-placeholder",
  process.env.DASHBOARD_URL,
].filter(Boolean);

function corsHeaders(req) {
  const origin = req.headers?.origin;
  const allowed = origin && ALLOWED_ORIGINS.includes(origin)
    ? origin
    : "*";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-api-key",
  };
}

function jsonResponse(res, data, status = 200, req) {
  res.writeHead(status, { "Content-Type": "application/json", ...corsHeaders(req) });
  res.end(JSON.stringify(data));
}

// ─────────────────────────────────────────
//  Multipart form-data parser (minimal)
// ─────────────────────────────────────────

function parseMultipart(buffer, boundary) {
  const boundaryStr = `--${boundary}`;
  const boundaryBytes = Buffer.from(boundaryStr);
  const parts = [];
  let start = 0;

  while (start < buffer.length) {
    const idx = buffer.indexOf(boundaryBytes, start);
    if (idx === -1) break;

    const nextIdx = buffer.indexOf(boundaryBytes, idx + boundaryBytes.length);
    if (nextIdx === -1) break;

    const partData = buffer.slice(idx + boundaryBytes.length, nextIdx);
    const headerEnd = partData.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      start = nextIdx;
      continue;
    }

    const headers = partData.slice(0, headerEnd).toString();
    const data = partData.slice(headerEnd + 4);

    const nameMatch = headers.match(/name="([^"]+)"/);
    const filenameMatch = headers.match(/filename="([^"]+)"/);
    const name = nameMatch ? nameMatch[1] : null;

    if (name) {
      parts.push({ name, data, filename: filenameMatch ? filenameMatch[1] : null });
    }

    start = nextIdx;
  }

  return parts;
}

// ─────────────────────────────────────────
//  Auth middleware
// ─────────────────────────────────────────

function authenticate(req) {
  if (!API_KEY) return true; // no key set = open (dev mode)
  const provided = req.headers["x-api-key"];
  return provided === API_KEY;
}

// ─────────────────────────────────────────
//  AI helpers
// ─────────────────────────────────────────

async function transcribeAudio(audioBuffer, language = null) {
  const file = new File([audioBuffer], "meeting.webm", { type: "audio/webm" });
  const params = {
    model: "whisper-1",
    file,
    response_format: "verbose_json",
  };
  if (language) {
    params.language = language;
  }
  const transcription = await openai.audio.transcriptions.create(params);
  return transcription;
}

async function summarizeMeeting(transcript) {
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 2048,
    messages: [
      {
        role: "system",
        content: "Eres un asistente que resume reuniones de trabajo. Responde en español.",
      },
      {
        role: "user",
        content: `Analiza esta transcripcion y genera:

1. **Resumen** (2-3 parrafos): De que trato la reunion
2. **Puntos clave**: Los temas mas importantes discutidos (bullet points)
3. **Action items**: Tareas o compromisos mencionados, con responsable si se menciona
4. **Decisiones**: Decisiones que se tomaron en la reunion

Transcripcion:
${transcript}`,
      },
    ],
  });
  return response.choices[0].message.content;
}

// ─────────────────────────────────────────
//  In-memory progress store for SSE
// ─────────────────────────────────────────

const progressStore = new Map();

function broadcastProgress(sessionId, data) {
  progressStore.set(sessionId, { ...data, ts: Date.now() });
}

// ─────────────────────────────────────────
//  Route handlers
// ─────────────────────────────────────────

async function handleTranscribe(req, res) {
  const sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  broadcastProgress(sessionId, { status: "uploading", progress: 0 });

  const contentType = req.headers["content-type"] || "";
  let audio, timestamp, durationMs, tzOffsetMinutes, language;

  if (contentType.includes("multipart/form-data")) {
    // FormData upload from offscreen document
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
      const totalSize = chunks.reduce((sum, c) => sum + c.length, 0);
      if (totalSize > MAX_BODY_SIZE) {
        broadcastProgress(sessionId, { status: "error", error: "Request too large (max 50MB)" });
        jsonResponse(res, { error: "Request body too large (max 50MB)" }, 413, req);
        return;
      }
    }
    const buffer = Buffer.concat(chunks);
    const boundary = contentType.split("boundary=")[1];
    if (!boundary) {
      jsonResponse(res, { error: "Invalid multipart request" }, 400, req);
      return;
    }

    const parts = parseMultipart(buffer, boundary);
    const audioPart = parts.find((p) => p.name === "audio");
    if (!audioPart) {
      jsonResponse(res, { error: "No audio data received" }, 400, req);
      return;
    }

    audio = audioPart.data;
    timestamp = parts.find((p) => p.name === "timestamp")?.data?.toString() || null;
    tzOffsetMinutes = parts.find((p) => p.name === "tzOffsetMinutes")?.data?.toString();
    language = parts.find((p) => p.name === "language")?.data?.toString() || null;
    durationMs = null;
  } else {
    // JSON upload from background.js
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > MAX_BODY_SIZE) {
        broadcastProgress(sessionId, { status: "error", error: "Request too large (max 50MB)" });
        jsonResponse(res, { error: "Request body too large (max 50MB)" }, 413, req);
        return;
      }
    }
    const parsed = JSON.parse(body);
    audio = parsed.audio;
    timestamp = parsed.timestamp;
    durationMs = parsed.durationMs;
    tzOffsetMinutes = parsed.tzOffsetMinutes;
    language = parsed.language;
  }

  if (!audio) {
    broadcastProgress(sessionId, { status: "error", error: "No audio data received" });
    jsonResponse(res, { error: "No audio data received" }, 400, req);
    return;
  }

  const audioBuffer = typeof audio === "string" ? Buffer.from(audio, "base64") : audio;
  console.log(`Audio received: ${audioBuffer.length} bytes`);

  if (audioBuffer.length < 2000) {
    broadcastProgress(sessionId, { status: "error", error: "Audio muy corto" });
    jsonResponse(
      res,
      { error: `Audio muy corto (${audioBuffer.length} bytes) — verifica que la pestaña tenga sonido y que la grabación haya durado al menos unos segundos` },
      400,
      req
    );
    return;
  }

  const dateStr = timestamp
    ? new Date(timestamp).toISOString().replace(/[:.]/g, "-")
    : new Date().toISOString().replace(/[:.]/g, "-");

  const baseName = `meeting-${dateStr}`;

  // Save raw audio
  broadcastProgress(sessionId, { status: "saving", progress: 10 });
  await storageSave(`${baseName}.webm`, audioBuffer);
  console.log(`Audio saved: ${baseName}.webm`);

  // Transcribe with Whisper (auto-detect language if not specified)
  broadcastProgress(sessionId, { status: "transcribing", progress: 20 });
  console.log("Transcribing with Whisper...");
  let transcriptText;
  try {
    const transcription = await transcribeAudio(audioBuffer, language || null);
    transcriptText = transcription.text;
    console.log(`Transcript (${transcriptText.length} chars): ${transcriptText.substring(0, 100)}...`);
  } catch (err) {
    console.error("Whisper error:", err.message);
    broadcastProgress(sessionId, { status: "error", error: err.message });
    jsonResponse(res, { error: `Error en transcripcion: ${err.message}` }, 500, req);
    return;
  }

  broadcastProgress(sessionId, { status: "transcribed", progress: 60 });

  // Save transcript
  await storageSave(`${baseName}.txt`, transcriptText);
  console.log(`Transcript saved: ${baseName}.txt`);

  // Summarize with GPT-4o
  let summary = "";
  if (transcriptText.length > 20) {
    broadcastProgress(sessionId, { status: "summarizing", progress: 70 });
    console.log("Summarizing with GPT-4o-mini...");
    try {
      summary = await summarizeMeeting(transcriptText);
    } catch (err) {
      console.error("Summary error:", err.message);
      summary = "Error generando resumen: " + err.message;
    }
  }

  broadcastProgress(sessionId, { status: "done", progress: 100 });

  // Build and save full summary document
  const tsDate = new Date(timestamp || Date.now());
  const shifted = typeof tzOffsetMinutes === "number"
    ? new Date(tsDate.getTime() - tzOffsetMinutes * 60000)
    : tsDate;
  const displayDate = shifted.toLocaleString("es-MX", { timeZone: "UTC" });
  const fullDoc = `# Reunion ${displayDate}

## Resumen generado por AI

${summary}

---

## Transcripcion completa

${transcriptText}
`;
  await storageSave(`${baseName}-summary.md`, fullDoc);
  console.log(`Summary saved: ${baseName}-summary.md`);

  // Save structured insights JSON for reliable dashboard rendering
  try {
    const extractList = (text) => {
      if (!text) return [];
      return text
        .split(/\n/)
        .map((l) => l.replace(/^[-*\d.\)\s]+/, "").trim())
        .filter(Boolean);
    };

    const getSection = (heading) => {
      const re = new RegExp(`##\\s+${heading}\\s*\\n([\\s\\S]*?)(?:\\n##\\s+|$)`, "i");
      const m = fullDoc.match(re);
      return m ? m[1].trim() : "";
    };

    const insights = {
      summary: getSection("Resumen generado por AI") || "",
      keyPoints: extractList(getSection("Puntos clave") || getSection("Puntos") || ""),
      actionItems: extractList(getSection("Action items") || getSection("Action") || getSection("Tareas") || ""),
      decisions: extractList(getSection("Decisiones") || getSection("Decision") || ""),
      durationMs: durationMs || null,
      timestamp: timestamp || new Date().toISOString(),
      audioSizeBytes: audioBuffer.length,
    };

    await storageSave(`${baseName}-insights.json`, JSON.stringify(insights, null, 2));
    console.log(`Insights saved: ${baseName}-insights.json`);
  } catch (err) {
    console.error("Could not save insights JSON:", err.message);
  }

  jsonResponse(res, {
    success: true,
    message: "Transcripcion y resumen guardados",
    summary: summary.substring(0, 200) + "...",
    sessionId,
  });
}

async function handleListMeetings(res, req) {
  const summaryFiles = await storageList("-summary.md");

  // Concurrent reads with limited concurrency
  const CONCURRENCY = 5;
  const meetings = [];
  for (let i = 0; i < summaryFiles.length; i += CONCURRENCY) {
    const batch = summaryFiles.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (file) => {
        const content = await storageRead(file);
        const titleMatch = content.match(/^# (.+)/m);
        const dateMatch = content.match(/^# Reunion\s+(.+)$/m);
        return {
          file,
          title: titleMatch?.[1] || file,
          date: dateMatch?.[1] || file,
          preview: content.substring(0, 300),
        };
      })
    );
    for (const r of results) {
      if (r.status === "fulfilled") {
        meetings.push(r.value);
      } else {
        console.error("List: failed to read file:", r.reason?.message);
      }
    }
  }

  jsonResponse(res, { meetings: meetings.reverse() }, 200, req);
}

async function handleGetMeeting(res, filename, req) {
  try {
    const safeName = basename(filename.replace(/[^a-zA-Z0-9._-]/g, ""));
    const content = await storageRead(safeName);

    const txtFile = safeName.replace("-summary.md", ".txt");
    let transcript = "";
    try {
      transcript = await storageRead(txtFile);
    } catch { /* no separate transcript file */ }

    const insightsFile = safeName.replace("-summary.md", "-insights.json");
    let insights = null;
    try {
      const raw = await storageRead(insightsFile);
      insights = JSON.parse(raw);
    } catch { /* ok if not present */ }

    jsonResponse(res, { content, transcript, file: safeName, insights }, 200, req);
  } catch (err) {
    jsonResponse(res, { error: "Meeting not found" }, 404, req);
  }
}

async function handleRenameMeeting(req, res, filename) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY_SIZE) {
      jsonResponse(res, { error: "Request body too large" }, 413, req);
      return;
    }
  }

  const { title } = JSON.parse(body);
  if (!title || typeof title !== "string" || title.length > 200) {
    jsonResponse(res, { error: "Title is required (max 200 chars)" }, 400, req);
    return;
  }

  try {
    const safeName = basename(filename.replace(/[^a-zA-Z0-9._-]/g, ""));
    const content = await storageRead(safeName);
    const updated = content.replace(/^# .+/m, `# ${title.trim()}`);
    await storageSave(safeName, updated);
    jsonResponse(res, { success: true, title: title.trim() }, 200, req);
  } catch (err) {
    jsonResponse(res, { error: "Meeting not found" }, 404, req);
  }
}

// ─────────────────────────────────────────
//  SSE endpoint for progress streaming
// ─────────────────────────────────────────

function handleSSE(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    ...corsHeaders(req),
  });

  const send = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Send all current progress entries
  for (const [id, data] of progressStore.entries()) {
    send({ sessionId: id, ...data });
  }

  // Poll for updates
  const interval = setInterval(() => {
    for (const [id, data] of progressStore.entries()) {
      if (Date.now() - data.ts < 5000) {
        send({ sessionId: id, ...data });
      }
    }
  }, 1000);

  req.on("close", () => {
    clearInterval(interval);
    res.end();
  });
}

// ─────────────────────────────────────────
//  HTTP Server
// ─────────────────────────────────────────

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders(req));
    res.end();
    return;
  }

  // Auth check (skip for health, SSE, and dashboard HTML)
  if (!["/health", "/progress", "/dashboard"].includes(req.url) && !authenticate(req)) {
    jsonResponse(res, { error: "Unauthorized" }, 401, req);
    return;
  }

  try {
    if (req.method === "POST" && req.url === "/transcribe") {
      await handleTranscribe(req, res);

    } else if (req.method === "GET" && req.url === "/meetings") {
      await handleListMeetings(res, req);

    } else if (req.method === "GET" && req.url?.startsWith("/meeting/")) {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const filename = decodeURIComponent(url.pathname.split("/meeting/")[1]);
      const format = url.searchParams.get("format") || "";

      if (format === "txt" || format === "md") {
        try {
          const safeName = basename(filename.replace(/[^a-zA-Z0-9._-]/g, ""));
          const content = await storageRead(safeName);
          const txtFile = safeName.replace("-summary.md", ".txt");
          let transcript = "";
          try { transcript = await storageRead(txtFile); } catch {}
          const mime = format === "md" ? "text/markdown" : "text/plain";
          const disposition = `attachment; filename="${safeName.replace(/\.md$/, "")}.${format}"`;
          res.writeHead(200, {
            "Content-Type": `${mime}; charset=utf-8`,
            "Content-Disposition": disposition,
            ...corsHeaders(req),
          });
          res.end(content + "\n\n---\n\n" + transcript);
        } catch {
          jsonResponse(res, { error: "Meeting not found" }, 404, req);
        }
      } else {
        await handleGetMeeting(res, filename, req);
      }

    } else if (req.method === "PATCH" && req.url?.startsWith("/meeting/")) {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const filename = decodeURIComponent(url.pathname.split("/meeting/")[1]);
      await handleRenameMeeting(req, res, filename);

    } else if (req.method === "DELETE" && req.url?.startsWith("/meeting/")) {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const filename = decodeURIComponent(url.pathname.split("/meeting/")[1]);
      const safeName = basename(filename.replace(/[^a-zA-Z0-9._-]/g, ""));
      const base = safeName.replace("-summary.md", "");
      const files = [
        `${base}-summary.md`,
        `${base}.txt`,
        `${base}.webm`,
        `${base}-insights.json`,
      ];
      const deleted = [];
      for (const f of files) {
        try {
          const ok = await storageDelete(f);
          if (ok) deleted.push(f);
        } catch (e) {
          console.error(`Failed to delete ${f}:`, e.message);
        }
      }
      jsonResponse(res, { success: true, deleted }, 200, req);

    } else if (req.method === "GET" && req.url === "/dashboard") {
      const dashPath = join(__dirname, "dashboard.html");
      const html = await readFile(dashPath, "utf-8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...corsHeaders(req) });
      res.end(html);

    } else if (req.method === "GET" && req.url === "/progress") {
      handleSSE(req, res);

    } else if (req.method === "GET" && req.url === "/health") {
      jsonResponse(res, { status: "ok", storage: IS_VERCEL ? "blob" : "local" }, 200, req);

    } else {
      jsonResponse(res, { error: "Not found" }, 404, req);
    }
  } catch (err) {
    console.error("Error:", err);
    jsonResponse(res, { error: err.message }, 500, req);
  }
});

server.listen(PORT, () => {
  console.log(`\n  Meet Assistant Server running on http://localhost:${PORT}`);
  console.log(`  Storage: ${IS_VERCEL ? "Vercel Blob" : `Local (${LOCAL_TRANSCRIPTIONS_DIR})`}`);
  console.log(`  Auth: ${API_KEY ? "API key enabled" : "Open (dev mode)"}\n`);
});
