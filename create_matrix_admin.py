#!/usr/bin/env python3
import hmac
import hashlib
import urllib.request
import json
import os
import sys

# Get nonce
with urllib.request.urlopen('http://localhost:8008/_synapse/admin/v1/register') as resp:
    nonce_data = json.loads(resp.read())
    nonce = nonce_data['nonce']

print(f"Got nonce: {nonce[:30]}...")

# MAC key — must match registration_shared_secret in synapse/homeserver.yaml.
# No baked-in secret: read it from the environment and fail loudly if unset.
secret = os.environ.get('SYNAPSE_REGISTRATION_SECRET', '')
if not secret:
    sys.exit('ERROR: SYNAPSE_REGISTRATION_SECRET is not set. Set it in .env '
             '(must match registration_shared_secret in synapse/homeserver.yaml).')
password = 'Admin123!'

# Try different MAC formats
mac_formats = [
    ('standard', nonce + 'admin' + password + 'admin'),
    ('admin bool', nonce + 'admin' + password + '1'),
    ('bytes', nonce + 'admin' + password + bytes([1]).decode()),
]

for name, msg in mac_formats:
    mac = hmac.new(secret.encode(), msg.encode(), hashlib.sha256).hexdigest()
    print(f"{name}: {mac}")

# Register with standard format first
mac = hmac.new(secret.encode(), (nonce + 'admin' + password + 'admin').encode(), hashlib.sha256).hexdigest()

# Register
data = json.dumps({
    'nonce': nonce,
    'username': 'admin',
    'password': password,
    'admin': True,
    'displayname': 'Admin',
    'mac': mac
}).encode()

req = urllib.request.Request(
    'http://localhost:8008/_synapse/admin/v1/register',
    data=data,
    headers={'Content-Type': 'application/json'},
    method='POST'
)

try:
    with urllib.request.urlopen(req) as resp:
        result = json.loads(resp.read())
        print(f"Success! Created user: {result.get('name', 'admin')}")
except urllib.error.HTTPError as e:
    error = json.loads(e.read())
    print(f"Error: {error.get('error', str(e))}")
