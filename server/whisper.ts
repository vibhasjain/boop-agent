import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileP = promisify(execFile);

const WHISPER_BIN = process.env.WHISPER_BIN ?? "/opt/whisper/whisper-cli";
const WHISPER_MODEL = process.env.WHISPER_MODEL ?? "/opt/whisper/ggml-base.en.bin";

// Hard cap to keep cold-start memory predictable. A 60s memo at 16kHz mono
// PCM is ~1.9MB; we allow ~10x that for safety on outliers.
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

export class WhisperUnavailableError extends Error {}

/**
 * Fetch an audio URL, transcode to 16kHz mono WAV, run whisper.cpp tiny.en,
 * return the transcript. Throws on any failure so the caller can fall back
 * to the URL-tag behavior gracefully.
 */
export async function transcribeAudioUrl(url: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "whisper-"));
  try {
    const inPath = join(dir, "in");
    const wavPath = join(dir, "out.wav");

    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch audio failed ${res.status}`);
    const ab = await res.arrayBuffer();
    if (ab.byteLength > MAX_AUDIO_BYTES) {
      throw new Error(`audio too large: ${ab.byteLength} bytes`);
    }
    await writeFile(inPath, Buffer.from(ab));

    // ffmpeg: any input format -> 16kHz mono 16-bit PCM WAV.
    await execFileP("ffmpeg", ["-y", "-i", inPath, "-ar", "16000", "-ac", "1", "-f", "wav", wavPath], {
      timeout: 30_000,
    });

    // whisper.cpp: --output-txt writes <wavPath>.txt; -nt suppresses timestamps.
    await execFileP(
      WHISPER_BIN,
      ["-m", WHISPER_MODEL, "-f", wavPath, "-otxt", "-nt", "-l", "en"],
      { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
    );

    const txt = await readFile(`${wavPath}.txt`, "utf8");
    const transcript = txt.trim();
    if (!transcript) throw new Error("empty transcript");
    return transcript;
  } catch (err) {
    // Detect "binary not found" so callers can log a clearer signal — but
    // still throw so the caller falls back.
    const msg = String((err as Error)?.message ?? err);
    if (msg.includes("ENOENT") && msg.includes(WHISPER_BIN)) {
      throw new WhisperUnavailableError(`whisper binary not found at ${WHISPER_BIN}`);
    }
    throw err;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
