import type { Db } from "../../db";
import { accessToken, api, type IntegrationsConfig } from "./connect";

/**
 * Spotify: a playlist made from songs she names. Each "artist - title" is
 * searched, the best match kept, and songs that cannot be found are simply
 * left out. Playlists are private and live in the person's own account.
 */

const API = "https://api.spotify.com/v1";

export interface Playlist { url: string; found: number; missing: string[] }

export async function makePlaylist(db: Db, config: IntegrationsConfig, userId: string, now: Date, title: string, songs: string[], description = ""): Promise<Playlist> {
  const token = await accessToken(db, config, userId, "spotify", now);
  const call = <T>(method: string, url: string, body?: unknown) => api<T>(config, token, method, url, body);
  const uris: string[] = [];
  const missing: string[] = [];
  for (const song of songs.slice(0, 25)) {
    const params = new URLSearchParams({ q: song, type: "track", limit: "1" });
    const found = await call<{ tracks?: { items?: Array<{ uri: string }> } }>("GET", `${API}/search?${params}`);
    const uri = found.tracks?.items?.[0]?.uri;
    if (uri && !uris.includes(uri)) uris.push(uri);
    else if (!uri) missing.push(song);
  }
  if (!uris.length) throw new Error("none of those songs were found on Spotify");
  const me = await call<{ id: string }>("GET", `${API}/me`);
  const playlist = await call<{ id: string; external_urls?: { spotify?: string } }>("POST", `${API}/users/${encodeURIComponent(me.id)}/playlists`, {
    name: title.slice(0, 100), description: description.slice(0, 300), public: false,
  });
  await call("POST", `${API}/playlists/${encodeURIComponent(playlist.id)}/tracks`, { uris });
  return { url: playlist.external_urls?.spotify ?? `https://open.spotify.com/playlist/${playlist.id}`, found: uris.length, missing };
}
