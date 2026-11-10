#!/usr/bin/env python3
"""Verification runner for token-traffic. See SKILL.md for the contract."""
import json, os, re, subprocess, sys, tempfile, time
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
PORT = int(os.environ.get('VERIFY_PORT', '0'))
CHROME = os.environ.get('CHROME_PATH', '/usr/bin/google-chrome')
failures = []

def check(name, ok, detail=''):
    print(('PASS' if ok else 'FAIL'), name, (':: ' + str(detail))[:400] if detail else '')
    if not ok:
        failures.append(name)

def run(cmd, **kw):
    return subprocess.run(cmd, cwd=REPO, capture_output=True, text=True, timeout=600, **kw)

def main():
    import socket
    global PORT
    if not PORT:
        s = socket.socket(); s.bind(('127.0.0.1', 0)); PORT = s.getsockname()[1]; s.close()
    model_cmd = "node verification/verify.mjs"
    if model_cmd and model_cmd != 'NONE':
        proc = run(model_cmd.split(), env={**os.environ})
        tail = (proc.stdout + proc.stderr)[-4000:]
        check('model checks', proc.returncode == 0 and "checks passed" in tail, tail[-400:])
    else:
        print('SKIP model checks (no model suite in this repo)')
    server = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT), '--bind', '127.0.0.1'], cwd=REPO, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        time.sleep(1.0)
        shot = tempfile.NamedTemporaryFile(suffix='.png', delete=False).name
        env = dict(os.environ)
        proc = subprocess.run([CHROME, '--headless=new', '--no-sandbox', '--disable-gpu',
                               '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
                               '--virtual-time-budget=8000', '--window-size=1280,900',
                               '--screenshot=' + shot, '--dump-dom', 'http://127.0.0.1:%d/' % PORT],
                              capture_output=True, text=True, timeout=120, env=env)
        dom = proc.stdout
        check('render: app boots', 'Token Traffic' in dom and 'id="runButton"' in dom, dom[:200])
        logs = proc.stderr
        errs = [l for l in logs.splitlines() if 'console' in l.lower() and 'error' in l.lower()
                and not re.search(r'dbus|gpu|vulkan|ozone|fontconfig', l, re.I)]
        check('render: no js console errors', not errs, errs[:3])
    finally:
        server.terminate()
    print('FAILURES=%d' % len(failures))
    evidence = {'repo': 'token-traffic', 'ts': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'failures': failures}
    (REPO / '.cursor/skills/verify-token-traffic').mkdir(parents=True, exist_ok=True)
    with open(REPO / '.cursor/skills/verify-token-traffic/evidence.json', 'w') as f:
        json.dump(evidence, f, indent=2)
    return 1 if failures else 0

if __name__ == '__main__':
    sys.exit(main())
