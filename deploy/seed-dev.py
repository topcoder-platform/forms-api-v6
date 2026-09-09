#!/usr/bin/env python3
"""Publish the supplied event-interest example to the deployed dev Forms API.

Uses inherited dev AWS credentials to mint a five-minute bootstrap JWT from the
existing shared signing key. Keeps the JWT in memory. Refuses existing differing
published content and never overwrites a version. Requires boto3 and requests.
"""
import base64
import hashlib
import hmac
import json
from pathlib import Path
import time

import boto3
import requests


def encoded(value):
    """Encode a JWT object as URL-safe JSON bytes; return text without padding."""
    return base64.urlsafe_b64encode(json.dumps(value, separators=(',', ':')).encode()).decode().rstrip('=')


def main():
    """Create or verify event_interest using dev configuration; raise on drift or HTTP errors."""
    session = boto3.Session(region_name='us-east-1')
    if session.client('sts').get_caller_identity()['Account'] != '811668436784':
        raise RuntimeError('The sample form is restricted to development.')
    ssm = session.client('ssm')
    def setting(name):
        """Read one exact decrypted SSM setting; propagate AWS errors without logging values."""
        return ssm.get_parameter(Name=name, WithDecryption=True)['Parameter']['Value']
    now = int(time.time())
    head = encoded({'alg': 'HS256', 'typ': 'JWT'})
    body = encoded({'sub': 'forms-dev-bootstrap@clients', 'iat': now, 'exp': now + 300,
                    'iss': setting('/config/forms-api-v6/appvar/VALID_ISSUERS').split(',')[0],
                    'aud': setting('/config/forms-api-v6/appvar/AUTH_AUDIENCE'),
                    'gty': 'client-credentials', 'scope': 'manage:forms'})
    message = head + '.' + body
    signature = hmac.new(setting('/config/common/global-appvar/AUTH_SECRET').encode(), message.encode(), hashlib.sha256).digest()
    token = message + '.' + base64.urlsafe_b64encode(signature).decode().rstrip('=')
    client = requests.Session()
    client.headers['Authorization'] = 'Bearer ' + token
    base = 'https://api.topcoder-dev.com/v6/forms'
    definition = json.loads((Path(__file__).resolve().parent.parent / 'examples/event-interest.json').read_text())
    public = requests.get(base + '/event_interest', timeout=30)
    if public.status_code == 200:
        current = public.json()
        expected = {**definition, 'fields': [
            {'helpText': None, 'maxLength': None, 'minValue': None, 'maxValue': None, 'options': [], **field}
            for field in definition['fields']]}
        if any(current.get(k) != v for k, v in expected.items()):
            raise RuntimeError('Published sample differs; review it before creating a new version.')
        print('The event_interest form is already published and matches the example.')
        return
    if public.status_code != 404:
        public.raise_for_status()
    created = client.post(base, json={'key': 'event_interest'}, timeout=30)
    created.raise_for_status()
    response = client.put(base + '/event_interest/versions/1', json=definition, timeout=30)
    response.raise_for_status()
    response = client.post(base + '/event_interest/versions/1/publish', timeout=30)
    response.raise_for_status()
    print('Published event_interest version 1 from examples/event-interest.json.')


if __name__ == '__main__':
    main()
