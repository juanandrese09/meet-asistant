import { createServer } from "node:http";
import { writeFile, readFile, mkdir, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import OpenAI from "openai";

const __dirname = dirname(fileURLToPath(import.meta.url));
// On Vercel, only /tmp is writable; locally use the server/transcriptions folder
const TRANSCRIPTIONS_DIR = process.env.VERCEL
  ? "/tmp/transcriptions"
  : join(__dirname, "transcriptions");
const PORT = process.env.PORT || 3456;

// Ensure OPENAI_API_KEY is set
if (!process.env.OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY environment variable is required. Set it in your .env file or Vercel environment variables.");
}

const openai = new OpenAI();

// Ensure transcriptions directory exists
await mkdir(TRANSCRIPTIONS_DIR, { recursive: true });

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonResponse(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json", ...corsHeaders() });
  res.end(JSON.stringify(data));
}

async function transcribeAudio(audioBuffer) {
  // Whisper API expects a file-like object
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

async function handleTranscribe(req, res) {
  let body = "";
  for await (const chunk of req) body += chunk;

  const { audio, timestamp } = JSON.parse(body);

  if (!audio) {
    jsonResponse(res, { error: "No audio data received" }, 400);
    return;
  }

  // Decode base64 audio
  const audioBuffer = Buffer.from(audio, "base64");
  console.log(`Audio received: ${audioBuffer.length} bytes`);

  if (audioBuffer.length < 1000) {
    jsonResponse(res, { error: `Audio muy corto (${audioBuffer.length} bytes) — puede que no se haya grabado audio` }, 400);
    return;
  }

  const dateStr = timestamp
    ? new Date(timestamp).toISOString().replace(/[:.]/g, "-")
    : new Date().toISOString().replace(/[:.]/g, "-");

  const baseName = `meeting-${dateStr}`;

  // Save raw audio
  const audioPath = join(TRANSCRIPTIONS_DIR, `${baseName}.webm`);
  await writeFile(audioPath, audioBuffer);
  console.log(`Audio saved: ${audioPath}`);

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
  const transcriptPath = join(TRANSCRIPTIONS_DIR, `${baseName}.txt`);
  await writeFile(transcriptPath, transcriptText);
  console.log(`Transcript saved: ${transcriptPath}`);

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

  // Save summary
  const summaryPath = join(TRANSCRIPTIONS_DIR, `${baseName}-summary.md`);
  const fullDoc = `# Reunion ${new Date(timestamp || Date.now()).toLocaleString("es-MX")}

## Resumen generado por AI

${summary}

---

## Transcripcion completa

${transcriptText}
`;
  await writeFile(summaryPath, fullDoc);
  console.log(`Summary saved: ${summaryPath}`);

  // Also save structured insights as JSON to make dashboard rendering reliable
  try {
    const extractList = (text) => {
      if (!text) return [];
      return text.split(/\n/).map(l=>l.replace(/^[-*\d\.\)\s]+/,'').trim()).filter(Boolean);
    };

    const getSection = (heading) => {
      const re = new RegExp(`##\\s+${heading}\\s*\\n([\s\S]*?)(?:\\n##\\s+|$)`, 'i');
      const m = fullDoc.match(re);
      return m ? m[1].trim() : '';
    };

    const insights = {
      summary: getSection('Resumen generado por AI') || '',
      keyPoints: extractList(getSection('Puntos clave') || getSection('Puntos') || ''),
      actionItems: extractList(getSection('Action items') || getSection('Action') || ''),
      decisions: extractList(getSection('Decisiones') || getSection('Decision') || ''),
    };

    const insightsPath = join(TRANSCRIPTIONS_DIR, `${baseName}-insights.json`);
    await writeFile(insightsPath, JSON.stringify(insights, null, 2));
    console.log(`Insights saved: ${insightsPath}`);
  } catch (err) {
    console.error('Could not save insights JSON:', err.message);
  }

  jsonResponse(res, {
    success: true,
    message: "Transcripcion y resumen guardados",
    summary: summary.substring(0, 200) + "...",
    files: {
      audio: audioPath,
      transcript: transcriptPath,
      summary: summaryPath,
    },
  });
}

async function handleListMeetings(res) {
  const files = await readdir(TRANSCRIPTIONS_DIR);
  const summaries = files.filter((f) => f.endsWith("-summary.md"));

  const meetings = await Promise.all(
    summaries.map(async (file) => {
      const content = await readFile(join(TRANSCRIPTIONS_DIR, file), "utf-8");
      const titleMatch = content.match(/^# (.+)/m);
      // Prefer the human readable date present in the saved summary header (# Reunion ...)
      const dateMatch = content.match(/^# Reunion\s+(.+)$/m);
      return {
        file,
        title: titleMatch?.[1] || file,
        date: dateMatch?.[1] || file,
        preview: content.substring(0, 300),
      };
    })
  );

  jsonResponse(res, { meetings: meetings.reverse() });
}

async function handleGetMeeting(res, filename) {
  try {
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "");
    const filePath = join(TRANSCRIPTIONS_DIR, safeName);
    const content = await readFile(filePath, "utf-8");

    // Try to also load the raw transcript
    const txtFile = safeName.replace("-summary.md", ".txt");
    let transcript = "";
    try {
      transcript = await readFile(join(TRANSCRIPTIONS_DIR, txtFile), "utf-8");
    } catch { /* no separate transcript file */ }

    // Try to load structured insights JSON if present
    const insightsFile = safeName.replace('-summary.md', '-insights.json');
    let insights = null;
    try {
      const raw = await readFile(join(TRANSCRIPTIONS_DIR, insightsFile), 'utf-8');
      insights = JSON.parse(raw);
    } catch { /* ok if not present */ }

    jsonResponse(res, { content, transcript, file: safeName, insights });
  } catch (err) {
    jsonResponse(res, { error: "Meeting not found" }, 404);
  }
}

const server = createServer(async (req, res) => {
  // Handle CORS preflight
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
      // Support optional ?format=txt to return plain text (summary + transcript)
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const filename = decodeURIComponent(url.pathname.split("/meeting/")[1]);
      const format = url.searchParams.get('format') || '';
      if (format === 'txt') {
        // Serve a plain text export
        try {
          const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "");
          const summaryPath = join(TRANSCRIPTIONS_DIR, safeName);
          const content = await readFile(summaryPath, 'utf-8');
          // Try to include the raw transcript if available
          const txtFile = safeName.replace('-summary.md', '.txt');
          let transcript = '';
          try { transcript = await readFile(join(TRANSCRIPTIONS_DIR, txtFile), 'utf-8'); } catch {}
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders() });
          res.end(content + "\n\n---\n\n" + transcript);
        } catch (err) {
          jsonResponse(res, { error: 'Meeting not found' }, 404);
        }
      } else {
        await handleGetMeeting(res, filename);
      }
    } else if (req.method === "GET" && req.url === "/dashboard") {
      const dashPath = join(__dirname, "dashboard.html");
      const html = await readFile(dashPath, "utf-8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...corsHeaders() });
      res.end(html);
    } else if (req.method === "GET" && req.url === "/health") {
      jsonResponse(res, { status: "ok" });
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
  console.log(`  Transcriptions saved to: ${TRANSCRIPTIONS_DIR}\n`);
});
