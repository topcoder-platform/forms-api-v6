#!/usr/bin/env python3
"""Validate the existing dev forms schema/login and configure encrypted SSM settings.

Requires inherited dev AWS credentials, boto3, and psql with RDS network access.
Reads FORMS_DB_USERNAME/FORMS_DB_PASSWORD from the inherited environment.
Runs read-only unless --apply explicitly replaces the two database URLs;
never logs passwords, URLs, or SQL containing credentials. Errors stop provisioning.
"""
import argparse
import json
import os
from pathlib import Path
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


def target_connection():
    """Return the existing dev schema-owner URL from inherited credentials.

    FORMS_DB_USERNAME must be forms; FORMS_DB_PASSWORD must be nonempty. The
    database/host/schema are fixed to this dev deployment. Raises on missing or
    mismatched inputs and never prints credentials.
    """
    username = os.environ.get('FORMS_DB_USERNAME')
    password = os.environ.get('FORMS_DB_PASSWORD')
    if username != 'forms' or not password:
        raise RuntimeError('FORMS_DB_USERNAME=forms and FORMS_DB_PASSWORD are required.')
    return urlsplit(f'postgresql://forms:{quote(password, safe="")}@'
                    'topcoder-services.ci8xwsszszsw.us-east-1.rds.amazonaws.com:5432/'
                    'topcoder-services?sslmode=verify-full&schema=forms')


def main():
    """Check the dev schema owner, optionally updating the managed connection URLs.

    Does not create databases, schemas, or roles. --apply selects the user-provided
    forms login for both runtime and migrations; run it only after data migration
    and before deploying the matching schema-aware runtime. AWS/SQL errors stop
    configuration without logging credentials.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    session = boto3.Session(region_name='us-east-1')
    if session.client('sts').get_caller_identity()['Account'] != '811668436784':
        raise RuntimeError('This bootstrap requires development account 811668436784.')
    ssm = session.client('ssm')
    connection = target_connection()
    owner = sql(connection, "SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='forms';")
    if owner != 'forms':
        raise RuntimeError('The forms schema must exist and be owned by the forms login.')
    print('Verified forms user and schema in topcoder-services.')
    if not args.apply:
        print('Plan: select this connection for runtime and migrations; preserve the existing database.')
        return
    for key in ['DATABASE_URL', 'MIGRATION_DATABASE_URL']:
        name = PREFIX + '/' + key
        if parameter(ssm, name) != connection.geturl():
            ssm.put_parameter(Name=name, Value=connection.geturl(), Type='SecureString',
                              Overwrite=True, Description='Forms schema in topcoder-services; user-provided forms login')
    issuers = json.loads(parameter(ssm, '/config/common/global-appvar/VALID_ISSUERS'))
    ensure_parameter(ssm, PREFIX + '/VALID_ISSUERS', ','.join(issuers))
    ensure_parameter(ssm, PREFIX + '/AUTH_AUDIENCE', parameter(ssm, '/config/common/global-appvar/AUTH0_AUDIENCE'))
    print('Encrypted database URLs now select topcoder-services, schema forms, user forms.')


if __name__ == '__main__':
    main()
