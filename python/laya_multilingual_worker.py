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
            result = agent.predict(request['state'], request['questions'])
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
