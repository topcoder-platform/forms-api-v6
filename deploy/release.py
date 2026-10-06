#!/usr/bin/env python3
"""Run the migration gate before the shared Topcoder ECS deployment script.

CLI: release.py dev|production IMAGE_TAG [MIGRATION_IMAGE].
Requires inherited AWS credentials, boto3, and Docker. Pushes the prebuilt migration
image to ECR and runs it as a private one-shot ECS task. Raises on failures so
CircleCI stops before master_deploy.sh promotes the runtime image.
"""
import base64
import copy
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

import boto3


def wait_until(description, check, seconds=1800):
    """Poll a live deployment check every 15 seconds, returning its truthy result.

    Inputs are a progress label, callable, and timeout. Check exceptions propagate;
    timeout raises RuntimeError without restarting the observed deployment.
    """
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        result = check()
        if result:
            return result
        print(f'Waiting for {description}...', flush=True)
        time.sleep(15)
    raise RuntimeError(f'Timed out observing {description}; inspect the existing AWS operation before retrying.')


def main():
    """Validate CLI arguments and environment, run migrations, and save evidence.

    Returns None on success; AWS, Docker, and failed migration
    errors propagate. Credentials are passed through stdin/environment, never argv.
    """
    if len(sys.argv) not in (3, 4) or sys.argv[1] not in ('dev', 'production'):
        raise RuntimeError(__doc__)
    environment, tag = sys.argv[1:3]
    if not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,110}', tag):
        raise RuntimeError('Invalid immutable release tag.')
    local_migration = sys.argv[3] if len(sys.argv) == 4 else 'forms-api-v6:migrate-candidate'
    session = boto3.Session(region_name=os.environ.get('AWS_REGION', 'us-east-1'))
    account = session.client('sts').get_caller_identity()['Account']
    if (account == '811668436784') != (environment == 'dev'):
        raise RuntimeError('AWS account does not match the selected deployment environment.')
    cfn, ecs, ecr = [session.client(name) for name in ['cloudformation', 'ecs', 'ecr']]
    stack_name = f'forms-api-v6-{environment}'
    stack = cfn.describe_stacks(StackName=stack_name)['Stacks'][0]
    if stack['StackStatus'] not in ('CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE'):
        raise RuntimeError('Existing stack is not stable; inspect it before releasing.')
    settings = {x['ParameterKey']: x['ParameterValue'] for x in stack['Parameters']}
    if settings['Environment'] != environment or settings['BootstrapOnly'] != 'false':
        raise RuntimeError('Stack environment or bootstrap state does not permit deployment.')
    output = {x['OutputKey']: x['OutputValue'] for x in stack['Outputs']}
    repository = output['RepositoryUri']
    authorization = ecr.get_authorization_token()['authorizationData'][0]
    user, password = base64.b64decode(authorization['authorizationToken']).decode().split(':', 1)
    subprocess.run(['docker', 'login', '--username', user, '--password-stdin', authorization['proxyEndpoint']],
                   input=password, text=True, check=True, stdout=subprocess.DEVNULL)
    destination = f'{repository}:{tag}-migrate'
    subprocess.run(['docker', 'tag', local_migration, destination], check=True)
    subprocess.run(['docker', 'push', destination], check=True)
    digest = ecr.describe_images(repositoryName='forms-api-v6', imageIds=[{'imageTag': tag + '-migrate'}])['imageDetails'][0]['imageDigest']
    migration_image = f'{repository}@{digest}'
    service = ecs.describe_services(cluster=settings['ClusterName'], services=[output['ServiceName']])['services'][0]
    current = ecs.describe_task_definition(taskDefinition=service['taskDefinition'])['taskDefinition']
    allowed = {'family', 'taskRoleArn', 'executionRoleArn', 'networkMode', 'containerDefinitions',
               'volumes', 'placementConstraints', 'requiresCompatibilities', 'cpu', 'memory', 'runtimePlatform', 'ephemeralStorage'}
    migration = {k: copy.deepcopy(v) for k, v in current.items() if k in allowed}
    migration['family'] = 'forms-api-v6-migrate'
    container = migration['containerDefinitions'][0]
    container['image'] = migration_image
    container['readonlyRootFilesystem'] = False
    container.pop('healthCheck', None)
    container['portMappings'] = []
    container['secrets'] = [{'name': 'DATABASE_URL', 'valueFrom': settings['ParameterPrefix'] + '/MIGRATION_DATABASE_URL'}]
    container['command'] = ['/bin/sh', '-c', 'pnpm migrate:deploy']
    migration_definition = ecs.register_task_definition(**migration)['taskDefinition']['taskDefinitionArn']
    result = ecs.run_task(cluster=settings['ClusterName'], taskDefinition=migration_definition,
                          launchType='FARGATE', networkConfiguration=service['networkConfiguration'],
                          startedBy='forms-release')
    if result.get('failures') or not result.get('tasks'):
        raise RuntimeError('ECS could not start the migration task.')
    migration_arn = result['tasks'][0]['taskArn']
    print('Migration task: ' + migration_arn, flush=True)

    def migration_finished():
        """Read this migration task; return the stopped task, or None while live."""
        tasks = ecs.describe_tasks(cluster=settings['ClusterName'], tasks=[migration_arn])['tasks']
        if not tasks:
            raise RuntimeError('Migration task handle is missing; inspect ECS before retrying.')
        return tasks[0] if tasks[0]['lastStatus'] == 'STOPPED' else None

    completed = wait_until('migration task ' + migration_arn, migration_finished)
    if any(c.get('exitCode') != 0 for c in completed['containers']):
        raise RuntimeError('Migration failed; inspect the migration task logs. Runtime was not promoted.')
    evidence = {'environment': environment, 'tag': tag, 'migrationImage': migration_image,
                'migrationTask': migration_arn, 'stack': stack_name}
    Path('deploy/release-' + environment + '.json').write_text(json.dumps(evidence, indent=2) + '\n')
    print(json.dumps(evidence, indent=2))


if __name__ == '__main__':
    main()
