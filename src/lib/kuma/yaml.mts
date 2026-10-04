// A small YAML writer for the configuration import-kuma prints. It writes
// block style with comments, which is all a configuration needs, and
// quotes whatever could be read back as anything but the same string.
//
// The loader replaces ${NAME} with an environment variable everywhere in
// the file before it parses it, comments included. So a literal "${" is
// written as "\x24{" inside double quotes, and as "$ {" in a comment.

/** An environment variable reference, written as `${NAME}` after `prefix`. */
export interface EnvRef {
  env: string;
  prefix?: string;
  /** Wrap it in double quotes, for a value that is not safe bare. */
  quote?: boolean;
}

export interface YamlMap {
  pairs: Pair[];
  /** Comment lines above this map when it is an item of a list. */
  before?: string[];
  /** An empty line above it, when it is an item of a list. */
  blank?: boolean;
}

export interface Pair {
  key: string;
  value: YamlValue;
  /** Comment lines above the key. */
  before?: string[];
  /** An empty line above the key. */
  blank?: boolean;
  /** A comment at the end of the line, after a single value. */
  comment?: string;
}

export type YamlValue =
  string | number | boolean | EnvRef | YamlMap | YamlValue[];

function isMap(value: YamlValue): value is YamlMap {
  return typeof value === "object" && !Array.isArray(value) && "pairs" in value;
}

const RESERVED = /^(?:true|false|yes|no|on|off|y|n|null|~)$/i;
const NUMERIC = [
  /^[-+]?(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:e[-+]?\d+)?$/i,
  /^0x[0-9a-f_]+$/i,
  /^0o[0-7_]+$/i,
  /^[-+]?\.inf$/i,
  /^\.nan$/i,
];

/** Whether a string reads back as the same string when written bare. */
export function isPlainSafe(text: string): boolean {
  if (text === "" || text !== text.trim()) return false;
  if (RESERVED.test(text) || NUMERIC.some((re) => re.test(text))) return false;
  if (!/^[A-Za-z0-9_./(]/.test(text)) return false;
  if (/[^A-Za-z0-9 _./()+@=&?%~,;:!*'-]/.test(text)) return false;
  return !/:(\s|$)/.test(text) && !/\s#/.test(text);
}

/** A string as a YAML scalar: bare when that is safe, double-quoted if not. */
export function yamlString(text: string): string {
  if (isPlainSafe(text)) return text;
  return JSON.stringify(text).replace(/\$\{/g, "\\x24{");
}

function scalar(value: string | number | boolean | EnvRef): string {
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (typeof value === "string") return yamlString(value);
  const text = `${value.prefix ?? ""}\${${value.env}}`;
  return value.quote ? `"${text}"` : text;
}

/** Comment text made safe: one line each, and no "${" for the loader. */
function commentText(text: string): string {
  return text.replace(/\r/g, "").replace(/\$\{/g, "$ {");
}

function commentLines(text: string, indent: number): string[] {
  const pad = " ".repeat(indent);
  return commentText(text)
    .split("\n")
    .map((line) => (line === "" ? `${pad}#` : `${pad}# ${line}`));
}

function inline(comment: string | undefined): string {
  return comment ? `  # ${commentText(comment).replace(/\n/g, " ")}` : "";
}

function valueLines(
  head: string,
  value: YamlValue,
  indent: number,
  comment?: string,
): string[] {
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${head} []${inline(comment)}`];
    return [`${head}${inline(comment)}`, ...seqLines(value, indent + 2)];
  }
  if (isMap(value)) {
    if (value.pairs.length === 0) return [`${head} {}${inline(comment)}`];
    return [`${head}${inline(comment)}`, ...mapLines(value, indent + 2)];
  }
  return [`${head} ${scalar(value)}${inline(comment)}`];
}

function mapLines(map: YamlMap, indent: number): string[] {
  const lines: string[] = [];
  for (const pair of map.pairs) {
    if (pair.blank) lines.push("");
    for (const text of pair.before ?? [])
      lines.push(...commentLines(text, indent));
    const head = `${" ".repeat(indent)}${yamlString(pair.key)}:`;
    lines.push(...valueLines(head, pair.value, indent, pair.comment));
  }
  return lines;
}

function seqLines(items: YamlValue[], indent: number): string[] {
  const pad = " ".repeat(indent);
  const lines: string[] = [];
  for (const item of items) {
    if (Array.isArray(item)) throw new Error("a list in a list is not written");
    if (isMap(item) && item.pairs.length > 0) {
      const [first, ...rest] = item.pairs;
      if (item.blank) lines.push("");
      for (const text of [...(item.before ?? []), ...(first.before ?? [])])
        lines.push(...commentLines(text, indent));
      const body = mapLines(
        { pairs: [{ ...first, before: undefined }, ...rest] },
        indent + 2,
      );
      body[0] = `${pad}- ${body[0].slice(indent + 2)}`;
      lines.push(...body);
    } else {
      lines.push(...valueLines(`${pad}-`, item, indent));
    }
  }
  return lines;
}

/** The whole document: comment lines, the map, and comment lines after it. */
export function renderYaml(
  doc: YamlMap,
  header: string[] = [],
  footer: string[] = [],
): string {
  const lines = [
    ...header.flatMap((text) => commentLines(text, 0)),
    ...(header.length > 0 ? [""] : []),
    ...mapLines(doc, 0),
    ...(footer.length > 0 ? [""] : []),
    ...footer.flatMap((text) => commentLines(text, 0)),
  ];
  return `${lines.join("\n")}\n`;
}
