/**
 * Turn Slack user ids into names in prose.
 *
 * Mentions may be `<@U…>` or `<@U…|label>`. Bare ids (the form that lands in
 * event titles when an author wasn't resolved) are replaced only when we
 * know the name, so unrelated tokens stay put.
 */

export interface SlackProfile {
  name?: string;
  real_name?: string;
  profile?: { display_name?: string; real_name?: string } | null;
}

/** Prefer the person's real name, then their Slack display name, then the handle. */
export function slackProfileName(user: SlackProfile): string | null {
  const real = user.real_name?.trim() || user.profile?.real_name?.trim();
  const display = user.profile?.display_name?.trim();
  const handle = user.name?.trim();
  return real || display || handle || null;
}

export function lookupSlackName(names: Map<string, string>, id: string): string | undefined {
  return names.get(id) ?? names.get(id.toUpperCase());
}

/** `<@U…>` or `<@U…|label>`, id in group 1 and optional label in group 2. */
const mentionPattern = () => /<@([UW][A-Za-z0-9]+)(?:\|([^>]*))?>/gi;

/**
 * Bare Slack user ids. At least 9 characters, not part of a longer token or a
 * URL path (`/U…`), so permalinks stay intact.
 */
const barePattern = () => /(^|[^A-Za-z0-9/])([UW][A-Z0-9]{8,})(?![A-Za-z0-9])/gi;

export function collectSlackIds(text: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(mentionPattern())) ids.add(match[1]!);
  for (const match of text.matchAll(barePattern())) ids.add(match[2]!);
  return [...ids];
}

export function rewriteSlackIds(
  text: string,
  names: Map<string, string>,
  opts?: { atMentions?: boolean },
): string {
  const prefix = opts?.atMentions ? "@" : "";
  const withMentions = text.replace(mentionPattern(), (full, id: string, label?: string) => {
    const name = lookupSlackName(names, id);
    if (name) return `${prefix}${name}`;
    const trimmed = label?.trim();
    if (trimmed) return `${prefix}${trimmed}`;
    return full;
  });
  return withMentions.replace(barePattern(), (full, lead: string, id: string) => {
    const name = lookupSlackName(names, id);
    return name ? `${lead}${name}` : full;
  });
}
