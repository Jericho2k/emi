/**
 * Her voice: ElevenLabs text-to-speech, returning MP3, which Telegram plays
 * as a voice note. One voice for everyone, on the operator's key, so she
 * sounds the same to every person.
 */

export interface VoiceConfig {
  apiKey: string;
  voiceId: string;
  /** eleven_v3 understands audio tags like [sighs]; older models read them aloud. */
  model: string;
}

export function supportsAudioTags(model: string): boolean {
  return model.startsWith("eleven_v3");
}

export function elevenLabs(config: VoiceConfig): (text: string) => Promise<Uint8Array> {
  return async (text) => {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(config.voiceId)}?output_format=mp3_44100_64`,
      {
        method: "POST",
        headers: { "xi-api-key": config.apiKey, "content-type": "application/json", accept: "audio/mpeg" },
        body: JSON.stringify({ text: text.slice(0, 600), model_id: config.model }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    // Status only: the body may echo the request, and the key must never reach a log.
    if (!response.ok) throw new Error(`voice provider returned ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  };
}
