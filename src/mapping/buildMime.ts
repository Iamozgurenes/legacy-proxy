// Build an RFC 5322 / MIME message from a JMAP Email/set create payload.
// Used by Email/set create (drafts) which APPENDs the result via IMAP.
//
// We use nodemailer's MimeNode (already a transitive dep) to handle
// quoted-printable encoding, header folding, and message id generation.

import MimeNode from "nodemailer/lib/mime-node/index.js";

interface JmapAddress {
  name?: string | null;
  email?: string;
}

interface BodyPartRef {
  partId?: string;
}

interface BodyValue {
  value?: string;
}

// JMAP `bodyStructure` (RFC 8621 §4.1.4): a recursive tree describing the
// MIME hierarchy. Leaves carry either a partId (resolved through bodyValues)
// or a blobId (references a previously-uploaded blob).
export interface BodyStructurePart {
  type?: string;
  partId?: string;
  blobId?: string;
  name?: string | null;
  disposition?: string | null;
  cid?: string | null;
  charset?: string | null;
  subParts?: BodyStructurePart[];
}

// RFC 8621 §4.1.4 form 2: a convenience alternative to `bodyStructure`.
// Clients that don't want to hand-build the MIME tree send textBody/htmlBody
// plus a flat `attachments` list instead, and the server assembles the
// multipart/mixed (+ multipart/related for inline parts) wrapper itself.
export interface AttachmentRef {
  blobId?: string;
  type?: string | null;
  name?: string | null;
  disposition?: string | null;
  cid?: string | null;
}

export interface JmapEmailCreate {
  bodyStructure?: BodyStructurePart | null;
  attachments?: AttachmentRef[] | null;
  from?: JmapAddress[] | null;
  sender?: JmapAddress[] | null;
  to?: JmapAddress[] | null;
  cc?: JmapAddress[] | null;
  bcc?: JmapAddress[] | null;
  replyTo?: JmapAddress[] | null;
  subject?: string | null;
  inReplyTo?: string[] | null;
  references?: string[] | null;
  messageId?: string[] | null;
  sentAt?: string | null;
  textBody?: BodyPartRef[] | null;
  htmlBody?: BodyPartRef[] | null;
  bodyValues?: Record<string, BodyValue> | null;
  // Headers passed through verbatim (asRaw form). We don't attempt to
  // re-parse these; clients that send us structured forms should map them
  // before submission.
  headers?: { name: string; value: string }[] | null;
}

function jmapAddrToHeader(list: JmapAddress[] | null | undefined): string | null {
  if (!list || list.length === 0) return null;
  return list
    .filter((a) => a.email)
    .map((a) => {
      const name = a.name?.trim();
      const email = a.email!;
      if (!name) return email;
      // Quote names that contain RFC 5322 specials
      const escaped = /[",;:<>@()\[\]\\]/.test(name) ? `"${name.replace(/(["\\])/g, "\\$1")}"` : name;
      return `${escaped} <${email}>`;
    })
    .join(", ");
}

// Walk a bodyStructure tree into a nodemailer MimeNode. Multipart parts
// (type starting with "multipart/") get child nodes; leaves are filled from
// either bodyValues[partId] (text/* parts) or getBlob(blobId) (attachments).
function nodeFromBodyStructure(
  part: BodyStructurePart,
  bodyValues: Record<string, BodyValue> | null,
  getBlob: BlobLookup,
  hostname: string,
): MimeNode {
  const type = part.type ?? "text/plain";
  if (type.toLowerCase().startsWith("multipart/")) {
    const node = new MimeNode(type, { hostname });
    for (const child of part.subParts ?? []) {
      node.appendChild(nodeFromBodyStructure(child, bodyValues, getBlob, hostname));
    }
    return node;
  }
  // Leaf part: either text content via bodyValues, or a blob attachment.
  const headers: Record<string, string> = {};
  if (part.disposition || part.name) {
    const disp = part.disposition ?? "inline";
    const filename = part.name ? `; filename="${part.name.replace(/"/g, "")}"` : "";
    headers["Content-Disposition"] = `${disp}${filename}`;
  }
  if (part.cid) headers["Content-ID"] = `<${part.cid}>`;
  let contentType = type;
  if (type.toLowerCase().startsWith("text/")) {
    contentType = `${type}; charset=${part.charset ?? "utf-8"}`;
  }
  const node = new MimeNode(contentType, { hostname });
  for (const [k, v] of Object.entries(headers)) node.setHeader(k, v);

  if (part.partId && bodyValues?.[part.partId]?.value !== undefined) {
    node.setContent(bodyValues[part.partId]!.value!);
  } else if (part.blobId) {
    const blob = getBlob(part.blobId);
    if (blob) node.setContent(blob.body);
  }
  return node;
}

function resolveBody(
  refs: BodyPartRef[] | null | undefined,
  values: Record<string, BodyValue> | null | undefined,
): string | null {
  if (!refs || refs.length === 0 || !values) return null;
  const chunks: string[] = [];
  for (const r of refs) {
    if (!r.partId) continue;
    const v = values[r.partId]?.value;
    if (typeof v === "string") chunks.push(v);
  }
  if (chunks.length === 0) return null;
  return chunks.join("\r\n");
}

export interface BlobLookup {
  // Returns the bytes for a previously-uploaded blobId, or null if missing.
  // The lookup is synchronous for buildRfc822's MimeNode walk; loading from
  // SQLite is cheap so a sync API is enough.
  (blobId: string): { body: Buffer; ctype: string } | null;
}

// Build a single attachment leaf (form 2's `attachments` entries mirror
// bodyStructure leaves closely enough to share the header/content logic,
// but they carry their own type/name/disposition/cid fields directly rather
// than a BodyStructurePart tree).
function nodeFromAttachment(att: AttachmentRef, getBlob: BlobLookup, hostname: string): MimeNode | null {
  if (!att.blobId) return null;
  const blob = getBlob(att.blobId);
  if (!blob) return null;
  const contentType = att.type || blob.ctype || "application/octet-stream";
  const node = new MimeNode(contentType, { hostname });
  const disp = att.disposition ?? "attachment";
  const filename = att.name ? `; filename="${att.name.replace(/"/g, "")}"` : "";
  node.setHeader("Content-Disposition", `${disp}${filename}`);
  if (att.cid) node.setHeader("Content-ID", `<${att.cid}>`);
  node.setContent(blob.body);
  return node;
}

export async function buildRfc822(
  create: JmapEmailCreate,
  hostname: string,
  getBlob: BlobLookup = () => null,
): Promise<Buffer> {
  // Choose a root structure based on the inputs we got. Prefer `bodyStructure`
  // (RFC 8621 §4.5.1 form 1) when present — it's the canonical source of
  // truth and drives multipart/alternative + attachments. Otherwise fall back
  // to the simpler textBody/htmlBody form.
  let root: MimeNode;
  if (create.bodyStructure) {
    root = nodeFromBodyStructure(create.bodyStructure, create.bodyValues ?? null, getBlob, hostname);
  } else {
    const text = resolveBody(create.textBody, create.bodyValues);
    const html = resolveBody(create.htmlBody, create.bodyValues);
    let bodyNode: MimeNode;
    if (text && html) {
      bodyNode = new MimeNode("multipart/alternative", { hostname });
      bodyNode.createChild("text/plain; charset=utf-8").setContent(text);
      bodyNode.createChild("text/html; charset=utf-8").setContent(html);
    } else if (html) {
      bodyNode = new MimeNode("text/html; charset=utf-8", { hostname });
      bodyNode.setContent(html);
    } else {
      bodyNode = new MimeNode("text/plain; charset=utf-8", { hostname });
      bodyNode.setContent(text ?? "");
    }

    // Form 2 (RFC 8621 §4.1.4): assemble the multipart/related (inline
    // parts referenced by cid) and multipart/mixed (regular attachments)
    // wrappers around the text/html body ourselves — clients using this
    // form never build a bodyStructure tree at all.
    const attachmentNodes = (create.attachments ?? [])
      .map((att) => ({ att, node: nodeFromAttachment(att, getBlob, hostname) }))
      .filter((x): x is { att: AttachmentRef; node: MimeNode } => x.node !== null);
    const inline = attachmentNodes.filter((x) => x.att.disposition === "inline");
    const regular = attachmentNodes.filter((x) => x.att.disposition !== "inline");

    let contentNode = bodyNode;
    if (inline.length > 0) {
      contentNode = new MimeNode("multipart/related", { hostname });
      contentNode.appendChild(bodyNode);
      for (const { node } of inline) contentNode.appendChild(node);
    }

    if (regular.length > 0) {
      root = new MimeNode("multipart/mixed", { hostname });
      root.appendChild(contentNode);
      for (const { node } of regular) root.appendChild(node);
    } else {
      root = contentNode;
    }
  }

  const setIfPresent = (header: string, value: string | null): void => {
    if (value) root.setHeader(header, value);
  };
  setIfPresent("From", jmapAddrToHeader(create.from));
  setIfPresent("Sender", jmapAddrToHeader(create.sender));
  setIfPresent("To", jmapAddrToHeader(create.to));
  setIfPresent("Cc", jmapAddrToHeader(create.cc));
  setIfPresent("Bcc", jmapAddrToHeader(create.bcc));
  setIfPresent("Reply-To", jmapAddrToHeader(create.replyTo));
  if (create.subject) root.setHeader("Subject", create.subject);

  const date = create.sentAt ? new Date(create.sentAt) : new Date();
  root.setHeader("Date", date.toUTCString().replace(/GMT/, "+0000"));

  if (create.messageId && create.messageId[0]) {
    root.setHeader("Message-ID", `<${create.messageId[0]}>`);
  }
  if (create.inReplyTo && create.inReplyTo.length) {
    root.setHeader("In-Reply-To", create.inReplyTo.map((id) => `<${id}>`).join(" "));
  }
  if (create.references && create.references.length) {
    root.setHeader("References", create.references.map((id) => `<${id}>`).join(" "));
  }

  // Verbatim headers (e.g. List-* additions). Skip headers we already set
  // so the explicit JMAP fields win.
  const reserved = new Set([
    "from",
    "sender",
    "to",
    "cc",
    "bcc",
    "reply-to",
    "subject",
    "date",
    "message-id",
    "in-reply-to",
    "references",
    "mime-version",
    "content-type",
    "content-transfer-encoding",
  ]);
  for (const h of create.headers ?? []) {
    if (!h?.name) continue;
    if (reserved.has(h.name.toLowerCase())) continue;
    root.setHeader(h.name, h.value ?? "");
  }

  return await new Promise<Buffer>((resolve, reject) => {
    root.build((err: Error | null, message: Buffer) => {
      if (err) reject(err);
      else resolve(message);
    });
  });
}
