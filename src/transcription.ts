import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const WHISPER_BIN = process.env.WHISPER_BIN || 'whisper-cli';
const WHISPER_MODEL =
  process.env.WHISPER_MODEL ||
  path.join(process.cwd(), 'data', 'models', 'ggml-base.bin');

export const TRANSCRIPTION_UNAVAILABLE =
  '[Voice Message - transcription unavailable]';

/**
 * Transcribe an audio buffer using local whisper.cpp.
 * Accepts any audio format ffmpeg can decode (ogg, opus, mp3, m4a, wav, etc.)
 * Returns the transcript string, or TRANSCRIPTION_UNAVAILABLE on failure.
 */
export async function transcribeAudio(audioBuffer: Buffer): Promise<string> {
  const tmpDir = os.tmpdir();
  const id = `nanoclaw-voice-${Date.now()}`;
  const tmpIn = path.join(tmpDir, `${id}.audio`);
  const tmpWav = path.join(tmpDir, `${id}.wav`);

  try {
    fs.writeFileSync(tmpIn, audioBuffer);

    // Convert to 16kHz mono WAV (required by whisper.cpp)
    await execFileAsync(
      'ffmpeg',
      ['-i', tmpIn, '-ar', '16000', '-ac', '1', '-f', 'wav', '-y', tmpWav],
      { timeout: 30_000 },
    );

    const { stdout } = await execFileAsync(
      WHISPER_BIN,
      ['-m', WHISPER_MODEL, '-f', tmpWav, '--no-timestamps', '-nt'],
      { timeout: 60_000 },
    );

    const transcript = stdout.trim();
    return transcript || TRANSCRIPTION_UNAVAILABLE;
  } catch (err) {
    console.error('whisper.cpp transcription failed:', err);
    return TRANSCRIPTION_UNAVAILABLE;
  } finally {
    for (const f of [tmpIn, tmpWav]) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* best effort */
      }
    }
  }
}
