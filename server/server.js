import { createServer } from "node:http";
import { writeFile, readFile, mkdir, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";

const __dirname = dirname(fileURLToPath(import.meta.url));
const IS_VERCEL = !!process.env.VERCEL;
const LOCAL_TRANSCRIPTIONS_DIR = join(__dirname, "transcriptions");
const PORT = process.env.PORT || 3456;

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
  if (IS_VERCEL) {
    const { put } = await import("@vercel/blob");
    const blob = await put(`transcriptions/${filename}`, content, {
      access: "private",
      addRandomSuffix: false,
    });
    return blob.url;
  }
  const path = join(LOCAL_TRANSCRIPTIONS_DIR, filename);
  await writeFile(path, content);
  return path;
}

async function storageRead(filename) {
  if (IS_VERCEL) {
    const { get } = await import("@vercel/blob");
    const result = await get(`transcriptions/${filename}`, { access: "private" });
    if (!result || result.statusCode !== 200 || !result.stream) {
      throw new Error(`File not found: ${filename}`);
    }
    return await new Response(result.stream).text();
  }
  return await readFile(join(LOCAL_TRANSCRIPTIONS_DIR, filename), "utf-8");
}

async function storageReadBuffer(filename) {
  if (IS_VERCEL) {
    const { get } = await import("@vercel/blob");
    const result = await get(`transcriptions/${filename}`, { access: "private" });
    if (!result || result.statusCode !== 200 || !result.stream) {
      throw new Error(`File not found: ${filename}`);
    }
    return Buffer.from(await new Response(result.stream).arrayBuffer());
  }
  return await readFile(join(LOCAL_TRANSCRIPTIONS_DIR, filename));
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
  if (IS_VERCEL) {
    const { list, del } = await import("@vercel/blob");
    const { blobs } = await list({ prefix: `transcriptions/${filename}` });
    const blob = blobs.find((b) => b.pathname === `transcriptions/${filename}`);
    if (blob) await del(blob.url);
    return !!blob;
  }
  const { unlink } = await import("node:fs/promises");
  try {
    await unlink(join(LOCAL_TRANSCRIPTIONS_DIR, filename));
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────
//  CORS helpers
// ─────────────────────────────────────────

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonResponse(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json", ...corsHeaders() });
  res.end(JSON.stringify(data));
}

// ─────────────────────────────────────────
//  AI helpers
// ─────────────────────────────────────────

async function transcribeAudio(audioBuffer) {
  const file = new File([audioBuffer], "meeting.webm", { type: "audio/webm" });
  const transcription = await openai.audio.transcriptions.create({
    model: "whisper-1",
    file,
    language: "es",
    response_format: "verbose_json",
  });
  return transcription;
}

async function summarizeMeeting(transcript) {
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
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
//  Route handlers
// ─────────────────────────────────────────

async function handleTranscribe(req, res) {
  let body = "";
  for await (const chunk of req) body += chunk;

  const { audio, timestamp, durationMs } = JSON.parse(body);

  if (!audio) {
    jsonResponse(res, { error: "No audio data received" }, 400);
    return;
  }

  const audioBuffer = Buffer.from(audio, "base64");
  console.log(`Audio received: ${audioBuffer.length} bytes`);

  if (audioBuffer.length < 2000) {
    jsonResponse(
      res,
      { error: `Audio muy corto (${audioBuffer.length} bytes) — verifica que la pestaña tenga sonido y que la grabación haya durado al menos unos segundos` },
      400
    );
    return;
  }

  const dateStr = timestamp
    ? new Date(timestamp).toISOString().replace(/[:.]/g, "-")
    : new Date().toISOString().replace(/[:.]/g, "-");

  const baseName = `meeting-${dateStr}`;

  // Save raw audio
  await storageSave(`${baseName}.webm`, audioBuffer);
  console.log(`Audio saved: ${baseName}.webm`);

  // Transcribe with Whisper
  console.log("Transcribing with Whisper...");
  let transcriptText;
  try {
    const transcription = await transcribeAudio(audioBuffer);
    transcriptText = transcription.text;
    console.log(`Transcript (${transcriptText.length} chars): ${transcriptText.substring(0, 100)}...`);
  } catch (err) {
    console.error("Whisper error:", err.message);
    jsonResponse(res, { error: `Error en transcripcion: ${err.message}` }, 500);
    return;
  }

  // Save transcript
  await storageSave(`${baseName}.txt`, transcriptText);
  console.log(`Transcript saved: ${baseName}.txt`);

  // Summarize with GPT-4o-mini
  let summary = "";
  if (transcriptText.length > 20) {
    console.log("Summarizing with GPT-4o-mini...");
    try {
      summary = await summarizeMeeting(transcriptText);
    } catch (err) {
      console.error("Summary error:", err.message);
      summary = "Error generando resumen: " + err.message;
    }
  }

  // Build and save full summary document
  const fullDoc = `# Reunion ${new Date(timestamp || Date.now()).toLocaleString("es-MX")}

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
  });
}

async function handleListMeetings(res) {
  const summaryFiles = await storageList("-summary.md");

  const meetings = await Promise.all(
    summaryFiles.map(async (file) => {
      try {
        const content = await storageRead(file);
        const titleMatch = content.match(/^# (.+)/m);
        const dateMatch = content.match(/^# Reunion\s+(.+)$/m);
        return {
          file,
          title: titleMatch?.[1] || file,
          date: dateMatch?.[1] || file,
          preview: content.substring(0, 300),
        };
      } catch {
        return { file, title: file, date: file, preview: "" };
      }
    })
  );

  jsonResponse(res, { meetings: meetings.reverse() });
}

async function handleGetMeeting(res, filename) {
  try {
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "");
    const content = await storageRead(safeName);

    // Try to also load the raw transcript
    const txtFile = safeName.replace("-summary.md", ".txt");
    let transcript = "";
    try {
      transcript = await storageRead(txtFile);
    } catch { /* no separate transcript file */ }

    // Try to load structured insights JSON if present
    const insightsFile = safeName.replace("-summary.md", "-insights.json");
    let insights = null;
    try {
      const raw = await storageRead(insightsFile);
      insights = JSON.parse(raw);
    } catch { /* ok if not present */ }

    jsonResponse(res, { content, transcript, file: safeName, insights });
  } catch (err) {
    jsonResponse(res, { error: "Meeting not found" }, 404);
  }
}

// ─────────────────────────────────────────
//  HTTP Server
// ─────────────────────────────────────────

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  try {
    if (req.method === "POST" && req.url === "/transcribe") {
      await handleTranscribe(req, res);

    } else if (req.method === "GET" && req.url === "/meetings") {
      await handleListMeetings(res);

    } else if (req.method === "GET" && req.url?.startsWith("/meeting/")) {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const filename = decodeURIComponent(url.pathname.split("/meeting/")[1]);
      const format = url.searchParams.get("format") || "";

      if (format === "txt" || format === "md") {
        try {
          const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "");
          const content = await storageRead(safeName);
          const txtFile = safeName.replace("-summary.md", ".txt");
          let transcript = "";
          try { transcript = await storageRead(txtFile); } catch {}
          const mime = format === "md" ? "text/markdown" : "text/plain";
          const disposition = `attachment; filename="${safeName.replace(/\.md$/, "")}.${format}"`;
          res.writeHead(200, {
            "Content-Type": `${mime}; charset=utf-8`,
            "Content-Disposition": disposition,
            ...corsHeaders(),
          });
          res.end(content + "\n\n---\n\n" + transcript);
        } catch {
          jsonResponse(res, { error: "Meeting not found" }, 404);
        }
      } else {
        await handleGetMeeting(res, filename);
      }

    } else if (req.method === "DELETE" && req.url?.startsWith("/meeting/")) {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const filename = decodeURIComponent(url.pathname.split("/meeting/")[1]);
      const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "");
      const base = safeName.replace("-summary.md", "");
      // Delete all related files
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
      jsonResponse(res, { success: true, deleted });

    } else if (req.method === "GET" && req.url === "/dashboard") {
      const dashPath = join(__dirname, "dashboard.html");
      const html = await readFile(dashPath, "utf-8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...corsHeaders() });
      res.end(html);

    } else if (req.method === "GET" && req.url === "/health") {
      jsonResponse(res, { status: "ok", storage: IS_VERCEL ? "blob" : "local" });

    } else {
      jsonResponse(res, { error: "Not found" }, 404);
    }
  } catch (err) {
    console.error("Error:", err);
    jsonResponse(res, { error: err.message }, 500);
  }
});

server.listen(PORT, () => {
  console.log(`\n  Meet Assistant Server running on http://localhost:${PORT}`);
  console.log(`  Storage: ${IS_VERCEL ? "Vercel Blob" : `Local (${LOCAL_TRANSCRIPTIONS_DIR})`}\n`);
});
