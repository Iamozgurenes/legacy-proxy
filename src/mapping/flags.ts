const SYSTEM: ReadonlyArray<[string, string]> = [
  ["$seen", "\\Seen"],
  ["$flagged", "\\Flagged"],
  ["$answered", "\\Answered"],
  ["$draft", "\\Draft"],
  ["$forwarded", "$Forwarded"],
  ["$junk", "$Junk"],
  ["$notjunk", "$NotJunk"],
  ["$phishing", "$Phishing"],
  ["$mdnsent", "$MDNSent"],
];

const KW_TO_FLAG = new Map<string, string>(SYSTEM);
const FLAG_TO_KW = new Map<string, string>(SYSTEM.map(([k, f]) => [f.toLowerCase(), k]));

// RFC 8621 §4.1.1: a keyword is 1-255 chars from the ASCII range %x21-%x7e,
// excluding `( ) { ] % * " \`. Clients rely on the full range -- the
// webmail's own tag feature, for one, keys nested tags like "$label:work/clients"
// on the `:` and `/` this used to reject as "unsafe".
const EXCLUDED_FLAG_CHARS = new Set(["(", ")", "{", "]", "%", "*", "\"", "\\"]);

function isSafeFlag(kw: string): boolean {
  if (kw.length < 1 || kw.length > 255) return false;
  for (const ch of kw) {
    const code = ch.codePointAt(0)!;
    if (code < 0x21 || code > 0x7e || EXCLUDED_FLAG_CHARS.has(ch)) return false;
  }
  return true;
}

export function keywordToFlag(kw: string): string {
  const sys = KW_TO_FLAG.get(kw);
  if (sys) return sys;
  if (!isSafeFlag(kw)) throw new Error(`unsafe keyword: ${kw}`);
  return kw;
}

export function flagToKeyword(flag: string): string | null {
  const sys = FLAG_TO_KW.get(flag.toLowerCase());
  if (sys) return sys;
  if (flag.startsWith("\\")) return null;
  return flag.toLowerCase();
}

export function flagsToKeywords(flags: ReadonlyArray<string>): Record<string, true> {
  const out: Record<string, true> = {};
  for (const f of flags) {
    const k = flagToKeyword(f);
    if (k) out[k] = true;
  }
  return out;
}

export function keywordsToFlags(kws: Record<string, true>): string[] {
  return Object.keys(kws).map(keywordToFlag);
}
