"""Exercise the release launcher using isolated PTYs and a fake Bun, never a TUI."""

import argparse
import errno
import fcntl
import json
import os
from pathlib import Path
import pty
import resource
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import termios
import time


FAKE_BUN = r'''
import json, os, signal, sys, time, tty
from pathlib import Path

scenario = os.environ['LAUNCHER_SCENARIO']
record = Path(os.environ['LAUNCHER_RECORD'])
metadata = {'pid': os.getpid(), 'cwd': os.getcwd(), 'args': sys.argv[1:]}
if os.isatty(0):
    metadata['foreground'] = os.tcgetpgrp(0) == os.getpgrp()
    tty.setraw(0)

def terminate(number, frame):
    metadata['signal'] = number
    record.write_text(json.dumps(metadata))
    # The supervisor must wait for this delayed exit, not race cleanup.
    time.sleep(0.08)
    if os.isatty(0):
        tty.setraw(0)
    sys.exit(43)

if scenario.startswith('signal-') or scenario == 'group-term':
    for number in (signal.SIGHUP, signal.SIGINT, signal.SIGQUIT, signal.SIGTERM):
        signal.signal(number, terminate)

record.write_text(json.dumps(metadata))
if scenario in ('exit', 'redirect-output', 'redirect-input', 'pipes'):
    metadata['input'] = os.read(0, 8).decode()
    record.write_text(json.dumps(metadata))
    print('fake child output', flush=True)
    sys.exit(37)
if scenario == 'success':
    sys.exit(0)
while True:
    time.sleep(0.02)
'''

RESET_SEQUENCES = (
    b'\x1b[?2026l', b'\x1b[?1000l', b'\x1b[?1001l', b'\x1b[?1002l',
    b'\x1b[?1003l', b'\x1b[?1004l', b'\x1b[?1005l', b'\x1b[?1006l',
    b'\x1b[?1015l', b'\x1b[?1016l', b'\x1b[?2004l', b'\x1b[<u',
    b'\x1b[=0u', b'\x1b[>4;0m', b'\x1b[?1049l', b'\x1b[?25h',
)


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def run(scenario, template):
    with tempfile.TemporaryDirectory(prefix='bobonyo launcher ') as temporary:
        root = Path(temporary)
        repo = root / 'release repo'
        (repo / 'dist').mkdir(parents=True)
        launcher = repo / 'dist' / 'bobonyo'
        shutil.copyfile(template, launcher)
        launcher.chmod(0o755)
        binaries = root / 'bin'
        binaries.mkdir()
        fake = binaries / 'bun'
        fake.write_text(f'#!{sys.executable}\n' + FAKE_BUN)
        fake.chmod(0o755)
        project = root / 'user project'
        (project / 'node_modules' / '@opentui' / 'solid').mkdir(parents=True)
        (project / 'bunfig.toml').write_text('# Intentionally no preload\n')
        record = root / 'child.json'
        environment = dict(os.environ, PATH=f'{binaries}:{os.environ["PATH"]}',
                           LAUNCHER_SCENARIO=scenario, LAUNCHER_RECORD=str(record))
        master, slave = pty.openpty()
        original = termios.tcgetattr(slave)
        # Verify restoration of actual saved settings, not `stty sane` defaults.
        original[3] &= ~termios.ECHO
        termios.tcsetattr(slave, termios.TCSANOW, original)
        input_tty = scenario not in ('pipes', 'redirect-input')
        output_tty = scenario not in ('pipes', 'redirect-output')

        def establish_terminal():
            os.setsid()
            fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
            resource.setrlimit(resource.RLIMIT_CORE, (0, 0))

        arguments = ['--', 'space argument', '', 'star*', 'line\nbreak']
        child = None
        process = None
        try:
            process = subprocess.Popen(
                ['bash', str(launcher), *arguments], cwd=project, env=environment,
                stdin=slave if input_tty else subprocess.PIPE,
                stdout=slave if output_tty else subprocess.PIPE,
                stderr=subprocess.PIPE, preexec_fn=establish_terminal,
                pass_fds=(slave,),
            )
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                try:
                    metadata = json.loads(record.read_text())
                    child = metadata['pid']
                    break
                except (FileNotFoundError, json.JSONDecodeError):
                    time.sleep(0.005)
            check(child is not None, 'Fake Bun never started')
            if scenario == 'kill':
                os.kill(child, signal.SIGKILL)
                expected = 137
            elif scenario.startswith('signal-'):
                os.kill(process.pid, getattr(signal, 'SIG' + scenario[7:]))
                expected = 43
            elif scenario == 'group-term':
                os.killpg(process.pid, signal.SIGTERM)
                expected = 43
            elif scenario.startswith('default-'):
                number = getattr(signal, 'SIG' + scenario[8:])
                os.kill(process.pid, number)
                expected = 128 + number
            elif scenario == 'success':
                expected = 0
            else:
                expected = 37
                if input_tty:
                    os.write(master, b'payload\n')

            stdout, stderr = process.communicate(
                input=None if input_tty else b'payload\n', timeout=5,
            )
            output = bytearray(stdout or b'')
            while select.select([master], [], [], 0.05)[0]:
                try:
                    data = os.read(master, 65536)
                    if not data:
                        break
                    output.extend(data)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    break
            check(process.returncode == expected,
                  f'Exit {process.returncode}, wanted {expected}: {stderr!r}')
            metadata = json.loads(record.read_text())
            check(metadata['cwd'] == str(project), 'Launcher changed cwd')
            check(metadata['args'] == [
                'run', '-r', str(repo / 'node_modules/@opentui/solid/scripts/preload.js'),
                str(repo / 'src/index.tsx'), *arguments,
            ], f'Preload/entry/arguments changed: {metadata["args"]!r}')
            if input_tty:
                check(metadata['foreground'], 'Bun lost foreground terminal ownership')
                check(termios.tcgetattr(slave) == original, 'Saved stty was not restored')
            if input_tty and output_tty:
                for sequence in RESET_SEQUENCES:
                    check(bytes(output).count(sequence) == 1,
                          f'Missing or repeated cleanup sequence: {sequence!r}')
            else:
                check(b'\x1b' not in output + stderr, 'Redirected I/O polluted by escapes')
            if expected == 37:
                check(metadata['input'] == 'payload\n', 'Supervisor stole/replaced stdin')
                check(b'fake child output' in output, 'Child output lost')
            if scenario.startswith('signal-'):
                check(metadata.get('signal') == getattr(signal, 'SIG' + scenario[7:]),
                      'Wrong termination signal forwarded')
        finally:
            if process is not None:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait(timeout=5)
            os.close(master)
            os.close(slave)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('scenario')
    parser.add_argument('--launcher', type=Path,
                        default=Path(__file__).with_name('launcher.sh'))
    options = parser.parse_args()
    run(options.scenario, options.launcher)
