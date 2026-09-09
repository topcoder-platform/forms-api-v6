#!/usr/bin/env python3
"""Provision the dedicated dev forms database and encrypted SSM configuration.

Requires inherited dev AWS credentials, boto3, and psql with RDS network access.
Runs read-only unless --apply is provided. Preserves existing service credentials;
never logs passwords, URLs, or SQL containing credentials. Errors stop provisioning.
"""
import argparse
import json
import os
from pathlib import Path
import secrets
import subprocess
from urllib.parse import quote, unquote, urlsplit

import boto3
from botocore.exceptions import ClientError

PREFIX = '/config/forms-api-v6/appvar'


def parameter(ssm, name):
    """Return a decrypted setting or None if missing; other AWS errors propagate."""
    try:
        return ssm.get_parameter(Name=name, WithDecryption=True)['Parameter']['Value']
    except ClientError as error:
        if error.response['Error']['Code'] == 'ParameterNotFound':
            return None
        raise


def ensure_parameter(ssm, name, value):
    """Store a new SecureString; return None, raising on conflicting existing data."""
    current = parameter(ssm, name)
    if current is not None:
        if current != value:
            raise RuntimeError(f'Refusing implicit configuration rotation: {name}')
        return
    ssm.put_parameter(Name=name, Value=value, Type='SecureString', Overwrite=False,
                      Description='Forms API configuration managed by deploy/bootstrap-dev.py')


def sql(connection, statement):
    """Execute bootstrap SQL with credentials in the child environment and return rows.

    Accepts a parsed PostgreSQL URL and SQL text. Raises a sanitized RuntimeError
    on failure because database error text may contain credentials.
    """
    env = {**os.environ, 'PGHOST': connection.hostname,
           'PGPORT': str(connection.port or 5432),
           'PGUSER': unquote(connection.username), 'PGPASSWORD': unquote(connection.password),
           'PGDATABASE': connection.path.lstrip('/'), 'PGSSLMODE': 'verify-full',
           'PGCONNECT_TIMEOUT': '10',
           'PGSSLROOTCERT': str(Path(__file__).resolve().parent / 'certs/us-east-1-bundle.pem')}
    result = subprocess.run(['psql', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1'],
                            input=statement, text=True, capture_output=True, env=env)
    if result.returncode:
        raise RuntimeError('Forms database bootstrap failed; database diagnostics were withheld.')
    return result.stdout.strip()


def main():
    """Inspect or provision fixed dev resources; raise on account, owner, or role mismatch."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    session = boto3.Session(region_name='us-east-1')
    if session.client('sts').get_caller_identity()['Account'] != '811668436784':
        raise RuntimeError('This bootstrap requires development account 811668436784.')
    ssm = session.client('ssm')
    source = urlsplit(parameter(ssm, '/config/member-api-v6/appvar/DATABASE_URL'))
    if source.path != '/topcoder-services':
        raise RuntimeError('Unexpected database administration connection.')
    owner = sql(source, "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='forms';")
    if owner and owner != 'forms_migrator':
        raise RuntimeError('Existing forms database has an unexpected owner.')
    print('Dedicated forms database: ' + ('exists' if owner else 'absent'))
    if not args.apply:
        print('Plan: forms database, forms_migrator owner, forms_runtime login, four encrypted settings.')
        return
    for role, key in [('forms_migrator', 'MIGRATION_DATABASE_URL'), ('forms_runtime', 'DATABASE_URL')]:
        existing = parameter(ssm, PREFIX + '/' + key)
        present = sql(source, f"SELECT 1 FROM pg_roles WHERE rolname='{role}';")
        if present and not existing:
            raise RuntimeError(f'{role} exists without managed credentials; refusing rotation.')
        password = unquote(urlsplit(existing).password) if existing else secrets.token_hex(32)
        host = source.hostname + (f':{source.port}' if source.port else '')
        url = f'postgresql://{role}:{quote(password, safe="")}@{host}/forms?sslmode=verify-full'
        ensure_parameter(ssm, PREFIX + '/' + key, existing or url)
        if not present:
            literal = password.replace("'", "''")
            sql(source, f"CREATE ROLE {role} LOGIN PASSWORD '{literal}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;")
    if not owner:
        sql(source, 'CREATE DATABASE forms OWNER forms_migrator;')
    sql(source, 'REVOKE ALL ON DATABASE forms FROM PUBLIC; GRANT CONNECT ON DATABASE forms TO forms_runtime;')
    owner_url = urlsplit(parameter(ssm, PREFIX + '/MIGRATION_DATABASE_URL'))
    sql(owner_url, 'REVOKE CREATE ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO forms_runtime;')
    issuers = json.loads(parameter(ssm, '/config/common/global-appvar/VALID_ISSUERS'))
    ensure_parameter(ssm, PREFIX + '/VALID_ISSUERS', ','.join(issuers))
    ensure_parameter(ssm, PREFIX + '/AUTH_AUDIENCE', parameter(ssm, '/config/common/global-appvar/AUTH0_AUDIENCE'))
    print('Forms database, separate logins, and four SecureString parameters are ready.')


if __name__ == '__main__':
    main()
