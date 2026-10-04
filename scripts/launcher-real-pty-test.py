"""Real app plus zsh handoff, with stdin/stdout sharing an isolated foreground PTY."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import subprocess
import tempfile
import termios
import time


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def visible_tail(data):
    """Replay post-teardown text and cursor/erase commands, not TUI rendering."""
    rows = [[' '] * 120 for _ in range(40)]
    row = column = 0
    tokens = re.split(r'(\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07)', data.decode())
    for token in tokens:
        if token.startswith('\x1b['):
            command = token[-1]
            if command == 'r':
                row = column = 0  # DECSTBM resets cursor, even with default margins.
            elif command == 'J':
                rows[row][column:] = [' '] * (120 - column)
                for index in range(row + 1, 40):
                    rows[index] = [' '] * 120
            elif command == 'K':
                rows[row][column:] = [' '] * (120 - column)
            continue
        if token.startswith('\x1b]'):
            continue
        for char in token:
            if char == '\r':
                column = 0
            elif char == '\n':
                row = min(39, row + 1)
            elif char == '\b':
                column = max(0, column - 1)
            elif char >= ' ':
                rows[row][column] = char
                column += 1
                if column == 120:
                    column = 0
                    row = min(39, row + 1)
    return '\n'.join(''.join(line).rstrip() for line in rows)


def run(launcher):
    with tempfile.TemporaryDirectory(prefix='bobonyo-real-exit-') as temporary:
        root = Path(temporary)
        config = root / 'config'
        config.mkdir()
        sessions = root / 'data' / 'sessions'
        sessions.mkdir(parents=True)
        (config / 'providers.json').write_text(json.dumps({'providers': [{
            'id': 'fixture', 'name': 'Fixture', 'baseUrl': 'http://127.0.0.1:1',
            'apiKey': '', 'models': ['fixture-model'],
        }]}))
        (sessions / 'fixture.json').write_text(json.dumps({
            'id': 'fixture', 'name': 'Exit fixture', 'createdAt': 1780000000000,
            'updatedAt': 1780000000000, 'firstMessage': 'exit fixture', 'cwd': temporary,
            'messages': [{'id': 'u1', 'role': 'user', 'content': 'exit fixture'}],
            'context': [{'role': 'user', 'content': 'exit fixture'}],
        }))
        env = dict(os.environ, BOBONYO_CONFIG_DIR=str(config),
                   BOBONYO_DATA_DIR=str(root / 'data'), NANOCODER_DATA_DIR=str(root / 'legacy'),
                   HOME=str(root), XDG_CONFIG_HOME=str(root / 'xdg-config'),
                   XDG_DATA_HOME=str(root / 'xdg-data'), TMPDIR=temporary, TERM='xterm-256color')
        for key in ('HERDR_ENV', 'NANOCODER_RESUME', 'NANOCODER_NONINTERACTIVE',
                    'MOCK_URL', 'BOBONYO_PROJECT_DIR', 'NANOCODER_PROJECT_DIR', 'ZDOTDIR'):
            env.pop(key, None)
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))

        def setup():
            os.setsid()
            fcntl.ioctl(slave, termios.TIOCSCTTY, 0)

        process = subprocess.Popen(['zsh', '-f', '-i'], cwd=temporary, env=env,
                                   stdin=slave, stdout=slave, stderr=slave, preexec_fn=setup)
        output = bytearray()
        prompt = b'BOBONYO_PTY_PROMPT> '
        import shlex
        command = ('PS1="BOBONYO_PTY_PROMPT> "; bash -x ' + shlex.quote(str(launcher)) +
                   ' --continue 2>' + shlex.quote(str(root / 'trace.log')) + '\n')
        os.write(master, command.encode())
        sent = False
        summary = -1
        start = time.monotonic()
        try:
            while time.monotonic() - start < 15:
                if select.select([master], [], [], .05)[0]:
                    output.extend(os.read(master, 65536))
                if not sent and b'Exit fixture' in output:
                    os.write(master, b'/exit\r')
                    sent = True
                summary = output.rfind(b'Continue  bobonyo --resume fixture')
                if sent and summary >= 0 and prompt in output[summary:]:
                    break
                check(process.poll() is None, 'Shell exited before app handoff')
            check(sent, 'Real app never displayed resumed fixture')
            check(summary >= 0 and prompt in output[summary:], 'Resume summary/shell handoff missing')
            trace = (root / 'trace.log').read_text()
            check('+ screen_restore=\n' in trace, 'Real renderer-finished handshake was not accepted')
            check(not list(root.glob('bobonyo-renderer-exit.*')), 'Handshake directory leaked')
            # zsh's line editor re-enters its own terminal mode at this point.
            # Exact saved-stty restoration is covered by the fake-child PTY suite.
            tail = bytes(output[summary:])
            check(b'\x1b[J' in tail, 'zsh erase-to-end handoff was not exercised')
            check(b'\x1b[?1049l' not in tail, 'Alternate screen reset after summary')
            check(b'\x1b[r' not in tail, 'Margins reset homed cursor after summary')
            check('Continue  bobonyo --resume fixture' in visible_tail(tail),
                  'Real app summary erased during zsh handoff (cursor-home followed by CSI J)')
            print('Real full-PTY renderer handshake and zsh handoff preserve resume summary')
        finally:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait(timeout=5)
            os.close(master)
            os.close(slave)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--launcher', type=Path,
                        default=Path(__file__).with_name('launcher.sh').resolve())
    run(parser.parse_args().launcher)
