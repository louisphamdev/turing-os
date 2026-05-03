import requests

resp = requests.post(
    'http://localhost:8008/_matrix/client/r0/login',
    json={
        'type': 'm.login.password',
        'identifier': {'type': 'm.id.user', 'user': 'admin'},
        'password': 'adminpassword'
    }
)
token = resp.json()['access_token']

resp2 = requests.get(
    'http://localhost:8008/_matrix/client/r0/rooms/!quaHDJObfkICUjezIg:localhost/messages?limit=10',
    headers={'Authorization': f'Bearer {token}'}
)
msgs = resp2.json().get('chunk', [])
for m in msgs[-8:]:
    print(f"{m.get('sender')}: {m.get('content', {}).get('body', '')}")
