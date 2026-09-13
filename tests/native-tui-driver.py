"""PTY acceptance driver. All prompts, hooks and history belong to a disposable fixture."""
import os, sys, pty, subprocess, select, time, fcntl, termios, struct, json, re, glob
binary, endpoint, workspace, output = sys.argv[1:5]
resumed = sys.argv[5] if len(sys.argv) > 5 else None
fixture_root = os.path.dirname(workspace)
assert os.path.basename(fixture_root).startswith('au-native-tui-')
assert os.path.commonpath([fixture_root, os.environ['CODEX_HOME'], workspace]) == fixture_root
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 60, 180, 0, 0))
def terminal_session():
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
def command(value):
    os.write(master, value.encode())
    time.sleep(.25)
    os.write(master, b'\r')
def threads():
    return [json.load(open(path)) for path in glob.glob(os.path.join(os.environ['FIXTURE_STATE_DIR'], 'threads', '*.json'))]
if endpoint == 'managed':
    runner = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'bin', 'run.ts'))
    tui_args = [os.environ['FIXTURE_NODE_BINARY'], runner, '--binary', binary, '--']
else:
    tui_args = [binary, '--remote', endpoint]
tui_args += ['--no-alt-screen', '--dangerously-bypass-hook-trust', '--cd', workspace]
tui_args += ['resume', resumed, 'Return LOCAL_NATIVE_TUI_OK after reconnect.'] if resumed else ['Return LOCAL_NATIVE_TUI_OK without tools.']
p = subprocess.Popen(tui_args, stdin=slave, stdout=slave, stderr=slave, env=dict(os.environ, TERM='xterm-256color'), cwd=workspace, preexec_fn=terminal_session)
os.close(slave)
text = ''; stage = 0; root = None; trusted_hooks = False; changed = time.monotonic(); last_output = changed; end = changed + 60
try:
    while time.monotonic() < end and p.poll() is None:
        readable, _, _ = select.select([master], [], [], .1)
        if readable:
            try: data = os.read(master, 65536).decode(errors='replace')
            except OSError: break
            text += data
            last_output = time.monotonic()
            if '\x1b[6n' in data: os.write(master, b'\x1b[1;1R')
        plain = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', text)
        records = threads()
        idle = time.monotonic() - last_output > .8
        compact = re.sub(r'\s', '', plain)
        if not trusted_hooks and idle and 'Hooksneedreview' in compact and 'Trustallandcontinue' in compact:
            # These are exclusively the fixture's own authored AU hooks. Trust
            # stays in its temporary native home, never the user's home.
            os.write(master, b'\x1b[B'); time.sleep(.25); os.write(master, b'\r')
            trusted_hooks = True
            continue
        if stage == 0 and idle and plain.count('LOCAL_NATIVE_TUI_OK') >= 2 and records:
            root = resumed or records[0]['session']
            time.sleep(1)
            if resumed:
                command('/quit'); stage = 5
            else:
                command('/fork'); stage = 1; changed = time.monotonic()
        elif stage == 1 and idle and 'Thread forked from' in plain and time.monotonic() - changed > 2:
            command('Return LOCAL_NATIVE_TUI_OK again.'); stage = 2; changed = time.monotonic()
        elif stage == 2 and idle and time.monotonic() - changed > 3:
            command('/resume ' + root); stage = 3; changed = time.monotonic()
        elif stage == 3 and idle and time.monotonic() - changed > 3:
            command('Return LOCAL_NATIVE_TUI_OK after resume.'); stage = 4; changed = time.monotonic()
        elif stage == 4 and idle and time.monotonic() - changed > 3:
            command('/quit'); stage = 5
finally:
    timed_out = p.poll() is None
    if timed_out:
        p.terminate()
        try: p.wait(timeout=4)
        except subprocess.TimeoutExpired: p.kill(); p.wait()
    os.close(master)
    open(output, 'w').write(text)
    print(json.dumps({'stage': stage, 'exit': p.returncode, 'timed_out': timed_out, 'root': root}))
    if stage < 5 or timed_out or p.returncode != 0: sys.exit(1)
