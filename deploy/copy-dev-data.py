#!/usr/bin/env python3
"""Copy the original dev database into the migrated forms schema without data loss.

Requires boto3, psycopg 3, inherited dev AWS credentials, and the administrator's
FORMS_DB_USERNAME/FORMS_DB_PASSWORD. --apply requires the ECS service at zero with
no live tasks. Copies the seven service tables and existing reporting views in a
transaction, verifies their contents, then fences the old runtime's write grants.
Does not print answers/credentials or remove the source database. Failures require
inspection before retry; a nonempty target is never overwritten.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys
from urllib.parse import unquote, urlsplit

import boto3
import psycopg
from psycopg import sql

TABLES = ('Form', 'FormVersion', 'FormField', 'FieldOption', 'Submission', 'Answer', 'AnswerSelection')


def connect(url):
    """Open a TLS-verified connection from a parsed URL; driver errors propagate.

    Uses a fixed safe search path and UTC so copied types and fingerprints are
    independent of role defaults. Credentials stay in memory, never command text.
    """
    return psycopg.connect(host=url.hostname, port=url.port or 5432,
                           dbname=url.path.lstrip('/'), user=unquote(url.username),
                           password=unquote(url.password), sslmode='verify-full',
                           sslrootcert=str(Path(__file__).resolve().parent / 'certs/us-east-1-bundle.pem'),
                           connect_timeout=10, options='-c search_path=pg_catalog -c timezone=UTC')


def fingerprint(connection, schema, relation):
    """Return row count and a deterministic digest for an existing relation.

    Identifiers are quoted by psycopg. Entire rows, including all audit fields and
    IDs, are compared; JSON is only a comparison transport, never stored data.
    Raises on SQL failure. Does not emit row contents.
    """
    rows = connection.execute(sql.SQL('SELECT row_to_json(t)::text FROM {} t ORDER BY 1').format(
        sql.Identifier(schema, relation))).fetchall()
    digest = hashlib.sha256()
    for (row,) in rows:
        encoded = row.encode()
        digest.update(len(encoded).to_bytes(8, 'big'))
        digest.update(encoded)
    return {'rows': len(rows), 'sha256': digest.hexdigest()}


def copy_data(source, target):
    """Copy and verify all service tables/views inside caller-owned transactions.

    Source and target must be connected to the legacy and migrated databases.
    Locks prevent concurrent changes, and a nonempty target is refused. Application
    triggers are disabled only within the destination transaction; FK and CHECK
    constraints remain active. Returns counts/matches, raises before commit on any
    mismatch. The caller commits or rolls back both connections.
    """
    source.execute(sql.SQL('LOCK TABLE {} IN SHARE MODE').format(sql.SQL(', ').join(
        sql.Identifier('public', name) for name in TABLES)))
    target.execute(sql.SQL('LOCK TABLE {} IN ACCESS EXCLUSIVE MODE').format(sql.SQL(', ').join(
        sql.Identifier('forms', name) for name in TABLES)))
    for name in TABLES:
        if fingerprint(target, 'forms', name)['rows']:
            raise RuntimeError('Target contains data; refusing to overwrite it.')
    if target.execute("SELECT 1 FROM pg_views WHERE schemaname='forms'").fetchone():
        raise RuntimeError('Target already contains reporting views.')
    for name in TABLES:
        target.execute(sql.SQL('ALTER TABLE {} DISABLE TRIGGER USER').format(sql.Identifier('forms', name)))
    evidence = {'tables': {}, 'views': {}}
    for name in TABLES:
        columns = source.execute('SELECT column_name FROM information_schema.columns '
                                 'WHERE table_schema=%s AND table_name=%s ORDER BY ordinal_position',
                                 ('public', name)).fetchall()
        target_columns = target.execute('SELECT column_name FROM information_schema.columns '
                                        'WHERE table_schema=%s AND table_name=%s ORDER BY ordinal_position',
                                        ('forms', name)).fetchall()
        if columns != target_columns:
            raise RuntimeError('Source and target column layouts differ: ' + name)
        identifiers = sql.SQL(', ').join(sql.Identifier(row[0]) for row in columns)
        with source.cursor().copy(sql.SQL('COPY {} ({}) TO STDOUT').format(
                sql.Identifier('public', name), identifiers)) as reader:
            with target.cursor().copy(sql.SQL('COPY {} ({}) FROM STDIN').format(
                    sql.Identifier('forms', name), identifiers)) as writer:
                for block in reader:
                    writer.write(block)
        before = fingerprint(source, 'public', name)
        after = fingerprint(target, 'forms', name)
        if before != after:
            raise RuntimeError('Copied table does not match source: ' + name)
        evidence['tables'][name] = {'rows': after['rows'], 'contentsMatch': True}
    for name in TABLES:
        target.execute(sql.SQL('ALTER TABLE {} ENABLE TRIGGER USER').format(sql.Identifier('forms', name)))
    views = source.execute("SELECT viewname, definition FROM pg_views WHERE schemaname='forms_reporting' ORDER BY viewname").fetchall()
    expected = source.execute('SELECT f.key || \'_v\' || v.version FROM public."FormVersion" v '
                              'JOIN public."Form" f ON f.id=v."formId" WHERE v."publishedAt" IS NOT NULL ORDER BY 1').fetchall()
    if [name for name, _ in views] != [row[0] for row in expected]:
        raise RuntimeError('Reporting views do not match published version history.')
    for name, definition in views:
        if not re.fullmatch(r'[a-z][a-z0-9_]{0,39}_v[1-9][0-9]{0,6}', name):
            raise RuntimeError('Unexpected reporting view name.')
        rewritten = definition.replace('public.', 'forms.').replace('"public".', '"forms".')
        target.execute(sql.SQL('CREATE VIEW {} AS ').format(sql.Identifier('forms', name)) + sql.SQL(rewritten))
        before = fingerprint(source, 'forms_reporting', name)
        after = fingerprint(target, 'forms', name)
        if before != after:
            raise RuntimeError('Copied reporting view does not match source: ' + name)
        evidence['views'][name] = {'rows': after['rows'], 'contentsMatch': True}
    if target.execute("SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid "
                      "JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='forms' AND t.tgenabled='D'").fetchone():
        raise RuntimeError('A target trigger remained disabled.')
    return evidence


def main():
    """Validate the dev topology, then inspect or copy/fence the original data.

    --apply performs the one-time copy and writes aggregate evidence. The target
    commit occurs before source fencing commits, so the service must remain stopped
    until configuration and runtime cutover finish. Raises on any AWS/SQL mismatch.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location('bootstrap', Path(__file__).with_name('bootstrap-dev.py'))
    bootstrap = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bootstrap)
    session = boto3.Session(region_name='us-east-1')
    if session.client('sts').get_caller_identity()['Account'] != '811668436784':
        raise RuntimeError('The dev AWS account is required.')
    source_url = urlsplit(bootstrap.parameter(session.client('ssm'), bootstrap.PREFIX + '/MIGRATION_DATABASE_URL'))
    target_url = bootstrap.target_connection()
    if source_url.path != '/forms' or source_url.username != 'forms_migrator' or source_url.hostname != target_url.hostname:
        raise RuntimeError('Source is not the original dedicated dev database.')
    with connect(source_url) as source, connect(target_url) as target:
        if not args.apply:
            print(json.dumps({'source': {name: fingerprint(source, 'public', name)['rows'] for name in TABLES},
                              'target': {name: fingerprint(target, 'forms', name)['rows'] for name in TABLES}}))
            return
        ecs = session.client('ecs')
        service = ecs.describe_services(cluster='topcoder-infrastructure', services=['forms-api-v6'])['services'][0]
        tasks = []
        for desired in ['RUNNING', 'STOPPED']:
            tasks.extend(ecs.list_tasks(cluster='topcoder-infrastructure', serviceName='forms-api-v6',
                                        desiredStatus=desired)['taskArns'])
        active = [task for task in ecs.describe_tasks(cluster='topcoder-infrastructure', tasks=tasks)['tasks']
                  if task['lastStatus'] != 'STOPPED'] if tasks else []
        if service['desiredCount'] or service['runningCount'] or service['pendingCount'] or active:
            raise RuntimeError('Stop the dev Forms service and wait for all tasks before copying.')
        # Published legacy views are owned by the runtime login. Give the existing
        # base-table owner SELECT so the copy can compare the original view rows.
        runtime_url = urlsplit(bootstrap.parameter(session.client('ssm'), bootstrap.PREFIX + '/DATABASE_URL'))
        if runtime_url.path != '/forms' or runtime_url.username != 'forms_runtime' or runtime_url.hostname != source_url.hostname:
            raise RuntimeError('The legacy view-owner connection is required.')
        with connect(runtime_url) as runtime:
            views = runtime.execute("SELECT viewname FROM pg_views WHERE schemaname='forms_reporting'").fetchall()
            for (name,) in views:
                runtime.execute(sql.SQL('GRANT SELECT ON {} TO forms_migrator').format(
                    sql.Identifier('forms_reporting', name)))
        evidence = copy_data(source, target)
        source.execute(sql.SQL('REVOKE INSERT, UPDATE, DELETE ON {} FROM forms_runtime').format(
            sql.SQL(', ').join(sql.Identifier('public', name) for name in TABLES)))
    evidence.update({'sourceDatabase': 'forms', 'targetDatabase': 'topcoder-services',
                     'targetSchema': 'forms', 'sourceRuntimeWritesRevoked': True})
    Path('deploy/schema-migration-dev.json').write_text(json.dumps(evidence, indent=2) + '\n')
    print(json.dumps(evidence, indent=2))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Data migration stopped (' + type(error).__name__ + '); database diagnostics withheld. Inspect state before retrying.', file=sys.stderr)
        sys.exit(1)
