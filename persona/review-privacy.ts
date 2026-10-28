/** Remote review keeps object identity within one request without exporting its identifiers. */
const SECRET_NAMES = 'api[_-]?key|password|secret|cookie|authorization|token|access[_-]?token|refresh[_-]?token';
const secretKey = new RegExp(`^(?:${SECRET_NAMES})$`, 'iu');
const secretText = new RegExp(String.raw`\b(Bearer\s+|(?:${SECRET_NAMES})["']?\s*[:=]\s*["']?(?:(?:Basic|Bearer|Digest)\s+)?)[^\s,;"'<>]+`, 'giu');

export function reviewPrivacy() {
  const aliases = new Map<string, string>();
  const identities = new Map<string, string>();
  let incomplete = false;
  const alias = (value: string, kind: string): string => {
    if (!aliases.has(value)) aliases.set(value, `[${kind}${aliases.size + 1}]`);
    return aliases.get(value)!;
  };
  const text = (value: string): string => {
    const patterns = [...identities.keys()].sort((a, b) => b.length - a.length)
      .map(identity => identity.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'));
    const result = patterns.length ? value.replace(new RegExp(`(?<![A-Za-z0-9_])(?:${patterns.join('|')})(?![A-Za-z0-9_])`, 'gu'), identity => identities.get(identity)!) : value;
    return result
      .replace(/(?:[A-Za-z]:[\\/]|\/(?:home|Users)\/)[^\s"<>]+/gu, value => alias(value, 'path'))
      .replace(secretText, (_, prefix: string) => { incomplete = true; return prefix + '[secret]'; })
      .replace(/https?:\/\/\S+/giu, value => alias(value, 'url'))
      .replace(/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/giu, value => alias(value, 'email'))
      .replace(/\d{4,}/gu, (value, offset: number, source: string) => {
        if (/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])(?:\D|$)/u.test(source.slice(offset))) return value;
        if (/^\s*(?:characters?\b|chars?\b|lines?\b|tokens?\b|bytes?\b|字符|字节|行|字)/iu.test(source.slice(offset + value.length))) return value;
        return alias(value, 'number');
      });
  };
  const identityKey = /^(?:speaker|senderKey|messageId|scene|to|reply_to|targetId|userId|groupId)$/u;
  const pathField = (key: string, item: unknown): item is string => typeof item === 'string'
    && (key === 'path' || (key === 'from' || key === 'to') && /[\\/]/u.test(item));
  const collectPath = (path: string): void => {
    const match = /(?:^|[\\/])people[\\/](.+)$/u.exec(path);
    if (!match) return;
    for (const segment of match[1].split(/[\\/]/u)) {
      const name = segment.replace(/\.md$/u, '');
      if (name && !['active', 'archived'].includes(name)) identities.set(name, alias(name, 'person'));
    }
  };
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(collect); return; }
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (identityKey.test(key) && !pathField(key, item) && (typeof item === 'string' || typeof item === 'number') && String(item)) {
        identityFields.push({ key, value: String(item) });
      }
      if (pathField(key, item)) collectPath(item);
      collectPath(key);
      collect(item);
    }
  };
  const identityFields: Array<{ key: string; value: string }> = [];
  const clean = (value: unknown): unknown => {
    if (typeof value === 'string') return text(value);
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (secretKey.test(key)) { incomplete = true; return [key, '[secret]']; }
      if (identityKey.test(key) && (typeof item === 'string' || typeof item === 'number') && identities.has(String(item))) return [key, identities.get(String(item))];
      return [text(key), clean(item)];
    }));
    return value;
  };
  return {
    prepare(value: unknown): void {
      collect(value);
      const input = value as { action?: { tool?: string } };
      const source = input.action?.tool?.split('_')[0];
      const scenes = new Set(identityFields.filter(field => field.key === 'scene').map(field => field.value));
      for (const field of identityFields) {
        const canonical = field.key === 'reply_to' || field.key === 'messageId' ? 'message:' + field.value.replace(/^#/u, '')
          : field.key === 'to' && source && scenes.has(`${source}:${field.value}`) ? `${source}:${field.value}` : field.value;
        identities.set(field.value, alias(canonical, 'identity'));
      }
    },
    clean,
    get incomplete(): boolean { return incomplete; },
  };
}
