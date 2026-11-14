import { describe, expect, it } from "vitest";
import { exportAccount, wipeAccount } from "../src/core/account";
import { pendingItems, upsertAgendaItem } from "../src/core/agenda/store";
import { activeMemories, insertMemory } from "../src/core/memory/store";
import { timelineFor } from "../src/core/memory/timeline";
import { handleTurn } from "../src/core/pipeline";
import { getUser, recentMessages, updateUser } from "../src/core/users";
import { HOUR, world } from "./helpers";

async function populated() {
  const w = await world();
  const user = await w.newUser({ encryptedApiKey: "encrypted-key-material", initiative: "low" });
  await handleTurn(w.deps, user.id, "my sister is called Anna");
  await insertMemory(w.db, { userId: user.id, kind: "relationship", content: "Has a sister called Anna", at: w.now });
  await upsertAgendaItem(w.db, { userId: user.id, kind: "followup", about: "job interview", importance: 2, windowStart: w.now, windowEnd: new Date(w.now.getTime() + HOUR), pingAt: null, at: w.now });
  await w.db.query(
    "insert into arcs (user_id, start_message_id, end_message_id, started_at, ended_at, headline, summary, created_at) values ($1, 1, 2, $2, $2, 'They met.', 'They introduced themselves.', $2)",
    [user.id, w.now],
  );
  return { w, user };
}

describe("export", () => {
  it("contains everything held about the person and never the API key", async () => {
    const { w, user } = await populated();
    const data = await exportAccount(w.db, user.id, w.now);
    expect(data.messages).toHaveLength(2);
    expect(data.memories).toHaveLength(1);
    expect(data.agenda).toHaveLength(1);
    expect(data.timeline.arcs).toHaveLength(1);
    expect(data.settings).toMatchObject({ timezone: "Europe/Berlin", initiative: "low" });
    const text = JSON.stringify(data);
    expect(text).toContain("my sister is called Anna");
    expect(text).not.toContain("encrypted-key-material");
    expect(text).not.toContain("api_key");
  });
});

describe("wipe", () => {
  it("erases the conversation and everything learned, and keeps settings and the key", async () => {
    const { w, user } = await populated();
    const other = await w.newUser();
    await handleTurn(w.deps, other.id, "hello from someone else");
    await updateUser(w.db, user.id, { mood: { label: "cheerful" } });

    await wipeAccount(w.db, user.id);

    expect(await recentMessages(w.db, user.id, 10)).toHaveLength(0);
    expect(await activeMemories(w.db, user.id)).toHaveLength(0);
    expect(await pendingItems(w.db, user.id)).toHaveLength(0);
    const after = (await getUser(w.db, user.id))!;
    expect(await timelineFor(w.db, after)).toBe("");
    expect(after).toMatchObject({ encryptedApiKey: "encrypted-key-material", initiative: "low", timezone: "Europe/Berlin", mood: {}, extractedThrough: 0, lastUserMessageAt: null });
    // No trace is left in any row, including erased memories' text.
    const leftovers = await w.db.query<{ n: string }>("select count(*) as n from memories where user_id = $1", [user.id]);
    expect(Number(leftovers.rows[0]!.n)).toBe(0);
    // Nobody else is touched.
    expect(await recentMessages(w.db, other.id, 10)).toHaveLength(2);

    // She starts from nothing, as with a new person.
    w.calls.length = 0;
    await handleTurn(w.deps, user.id, "hi");
    const prompt = w.calls[0]!.messages.map((m) => m.content).join("\n");
    expect(prompt).not.toContain("Anna");
    expect(prompt).toContain("This is the first time they've written to you.");
  });
});
