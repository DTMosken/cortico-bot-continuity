import argparse
import contextlib
import json
import sys


def write(message):
    sys.__stdout__.write(json.dumps(message, ensure_ascii=False, separators=(',', ':')) + '\n')
    sys.__stdout__.flush()


def load_agent():
    with contextlib.redirect_stdout(sys.stderr):
        import laya
        return laya.load('convaiinnovations/laya', subfolder='multilingual')


def verify(agent):
    result = agent.predict(
        {'message': '这是多语言 Laya 安装验证。'},
        {'available': {'type': 'noul', 'instructions': 'Is this message non-empty?'}},
    )
    answer = result.get('answers', {}).get('available', {}).get('noul')
    if not isinstance(answer, (int, float)):
        raise RuntimeError('multilingual Laya did not return a noul answer')
    write({'type': 'verified', 'available': answer})


def review_fits(agent, state, questions):
    review = [q for q in questions.values()
              if q['type'] == 'choice' and isinstance(q.get('criteria'), list)
              and 'insufficient' in q['criteria']]
    if not review:
        return True
    tok = agent.tok
    def count(text):
        return len(tok(text.replace(tok.mask_token, ' '), add_special_tokens=False)['input_ids'])
    state_text = state if isinstance(state, str) else json.dumps(state, ensure_ascii=False)
    state_size = count(state_text)
    for question in review:
        options = [count(' ' + option) for option in question['criteria']]
        head = count('choice question: ' + question['instructions'])
        used = head + sum(size + 1 for size in options)
        if (any(size > 48 for size in options)
                or used > agent.cfg.get('head_max_len', 192)
                or used + state_size + 4 > agent.cfg.get('max_len', 512)):
            return False
    return True


def serve(agent):
    write({'type': 'ready'})
    for line in sys.stdin:
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            continue
        if request.get('type') == 'close':
            return
        request_id = request.get('id')
        if not isinstance(request_id, str):
            continue
        try:
            result = (agent.predict(request['state'], request['questions'])
                      if review_fits(agent, request['state'], request['questions'])
                      else {'inputIncomplete': True})
            write({'id': request_id, 'ok': True, 'result': result})
        except Exception as error:
            write({'id': request_id, 'ok': False, 'error': f'{type(error).__name__}: {error}'})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--verify', action='store_true')
    options = parser.parse_args()
    agent = load_agent()
    if options.verify:
        verify(agent)
    else:
        serve(agent)


if __name__ == '__main__':
    main()
