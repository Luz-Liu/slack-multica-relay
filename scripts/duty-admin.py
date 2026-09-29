#!/usr/bin/env python3
"""Operator client; credentials stay in a local mode-0600 config, never argv."""
import argparse
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.request
import uuid

p = argparse.ArgumentParser()
p.add_argument('action', choices=['on', 'off', 'status'])
p.add_argument('--until', help='Required for on, e.g. 2026-10-08T09:00+08:00')
p.add_argument('--request-id', help='Reuse the printed request ID for an uncertain retry')
p.add_argument('--config', type=Path, default=Path.home()/'.config/cs-duty-admin/config.json')
a = p.parse_args()
if a.action == 'on' and not a.until:
    p.error('on requires --until with an explicit timezone')
try:
    if a.config.stat().st_mode & 0o077:
        sys.exit('Config must be private: chmod 600 the config file.')
    config = json.loads(a.config.read_text())
    base, token = config['url'].rstrip('/'), config['token']
    if not base.startswith('https://') or len(token) < 32:
        raise ValueError()
except (OSError, ValueError, KeyError):
    sys.exit('Missing or invalid private admin configuration.')
body = {'action': a.action}
if a.action != 'status':
    body['requestId'] = a.request_id or str(uuid.uuid4())
    print('requestId='+body['requestId'], file=sys.stderr)
if a.action == 'on':
    body['endsAt'] = a.until
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None
req = urllib.request.Request(base+'/api/duty/admin', data=json.dumps(body).encode(), headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'}, method='POST')
try:
    with urllib.request.build_opener(NoRedirect).open(req, timeout=55) as r:
        print(json.dumps(json.load(r), ensure_ascii=False, indent=2))
except urllib.error.HTTPError as e:
    print('HTTP '+str(e.code)+': '+e.read().decode()[:2000], file=sys.stderr)
    sys.exit(1)
except Exception:
    sys.exit('Result uncertain. Query status; retry mutations only with the same --request-id.')
