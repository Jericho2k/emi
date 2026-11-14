import { describe, expect, it } from "vitest";
import { activeMischief, sweepMakeups } from "../src/core/expression";
import { claimHeld, extractActions, forgetView, integrationView } from "../src/core/integrations/actions";
import { accessToken, completeConnection, connectUrl, makeState, readState, type IntegrationsConfig } from "../src/core/integrations/connect";
import { makePlaylist } from "../src/core/integrations/spotify";
import { handleTurn } from "../src/core/pipeline";
import { getUser, recentMessages, updateUser } from "../src/core/users";
import { startHttp } from "../src/http";
import { HOUR, world, type World } from "./helpers";

interface Call { method: string; url: string; body: any }

/** A fake Google and Spotify that answer like the real APIs and record every request. */
function fakeNet(overrides: Partial<Record<string, (call: Call) => [number, unknown]>> = {}) {
  const calls: Call[] = [];
  let nextId = 0;
  const routes: Record<string, (call: Call) => [number, unknown]> = {
    "POST oauth2.googleapis.com/token": (call) => call.body.includes("refresh_token=")
      ? [200, { access_token: "google-access-2", expires_in: 3600 }]
      : [200, { access_token: "google-access-1", refresh_token: "google-refresh-secret", expires_in: 3600, scope: "calendar tasks" }],
    "POST accounts.spotify.com/api/token": () => [200, { access_token: "spotify-access", refresh_token: "spotify-refresh", expires_in: 3600 }],
    "GET www.googleapis.com/calendar/v3/calendars/primary/events": () => [200, { items: [
      { id: "real-event-1", summary: "Dentist", start: { dateTime: "2026-11-16T10:30:00+01:00" }, end: { dateTime: "2026-11-16T11:00:00+01:00" } },
      { id: "real-event-2", summary: "Anna's birthday", start: { date: "2026-11-18" }, end: { date: "2026-11-19" } },
    ] }],
    "GET tasks.googleapis.com/tasks/v1/lists/@default/tasks": () => [200, { items: [{ id: "real-task-1", title: "Buy milk", status: "needsAction" }] }],
    "POST tasks.googleapis.com/tasks/v1/lists/@default/tasks": (call) => [200, { id: `new-task-${++nextId}`, title: JSON.parse(call.body).title }],
    "POST www.googleapis.com/calendar/v3/calendars/primary/events": (call) => [200, { id: `new-event-${++nextId}`, summary: JSON.parse(call.body).summary, start: JSON.parse(call.body).start, end: JSON.parse(call.body).end }],
    "GET api.spotify.com/v1/search": (call) => [200, { tracks: { items: call.url.includes("nobody") ? [] : [{ uri: `spotify:track:${new URL(call.url).searchParams.get("q")!.length}` }] } }],
    "GET api.spotify.com/v1/me": () => [200, { id: "sam" }],
    "POST api.spotify.com/v1/users/sam/playlists": () => [201, { id: "pl1", external_urls: { spotify: "https://open.spotify.com/playlist/pl1" } }],
    "POST api.spotify.com/v1/playlists/pl1/tracks": () => [201, { snapshot_id: "x" }],
    ...overrides,
  };
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const call: Call = { method: init?.method ?? "GET", url, body: typeof init?.body === "string" ? init.body : init?.body?.toString() ?? "" };
    calls.push(call);
    const parsed = new URL(url);
    const key = `${call.method} ${parsed.host}${parsed.pathname}`;
    const route = routes[key] ?? (call.method === "DELETE" || call.method === "PATCH" ? () => [204, null] as [number, unknown] : undefined);
    if (!route) return new Response("not found", { status: 404 });
    const [status, body] = route(call);
    return new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

const MASTER = Buffer.alloc(32, 9);
function integrations(net: ReturnType<typeof fakeNet>): IntegrationsConfig {
  return { masterKey: MASTER, publicUrl: "https://emi.example.com/", google: { clientId: "gid", clientSecret: "gsecret" }, spotify: { clientId: "sid", clientSecret: "ssecret" }, fetch: net.fetch };
}

async function connected(w: World, net: ReturnType<typeof fakeNet>, providers: Array<"google" | "spotify"> = ["google"]) {
  w.deps.integrations = integrations(net);
  const person = await w.newUser();
  for (const provider of providers) await completeConnection(w.db, w.deps.integrations, provider, person.id, "one-time-code", w.now);
  forgetView(person.id);
  return person;
}
const lastNotes = (w: World) => w.calls.filter((call) => call.options.model === "writer").at(-1)!.messages.at(-1)!.content;
const sentTo = (net: ReturnType<typeof fakeNet>, method: string, path: string) => net.calls.filter((call) => call.method === method && new URL(call.url).pathname.endsWith(path));

describe("connecting accounts", () => {
  it("signs the state so a callback can only attach an account to whoever asked, and only for 15 minutes", () => {
    const config = integrations(fakeNet());
    const now = new Date("2026-11-13T12:00:00Z");
    const state = makeState(config, "user-1", "google", now);
    expect(readState(config, state, now)).toEqual({ userId: "user-1", provider: "google" });
    expect(readState(config, state, new Date(now.getTime() + 16 * 60_000))).toBeNull();
    const [payload, signature] = state.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, "base64url").toString()), u: "user-2" })).toString("base64url");
    expect(readState(config, `${forged}.${signature}`, now)).toBeNull();
    expect(readState({ ...config, masterKey: Buffer.alloc(32, 1) }, state, now)).toBeNull();

    const url = new URL(connectUrl(config, "google", "user-1", now));
    expect(url.searchParams.get("redirect_uri")).toBe("https://emi.example.com/oauth/google");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("scope")).toContain("calendar.events");
  });

  it("keeps tokens encrypted, refreshes them when they expire, and forgets a revoked connection", async () => {
    const w = await world();
    let revoked = false;
    const net = fakeNet({ "POST oauth2.googleapis.com/token": (call) => call.body.includes("refresh_token=")
      ? (revoked ? [400, { error: "invalid_grant" }] : [200, { access_token: "google-access-2", expires_in: 3600 }])
      : [200, { access_token: "google-access-1", refresh_token: "google-refresh-secret", expires_in: 3600 }] });
    const person = await connected(w, net);
    const stored = JSON.stringify((await w.db.query("select * from connections")).rows);
    expect(stored).not.toContain("google-refresh-secret");
    expect(stored).not.toContain("google-access-1");
    expect(await accessToken(w.db, w.deps.integrations!, person.id, "google", w.now)).toBe("google-access-1");
    w.advance(2 * HOUR);
    expect(await accessToken(w.db, w.deps.integrations!, person.id, "google", w.now)).toBe("google-access-2");
    w.advance(2 * HOUR);
    revoked = true;
    await expect(accessToken(w.db, w.deps.integrations!, person.id, "google", w.now)).rejects.toMatchObject({ lost: true });
    expect((await w.db.query("select * from connections")).rows).toHaveLength(0);
  });

  it("finishes sign-in at the callback page, tells the chat, and refuses a forged link", async () => {
    const w = await world();
    const net = fakeNet();
    w.deps.integrations = integrations(net);
    const person = await w.newUser();
    const announced: string[] = [];
    const server = startHttp({ port: 0, db: w.db, integrations: w.deps.integrations, clock: w.deps.clock, onConnected: async (userId, provider) => { announced.push(`${userId}:${provider}`); } });
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const state = makeState(w.deps.integrations, person.id, "google", w.now);
      const good = await fetch(`${base}/oauth/google?code=abc&state=${encodeURIComponent(state)}`);
      expect(good.status).toBe(200);
      expect(await good.text()).toContain("Connected");
      expect(announced).toEqual([`${person.id}:google`]);
      expect((await w.db.query("select user_id from connections")).rows).toEqual([{ user_id: person.id }]);
      expect((await fetch(`${base}/oauth/google?code=abc&state=forged.state`)).status).toBe(400);
      expect((await fetch(`${base}/oauth/spotify?code=abc&state=${encodeURIComponent(state)}`)).status).toBe(400); // state was for google
      expect(await (await fetch(`${base}/health`)).text()).toBe("ok");
    } finally {
      server.close();
    }
  });
});

describe("what she sees", () => {
  it("shows their week and to-dos with short ids, and says plainly when something isn't connected", async () => {
    const w = await world();
    const net = fakeNet();
    const person = await connected(w, net);
    const view = await integrationView(w.deps, (await getUser(w.db, person.id))!, w.now);
    expect(view.lines.join("\n")).toContain("- e1: Mon 16 Nov 10:30–11:00 Dentist");
    expect(view.lines.join("\n")).toContain("- e2: 2026-11-18 (all day) Anna's birthday");
    expect(view.lines.join("\n")).toContain("- t1: Buy milk");
    expect(view.lines.join("\n")).toContain("Spotify isn't connected");
    expect(view.labels.get("e1")).toMatchObject({ kind: "event", id: "real-event-1" });
  });
});

describe("what she does", () => {
  it("reads actions only from well-formed tags, and never shows them", () => {
    const { text, actions } = extractActions('done\n<<do:{"type":"task.add","title":"Call mom"}>>\n<<do:{"type":"task.add"}>>\n<<do:not json>>');
    expect(text.trim()).toBe("done");
    expect(actions).toEqual([{ type: "task.add", title: "Call mom" }]);
  });

  it("adds right away, holds a removal for their OK, and ignores ids it never showed her", async () => {
    const w = await world();
    const net = fakeNet();
    const person = await connected(w, net);
    w.script = () => [
      "on it",
      '<<do:{"type":"task.add","title":"Call mom","due":"2026-11-14"}>>',
      '<<do:{"type":"event.remove","id":"e1"}>>',
      '<<do:{"type":"task.done","id":"t9"}>>',
    ].join("\n");
    const result = await handleTurn(w.deps, person.id, "remind me to call mom tomorrow and cancel the dentist");
    expect(lastNotes(w)).toContain("- e1: Mon 16 Nov 10:30–11:00 Dentist");
    expect(lastNotes(w)).toContain("Moving or removing anything waits for their OK");
    expect(result.bubbles).toEqual(["on it"]);
    expect(result.actions?.done).toEqual(['📝 added to-do "Call mom" (due 2026-11-14)']);
    expect(result.actions?.held.map((item) => item.summary)).toEqual(['📅 remove "Dentist"']);
    expect(JSON.parse(sentTo(net, "POST", "/tasks")[0]!.body)).toEqual({ title: "Call mom", due: "2026-11-14T00:00:00.000Z" });
    expect(net.calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
    const stored = (await recentMessages(w.db, person.id, 1))[0]!.content;
    expect(stored).toContain('[did: 📝 added to-do "Call mom" (due 2026-11-14)]');
    expect(stored).toContain('[waiting for their OK: 📅 remove "Dentist"]');

    // Their tap runs it once; a second tap finds nothing.
    const held = result.actions!.held[0]!;
    const claimed = await claimHeld(w.db, person.id, held.id, "done", w.now);
    expect(claimed?.resolved.target).toMatchObject({ id: "real-event-1" });
    expect(await claimHeld(w.db, person.id, held.id, "done", w.now)).toBeNull();
  });

  it("asks before everything at 'ask', and does everything at 'auto'", async () => {
    const w = await world();
    const net = fakeNet();
    const person = await connected(w, net);
    w.script = () => '<<do:{"type":"event.add","title":"Gym","start":"2026-11-14T18:00"}>>\n<<do:{"type":"event.remove","id":"e2"}>>';
    await updateUser(w.db, person.id, { autonomy: "ask" });
    expect((await handleTurn(w.deps, person.id, "gym tomorrow at 6, and drop anna's thing")).actions?.held).toHaveLength(2);
    await updateUser(w.db, person.id, { autonomy: "auto" });
    forgetView(person.id);
    const auto = await handleTurn(w.deps, person.id, "again");
    expect(auto.actions?.done).toEqual(['📅 added "Gym", Sat 14 Nov 18:00', '📅 removed "Anna\'s birthday"']);
    const event = JSON.parse(sentTo(net, "POST", "/events")[0]!.body);
    expect(event).toEqual({ summary: "Gym", start: { dateTime: "2026-11-14T18:00:00", timeZone: "Europe/Berlin" }, end: { dateTime: "2026-11-14T19:00:00", timeZone: "Europe/Berlin" } });
    expect(event.attendees).toBeUndefined(); // nothing she does can invite anyone
  });

  it("makes a private Spotify playlist from song names, leaving out what it can't find", async () => {
    const w = await world();
    const net = fakeNet();
    const person = await connected(w, net, ["spotify"]);
    const playlist = await makePlaylist(w.db, w.deps.integrations!, person.id, w.now, "songs about being ignored", ["Adele - Hello", "nobody - nothing", "Phil Collins - In the Air Tonight"]);
    expect(playlist).toEqual({ url: "https://open.spotify.com/playlist/pl1", found: 2, missing: ["nobody - nothing"] });
    expect(JSON.parse(sentTo(net, "POST", "/playlists")[0]!.body)).toMatchObject({ public: false });
  });
});

describe("gestures", () => {
  async function annoyed(patch: Record<string, unknown> = {}) {
    const w = await world();
    const net = fakeNet();
    const person = await connected(w, net);
    await updateUser(w.db, person.id, { bond: { irritation: 0.4, irritationAt: w.now.toISOString() }, ...patch });
    w.script = () => 'fine.\n<<do:{"type":"task.add","title":"apologise to emi","gesture":true}>>\n<<do:{"type":"event.remove","id":"e1","gesture":true}>>';
    return { w, net, person };
  }

  it("lets her add one small unasked thing when she's in a mood, never remove, and takes it back when she makes up", async () => {
    const { w, net, person } = await annoyed();
    const result = await handleTurn(w.deps, person.id, "whatever");
    expect(lastNotes(w)).toContain("You may do one small unasked thing");
    expect(result.actions?.done).toEqual(['📝 added to-do "apologise to emi"']);
    expect(result.actions?.held).toEqual([]); // the unasked removal was refused, not even offered
    expect(net.calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
    expect((await activeMischief(w.db, person.id)).map((act) => act.kind)).toEqual(["task"]);

    w.script = () => "took it off your list. you're forgiven";
    w.advance(7 * HOUR);
    expect(await sweepMakeups(w.deps, w.outbound)).toBe(1);
    expect(sentTo(net, "DELETE", "/tasks/new-task-1")).toHaveLength(1);
    expect(lastNotes(w)).toContain('put the to-do "apologise to emi" on their list');
  });

  it("allows none with mischief off or at autonomy 'ask'", async () => {
    for (const patch of [{ mischief: false }, { autonomy: "ask" }]) {
      const { w, net, person } = await annoyed(patch);
      const result = await handleTurn(w.deps, person.id, "whatever");
      expect(lastNotes(w)).not.toContain("unasked thing");
      expect(result.actions).toBeUndefined();
      expect(sentTo(net, "POST", "/tasks")).toHaveLength(0);
    }
  }, 20_000);
});

describe("the app's record", () => {
  it("never shows them a copy of it written by her", async () => {
    const { parseReply } = await import("../src/core/prompt");
    expect(parseReply('cancelling it, just needs your OK.\n[waiting for their OK: 🗑 remove "Standup"]\nbrave.', "social").bubbles.join(" "))
      .toBe("cancelling it, just needs your OK. brave.");
    expect(parseReply('[did: 📅 added "Gym"]\ndone', "social").bubbles).toEqual(["done"]);
  });
});
