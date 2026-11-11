import type { Carrier } from "@archival/carrier";

const LIMITS = { name: 200, email: 320, message: 5000 };
const MIN_FILL_MS = 2500;
const EMAIL_PATTERN = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

type Fields = Record<string, unknown>;

const field = (body: Fields, key: string) => (typeof body[key] === "string" ? (body[key] as string).trim() : "");

const carrier: Carrier = async (_params, body, objects, site) => {
  const siteURL = site.url || "";
  const settings = objects.site;
  const fields: Fields = body && typeof body === "object" && !Array.isArray(body) ? (body as Fields) : {};
  const fromScript = field(fields, "_js") === "1";

  const reply = (ok: boolean, message: string, status = ok ? 200 : 400): Response | string => {
    if (!fromScript) return `redirect:${siteURL}/contact.html#${ok ? "sent" : "unsent"}`;
    return new Response(JSON.stringify({ ok, message }), {
      status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  };

  if (!body) return reply(false, "Send the form to write a note.", 405);
  if (settings.show_contact === false) return reply(false, "The contact form is turned off.", 404);

  // Bots fill the hidden field or submit before a person could have typed anything.
  const started = Number(field(fields, "_t"));
  if (field(fields, "website") || (started && Date.now() - started < MIN_FILL_MS)) {
    return reply(true, "Thanks — your note is on its way.");
  }

  const name = field(fields, "name").slice(0, LIMITS.name);
  const email = field(fields, "email");
  const message = field(fields, "message");
  if (!EMAIL_PATTERN.test(email) || email.length > LIMITS.email) return reply(false, "That email address doesn't look right.");
  if (message.length < 2) return reply(false, "Write a message first.");
  if (message.length > LIMITS.message) return reply(false, `Keep it under ${LIMITS.message} characters.`);

  const to = settings.contact_email?.trim();
  if (!to) return reply(false, "The contact form isn't set up yet.", 503);

  const siteName = settings.name || new URL(siteURL || "https://localhost").hostname;
  const sender = name ? `${name} <${email}>` : email;
  try {
    await site.email.send({
      ...(settings.email_from ? { from: settings.email_from } : {}),
      to,
      replyTo: email,
      subject: `${siteName}: a note from ${name || email}`,
      text: `${message}\n\n— ${sender}\nSent from the contact form at ${siteURL}/contact.html`,
    });
  } catch {
    return reply(false, "That didn't go through. Try again in a bit.", 502);
  }
  return reply(true, "Thanks — your note is on its way.");
};

export default carrier;
