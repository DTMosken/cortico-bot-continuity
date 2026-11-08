export type QqSpeech = { source: 'qq' | 'qqbot' | 'astrbot'; mode: 'draft' | 'confirm' | 'send' | 'alreadySent' };
export const QQ_SPEECH: Record<string, Record<string, QqSpeech>> = {
  qq: { qq_draft: { source: 'qq', mode: 'draft' }, qq_confirm: { source: 'qq', mode: 'confirm' } },
  'qq-continuity': { qq_send: { source: 'qq', mode: 'send' } },
  qqbot: { qq_send: { source: 'qqbot', mode: 'send' }, qq_confirm_send: { source: 'qqbot', mode: 'alreadySent' } },
  astrbot: { astrbot_send_message: { source: 'astrbot', mode: 'send' } },
};

export function sentReceipt(source: QqSpeech['source'], output: string): boolean {
  switch (source) {
    case 'qq': return /^\[sent(?: #[^ ]+)? → /u.test(output);
    case 'qqbot': return output.startsWith('已发送（编号 ') || output.startsWith('{"sent":true,');
    case 'astrbot': return /^已(?:发到|把图片发到|用语音发到|把语音和图片发到)/u.test(output);
  }
}
