import type { Message } from "grammy/types";
import type { IncomingMessage, ReplyContext } from "../core/types";

const KEY_COMMAND = /^\/key(?:@[a-z0-9_]+)?(?:\s|$)/i;

/** Never retain credentials from /key, including when someone replies to it. */
export function telegramInput(message: Message, botId: number): IncomingMessage {
  const text = message.text ?? message.caption ?? "";
  if (KEY_COMMAND.test(text)) return { text: "/key [redacted]" };
  const original = message.reply_to_message;
  if (!original && !message.quote && !message.external_reply) return { text };

  // External replies are not attributed to this person or Emi. Telegram may
  // supply only the selected quote, not the original message's body.
  const author: ReplyContext["author"] = original?.from?.id === botId ? "emi"
    : original?.from?.id === message.from?.id && original?.from ? "user" : "other";
  const body = original?.text ?? original?.caption;
  const sensitive = KEY_COMMAND.test(body ?? "") || KEY_COMMAND.test(message.quote?.text ?? "");
  return {
    text,
    replyTo: {
      author,
      text: sensitive ? "[credential message redacted]" : body?.slice(0, 4096),
      quote: sensitive ? undefined : message.quote?.text.slice(0, 4096),
    },
  };
}
