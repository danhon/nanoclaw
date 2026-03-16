/**
 * Transcription proxy for container isolation.
 * Containers POST raw audio bytes here; the host runs whisper.cpp and returns
 * the transcript. This avoids needing whisper-cli or ffmpeg inside containers.
 *
 * Routes:
 *   POST /transcribe   → accepts raw audio bytes, returns JSON {transcript}
 */
import { createServer, Server } from 'http';

import { logger } from './logger.js';
import { transcribeAudio, TRANSCRIPTION_UNAVAILABLE } from './transcription.js';

export function startTranscriptionProxy(
  port: number,
  host = '0.0.0.0',
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        if (req.method === 'POST' && req.url === '/transcribe') {
          const chunks: Buffer[] = [];
          req.on('data', (c) => chunks.push(c));
          await new Promise<void>((r) => req.on('end', r));
          const audioBuffer = Buffer.concat(chunks);

          if (!audioBuffer.length) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Empty audio body' }));
            return;
          }

          logger.info(
            { bytes: audioBuffer.length },
            'Transcription proxy: received audio',
          );
          const transcript = await transcribeAudio(audioBuffer);
          const ok = transcript !== TRANSCRIPTION_UNAVAILABLE;
          logger.info(
            { ok, length: transcript.length },
            'Transcription proxy: done',
          );

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ transcript }));
        } else {
          res.writeHead(404);
          res.end('Not found');
        }
      } catch (err) {
        logger.error({ err }, 'Transcription proxy error');
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              transcript: TRANSCRIPTION_UNAVAILABLE,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      }
    });

    server.listen(port, host, () => {
      logger.info({ port, host }, 'Transcription proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}
