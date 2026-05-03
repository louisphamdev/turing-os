import requests, time

# Login
resp = requests.post(
    'http://localhost:8008/_matrix/client/r0/login',
    json={
        'type': 'm.login.password',
        'identifier': {'type': 'm.id.user', 'user': 'admin'},
        'password': 'adminpassword'
    }
)
print('Login status:', resp.status_code)
print('Login response:', resp.json())

if 'access_token' in resp.json():
    token = resp.json()['access_token']
    print('Token:', token[:30] + '...')
    
    # Join PO room
    resp2 = requests.post(
        'http://localhost:8008/_matrix/client/r0/rooms/!aCmGvPwDSHpzyAanVo:localhost/join',
        headers={'Authorization': f'Bearer {token}'},
        json={}
    )
    print('Join:', resp2.status_code)
    
    # Send message
    txn_id = f'test_{int(time.time() * 1000)}'
    resp3 = requests.put(
        f'http://localhost:8008/_matrix/client/r0/rooms/!aCmGvPwDSHpzyAanVo:localhost/send/m.room.message/{txn_id}',
        headers={'Authorization': f'Bearer {token}'},
        json={'msgtype': 'm.text', 'body': 'Hello! What can you help me with?'}
    )
    print('Send:', resp3.status_code)
else:
    print('No token in response')
